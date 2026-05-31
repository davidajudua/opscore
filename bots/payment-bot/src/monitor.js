/**
 * Per-provider Gmail monitor — IMAP IDLE driven.
 *
 * Replaces the previous 15-second polling loop. The bot keeps a single IMAP
 * connection open per Gmail account and listens for the server's EXISTS push,
 * which fires within ~1s of new mail landing. We process the new UIDs
 * immediately. This puts us on equal footing with any other bot watching the
 * same account that uses IDLE — whoever parses + posts first wins.
 *
 * Public surface unchanged from the polling version:
 *   new PaymentMonitor({ provider, env, db, logger })
 *   monitor.start()
 *   monitor.stop()
 *   monitor.addEventListener('payment', cb)
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const RECONNECT_BACKOFFS_MS = [2_000, 5_000, 10_000, 30_000, 60_000, 120_000];
// Backstop in case an IDLE notification ever gets dropped — every few minutes
// we sweep without waiting for an EXISTS push.
const SAFETY_REPOLL_MS = 5 * 60_000;

export class PaymentMonitor extends EventTarget {
  constructor({ provider, env, db, logger }) {
    super();
    this.provider = provider;
    this.db = db;
    this.logger = logger;
    this.user = env[provider.addressEnvKey];
    // App passwords are usually displayed with spaces. Strip them — Gmail accepts
    // either form, but a literal space could confuse some IMAP libs.
    this.pass = (env[provider.passwordEnvKey] ?? '').replace(/\s+/g, '');
    this.client = null;
    this.running = false;
    this.processing = false;
    this.pendingProcess = false;
    this.reconnectAttempt = 0;
    this.safetyTimer = null;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this._loop().catch((err) =>
      this.logger?.error({ err: err?.message ?? String(err) }, 'monitor loop crashed'),
    );
    return this;
  }

  async stop() {
    this.running = false;
    if (this.safetyTimer) {
      clearInterval(this.safetyTimer);
      this.safetyTimer = null;
    }
    if (this.client) {
      try { await this.client.logout(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  /** Outer loop — connect, hold, reconnect on failure with exponential backoff. */
  async _loop() {
    while (this.running) {
      try {
        await this._connectAndIdle();
        // Clean exit (stop() called) — leave the loop.
        break;
      } catch (err) {
        if (!this.running) break;
        const delay =
          RECONNECT_BACKOFFS_MS[
            Math.min(this.reconnectAttempt, RECONNECT_BACKOFFS_MS.length - 1)
          ];
        this.reconnectAttempt++;
        this.logger?.warn(
          {
            err: err?.message ?? String(err),
            retryInMs: delay,
            attempt: this.reconnectAttempt,
            provider: this.provider.id,
          },
          'monitor: connection error; reconnecting',
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /** One connect → IDLE-listen session. Throws on disconnect / error. */
  async _connectAndIdle() {
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: this.user, pass: this.pass },
      logger: false,
      // Default is auto-IDLE on. Explicit for clarity — this is the whole point.
      disableAutoIdle: false,
    });
    this.client = client;

    // Server-pushed: a new message landed in INBOX.
    client.on('exists', () => this._scheduleProcess('imap exists push'));
    client.on('error', (err) =>
      this.logger?.warn(
        { err: err?.message ?? String(err), provider: this.provider.id },
        'monitor: imap client error',
      ),
    );

    await client.connect();
    this.logger?.info(
      { provider: this.provider.id, user: this.user },
      'monitor: imap connected (IDLE mode)',
    );
    this.reconnectAttempt = 0;

    await client.mailboxOpen('INBOX');

    // Catch up on anything that landed while the bot was offline. After this,
    // imapflow auto-IDLE takes over and `exists` events drive everything.
    await this._processNewMessages('initial sweep');

    // Backstop sweep — every few minutes, run a process pass without waiting for
    // an EXISTS push. Belt-and-suspenders against silent desync.
    this.safetyTimer = setInterval(
      () => this._scheduleProcess('safety repoll'),
      SAFETY_REPOLL_MS,
    );

    // Park here until the connection dies or stop() is called. imapflow handles
    // IDLE entry/exit around any operations we run via fetch/lock.
    await new Promise((resolve, reject) => {
      const onClose = () => {
        cleanup();
        if (this.running) reject(new Error('imap connection closed'));
        else resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        client.off('close', onClose);
        client.off('error', onError);
        if (this.safetyTimer) {
          clearInterval(this.safetyTimer);
          this.safetyTimer = null;
        }
      };
      client.on('close', onClose);
      client.on('error', onError);
    });
  }

  /**
   * Coalesce overlapping triggers. Rapid-fire EXISTS + safety repoll + an
   * in-flight run shouldn't spawn parallel fetches; serialize to one in-flight
   * and at most one queued.
   */
  _scheduleProcess(reason) {
    if (this.processing) {
      this.pendingProcess = true;
      return;
    }
    this._processNewMessages(reason).catch((err) =>
      this.logger?.warn(
        { err: err?.message ?? String(err), provider: this.provider.id },
        'monitor: process error',
      ),
    );
  }

  async _processNewMessages(reason) {
    if (this.processing) {
      this.pendingProcess = true;
      return;
    }
    this.processing = true;
    try {
      do {
        this.pendingProcess = false;
        await this._processOnce(reason);
      } while (this.pendingProcess && this.running);
    } finally {
      this.processing = false;
    }
  }

  async _processOnce(reason) {
    if (!this.client?.usable) return;
    const cursor = this.db.get(
      `SELECT last_uid FROM imap_cursor WHERE provider = ?`,
      this.provider.id,
    );
    const lastUid = cursor?.last_uid ?? 0;

    // First-ever start: jump the cursor to the current uidNext so we don't
    // re-scan years of historical mail. Every payment from now on is in scope.
    if (lastUid === 0) {
      const startFromUid = (this.client.mailbox?.uidNext ?? 1) - 1;
      this._saveCursor(startFromUid);
      this.logger?.info(
        { provider: this.provider.id, startFromUid },
        'monitor: cursor initialized to current uidNext',
      );
      return;
    }

    let highestUid = lastUid;
    const lock = await this.client.getMailboxLock('INBOX');
    try {
      const range = `${lastUid + 1}:*`;
      const fetched = [];
      for await (const msg of this.client.fetch(
        range,
        { uid: true, envelope: true, source: true, internalDate: true },
        { uid: true },
      )) {
        fetched.push(msg);
      }
      this.logger?.debug(
        { provider: this.provider.id, reason, lastUid, found: fetched.length },
        'monitor: fetched',
      );

      for (const msg of fetched) {
        if (msg.uid <= lastUid) continue;
        if (msg.uid > highestUid) highestUid = msg.uid;
        await this._handleMessage(msg);
      }
    } catch (err) {
      // Range fetch can fail if the mailbox is empty above the cursor; log and
      // continue rather than blowing up the IDLE session.
      this.logger?.debug(
        { err: err?.message ?? String(err), provider: this.provider.id, reason },
        'monitor: fetch range returned no rows or errored',
      );
    } finally {
      lock.release();
      if (highestUid > lastUid) this._saveCursor(highestUid);
    }
  }

  async _handleMessage(msg) {
    const fromAddr = (msg.envelope?.from?.[0]?.address ?? '').toLowerCase();
    const matched = this.provider.senders.some((s) => fromAddr.includes(s.toLowerCase()));
    if (!matched) return;

    let parsed;
    try {
      parsed = await simpleParser(msg.source);
    } catch (err) {
      this.logger?.warn(
        { err: err.message, uid: msg.uid, provider: this.provider.id },
        'monitor: simpleParser failed',
      );
      return;
    }

    const result = this.provider.parse({
      subject: msg.envelope?.subject ?? '',
      text: parsed.text ?? '',
      html: parsed.html ?? '',
    });

    // Mark the email as Seen regardless of parser outcome — we've inspected it,
    // it's from a payment sender, and we don't want it to look unread in the
    // inbox UI. Bonus: a racing bot using UNSEEN-style filters skips it.
    try {
      await this.client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
    } catch (err) {
      this.logger?.warn(
        { err: err.message, uid: msg.uid, provider: this.provider.id },
        'monitor: marking \\Seen failed',
      );
    }

    if (!result) {
      this.logger?.debug(
        { uid: msg.uid, subject: msg.envelope?.subject, provider: this.provider.id },
        'monitor: filters matched but parser found nothing',
      );
      return;
    }

    this.logger?.info(
      {
        provider: this.provider.id,
        uid: msg.uid,
        amount: result.amount,
        from: result.name,
      },
      'payment detected',
    );

    this.dispatchEvent(
      new CustomEvent('payment', {
        detail: {
          provider: this.provider,
          uid: msg.uid,
          amount: result.amount,
          name: result.name,
          receivedAt: msg.internalDate ?? new Date(),
        },
      }),
    );
  }

  _saveCursor(uid) {
    this.db.run(
      `INSERT INTO imap_cursor (provider, last_uid, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET last_uid = excluded.last_uid, updated_at = excluded.updated_at`,
      this.provider.id,
      uid,
      Date.now(),
    );
  }
}

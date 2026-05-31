/**
 * Safekey IMAP fetcher. Polls the configured Proton Bridge inbox for an Amex
 * verification email and pulls the numeric code out of the body.
 *
 * Direct use of imapflow + mailparser so we get fine-grained control over:
 *   - NOOP-before-SEARCH so newly-arrived mail is visible (Bridge can be slow
 *     to flush EXISTS without a probe)
 *   - internalDate-based filtering accurate to the second (server SEARCH SINCE
 *     is day-granular, which means we widen by 24h and re-filter precisely)
 *   - In-memory dedup of UIDs we've already served (so two rapid /Get Code
 *     clicks can't return the same email twice)
 *   - Marking consumed messages as \Seen so a human can audit what was used
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const SAFEKEY = {
  senderIncludes: 'americanexpress.com',
  subjectRegex: /SafeKey|Verification Code/i,
  // Amex puts the digits inside <span>/<strong> tags in the HTML body; the
  // `(?:<[^>]+>\s*)*` permits any number of tags between the colon and the
  // 6-digit code. Matches the literal phrase used by Amex SafeKey emails:
  //   "Your Verification Code is: 123456"
  codeRegex: /Your Verification Code is:\s*(?:<[^>]+>\s*)*([0-9]{6})/i,
  // Server-side SEARCH window — back-look from click time. Bumped to 5 min
  // so a re-click after a slow Amex delivery (or any race where the email
  // arrived just before the worker clicked) still finds the email. Dedup
  // tables prevent the same code being served twice.
  sinceOffsetMs: 5 * 60 * 1000,
};

export const TIMING = {
  idleTimeoutMs: 60_000,
  fetchTimeoutMs: 60_000,
  fetchPollMs: 2_000,
  skippedMessageTtlMs: 5_000,
};

const SERVED_TTL_MS = 60 * 60 * 1000;

export class SafekeyFetcher {
  constructor({ env, db, logger }) {
    this.logger = logger;
    this.db = db;
    this.config = {
      host: env.PROTON_IMAP_HOST,
      port: env.PROTON_IMAP_PORT,
      auth: { user: env.PROTON_IMAP_USER, pass: env.PROTON_IMAP_PASS },
      folder: env.MAIL_FOLDER,
    };
    /** @type {ImapFlow|null} */
    this.client = null;
    /** Promise of an in-flight connect, so concurrent callers share one attempt. */
    this.connecting = null;
    // Served-UID dedup is persisted in the `served_codes` table (migration 002)
    // so a PM2 restart can't wipe it and replay a code to the next worker.
  }

  _build() {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: false, // Bridge uses STARTTLS, not implicit TLS
      tls: { rejectUnauthorized: false }, // Bridge ships a self-signed cert
      auth: this.config.auth,
      logger: false,
      disableAutoIdle: true,
    });
  }

  async _getClient() {
    if (this.client && this.client.usable) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      this.logger?.info(
        { host: this.config.host, port: this.config.port },
        'imap: connecting',
      );
      const c = this._build();
      c.on('error', (err) =>
        this.logger?.warn({ err: err?.message ?? String(err) }, 'imap: client error'),
      );
      c.on('close', () => {
        this.logger?.warn('imap: connection closed');
        if (this.client === c) this.client = null;
      });
      await c.connect();
      this.logger?.info({ user: this.config.auth.user }, 'imap: connected');
      this.client = c;
      this.connecting = null;
      return c;
    })();

    try {
      return await this.connecting;
    } catch (err) {
      this.connecting = null;
      throw err;
    }
  }

  _purgeServed() {
    const cutoff = Date.now() - SERVED_TTL_MS;
    this.db.run(`DELETE FROM served_codes WHERE served_at < ?`, cutoff);
  }

  _isServed(uid) {
    return !!this.db.get(`SELECT 1 FROM served_codes WHERE uid = ?`, uid);
  }

  /**
   * Atomically claim a UID as served. Returns true if we claimed it, false if
   * another concurrent caller (or a prior run before restart) beat us to it.
   */
  _claimServed(uid) {
    const result = this.db.run(
      `INSERT OR IGNORE INTO served_codes (uid, served_at) VALUES (?, ?)`,
      uid,
      Date.now(),
    );
    return result.changes === 1;
  }

  /**
   * One pass over the inbox. Returns the first matching unserved code, or null.
   */
  async fetchOnce({ clickTime }) {
    this._purgeServed();
    const client = await this._getClient();
    const sinceDate = new Date(clickTime - SAFEKEY.sinceOffsetMs);
    // Server SEARCH SINCE is day-granular and evaluated in server local time —
    // widen by 24h so we never miss an email that straddles midnight. Precise
    // filtering happens below via internalDate (to-the-second).
    const imapSinceDate = new Date(sinceDate.getTime() - 24 * 60 * 60 * 1000);

    const lock = await client.getMailboxLock(this.config.folder);
    try {
      // NOOP forces the server to flush EXISTS / EXPUNGE — without this, newly
      // arrived mail can stay invisible to the IMAP session for a poll cycle.
      try { await client.noop(); } catch { /* noop can fail harmlessly */ }

      const uids = await client.search(
        { since: imapSinceDate, from: SAFEKEY.senderIncludes },
        { uid: true },
      );
      if (!uids?.length) return null;
      uids.sort((a, b) => b - a); // newest first

      for (const uid of uids) {
        if (this._isServed(uid)) continue;

        const msg = await client.fetchOne(
          uid,
          { source: true, envelope: true, internalDate: true },
          { uid: true },
        );
        if (!msg) continue;

        const internalDate = msg.internalDate ? new Date(msg.internalDate) : null;
        const subject = msg.envelope?.subject ?? '';

        // Drop anything older than the click window.
        if (internalDate && internalDate.getTime() < sinceDate.getTime()) continue;
        if (!SAFEKEY.subjectRegex.test(subject)) continue;

        const parsed = await simpleParser(msg.source);
        const body = parsed.html || parsed.text || '';
        const m = body.match(SAFEKEY.codeRegex);
        if (!m?.[1]) {
          this.logger?.warn(
            { uid, subject },
            'imap: filters matched but body codeRegex found nothing',
          );
          continue;
        }

        const code = m[1];
        // Per-source claim (this email UID). If another caller already owns it
        // (stale row from before restart, or extreme concurrency) — skip.
        if (!this._claimServed(uid)) continue;
        // Cross-source value claim. Prevents the same physical code from being
        // served once via email AND once via webhook (Amex sometimes sends both).
        if (!claimCodeValue(this.db, code)) {
          this.logger?.info({ uid, code }, 'imap: code already served from another source; skipping');
          continue;
        }
        this.logger?.info({ uid, subject, code }, 'imap: code captured');
        // Best-effort \Seen so humans can see what the bot consumed.
        try {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } catch (err) {
          this.logger?.warn(
            { uid, err: err?.message ?? String(err) },
            'imap: could not mark \\Seen',
          );
        }
        return { code, receivedAt: internalDate ?? new Date(), uid };
      }
      return null;
    } finally {
      lock.release();
    }
  }

  /**
   * Poll repeatedly until either a code is found or the deadline expires.
   */
  async fetchUntilDeadline({ clickTime, signal }) {
    const deadline = clickTime + TIMING.fetchTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) return null;
      try {
        const hit = await this.fetchOnce({ clickTime });
        if (hit) return hit;
      } catch (err) {
        this.logger?.warn(
          { err: err?.message ?? String(err) },
          'imap: poll error; retrying',
        );
      }
      await sleepUntil(Math.min(deadline, Date.now() + TIMING.fetchPollMs), signal);
    }
    this.logger?.info(
      { sinceClickMs: Date.now() - clickTime },
      'imap: deadline reached without a matching email',
    );
    return null;
  }

  async close() {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch {
      // ignore
    }
    this.client = null;
  }
}

/**
 * Cross-source dedup. Atomically claim a code value (the 6-digit string).
 * Returns true if we claimed it, false if another source already served it
 * within the TTL window. Used by both IMAP and webhook fetchers so the same
 * physical code isn't served twice via different sources.
 *
 * Backed by served_code_values (migration 004). Old rows aged out by the
 * per-fetcher _purgeServed calls using the same SERVED_TTL_MS window.
 */
export function claimCodeValue(db, code) {
  // Purge expired rows opportunistically so the table doesn't grow unbounded.
  db.run(
    `DELETE FROM served_code_values WHERE served_at < ?`,
    Date.now() - SERVED_TTL_MS,
  );
  const result = db.run(
    `INSERT OR IGNORE INTO served_code_values (code, served_at) VALUES (?, ?)`,
    code,
    Date.now(),
  );
  return result.changes === 1;
}

function sleepUntil(targetMs, signal) {
  const ms = Math.max(0, targetMs - Date.now());
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

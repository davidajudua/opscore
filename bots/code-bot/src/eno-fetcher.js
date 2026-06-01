/**
 * Eno (Capital One) IMAP fetcher. Polls the same Proton Bridge inbox the
 * SafekeyFetcher uses, but filters for Capital One purchase-notification
 * emails and matches on a worker-supplied 3-char hint.
 *
 * Email shape (forwarded from Gmail → Proton):
 *   From:    "Capital One | VentureOne" <capitalone@notification.capitalone.com>
 *   Subject: A new transaction was charged to your account
 *   Body:    "...As requested, we're notifying you that on May. 11, 2026,
 *            at RLP 483693, a pending authorization or purchase..."
 *
 * The 3-char hint (e.g. "RLP", "2LS") is whatever the worker sees in their
 * Google Pay flow and types into the Request modal. The fetcher then looks
 * for an email containing "at <HINT> <6-digit>" and returns the 6-digit code.
 *
 * Same interface as SafekeyFetcher (constructor, fetchUntilDeadline, close)
 * so get-code.js can swap in this fetcher based on the provider.
 *
 * Uses the shared served_codes + served_code_values dedup tables — same
 * cross-source protection as Safekey.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { TIMING, claimCodeValue } from './imap-fetcher.js';

const ENO = {
  senderIncludes: 'notification.capitalone.com',
  subjectRegex: /transaction|charged to your account/i,
  // "at <HINT> <CODE>" pattern; hint is alphanumeric, code is exactly 6 digits.
  // Built per-fetch with the worker's specific hint inserted.
  buildCodeRegex: (hint) => new RegExp(`\\bat\\s+${escapeRegex(hint)}\\s+(\\d{6})\\b`, 'i'),
  // 1-hour back-window. Bumped above Capital One's stated 10-min code
  // validity so testing flows that involve older emails don't false-fail
  // on the timestamp filter. In production, stale-but-served codes will
  // still get rejected at Amex/Capital One when used.
  sinceOffsetMs: 60 * 60_000,
  // 3-minute poll window per Request Code click. Capital One can take
  // 5+ min from purchase to email delivery; 60s often misses it and the
  // worker has to retry. 180s catches most slow deliveries on the first try.
  fetchTimeoutMs: 180_000,
};

const SERVED_TTL_MS = 60 * 60 * 1000;

export class EnoFetcher {
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
    this.connecting = null;
  }

  _build() {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: false,
      tls: { rejectUnauthorized: false },
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
        'eno-imap: connecting',
      );
      const c = this._build();
      c.on('error', (err) =>
        this.logger?.warn({ err: err?.message ?? String(err) }, 'eno-imap: client error'),
      );
      c.on('close', () => {
        this.logger?.warn('eno-imap: connection closed');
        if (this.client === c) this.client = null;
      });
      await c.connect();
      this.logger?.info({ user: this.config.auth.user }, 'eno-imap: connected');
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

  _claimServed(uid) {
    const result = this.db.run(
      `INSERT OR IGNORE INTO served_codes (uid, served_at) VALUES (?, ?)`,
      uid,
      Date.now(),
    );
    return result.changes === 1;
  }

  async fetchOnce({ clickTime, hint }) {
    if (!hint) return null;
    this._purgeServed();
    const client = await this._getClient();
    const lock = await client.getMailboxLock(this.config.folder);
    try {
      // NOOP forces the server to flush EXISTS / EXPUNGE — without this, newly
      // arrived mail can stay invisible to the IMAP session for a poll cycle.
      // Mirrors SafekeyFetcher.fetchOnce so Eno polls behave identically.
      try { await client.noop(); } catch { /* noop can fail harmlessly */ }

      const sinceDate = new Date(clickTime - ENO.sinceOffsetMs);
      // Day-granular search; we re-filter to second precision below.
      const imapSinceDate = new Date(sinceDate.getTime() - 24 * 60 * 60_000);
      const codeRegex = ENO.buildCodeRegex(hint);

      const uids = await client.search(
        { since: imapSinceDate, from: ENO.senderIncludes },
        { uid: true },
      );
      if (!uids?.length) return null;

      // Newest first.
      const sorted = [...uids].sort((a, b) => b - a);
      for (const uid of sorted) {
        if (this._isServed(uid)) continue;
        const msg = await client.fetchOne(
          uid,
          { uid: true, envelope: true, internalDate: true, source: true },
          { uid: true },
        );
        if (!msg) continue;

        const internalDate = msg.internalDate ? new Date(msg.internalDate) : null;
        const subject = msg.envelope?.subject ?? '';

        if (internalDate && internalDate.getTime() < sinceDate.getTime()) continue;
        if (!ENO.subjectRegex.test(subject)) continue;

        const parsed = await simpleParser(msg.source);
        const body = parsed.html || parsed.text || '';
        const m = body.match(codeRegex);
        if (!m?.[1]) continue;

        const code = m[1];
        if (!this._claimServed(uid)) continue;
        if (!claimCodeValue(this.db, code)) {
          this.logger?.info({ uid, code, hint }, 'eno: code already served from another source; skipping');
          continue;
        }
        this.logger?.info({ uid, subject, code, hint }, 'eno: code captured');
        try {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } catch (err) {
          this.logger?.warn(
            { uid, err: err?.message ?? String(err) },
            'eno: could not mark \\Seen',
          );
        }
        return { code, uid, receivedAt: internalDate };
      }
      return null;
    } finally {
      lock.release();
    }
  }

  async fetchUntilDeadline({ clickTime, hint, signal }) {
    if (!hint) return null;
    const deadline = clickTime + ENO.fetchTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) return null;
      try {
        const hit = await this.fetchOnce({ clickTime, hint });
        if (hit) return hit;
      } catch (err) {
        this.logger?.warn(
          { err: err?.message ?? String(err) },
          'eno: poll error; retrying',
        );
      }
      await sleepUntil(Math.min(deadline, Date.now() + TIMING.fetchPollMs), signal);
    }
    this.logger?.info(
      { sinceClickMs: Date.now() - clickTime, hint },
      'eno: deadline reached without a matching email',
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

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

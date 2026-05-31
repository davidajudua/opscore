/**
 * Webhook-channel SafeKey fetcher. Poll-and-match against a Discord channel
 * where a webhook (e.g. "Forward SMS for iOS") drops Amex SafeKey SMS codes.
 *
 * Mirrors SafekeyFetcher's interface exactly so get-code.js can race the two
 * against each other and use whichever delivers first:
 *   - constructor({ env, db, bot, logger })
 *   - fetchUntilDeadline({ clickTime, signal })  → { code, uid, receivedAt } | null
 *   - close()
 *
 * Uses REST (channel.messages.fetch) rather than gateway events so we don't
 * need the privileged MessageContent intent. Polls every 2s, matching the
 * IMAP fetcher's cadence and 60s deadline.
 *
 * Dedup is persisted in served_webhook_codes (migration 003) keyed on Discord
 * message id (snowflake). Claim is atomic via INSERT OR IGNORE — even if two
 * fetcher instances ever ran concurrently they couldn't return the same code.
 */

import { TIMING, claimCodeValue } from './imap-fetcher.js';

const SAFEKEY_WEBHOOK = {
  // The webhook posts messages like:
  //   "194084 is your Amex SafeKey Verification Code. Never share this code. ..."
  // Code is the first 6 digits, followed by " is your".
  codeRegex: /^(\d{6})\s+is your.*SafeKey/i,
  // How far back from clickTime to look for matching messages. Same window as
  // IMAP fetcher's sinceOffsetMs so the two sources behave identically.
  sinceOffsetMs: 30_000,
  // How many recent messages to scan per poll. Webhook posts a few codes at a
  // time; 25 covers any realistic backlog.
  fetchLimit: 25,
};

const SERVED_TTL_MS = 60 * 60 * 1000;

export class WebhookSafekeyFetcher {
  constructor({ env, db, bot, logger }) {
    this.channelId = env.WEBHOOK_CODE_CHANNEL_ID;
    this.authorId = env.WEBHOOK_CODE_AUTHOR_ID;
    this.db = db;
    this.bot = bot;
    this.logger = logger;
  }

  /** True when both env vars are set; otherwise the fetcher is a no-op. */
  isConfigured() {
    return Boolean(this.channelId && this.authorId);
  }

  async fetchUntilDeadline({ clickTime, signal }) {
    if (!this.isConfigured()) return null;
    const deadline = clickTime + TIMING.fetchTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) return null;
      try {
        const hit = await this.fetchOnce({ clickTime });
        if (hit) return hit;
      } catch (err) {
        this.logger?.warn(
          { err: err?.message ?? String(err) },
          'webhook: poll error; retrying',
        );
      }
      await sleepUntil(Math.min(deadline, Date.now() + TIMING.fetchPollMs), signal);
    }
    this.logger?.info(
      { sinceClickMs: Date.now() - clickTime },
      'webhook: deadline reached without a matching message',
    );
    return null;
  }

  async fetchOnce({ clickTime }) {
    this._purgeServed();

    const channel =
      this.bot.client.channels.cache.get(this.channelId) ??
      (await this.bot.client.channels.fetch(this.channelId));
    const collection = await channel.messages.fetch({ limit: SAFEKEY_WEBHOOK.fetchLimit });

    const sinceMs = clickTime - SAFEKEY_WEBHOOK.sinceOffsetMs;
    const candidates = [...collection.values()]
      .filter((m) => m.author?.id === this.authorId && m.createdTimestamp >= sinceMs)
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

    for (const msg of candidates) {
      if (this._isServed(msg.id)) continue;
      const match = msg.content?.match(SAFEKEY_WEBHOOK.codeRegex);
      if (!match) continue;
      const code = match[1];
      // Per-source claim (this Discord message). Stale row or extreme
      // concurrency would lose the race; skip and keep looking.
      if (!this._claimServed(msg.id)) continue;
      // Cross-source value claim. Prevents the same physical code from being
      // served once via webhook AND once via IMAP (Amex sometimes sends both).
      if (!claimCodeValue(this.db, code)) {
        this.logger?.info(
          { messageId: msg.id, code },
          'webhook: code already served from another source; skipping',
        );
        continue;
      }
      this.logger?.info(
        { messageId: msg.id, code },
        'webhook: code captured',
      );
      return { code, uid: msg.id, receivedAt: new Date(msg.createdTimestamp) };
    }
    return null;
  }

  _purgeServed() {
    const cutoff = Date.now() - SERVED_TTL_MS;
    this.db.run(`DELETE FROM served_webhook_codes WHERE served_at < ?`, cutoff);
  }

  _isServed(messageId) {
    return !!this.db.get(
      `SELECT 1 FROM served_webhook_codes WHERE message_id = ?`,
      messageId,
    );
  }

  _claimServed(messageId) {
    const result = this.db.run(
      `INSERT OR IGNORE INTO served_webhook_codes (message_id, served_at) VALUES (?, ?)`,
      messageId,
      Date.now(),
    );
    return result.changes === 1;
  }

  async close() {
    // No persistent connection — REST API only.
  }
}

function sleepUntil(targetMs, signal) {
  return new Promise((resolve) => {
    const delay = Math.max(0, targetMs - Date.now());
    const t = setTimeout(resolve, delay);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/**
 * Bounded LRU set for UID dedup. Insertion order is preserved (Set semantics);
 * oldest entries are evicted when capacity is exceeded.
 */
export class BoundedUidSet {
  constructor(capacity = 5000) {
    this.capacity = capacity;
    this.set = new Set();
  }
  has(uid) {
    return this.set.has(uid);
  }
  add(uid) {
    if (this.set.has(uid)) {
      this.set.delete(uid);
      this.set.add(uid);
      return;
    }
    if (this.set.size >= this.capacity) {
      const oldest = this.set.values().next().value;
      if (oldest !== undefined) this.set.delete(oldest);
    }
    this.set.add(uid);
  }
  size() {
    return this.set.size;
  }
}

/**
 * Wrapper around imapflow that provides:
 *   - lazy connect with auto-reconnect on transient errors
 *   - a simple searchAndParse() helper that runs SEARCH SINCE + fetch + parse
 *   - a built-in bounded UID dedup set
 *   - configurable per-call timeouts
 *
 * Construction options mirror imapflow with a few additions:
 *   logger             pino logger (optional)
 *   dedupCapacity      capacity for the built-in seen-UID set (default 5000)
 *   connectTimeoutMs   timeout for initial connect (default 30000)
 *   operationTimeoutMs timeout for SEARCH + FETCH per call (default 60000)
 */
export class ImapClient {
  constructor({
    host,
    port,
    secure = true,
    auth,
    tls = { rejectUnauthorized: true },
    folder = 'INBOX',
    logger,
    dedupCapacity = 5000,
    connectTimeoutMs = 30_000,
    operationTimeoutMs = 60_000,
  }) {
    if (!host || !port || !auth?.user || !auth?.pass) {
      throw new Error('ImapClient: host, port, auth.user, auth.pass required');
    }
    this.cfg = { host, port, secure, auth, tls, folder };
    this.logger = logger;
    this.connectTimeoutMs = connectTimeoutMs;
    this.operationTimeoutMs = operationTimeoutMs;
    this.seen = new BoundedUidSet(dedupCapacity);

    this.client = null;
    this.connecting = null;
  }

  async connect() {
    if (this.client?.usable) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      // If a previous client exists but is no longer usable (dropped
      // connection), close it before replacing it. Otherwise its underlying
      // socket and error listener stay alive, leaking a socket on every
      // reconnect over the bot's lifetime.
      if (this.client) {
        const stale = this.client;
        this.client = null;
        try {
          await stale.logout();
        } catch {
          try {
            stale.close();
          } catch {
            // ignore — best-effort cleanup of a dead client
          }
        }
      }

      const client = new ImapFlow({
        host: this.cfg.host,
        port: this.cfg.port,
        secure: this.cfg.secure,
        auth: this.cfg.auth,
        tls: this.cfg.tls,
        logger: false,
      });
      client.on('error', (err) => {
        if (this.logger) this.logger.warn({ err: err.message }, 'imap error event');
      });

      const connectPromise = client.connect();
      try {
        await withTimeout(connectPromise, this.connectTimeoutMs, 'imap connect');
      } catch (err) {
        // Connect timed out or failed: the in-flight ImapFlow instance may
        // still establish a socket in the background. Close it so it isn't
        // orphaned with an open socket.
        try {
          client.close();
        } catch {
          // ignore
        }
        throw err;
      }
      this.client = client;
      if (this.logger)
        this.logger.info({ host: this.cfg.host, user: this.cfg.auth.user }, 'imap connected');
      return client;
    })().finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  async close() {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch {
      // ignore — logout failures aren't actionable
    } finally {
      this.client = null;
    }
  }

  /**
   * Run a single IMAP search + fetch pass.
   *
   * @param {object} opts
   * @param {Date}   opts.since                Lower bound for IMAP SEARCH SINCE (day-granular on the wire)
   * @param {string} [opts.fromIncludes]       Optional substring to match in From header (server-side filter)
   * @param {RegExp} [opts.subjectRegex]       Optional client-side subject filter
   * @param {(msg: ParsedMessage) => boolean | Promise<boolean>} [opts.match]
   *                                           Optional client-side filter that gets the parsed message; return true to keep
   * @param {number} [opts.preciseSinceMs]     Client-side precise lower bound (ms epoch). Bypasses IMAP's day granularity
   * @param {boolean} [opts.skipSeen=true]     Skip UIDs already in the dedup set
   * @param {boolean} [opts.markSeen=true]     Add returned UIDs to the dedup set
   * @returns {Promise<ParsedMessage[]>}
   */
  async searchAndParse({
    since,
    fromIncludes,
    subjectRegex,
    match,
    preciseSinceMs,
    skipSeen = true,
    markSeen = true,
  } = {}) {
    if (!since) throw new Error('searchAndParse: since is required');

    const op = async () => {
      const client = await this.connect();

      // Widen by 24h to absorb IMAP's day-granular SEARCH SINCE + timezone drift
      const searchSince = new Date(since.getTime() - 24 * 60 * 60 * 1000);

      const lock = await client.getMailboxLock(this.cfg.folder);
      const out = [];
      try {
        await client.noop();
        const criteria = { since: searchSince };
        if (fromIncludes) criteria.from = fromIncludes;

        const uids = await client.search(criteria, { uid: true });
        if (!uids?.length) return [];

        // Newest first
        uids.sort((a, b) => b - a);

        for (const uid of uids) {
          if (skipSeen && this.seen.has(uid)) continue;

          const msg = await client.fetchOne(
            uid,
            { envelope: true, internalDate: true, source: true },
            { uid: true },
          );
          if (!msg) continue;

          if (
            preciseSinceMs &&
            msg.internalDate &&
            msg.internalDate.getTime() < preciseSinceMs
          ) {
            continue;
          }

          const subject = msg.envelope?.subject ?? '';
          if (subjectRegex && !subjectRegex.test(subject)) continue;

          const parsed = await simpleParser(msg.source);
          const rec = {
            uid,
            subject,
            from: msg.envelope?.from?.[0]?.address ?? null,
            internalDate: msg.internalDate ?? null,
            text: parsed.text ?? '',
            html: parsed.html || '',
            parsed,
          };

          if (match && !(await match(rec))) continue;

          if (markSeen) this.seen.add(uid);
          out.push(rec);
        }
        return out;
      } finally {
        lock.release();
      }
    };

    return withTimeout(op(), this.operationTimeoutMs, 'imap searchAndParse');
  }
}

function withTimeout(promise, ms, label) {
  let to;
  const timeout = new Promise((_, reject) => {
    to = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(to));
}

/**
 * @typedef {object} ParsedMessage
 * @property {number} uid
 * @property {string} subject
 * @property {string|null} from
 * @property {Date|null} internalDate
 * @property {string} text
 * @property {string} html
 * @property {object} parsed   simpleParser output for advanced consumers
 */

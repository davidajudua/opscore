import { EventEmitter } from 'node:events';

/**
 * Generic FIFO worker queue, SQLite-backed. Modeled on Code Bot's queue but
 * generalized so other bots can reuse it.
 *
 * Schema (created by ensureSchema, idempotent):
 *   queue_<name>(
 *     position           INTEGER PRIMARY KEY AUTOINCREMENT,
 *     user_id            TEXT NOT NULL UNIQUE,
 *     username           TEXT NOT NULL,
 *     status             TEXT NOT NULL DEFAULT 'waiting',  -- 'waiting' | 'active' | 'fetching'
 *     joined_at          INTEGER NOT NULL,
 *     activated_at       INTEGER,
 *     session_message_id TEXT,
 *     match_code         TEXT,
 *     source_id          TEXT,
 *     metadata           TEXT  -- json blob for bot-specific extras
 *   )
 *
 * Events emitted:
 *   'activate' { entry }    -- a user just became #1 (joined empty queue OR was promoted)
 *   'idle'     { entry }    -- the active worker hit the idle timeout and was skipped
 *   'remove'   { entry }    -- a user was removed (cancelled, completed, or skipped)
 */
export class WorkerQueue extends EventEmitter {
  /**
   * @param {object} opts
   * @param {ReturnType<import('./db.js').openDb>} opts.db
   * @param {string} opts.name                              Unique queue name (becomes the table suffix)
   * @param {object} [opts.logger]                          Pino logger (optional)
   * @param {number} [opts.idleTimeoutMs=60000]             How long an active worker can sit idle before auto-skip
   */
  constructor({ db, name, logger, idleTimeoutMs = 60_000 }) {
    super();
    if (!db) throw new Error('WorkerQueue: db is required');
    if (!name || !/^[a-z0-9_]+$/.test(name)) {
      throw new Error('WorkerQueue: name must be lowercase alphanumeric with underscores');
    }
    this.db = db;
    this.name = name;
    this.logger = logger;
    this.idleTimeoutMs = idleTimeoutMs;
    this.table = `queue_${name}`;
    this.idleTimers = new Map(); // user_id -> Timeout
    this.ensureSchema();
  }

  ensureSchema() {
    this.db.runScript(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        position           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id            TEXT NOT NULL UNIQUE,
        username           TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'waiting',
        joined_at          INTEGER NOT NULL,
        activated_at       INTEGER,
        session_message_id TEXT,
        match_code         TEXT,
        source_id          TEXT,
        metadata           TEXT
      );
      CREATE INDEX IF NOT EXISTS ${this.table}_status_idx ON ${this.table}(status);
    `);
  }

  /** Add a user to the queue. If the queue is empty, auto-activates them. Idempotent on user_id. */
  add({ userId, username, sourceId = null, matchCode = null, metadata = null }) {
    if (!userId || !username) throw new Error('add: userId and username required');

    const existing = this.getByUserId(userId);
    if (existing) return { entry: existing, alreadyQueued: true };

    const empty = this.size() === 0;
    const now = Date.now();
    const status = empty ? 'active' : 'waiting';
    const activatedAt = empty ? now : null;

    this.db.run(
      `INSERT INTO ${this.table}
        (user_id, username, status, joined_at, activated_at, source_id, match_code, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      username,
      status,
      now,
      activatedAt,
      sourceId,
      matchCode,
      metadata ? JSON.stringify(metadata) : null,
    );

    const entry = this.getByUserId(userId);
    if (this.logger) this.logger.info({ entry, queue: this.name }, 'queue add');

    if (empty) {
      this.startIdleTimer(entry);
      this.emit('activate', { entry });
    }
    return { entry, alreadyQueued: false };
  }

  /** Remove a user from the queue. If they were the active worker, promote the next one. */
  remove(userId) {
    const entry = this.getByUserId(userId);
    if (!entry) return null;

    this.clearIdleTimer(userId);
    this.db.run(`DELETE FROM ${this.table} WHERE user_id = ?`, userId);
    if (this.logger) this.logger.info({ entry, queue: this.name }, 'queue remove');
    this.emit('remove', { entry });

    if (entry.status === 'active' || entry.status === 'fetching') {
      this.promoteNext();
    }
    return entry;
  }

  promoteNext() {
    const next = this.db.get(
      `SELECT * FROM ${this.table} WHERE status = 'waiting' ORDER BY position ASC LIMIT 1`,
    );
    if (!next) return null;

    const now = Date.now();
    this.db.run(
      `UPDATE ${this.table} SET status = 'active', activated_at = ? WHERE user_id = ?`,
      now,
      next.user_id,
    );

    const promoted = this.getByUserId(next.user_id);
    if (this.logger) this.logger.info({ entry: promoted, queue: this.name }, 'queue promote');
    this.startIdleTimer(promoted);
    this.emit('activate', { entry: promoted });
    return promoted;
  }

  /** Mark the active user as 'fetching' (the worker is actively waiting on a code). */
  setFetching(userId) {
    this.db.run(`UPDATE ${this.table} SET status = 'fetching' WHERE user_id = ?`, userId);
    this.clearIdleTimer(userId); // fetching state suspends idle skip
    return this.getByUserId(userId);
  }

  /** Revert a fetching user back to active and restart their idle timer. */
  revertToActive(userId) {
    this.db.run(`UPDATE ${this.table} SET status = 'active' WHERE user_id = ?`, userId);
    const entry = this.getByUserId(userId);
    if (entry) this.startIdleTimer(entry);
    return entry;
  }

  setSessionMessageId(userId, messageId) {
    this.db.run(`UPDATE ${this.table} SET session_message_id = ? WHERE user_id = ?`, messageId, userId);
  }

  getByUserId(userId) {
    return this.db.get(`SELECT * FROM ${this.table} WHERE user_id = ?`, userId);
  }

  getActive() {
    return this.db.get(`SELECT * FROM ${this.table} ORDER BY position ASC LIMIT 1`);
  }

  /** All entries, ordered by position. */
  list() {
    return this.db.all(`SELECT * FROM ${this.table} ORDER BY position ASC`);
  }

  size() {
    return this.db.get(`SELECT COUNT(*) AS n FROM ${this.table}`).n;
  }

  /**
   * Position of a user in the queue (1-indexed by activation order). Returns null if not queued.
   * Position 1 is the active worker.
   */
  positionOf(userId) {
    const rows = this.list();
    const i = rows.findIndex((r) => r.user_id === userId);
    return i === -1 ? null : i + 1;
  }

  startIdleTimer(entry) {
    this.clearIdleTimer(entry.user_id);
    const t = setTimeout(() => this.handleIdle(entry.user_id), this.idleTimeoutMs);
    this.idleTimers.set(entry.user_id, t);
  }

  clearIdleTimer(userId) {
    const t = this.idleTimers.get(userId);
    if (t) {
      clearTimeout(t);
      this.idleTimers.delete(userId);
    }
  }

  handleIdle(userId) {
    const entry = this.getByUserId(userId);
    if (!entry || entry.status !== 'active') return; // stale timer
    if (this.logger) this.logger.info({ entry, queue: this.name }, 'queue idle skip');
    this.emit('idle', { entry });
    this.remove(userId);
  }

  /** Tear down all timers (call on shutdown). */
  shutdown() {
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
  }
}

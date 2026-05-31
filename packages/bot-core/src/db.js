import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const EXEC = 'exec';

/**
 * Open (or create) a SQLite database at `dbPath`. Uses Node's built-in `node:sqlite`
 * (no native build step required). Enables WAL mode and a sensible busy timeout.
 *
 * @param {object} opts
 * @param {string} opts.dbPath
 * @param {object} [opts.logger]
 * @param {boolean} [opts.readonly=false]
 */
export function openDb({ dbPath, logger, readonly = false }) {
  if (!dbPath) throw new Error('openDb: dbPath is required');

  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath, { readOnly: readonly });
  const runScript = (sql) => db[EXEC](sql);

  if (!readonly) {
    runScript('PRAGMA journal_mode = WAL');
    runScript('PRAGMA foreign_keys = ON');
    runScript('PRAGMA synchronous = NORMAL');
    runScript('PRAGMA busy_timeout = 5000');
  }

  if (logger) logger.debug({ dbPath }, 'opened sqlite database');

  const stmtCache = new Map();

  function prepareCached(sql) {
    const cached = stmtCache.get(sql);
    if (cached) return cached;
    const stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
    return stmt;
  }

  return {
    raw: db,
    prepareCached,

    /** Run a single statement (no result rows expected). */
    run(sql, ...params) {
      return prepareCached(sql).run(...params);
    },

    /** Get a single row or undefined. */
    get(sql, ...params) {
      return prepareCached(sql).get(...params);
    },

    /** Get all matching rows. */
    all(sql, ...params) {
      return prepareCached(sql).all(...params);
    },

    /** Run a multi-statement SQL script (used by migrations). */
    runScript,

    /**
     * Wrap a sync function in BEGIN/COMMIT. Throws roll back. node:sqlite is sync,
     * so the inner function must also be sync.
     */
    transaction(fn) {
      return (...args) => {
        runScript('BEGIN IMMEDIATE');
        try {
          const out = fn(...args);
          runScript('COMMIT');
          return out;
        } catch (err) {
          try {
            runScript('ROLLBACK');
          } catch {
            // ignore — primary error wins
          }
          throw err;
        }
      };
    },

    close() {
      db.close();
      stmtCache.clear();
    },
  };
}

/**
 * Run all migrations in `migrationsDir` that haven't been applied yet, in lex order.
 * Migration filenames must sort correctly — convention: `001_init.sql`, `002_*.sql`...
 */
export function runMigrations({ db, migrationsDir, logger }) {
  if (!existsSync(migrationsDir)) {
    if (logger) logger.debug({ migrationsDir }, 'no migrations directory');
    return { applied: [] };
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(db.all(`SELECT name FROM _migrations`).map((r) => r.name));
  const newlyApplied = [];

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    const txn = db.transaction(() => {
      db.runScript(sql);
      db.run(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`, file, Date.now());
    });
    txn();

    newlyApplied.push(file);
    if (logger) logger.info({ file }, 'applied migration');
  }

  return { applied: newlyApplied };
}

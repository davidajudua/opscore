import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

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

  // Only create the parent directory when we may write. A read-only open must
  // not have the side effect of creating directories for a missing database.
  if (!readonly) mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath, { readOnly: readonly });
  const runScript = (sql) => db.exec(sql);

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

    /**
     * Forget every cached statement. Call after a schema change: on Node 22 a
     * statement prepared before a table was rebuilt keeps returning the old columns.
     */
    clearStatementCache() {
      stmtCache.clear();
    },

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
 * Run every migration in `migrationsDir` that has not been applied yet, in lexical
 * filename order (`001_init.sql`, `002_*.sql`, ...). Each one runs in its own
 * transaction together with its `_migrations` row, so a failure leaves no trace.
 *
 * A migration is either:
 *   - `NNN_name.sql`: a SQL script.
 *   - `NNN_name.js`:  an ES module exporting a synchronous `up(db, context)`, for
 *     changes SQL cannot express (for example re-encoding existing rows).
 *
 * @param {object} opts
 * @param {ReturnType<typeof openDb>} opts.db
 * @param {string} opts.migrationsDir
 * @param {object} [opts.logger]
 * @param {object} [opts.context]  Passed to every `.js` migration's `up` as its second argument.
 */
export async function runMigrations({ db, migrationsDir, logger, context = {} }) {
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
    .filter((f) => f.endsWith('.sql') || f.endsWith('.js'))
    .sort();

  const applied = new Set(db.all(`SELECT name FROM _migrations`).map((r) => r.name));
  const newlyApplied = [];

  for (const file of files) {
    if (applied.has(file)) continue;

    const apply = await loadMigration(path.join(migrationsDir, file));
    const txn = db.transaction(() => {
      apply(db, context);
      db.run(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`, file, Date.now());
    });
    txn();
    db.clearStatementCache();

    newlyApplied.push(file);
    if (logger) logger.info({ file }, 'applied migration');
  }

  return { applied: newlyApplied };
}

/** Turn a migration file into one synchronous `(db, context) => void` step. */
async function loadMigration(file) {
  if (file.endsWith('.sql')) {
    const sql = readFileSync(file, 'utf8');
    return (db) => db.runScript(sql);
  }

  const { up } = await import(pathToFileURL(file).href);
  if (typeof up !== 'function') {
    throw new Error(`migration ${path.basename(file)} must export a function named up`);
  }
  return (db, context) => {
    const result = up(db, context);
    // node:sqlite is synchronous. An async `up` would keep writing after COMMIT.
    if (typeof result?.then === 'function') {
      throw new Error(`migration ${path.basename(file)}: up() must be synchronous`);
    }
  };
}

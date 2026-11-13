import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { openDb, runMigrations } from '../src/db.js';

function scratch(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-db-'));
  const migrationsDir = path.join(dir, 'migrations');
  mkdirSync(migrationsDir);
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(migrationsDir, name), body);
  }
  const db = openDb({ dbPath: path.join(dir, 'test.db') });
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, migrationsDir, cleanup };
}

test('SQL and JS migrations apply in filename order, once', async () => {
  const { db, migrationsDir, cleanup } = scratch({
    '001_init.sql': `CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);`,
    '002_seed.js': `export function up(db, { label }) {
      db.run('INSERT INTO items (label) VALUES (?)', label);
    }`,
    '003_more.sql': `INSERT INTO items (label) VALUES ('sql');`,
  });
  try {
    const first = await runMigrations({ db, migrationsDir, context: { label: 'from context' } });
    assert.deepEqual(first.applied, ['001_init.sql', '002_seed.js', '003_more.sql']);
    assert.deepEqual(
      db.all('SELECT label FROM items ORDER BY id').map((r) => r.label),
      ['from context', 'sql'],
    );

    const second = await runMigrations({ db, migrationsDir, context: { label: 'again' } });
    assert.deepEqual(second.applied, [], 'a second run applies nothing');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM items').n, 2, 'no row written twice');
  } finally {
    cleanup();
  }
});

test('a JS migration that throws rolls back its writes and stays unapplied', async () => {
  const { db, migrationsDir, cleanup } = scratch({
    '001_init.sql': `CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);`,
    '002_broken.js': `export function up(db) {
      db.run("INSERT INTO items (label) VALUES ('half')");
      throw new Error('boom');
    }`,
  });
  try {
    await assert.rejects(runMigrations({ db, migrationsDir }), /boom/);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM items').n, 0, 'partial write rolled back');
    assert.deepEqual(
      db.all('SELECT name FROM _migrations').map((r) => r.name),
      ['001_init.sql'],
      'the failed migration is not recorded, so the next boot retries it',
    );
  } finally {
    cleanup();
  }
});

test('an async up() is refused and leaves nothing behind', async () => {
  const { db, migrationsDir, cleanup } = scratch({
    '001_async.js': `export async function up(db) {
      db.run('CREATE TABLE never (id INTEGER)');
    }`,
  });
  try {
    await assert.rejects(runMigrations({ db, migrationsDir }), /must be synchronous/);
    assert.equal(
      db.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'never'`).n,
      0,
      'the table created before the first await was rolled back',
    );
  } finally {
    cleanup();
  }
});

test('a JS migration without an up export is refused', async () => {
  const { db, migrationsDir, cleanup } = scratch({
    '001_nothing.js': `export const down = () => {};`,
  });
  try {
    await assert.rejects(runMigrations({ db, migrationsDir }), /must export a function named up/);
  } finally {
    cleanup();
  }
});

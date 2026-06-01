import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { WorkerQueue } from '../src/queue.js';

function freshQueue() {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-queue-'));
  const dbPath = path.join(dir, 'test.db');
  const db = openDb({ dbPath });
  const q = new WorkerQueue({ db, name: 'test' });
  const cleanup = () => {
    q.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { q, db, cleanup };
}

test('metadata is deserialized back to an object on read', () => {
  const { q, cleanup } = freshQueue();
  try {
    const meta = { foo: 'bar', n: 42, nested: { a: [1, 2, 3] } };
    const { entry } = q.add({ userId: 'u1', username: 'Alice', metadata: meta });

    // add() return value
    assert.deepEqual(entry.metadata, meta, 'add() entry.metadata should be an object');

    // getByUserId
    assert.deepEqual(q.getByUserId('u1').metadata, meta, 'getByUserId metadata should be object');

    // getActive (u1 is the only/active entry)
    assert.deepEqual(q.getActive().metadata, meta, 'getActive metadata should be object');

    // list
    const listed = q.list();
    assert.deepEqual(listed[0].metadata, meta, 'list metadata should be object');
  } finally {
    cleanup();
  }
});

test('null metadata stays null on read', () => {
  const { q, cleanup } = freshQueue();
  try {
    q.add({ userId: 'u1', username: 'Alice' });
    assert.equal(q.getByUserId('u1').metadata, null);
    assert.equal(q.getActive().metadata, null);
    assert.equal(q.list()[0].metadata, null);
  } finally {
    cleanup();
  }
});

test('metadata is deserialized on the promoteNext activate payload', () => {
  const { q, cleanup } = freshQueue();
  try {
    q.add({ userId: 'u1', username: 'Alice' });
    const meta = { plan: 'pro' };
    q.add({ userId: 'u2', username: 'Bob', metadata: meta });

    let activatedEntry = null;
    q.on('activate', ({ entry }) => {
      if (entry.user_id === 'u2') activatedEntry = entry;
    });

    q.remove('u1'); // promotes u2
    assert.ok(activatedEntry, 'u2 should have been activated');
    assert.deepEqual(activatedEntry.metadata, meta, 'promoteNext activate payload metadata should be object');
  } finally {
    cleanup();
  }
});

test('getActive returns the active worker by status, not just lowest position', () => {
  const { q, cleanup } = freshQueue();
  try {
    q.add({ userId: 'u1', username: 'Alice' }); // active, position 1
    q.add({ userId: 'u2', username: 'Bob' }); // waiting, position 2

    // Simulate a state where the lowest-position row is NOT the active one:
    // directly demote u1 to 'waiting' without removing it, and activate u2.
    q.db.run(`UPDATE queue_test SET status = 'waiting' WHERE user_id = ?`, 'u1');
    q.db.run(`UPDATE queue_test SET status = 'active' WHERE user_id = ?`, 'u2');

    const active = q.getActive();
    assert.ok(active, 'getActive should return a row');
    assert.equal(active.user_id, 'u2', 'getActive should return the row whose status is active');
    assert.ok(['active', 'fetching'].includes(active.status), 'returned entry should be active/fetching');
  } finally {
    cleanup();
  }
});

test('add() still auto-activates the first user and waits the rest (transaction-wrapped)', () => {
  const { q, cleanup } = freshQueue();
  try {
    const r1 = q.add({ userId: 'u1', username: 'Alice' });
    assert.equal(r1.entry.status, 'active');
    assert.equal(r1.alreadyQueued, false);

    const r2 = q.add({ userId: 'u2', username: 'Bob' });
    assert.equal(r2.entry.status, 'waiting');

    // idempotent on user_id
    const r1b = q.add({ userId: 'u1', username: 'Alice' });
    assert.equal(r1b.alreadyQueued, true);
    assert.equal(q.size(), 2);
  } finally {
    cleanup();
  }
});

test('duplicate add returns alreadyQueued cleanly without throwing on UNIQUE constraint', () => {
  const { q, cleanup } = freshQueue();
  try {
    const first = q.add({ userId: 'u1', username: 'Alice', metadata: { a: 1 } });
    assert.equal(first.alreadyQueued, false);

    // A second add with the same userId must not throw (the in-transaction
    // existence check returns cleanly rather than hitting the UNIQUE constraint).
    let dup;
    assert.doesNotThrow(() => {
      dup = q.add({ userId: 'u1', username: 'Alice-again' });
    });
    assert.equal(dup.alreadyQueued, true);
    // returns the existing entry with deserialized metadata
    assert.deepEqual(dup.entry.metadata, { a: 1 });
    assert.equal(q.size(), 1);
  } finally {
    cleanup();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Register module-resolution stubs BEFORE importing get-code.js. On this review
// branch (a partial tree) get-code.js's sibling/workspace imports are absent;
// the loader supplies empty stubs so we can import and exercise the real
// raceFetchers. Self-registering here keeps `node --test test/*.test.js` working
// with no extra flags. See test/stub-loader.mjs.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register('./stub-loader.mjs', pathToFileURL(import.meta.dirname + '/').href);

const { raceFetchers } = await import('../src/handlers/get-code.js');

// Minimal fake fetcher: resolves to `result` after `delayMs`, or rejects if
// `rejectWith` is set. Records whether its AbortController signal was aborted.
function makeFetcher(name, { result = null, delayMs = 0, rejectWith = null } = {}) {
  const f = {
    aborted: false,
    constructor: { name },
    fetchUntilDeadline({ signal } = {}) {
      if (signal) {
        signal.addEventListener('abort', () => {
          f.aborted = true;
        });
      }
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (rejectWith) reject(rejectWith);
          else resolve(result);
        }, delayMs);
      });
    },
  };
  return f;
}

function makeLogger() {
  const calls = { info: [], warn: [], error: [] };
  return {
    calls,
    info: (obj, msg) => calls.info.push({ obj, msg }),
    warn: (obj, msg) => calls.warn.push({ obj, msg }),
    error: (obj, msg) => calls.error.push({ obj, msg }),
  };
}

test('returns null for an empty fetcher list', async () => {
  const result = await raceFetchers([], { clickTime: 0, hint: null, logger: null });
  assert.equal(result, null);
});

test('single fetcher: returns its result directly', async () => {
  const hit = { code: '123456', uid: 'u1' };
  const f = makeFetcher('Solo', { result: hit });
  const result = await raceFetchers([f], { clickTime: 0, hint: 'ABC', logger: makeLogger() });
  assert.deepEqual(result, hit);
});

test('multi fetcher: first non-null hit wins and aborts the others', async () => {
  const winner = makeFetcher('Fast', { result: { code: '111', uid: 'win' }, delayMs: 5 });
  const loser = makeFetcher('Slow', { result: { code: '222', uid: 'lose' }, delayMs: 100 });
  const logger = makeLogger();
  const result = await raceFetchers([winner, loser], { clickTime: 0, hint: null, logger });
  assert.equal(result.uid, 'win');
  // The slower fetcher should have been aborted.
  assert.equal(loser.aborted, true);
  // Winner logs a "code source won" info line.
  assert.ok(logger.calls.info.some((c) => c.msg === 'race: code source won'));
});

test('multi fetcher: all resolve null -> race resolves null', async () => {
  const a = makeFetcher('A', { result: null, delayMs: 5 });
  const b = makeFetcher('B', { result: null, delayMs: 10 });
  const result = await raceFetchers([a, b], { clickTime: 0, hint: null, logger: makeLogger() });
  assert.equal(result, null);
});

test('multi fetcher: a rejecting fetcher is logged via warn (observability)', async () => {
  const boom = makeFetcher('Boom', { rejectWith: new Error('network down'), delayMs: 5 });
  const ok = makeFetcher('Ok', { result: null, delayMs: 10 });
  const logger = makeLogger();
  const result = await raceFetchers([boom, ok], { clickTime: 0, hint: null, logger });
  // Both ultimately yield no code.
  assert.equal(result, null);
  // The rejection must produce a warn log — this is the gap Greptile flagged.
  const warned = logger.calls.warn.find((c) => c.msg === 'race: fetcher rejected');
  assert.ok(warned, 'expected a "race: fetcher rejected" warn log');
  assert.equal(warned.obj.source, 'Boom');
  assert.equal(warned.obj.err, 'network down');
});

test('multi fetcher: one rejects, the other still wins', async () => {
  const boom = makeFetcher('Boom', { rejectWith: new Error('boom'), delayMs: 5 });
  const winner = makeFetcher('Win', { result: { code: '999', uid: 'w' }, delayMs: 20 });
  const logger = makeLogger();
  const result = await raceFetchers([boom, winner], { clickTime: 0, hint: null, logger });
  assert.equal(result.uid, 'w');
  assert.ok(logger.calls.warn.some((c) => c.msg === 'race: fetcher rejected'));
});

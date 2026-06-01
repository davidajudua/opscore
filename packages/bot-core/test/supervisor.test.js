import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supervise } from '../src/supervisor.js';

test('supervise returns a controller with stop, signal, and done', () => {
  const ctrl = supervise({ run: async () => {}, maxFastFailures: 1, initialBackoffMs: 1 });
  assert.equal(typeof ctrl.stop, 'function');
  assert.ok(ctrl.signal instanceof AbortSignal);
  assert.ok(ctrl.done instanceof Promise, 'done must be exposed as a Promise');
  ctrl.stop();
  return ctrl.done;
});

test('done is a captured promise with an error boundary and resolves on giveup', async () => {
  // The loop promise must be captured (not fire-and-forget) so an unexpected
  // rejection can never become a process-crashing unhandled rejection. We can't
  // easily force an *internal* unexpected throw without a throwing logger (which
  // would also throw inside the boundary), so we assert the observable
  // contract: done is a Promise and it resolves (never rejects) when the loop
  // terminates by giving up — even when run throws non-Error values.
  const ctrl = supervise({
    run: async () => {
      throw 'a-string-not-an-error'; // exercises err?.message ?? String(err)
    },
    initialBackoffMs: 1,
    maxBackoffMs: 1,
    maxFastFailures: 3,
  });
  assert.ok(ctrl.done instanceof Promise);
  await assert.doesNotReject(ctrl.done);
  assert.equal(ctrl.signal.aborted, true);
});

test('gives up after maxFastFailures consecutive fast failures and aborts the signal', async () => {
  let runs = 0;
  const ctrl = supervise({
    run: async () => {
      runs += 1;
      throw new Error('fast fail');
    },
    initialBackoffMs: 1,
    maxBackoffMs: 2,
    factor: 2,
    healthyMs: 60_000,
    maxFastFailures: 3,
  });
  await ctrl.done;
  assert.equal(runs, 3, 'should run exactly maxFastFailures times before giving up');
  assert.equal(ctrl.signal.aborted, true, 'signal should be aborted after giving up');
});

test('stop() aborts the run signal and halts the loop', async () => {
  let sawAbort = false;
  const ctrl = supervise({
    run: (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve();
        });
      }),
    initialBackoffMs: 1,
  });
  // let the loop enter run()
  await new Promise((r) => setTimeout(r, 5));
  ctrl.stop();
  await ctrl.done;
  assert.equal(sawAbort, true, 'run should observe abort via its signal');
  assert.equal(ctrl.signal.aborted, true);
});

test('sleep via timeout does not leak abort listeners on the signal', async () => {
  // Each fast failure sleeps on the shared abort signal. If sleep() leaks a
  // listener every time it resolves via timeout, the net live listener count on
  // AbortSignal grows with the number of failures. We instrument
  // add/removeEventListener globally and assert the net count returns to 0.
  const proto = AbortSignal.prototype;
  const origAdd = proto.addEventListener;
  const origRemove = proto.removeEventListener;
  let live = 0;
  let peak = 0;
  proto.addEventListener = function (type, ...rest) {
    if (type === 'abort') {
      live += 1;
      peak = Math.max(peak, live);
    }
    return origAdd.call(this, type, ...rest);
  };
  proto.removeEventListener = function (type, ...rest) {
    if (type === 'abort') live -= 1;
    return origRemove.call(this, type, ...rest);
  };
  try {
    const ctrl = supervise({
      run: async () => {
        throw new Error('fast');
      },
      initialBackoffMs: 1,
      maxBackoffMs: 1,
      healthyMs: 60_000,
      maxFastFailures: 8,
    });
    await ctrl.done;
    // Each of the (maxFastFailures-1) sleeps adds + removes a listener; the
    // supervisor's own stop() abort listeners are { once: true } and auto-clean
    // on dispatch. With the leak fixed, net live count must be 0.
    assert.equal(live, 0, `expected 0 net live abort listeners, found ${live}`);
    assert.ok(peak >= 1, 'sanity: at least one abort listener was added during sleeps');
  } finally {
    proto.addEventListener = origAdd;
    proto.removeEventListener = origRemove;
  }
});

test('clean return that is healthy resets backoff and keeps looping until stopped', async () => {
  let runs = 0;
  let ctrl;
  ctrl = supervise({
    // Each run takes a real macrotask tick so it counts as "healthy" relative to
    // healthyMs=0, and yields to the event loop (no busy-spin). Stop from inside
    // after a few iterations to make the test deterministic.
    run: async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 2));
      if (runs >= 3) ctrl.stop();
    },
    initialBackoffMs: 1,
    healthyMs: 0, // any runtime counts as healthy -> no backoff between iterations
    maxFastFailures: 3,
  });
  await ctrl.done;
  assert.ok(runs >= 3, 'healthy clean returns should restart the loop repeatedly');
});

test('clean return that is too fast (unhealthy) eventually gives up', async () => {
  let runs = 0;
  const ctrl = supervise({
    run: async () => {
      runs += 1;
    },
    initialBackoffMs: 1,
    maxBackoffMs: 1,
    healthyMs: 60_000, // returns are always "too fast"
    maxFastFailures: 4,
  });
  await ctrl.done;
  assert.equal(runs, 4, 'should give up after maxFastFailures unhealthy clean returns');
  assert.equal(ctrl.signal.aborted, true);
});

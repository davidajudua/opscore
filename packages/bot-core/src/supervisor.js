/**
 * Generic backoff supervisor for in-process recoverable loops.
 *
 * Wraps a long-running async function so that if it throws, the supervisor
 * waits with exponential backoff and restarts it. Backoff resets after the
 * loop has run successfully for `healthyMs`.
 *
 * Modeled on AIO Bot's run.py semantics:
 *   initialBackoffMs: 5000
 *   maxBackoffMs:     60000
 *   factor:           2
 *   healthyMs:        60000  (reset backoff if loop ran this long without throwing)
 *   maxFastFailures:  5      (give up after this many sub-healthyMs failures in a row)
 *
 * Returns a controller with stop() to halt the loop.
 *
 * @param {object} opts
 * @param {(signal: AbortSignal) => Promise<void>} opts.run
 * @param {object} [opts.logger]
 * @param {string} [opts.label='loop']
 * @param {number} [opts.initialBackoffMs=5000]
 * @param {number} [opts.maxBackoffMs=60000]
 * @param {number} [opts.factor=2]
 * @param {number} [opts.healthyMs=60000]
 * @param {number} [opts.maxFastFailures=5]
 */
export function supervise({
  run,
  logger,
  label = 'loop',
  initialBackoffMs = 5_000,
  maxBackoffMs = 60_000,
  factor = 2,
  healthyMs = 60_000,
  maxFastFailures = 5,
}) {
  if (typeof run !== 'function') throw new Error('supervise: run must be a function');

  const ac = new AbortController();
  let stopped = false;
  let fastFailures = 0;
  let backoff = initialBackoffMs;

  const stop = () => {
    stopped = true;
    ac.abort();
  };

  const loop = async () => {
    while (!stopped) {
      const startedAt = Date.now();
      try {
        await run(ac.signal);
        if (stopped) return;
        // Clean exit (run returned without throwing). Treat like a healthy iteration.
        if (logger) logger.info({ label }, 'supervised loop returned cleanly; restarting');
      } catch (err) {
        if (stopped || ac.signal.aborted) return;
        const ranFor = Date.now() - startedAt;
        if (ranFor >= healthyMs) {
          fastFailures = 0;
          backoff = initialBackoffMs;
        } else {
          fastFailures += 1;
        }
        if (logger) {
          logger.error(
            { err: err?.message ?? String(err), label, ranFor, fastFailures, backoff },
            'supervised loop crashed',
          );
        }
        if (fastFailures >= maxFastFailures) {
          if (logger) {
            logger.error(
              { label, maxFastFailures },
              'supervised loop exceeded max consecutive fast failures; giving up',
            );
          }
          stop();
          return;
        }
        await sleep(backoff, ac.signal).catch(() => {});
        backoff = Math.min(maxBackoffMs, backoff * factor);
        continue;
      }
      // The run function returned successfully. If it was healthy, reset backoff
      // and immediately start the next iteration; otherwise apply backoff to avoid hot-loops.
      const ranFor = Date.now() - startedAt;
      if (ranFor >= healthyMs) {
        fastFailures = 0;
        backoff = initialBackoffMs;
      } else {
        fastFailures += 1;
        if (fastFailures >= maxFastFailures) {
          if (logger)
            logger.error({ label }, 'supervised loop returning too quickly; giving up');
          stop();
          return;
        }
        await sleep(backoff, ac.signal).catch(() => {});
        backoff = Math.min(maxBackoffMs, backoff * factor);
      }
    }
  };

  // Capture the loop promise so an unexpected rejection cannot become an
  // unhandled rejection (process-crashing in Node v15+). Callers can also await
  // `done` to observe natural termination.
  const done = loop().catch((err) => {
    if (logger)
      logger.error({ err: err?.message ?? String(err), label }, 'supervise: unexpected loop error');
  });
  return { stop, signal: ac.signal, done };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      };
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    } else {
      setTimeout(resolve, ms);
    }
  });
}

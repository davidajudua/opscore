import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBotLogger } from '../src/logger.js';

test('LOG_LEVEL set after module import is honored (level resolved at call time)', () => {
  const logDir = mkdtempSync(path.join(tmpdir(), 'oc-log-'));
  const prev = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'debug';
  try {
    // unique botName so the per-bot singleton cache doesn't return a logger from another test
    const log = createBotLogger({ botName: `oc-test-${process.pid}-${Date.now()}`, logDir });
    assert.equal(log.level, 'debug', 'logger must use LOG_LEVEL present at creation time, not module-load time');
  } finally {
    if (prev === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prev;
    // Do not rmSync(logDir) here: pino-roll's transport runs on a worker thread that
    // may still be initializing, and removing the dir mid-flight causes ENOENT noise.
    // The dir lives under the OS tmp dir and is reclaimed by the system.
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnvFiles } from '../src/env.js';

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'oc-env-'));
  const botRoot = path.join(root, 'bots', 'x');
  mkdirSync(botRoot, { recursive: true });
  return { root, botRoot };
}

test('bot-specific .env overrides shared .env (documented priority)', () => {
  const { root, botRoot } = scratch();
  writeFileSync(path.join(root, '.env'), 'OC_TEST_KEY=shared\nOC_SHARED_ONLY=base\n');
  writeFileSync(path.join(botRoot, '.env'), 'OC_TEST_KEY=bot\n');
  delete process.env.OC_TEST_KEY;
  delete process.env.OC_SHARED_ONLY;
  try {
    loadEnvFiles({ botRoot, repoRoot: root });
    assert.equal(process.env.OC_TEST_KEY, 'bot', 'bot-specific value must win over shared');
    assert.equal(process.env.OC_SHARED_ONLY, 'base', 'shared-only var still loads');
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.OC_TEST_KEY;
    delete process.env.OC_SHARED_ONLY;
  }
});

test('real process.env wins over both files (production safety preserved)', () => {
  const { root, botRoot } = scratch();
  writeFileSync(path.join(root, '.env'), 'OC_PROD_KEY=fromShared\n');
  writeFileSync(path.join(botRoot, '.env'), 'OC_PROD_KEY=fromBot\n');
  process.env.OC_PROD_KEY = 'fromRealEnv';
  try {
    loadEnvFiles({ botRoot, repoRoot: root });
    assert.equal(process.env.OC_PROD_KEY, 'fromRealEnv', 'a value already in process.env must not be overridden by any file');
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.OC_PROD_KEY;
  }
});

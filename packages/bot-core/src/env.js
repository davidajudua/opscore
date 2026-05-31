import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Load .env files in priority order:
 *   1. <repoRoot>/.env             (shared across all bots)
 *   2. <botRoot>/.env              (bot-specific overrides + secrets)
 *
 * Variables already in process.env are NOT overridden — that's the dotenv default
 * and the right behavior for production where env comes from PM2 / systemd.
 *
 * @param {object} opts
 * @param {string} opts.botRoot   Absolute path to the bot's package directory
 * @param {string} [opts.repoRoot] Absolute path to the monorepo root. Defaults to two levels up from botRoot.
 */
export function loadEnvFiles({ botRoot, repoRoot } = {}) {
  if (!botRoot) throw new Error('loadEnvFiles: botRoot is required');

  const root = repoRoot ?? path.resolve(botRoot, '..', '..');

  const sharedEnv = path.join(root, '.env');
  const botEnv = path.join(botRoot, '.env');

  if (existsSync(sharedEnv)) dotenv.config({ path: sharedEnv });
  if (existsSync(botEnv)) dotenv.config({ path: botEnv });
}

/**
 * Validate process.env against a zod schema. Returns the parsed (typed) env on success,
 * or throws a readable error listing every missing/invalid variable.
 *
 * @template T
 * @param {z.ZodType<T>} schema
 * @returns {T}
 */
export function validateEnv(schema) {
  const result = schema.safeParse(process.env);
  if (result.success) return result.data;

  const issues = result.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Environment validation failed:\n${issues}`);
}

/**
 * One-shot helper: load both .env files and validate against a schema.
 *
 * @template T
 * @param {object} opts
 * @param {string} opts.botRoot
 * @param {string} [opts.repoRoot]
 * @param {z.ZodType<T>} opts.schema
 * @returns {T}
 */
export function loadEnv({ botRoot, repoRoot, schema }) {
  loadEnvFiles({ botRoot, repoRoot });
  return validateEnv(schema);
}

/**
 * Resolve the directory of a module from its import.meta.url. Convenient when each
 * bot's index.js needs `botRoot` for loadEnv without hardcoding a path.
 */
export function moduleDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

/** Re-export zod so bots can declare schemas without an extra dependency. */
export { z };

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

const rootLoggers = new Map();

function buildRootLogger({ botName, logDir, level }) {
  mkdirSync(logDir, { recursive: true });

  const filePath = path.join(logDir, `${botName}.log`);

  const transport = pino.transport({
    targets: [
      {
        target: 'pino-pretty',
        level,
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname,bot',
          singleLine: false,
        },
      },
      {
        target: 'pino-roll',
        level,
        options: {
          file: filePath,
          frequency: 'daily',
          size: '5m',
          mkdir: true,
          dateFormat: 'yyyy-MM-dd',
          symlink: false,
        },
      },
    ],
  });

  return pino(
    {
      level,
      base: { bot: botName },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport,
  );
}

/**
 * Create or reuse the root logger for a bot. Subsequent calls with the same botName
 * return the same logger so per-module child loggers all share one transport.
 *
 * @param {object} opts
 * @param {string} opts.botName  Logical bot name (e.g. "code-bot")
 * @param {string} [opts.logDir] Directory to write log files. Default: ./logs/<botName>
 * @param {string} [opts.level]  Log level. Default: process.env.LOG_LEVEL || 'info'
 */
export function createBotLogger({ botName, logDir, level } = {}) {
  if (!botName) throw new Error('createBotLogger: botName is required');

  const cached = rootLoggers.get(botName);
  if (cached) return cached;

  const dir = logDir ?? path.join(process.cwd(), 'logs', botName);
  // Resolve the level at call time, not module-load time, so a LOG_LEVEL set by
  // loadEnvFiles() (which usually runs after this module is imported) is honored.
  const lvl = level ?? process.env.LOG_LEVEL ?? 'info';

  const root = buildRootLogger({ botName, logDir: dir, level: lvl });
  rootLoggers.set(botName, root);
  return root;
}

/**
 * Get a child logger scoped to a module (e.g. "queue", "imap", "discord").
 *
 * Equivalent to `rootLogger.child({ module })`. Bots typically inline that call,
 * but this helper exists for callers who prefer a named convenience.
 */
export function moduleLogger(rootLogger, moduleName) {
  if (!rootLogger || typeof rootLogger.child !== 'function') {
    throw new Error('moduleLogger: rootLogger must be a pino logger');
  }
  return rootLogger.child({ module: moduleName });
}

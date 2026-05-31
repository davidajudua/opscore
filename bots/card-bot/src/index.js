import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBotLogger,
  loadEnv,
  openDb,
  runMigrations,
  DiscordBot,
  GatewayIntentBits,
} from '@platform/bot-core';
import { envSchema } from './env-schema.js';
import { expireOldSessions } from './inventory.js';
import {
  cardCmd,
  cardHandler,
  cardActionHandler,
  whitelistCmd,
  whitelistHandler,
  whitelistButtonHandler,
  providersCmd,
  providersHandler,
  providersButtonHandler,
  providersCreateModalHandler,
  providersEditModalHandler,
  providersEraseModalHandler,
  providersDeleteModalHandler,
  statsCmd,
  statsHandler,
  statsButtonHandler,
  setPriceCmd,
  setPriceHandler,
  scheduleWeeklyStatsReset,
  loadCmd,
  loadHandler,
  loadExportAutocompleteHandler,
  exportCmd,
  exportHandler,
  purgeCmd,
  purgeHandler,
  purgeButtonHandler,
} from './commands.js';

const BOT_NAME = 'card-bot';
const BOT_PREFIX = 'cardbot';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const botRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(botRoot, '..', '..');

async function main() {
  const env = loadEnv({ botRoot, repoRoot, schema: envSchema });

  const logger = createBotLogger({
    botName: BOT_NAME,
    logDir: path.join(repoRoot, 'logs', BOT_NAME),
    level: env.LOG_LEVEL,
  });

  const db = openDb({ dbPath: path.join(botRoot, 'data', 'card.db'), logger });
  runMigrations({ db, migrationsDir: path.join(botRoot, 'migrations'), logger });

  const bot = new DiscordBot({
    token: env.DISCORD_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    guildId: env.DISCORD_GUILD_ID,
    botPrefix: BOT_PREFIX,
    intents: [GatewayIntentBits.Guilds],
    logger: logger.child({ module: 'discord' }),
  });

  const ctx = { db, env, logger, bot, repoRoot };

  bot
    .command(cardCmd, cardHandler(ctx))
    .command(whitelistCmd, whitelistHandler(ctx))
    .command(providersCmd, providersHandler(ctx))
    .command(statsCmd, statsHandler(ctx))
    .command(setPriceCmd, setPriceHandler(ctx))
    .command(loadCmd, loadHandler(ctx))
    .command(exportCmd, exportHandler(ctx))
    .command(purgeCmd, purgeHandler(ctx));

  bot.autocomplete('load', loadExportAutocompleteHandler(ctx));
  bot.autocomplete('export', loadExportAutocompleteHandler(ctx));
  bot.button('wl', whitelistButtonHandler(ctx));
  bot.button('cardact', cardActionHandler(ctx));
  bot.button('prov', providersButtonHandler(ctx));
  bot.button('purge', purgeButtonHandler(ctx));
  bot.button('stats', statsButtonHandler(ctx));

  scheduleWeeklyStatsReset(db, logger);
  bot.modal('prov-create', providersCreateModalHandler(ctx));
  bot.modal('prov-edit', providersEditModalHandler(ctx));
  bot.modal('prov-erase', providersEraseModalHandler(ctx));
  bot.modal('prov-delete', providersDeleteModalHandler(ctx));

  await bot.start();
  logger.info({ botName: BOT_NAME }, 'card-bot started');

  // Card-session reaper — users often claim a card and forget to click
  // Used/Return, leaving the session row around. Every 6 hours we delete
  // sessions older than 48h so the table stays tidy. Cards are NOT returned to
  // the pool (the overwhelming majority of stale sessions = card used, just not
  // clicked).
  const SESSION_REAP_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours
  const SESSION_MAX_AGE_MS = 48 * 60 * 60_000;      // 48 hours
  const reaperTimer = setInterval(() => {
    try {
      const removed = expireOldSessions(db, SESSION_MAX_AGE_MS);
      if (removed > 0) logger.info({ removed }, 'card_sessions reaper');
    } catch (err) {
      logger.error({ err: err.message }, 'card_sessions reaper failed');
    }
  }, SESSION_REAP_INTERVAL_MS);

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(reaperTimer);
    await bot.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});

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
import { activeProviders } from './providers.js';
import { PaymentMonitor } from './monitor.js';
import { recordPayment } from './ledger.js';
import { paymentEmbed } from './embeds.js';
import {
  refreshDashboards,
  dashboardCommand,
  dashboardHandler,
  dashboardButtonHandler,
  cashoutCommand,
  cashoutHandler,
  minusCommand,
  minusHandler,
  cryptoCommand,
  cryptoHandler,
  cryptoModalHandler,
  refundCommand,
  refundHandler,
  refundModalHandler,
  refundButtonHandler,
  purgeCommand,
  purgeHandler,
  purgeButtonHandler,
} from './commands.js';

const BOT_NAME = 'payment-bot';
const BOT_PREFIX = 'paybot';

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

  const providers = activeProviders(env);
  if (providers.length === 0) {
    logger.warn(
      'No IMAP providers configured. Bot will run in crypto/manual-only mode (set GMAIL_ADDRESS_<provider> + GMAIL_APP_PASSWORD_<provider> to enable Zelle/Venmo/PayPal monitoring).',
    );
  } else {
    logger.info({ providers: providers.map((p) => p.id) }, 'active payment providers');
  }

  const db = openDb({ dbPath: path.join(botRoot, 'data', 'payments.db'), logger });
  await runMigrations({ db, migrationsDir: path.join(botRoot, 'migrations'), logger });

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
    .command(dashboardCommand, dashboardHandler(ctx))
    .command(cashoutCommand, cashoutHandler(ctx))
    .command(minusCommand, minusHandler(ctx))
    .command(cryptoCommand, cryptoHandler(ctx))
    .command(refundCommand, refundHandler(ctx))
    .command(purgeCommand, purgeHandler(ctx));

  bot.button('purge', purgeButtonHandler(ctx));
  bot.button('dash', dashboardButtonHandler(ctx));
  bot.button('refund', refundButtonHandler(ctx));
  bot.modal('crypto-track', cryptoModalHandler(ctx));
  bot.modal('refund-modal', refundModalHandler(ctx));

  await bot.start();
  logger.info({ botName: BOT_NAME }, 'payment-bot started');

  // Spin up a per-provider monitor; on payment events, dedupe via UID and post an embed.
  const monitors = providers.map((provider) => {
    const m = new PaymentMonitor({
      provider,
      env,
      db,
      logger: logger.child({ module: `monitor:${provider.id}` }),
    });
    m.addEventListener('payment', async (ev) => {
      const { provider: p, uid, amount, name, receivedAt } = ev.detail;
      // Name-only notifications (e.g. US Bank Zelle) carry no amount — there's
      // nothing to book. Skip rather than let recordPayment throw on a null amount.
      if (!Number.isFinite(amount) || amount <= 0) {
        logger.debug({ provider: p.id, uid, amount }, 'payment event without a positive amount; skipping ledger');
        return;
      }
      let result;
      try {
        result = recordPayment(db, {
          method: p.id,
          amount,
          name,
          externalId: String(uid),
          receivedAt,
        });
      } catch (err) {
        // A DB error (locked file, constraint) must not become an unhandled
        // rejection that could halt this provider's monitor.
        logger.error({ err: err.message, provider: p.id, uid }, 'recordPayment failed');
        return;
      }
      if (!result.inserted) {
        logger.debug({ provider: p.id, uid }, 'duplicate payment uid; skipping post');
        return;
      }
      try {
        const channel = await bot.client.channels.fetch(env.DISCORD_PAYMENT_CHANNEL_ID);
        await channel.send({ embeds: [paymentEmbed({ provider: p, amount, name, receivedAt })] });
      } catch (err) {
        logger.error({ err: err.message }, 'failed to post payment embed');
      }
      // Live-refresh every saved /dashboard message so workers see the new total
      // without having to re-run the command.
      refreshDashboards({ db, bot, repoRoot, logger }).catch((err) =>
        logger.warn({ err: err.message }, 'dashboard refresh failed'),
      );
    });
    m.start();
    return m;
  });

  // Day-rollover watcher: every minute, check if the EST calendar day flipped.
  // On flip, refresh saved dashboards so "Today" resets and Week/Month may roll.
  const estYmd = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  let lastYmd = estYmd();
  const rolloverTimer = setInterval(() => {
    const cur = estYmd();
    if (cur !== lastYmd) {
      lastYmd = cur;
      logger.info({ date: cur }, 'day rollover, refreshing dashboards');
      refreshDashboards({ db, bot, repoRoot, logger }).catch((err) =>
        logger.warn({ err: err.message }, 'dashboard refresh failed'),
      );
    }
  }, 60_000);

  // Catch-up: if payments arrived while the bot was down, the IMAP monitor will
  // record them on first poll. A delayed refresh ensures the dashboard reflects
  // those before any user interacts. Handle is stored so shutdown can cancel it —
  // otherwise a quick restart fires this against a closed DB / stopped client.
  const catchupTimer = setTimeout(() => {
    refreshDashboards({ db, bot, repoRoot, logger }).catch((err) =>
      logger.warn({ err: err.message }, 'dashboard refresh failed'),
    );
  }, 30_000);

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(rolloverTimer);
    clearTimeout(catchupTimer);
    for (const m of monitors) await m.stop().catch(() => {});
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

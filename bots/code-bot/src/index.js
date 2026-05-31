import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBotLogger,
  loadEnv,
  openDb,
  runMigrations,
  WorkerQueue,
  DiscordBot,
  GatewayIntentBits,
} from '@platform/bot-core';
import { envSchema } from './env-schema.js';
import { SafekeyFetcher, TIMING } from './imap-fetcher.js';
import { WebhookSafekeyFetcher } from './webhook-fetcher.js';
import { EnoFetcher } from './eno-fetcher.js';
import { deployCommandDefinition, deployCommandHandler } from './handlers/deploy-cmd.js';
import { requestButtonHandler } from './handlers/request.js';
import { enoModalHandler } from './handlers/eno-modal.js';
import { getCodeButtonHandler } from './handlers/get-code.js';
import {
  cancelButtonHandler,
  retryButtonHandler,
  doneButtonHandler,
} from './handlers/cancel-retry-done.js';
import { releaseButtonHandler } from './handlers/release.js';
import {
  postSession,
  deleteSession,
  buildPlainView,
  buildFetchingView,
  buildCodeView,
  buildAutoTimeoutView,
} from './session.js';
import { refreshDeployMessage, getDeployRecord, PROVIDERS } from './deploy.js';

const BOT_NAME = 'code-bot';
const BOT_PREFIX = 'codebot';

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

  const db = openDb({ dbPath: path.join(botRoot, 'data', 'queue.db'), logger });
  runMigrations({ db, migrationsDir: path.join(botRoot, 'migrations'), logger });

  // One queue per provider. WorkerQueue creates its backing table
  // (queue_codebot_<provider>) on demand — no migration needed.
  const queues = {};
  for (const provider of PROVIDERS) {
    queues[provider] = new WorkerQueue({
      db,
      name: `codebot_${provider}`,
      logger: logger.child({ module: `queue:${provider}` }),
      idleTimeoutMs: TIMING.idleTimeoutMs,
    });
  }

  const bot = new DiscordBot({
    token: env.DISCORD_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    guildId: env.DISCORD_GUILD_ID,
    botPrefix: BOT_PREFIX,
    // MessageContent is privileged — also requires enabling in the Dev Portal.
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    logger: logger.child({ module: 'discord' }),
  });

  // Per-provider fetcher arrays. Amex races IMAP + webhook (if configured);
  // Eno is IMAP-only (no Capital One SMS forwarder today).
  const imapFetcher = new SafekeyFetcher({ env, db, logger: logger.child({ module: 'safekey' }) });
  const webhookFetcher = new WebhookSafekeyFetcher({
    env,
    db,
    bot,
    logger: logger.child({ module: 'safekey-webhook' }),
  });
  const enoFetcher = new EnoFetcher({ env, db, logger: logger.child({ module: 'eno' }) });

  if (webhookFetcher.isConfigured()) {
    logger.info(
      { channelId: env.WEBHOOK_CODE_CHANNEL_ID, authorId: env.WEBHOOK_CODE_AUTHOR_ID },
      'webhook safekey fetcher enabled',
    );
  }

  const fetchersByProvider = {
    amex: webhookFetcher.isConfigured() ? [imapFetcher, webhookFetcher] : [imapFetcher],
    eno: [enoFetcher],
  };
  const allFetchers = [imapFetcher, webhookFetcher, enoFetcher];

  const ctx = { db, bot, queues, fetchersByProvider, env, logger };

  bot.command(deployCommandDefinition, deployCommandHandler(ctx));
  // All button handlers receive the provider in args[0] (encoded in customId
  // by the deploy panel). They look up the right queue / fetchers themselves.
  bot.button('request', requestButtonHandler(ctx));
  bot.button('get', getCodeButtonHandler(ctx));
  bot.button('cancel', cancelButtonHandler(ctx));
  bot.button('retry', retryButtonHandler(ctx));
  bot.button('done', doneButtonHandler(ctx));
  bot.button('release', releaseButtonHandler(ctx));
  bot.modal('eno-req', enoModalHandler(ctx));

  // Per-queue event wiring. Each queue's session messages go to the channel
  // where THAT provider's /deploy was run (looked up from deploy_message).
  for (const provider of PROVIDERS) {
    const queue = queues[provider];

    queue.on('activate', async ({ entry }) => {
      const rec = getDeployRecord(db, provider);
      if (!rec) return; // no deploy for this provider yet

      if (provider === 'eno') {
        // Eno: auto-fire — no "It's your turn" panel, no Get Code button.
        // The hint was captured at modal submit; just post "Fetching..." and run.
        await autoFireEno({
          bot,
          db,
          queue,
          channelId: rec.channel_id,
          entry,
          fetcher: fetchersByProvider.eno?.[0],
          logger,
        });
        return;
      }

      // Amex: original flow — post the "It's your turn" panel with Get Code button.
      try {
        await postSession({
          client: bot.client,
          bot,
          channelId: rec.channel_id,
          queue,
          provider,
          entry,
        });
        await refreshDeployMessage({ client: bot.client, db, bot, queue, provider, logger });
      } catch (err) {
        logger.error({ err: err.message, provider, userId: entry.user_id }, 'failed to post session embed');
      }
    });

    queue.on('idle', async ({ entry }) => {
      const rec = getDeployRecord(db, provider);
      if (rec && entry.session_message_id) {
        try {
          const channel = await bot.client.channels.fetch(rec.channel_id);
          if (channel?.isTextBased()) {
            try {
              const msg = await channel.messages.fetch(entry.session_message_id);
              await msg.edit(buildPlainView(`💤 Skipped <@${entry.user_id}>`));
            } catch {
              // already gone — nothing to do
            }
          }
        } catch (err) {
          logger.warn({ err: err.message, provider }, 'idle UI update failed');
        }
      }
      // 'idle' fires from inside WorkerQueue's setTimeout — refresh panel here.
      await refreshDeployMessage({ client: bot.client, db, bot, queue, provider, logger }).catch(
        () => {},
      );
    });

    queue.on('remove', async ({ entry }) => {
      const rec = getDeployRecord(db, provider);
      if (!rec) return;
      try {
        await deleteSession({
          client: bot.client,
          channelId: rec.channel_id,
          entry,
        });
      } catch {
        // best-effort
      }
    });
  }

  await bot.start();
  logger.info({ botName: BOT_NAME }, 'code-bot started');

  // Refresh persistent dashboards (one per provider) so they reflect current state.
  for (const provider of PROVIDERS) {
    await refreshDeployMessage({
      client: bot.client,
      db,
      bot,
      queue: queues[provider],
      provider,
      logger,
    }).catch(() => {});
  }

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    for (const q of Object.values(queues)) q.shutdown();
    await Promise.all(allFetchers.map((f) => f.close?.().catch(() => {})));
    await bot.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Eno auto-fire: when a worker reaches the head of the Eno queue, skip the
 * "It's your turn" panel + Get Code button and fire the fetcher immediately.
 * The hint was captured at Request Code time and stored on entry.match_code.
 *
 * Posts "Fetching..." then edits with code or timeout. Removes worker from
 * queue on completion (auto-advance — no Done button to click).
 */
async function autoFireEno({ bot, db, queue, channelId, entry, fetcher, logger }) {
  if (!fetcher) {
    logger.warn({ userId: entry.user_id }, 'eno auto-fire: no fetcher configured');
    queue.remove(entry.user_id);
    return;
  }

  let msg;
  try {
    const channel = await bot.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error('deploy channel is not text-based');
    msg = await channel.send(buildFetchingView());
    queue.setSessionMessageId(entry.user_id, msg.id);
    queue.setFetching(entry.user_id);
  } catch (err) {
    logger.error({ err: err.message, userId: entry.user_id }, 'eno auto-fire: failed to post fetching view');
    queue.remove(entry.user_id);
    return;
  }

  const clickTime = Date.now();
  const hint = entry.match_code ?? null;
  logger.info({ provider: 'eno', userId: entry.user_id, hint }, 'eno auto-fire started');

  let result = null;
  try {
    result = await fetcher.fetchUntilDeadline({ clickTime, hint });
  } catch (err) {
    logger.error({ err: err.message, provider: 'eno' }, 'eno fetcher threw');
  }

  // If the entry was removed (e.g. by Release) while we were polling, bail.
  const stillThere = queue.getByUserId(entry.user_id);
  if (!stillThere) return;

  try {
    if (result) {
      await msg.edit(buildCodeView({ code: result.code, bot, userId: entry.user_id, provider: 'eno' }));
      logger.info({ provider: 'eno', uid: result.uid, userId: entry.user_id }, 'code delivered');
      // Auto-advance after 10s so the next worker's auto-fire can begin.
      setTimeout(async () => {
        const e = queue.getByUserId(entry.user_id);
        if (e) queue.remove(entry.user_id);
        await refreshDeployMessage({
          client: bot.client, db, bot, queue, provider: 'eno', logger,
        }).catch(() => {});
      }, 10_000);
    } else {
      await msg.edit(buildAutoTimeoutView({ userId: entry.user_id, provider: 'eno' }));
      logger.warn({ provider: 'eno', userId: entry.user_id, hint }, 'eno auto-fire timed out');
      // Timeout → remove immediately so next worker can try.
      queue.remove(entry.user_id);
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'eno auto-fire: final edit failed');
    queue.remove(entry.user_id);
  }

  await refreshDeployMessage({ client: bot.client, db, bot, queue, provider: 'eno', logger }).catch(
    () => {},
  );
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});

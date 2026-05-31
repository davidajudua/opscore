import { ephemeralError } from '@platform/bot-core/discord';
import {
  buildFetchingView,
  buildCodeView,
  buildTimeoutView,
  buildPlainView,
} from '../session.js';
import { refreshDeployMessage } from '../deploy.js';

const AUTO_ADVANCE_MS = 10_000;

/**
 * Handler for "Get Code" — custom_id: codebot:get:<provider>.
 * Routes to the provider's queue and fetcher set. Only the active worker can
 * click; everyone else gets a polite refusal. Eno fetchers get the worker's
 * match_code (Google Pay 3-char hint) passed in.
 */
export function getCodeButtonHandler({ db, bot, queues, fetchersByProvider, logger }) {
  return async function handle(interaction, args) {
    const provider = args[0];
    const queue = queues[provider];
    const fetcherList = fetchersByProvider[provider] ?? [];
    if (!queue || fetcherList.length === 0) {
      await ephemeralError(interaction, 'Code source not configured.');
      return;
    }

    const active = queue.getActive();
    if (!active || active.user_id !== interaction.user.id) {
      await ephemeralError(interaction, 'It\'s not your turn yet.');
      return;
    }
    if (active.status === 'fetching') {
      await ephemeralError(interaction, 'Already fetching, hang tight.');
      return;
    }

    queue.setFetching(active.user_id);
    await interaction.update(buildFetchingView());

    if (logger) {
      logger.info(
        { provider, userId: active.user_id, fetchers: fetcherList.length, hint: active.match_code ?? null },
        'get code started',
      );
    }

    const clickTime = Date.now();
    const hint = active.match_code ?? null;
    let result = null;
    try {
      result = await raceFetchers(fetcherList, { clickTime, hint, logger });
    } catch (err) {
      if (logger) logger.error({ err: err.message, provider }, 'fetchers threw unexpectedly');
    }

    const stillActive = queue.getByUserId(active.user_id);
    if (!stillActive || stillActive.status !== 'fetching') {
      if (logger) logger.warn({ provider, userId: active.user_id }, 'fetch finished but user no longer active');
      return;
    }

    if (result) {
      if (logger) logger.info({ provider, uid: result.uid }, 'code delivered');
      await interaction.editReply(
        buildCodeView({ code: result.code, bot, userId: active.user_id, provider }),
      );
      scheduleAutoAdvance({
        interaction,
        queue,
        userId: active.user_id,
        db,
        bot,
        provider,
        logger,
        isStuck: (entry) => entry.status === 'fetching',
        logMsg: 'session auto-advanced after 10s (code state)',
      });
    } else {
      if (logger) logger.warn({ provider, userId: active.user_id }, 'fetch timed out');
      queue.revertToActive(active.user_id);
      await interaction.editReply(buildTimeoutView(bot, { mention: active.user_id, provider }));
      scheduleAutoAdvance({
        interaction,
        queue,
        userId: active.user_id,
        db,
        bot,
        provider,
        logger,
        isStuck: (entry) => entry.status === 'active',
        logMsg: 'session auto-advanced after 10s (timeout state)',
      });
    }

    await refreshDeployMessage({ client: interaction.client, db, bot, queue, provider, logger });
  };
}

/**
 * Race multiple fetchers — first to return a non-null code wins, others
 * are AbortController-cancelled. `hint` (for Eno's 3-char Google Pay code)
 * is forwarded to every fetcher; fetchers that don't need it ignore the arg.
 */
async function raceFetchers(fetcherList, { clickTime, hint, logger }) {
  if (fetcherList.length === 0) return null;
  if (fetcherList.length === 1) {
    return fetcherList[0].fetchUntilDeadline({ clickTime, hint });
  }
  return new Promise((resolve) => {
    const controllers = fetcherList.map(() => new AbortController());
    let resolved = false;
    let pending = fetcherList.length;
    fetcherList.forEach((f, i) => {
      const tag = f.constructor?.name ?? `fetcher${i}`;
      f.fetchUntilDeadline({ clickTime, hint, signal: controllers[i].signal })
        .then((hit) => {
          if (resolved) return;
          if (hit) {
            resolved = true;
            controllers.forEach((c, j) => j !== i && c.abort());
            logger?.info({ source: tag, uid: hit.uid }, 'race: code source won');
            resolve(hit);
            return;
          }
          if (--pending === 0) {
            resolved = true;
            resolve(null);
          }
        })
        .catch((err) => {
          if (resolved) return;
          logger?.warn({ source: tag, err: err?.message }, 'race: fetcher rejected');
          if (--pending === 0) {
            resolved = true;
            resolve(null);
          }
        });
    });
  });
}

/**
 * After 10s, if the worker hasn't acted, drop them from the queue and promote
 * the next worker. Idempotent — timer no-ops if status already moved on.
 */
export function scheduleAutoAdvance({
  interaction,
  queue,
  userId,
  db,
  bot,
  provider,
  logger,
  isStuck,
  logMsg,
}) {
  setTimeout(async () => {
    const entry = queue.getByUserId(userId);
    if (!entry || !isStuck(entry)) return;
    queue.remove(userId);
    try {
      await interaction.editReply(buildPlainView(`💤 Skipped <@${userId}>`));
    } catch {
      // interaction token may have expired; ignore
    }
    if (logger) logger.info({ provider, userId }, logMsg);
    await refreshDeployMessage({ client: interaction.client, db, bot, queue, provider, logger }).catch(
      () => {},
    );
  }, AUTO_ADVANCE_MS);
}

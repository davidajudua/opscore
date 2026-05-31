import { ephemeralError } from '@platform/bot-core/discord';
import {
  buildFetchingView,
  buildCodeView,
  buildTimeoutView,
  buildPlainView,
  deleteSession,
} from '../session.js';
import { refreshDeployMessage, getDeployRecord } from '../deploy.js';
import { scheduleAutoAdvance } from './get-code.js';

/**
 * "Cancel" button — custom_id: codebot:cancel:<provider>.
 * Anyone in the queue can leave. If they're the active worker, the next
 * worker is auto-promoted by the queue.
 */
export function cancelButtonHandler({ db, bot, queues, logger }) {
  return async function handle(interaction, args) {
    const provider = args[0];
    const queue = queues[provider];
    if (!queue) {
      await ephemeralError(interaction, 'Unknown provider.');
      return;
    }

    const entry = queue.getByUserId(interaction.user.id);
    if (!entry) {
      await ephemeralError(interaction, 'You\'re not in the queue.');
      return;
    }

    queue.remove(interaction.user.id);
    const rec = getDeployRecord(db, provider);
    if (rec) {
      await deleteSession({ client: interaction.client, channelId: rec.channel_id, entry });
    }

    try {
      await interaction.update(buildPlainView('❌ Cancelled.'));
    } catch {
      // The original message may have been deleted by deleteSession; ignore.
    }

    if (logger) logger.info({ provider, userId: interaction.user.id }, 'queue cancel');
    await refreshDeployMessage({ client: interaction.client, db, bot, queue, provider, logger });
  };
}

/**
 * "Try Again" button — custom_id: codebot:retry:<provider>.
 * Re-runs the fetch race for the active worker after a timeout.
 */
export function retryButtonHandler({ db, bot, queues, fetchersByProvider, logger }) {
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
      await ephemeralError(interaction, 'It\'s not your turn.');
      return;
    }

    queue.setFetching(active.user_id);
    await interaction.update(buildFetchingView());

    if (logger) logger.info({ provider, userId: active.user_id }, 'retry started');

    const clickTime = Date.now();
    const hint = active.match_code ?? null;
    let result = null;
    try {
      // Simple single-fetcher path replaced with the race; we don't import the
      // helper because the handler is short and inlining is clearer.
      if (fetcherList.length === 1) {
        result = await fetcherList[0].fetchUntilDeadline({ clickTime, hint });
      } else {
        result = await new Promise((resolve) => {
          const controllers = fetcherList.map(() => new AbortController());
          let resolved = false;
          let pending = fetcherList.length;
          fetcherList.forEach((f, i) => {
            f.fetchUntilDeadline({ clickTime, hint, signal: controllers[i].signal })
              .then((hit) => {
                if (resolved) return;
                if (hit) {
                  resolved = true;
                  controllers.forEach((c, j) => j !== i && c.abort());
                  resolve(hit);
                } else if (--pending === 0) {
                  resolved = true;
                  resolve(null);
                }
              })
              .catch(() => {
                if (resolved) return;
                if (--pending === 0) {
                  resolved = true;
                  resolve(null);
                }
              });
          });
        });
      }
    } catch (err) {
      if (logger) logger.error({ err: err.message, provider }, 'retry fetcher threw');
    }

    const stillActive = queue.getByUserId(active.user_id);
    if (!stillActive || stillActive.status !== 'fetching') return;

    if (result) {
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
        logMsg: 'session auto-advanced after 10s (code state, retry)',
      });
    } else {
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
        logMsg: 'session auto-advanced after 10s (timeout state, retry)',
      });
    }
    await refreshDeployMessage({ client: interaction.client, db, bot, queue, provider, logger });
  };
}

/**
 * "Done" button — custom_id: codebot:done:<provider>:<userId>.
 * Only the recipient can click. Removes them from the provider's queue.
 */
export function doneButtonHandler({ db, bot, queues, logger }) {
  return async function handle(interaction, args) {
    const [provider, ownerId] = args;
    const queue = queues[provider];
    if (!queue) {
      await ephemeralError(interaction, 'Unknown provider.');
      return;
    }
    if (interaction.user.id !== ownerId) {
      await ephemeralError(interaction, 'Only the code recipient can click Done.');
      return;
    }
    const entry = queue.getByUserId(ownerId);
    if (entry) queue.remove(ownerId);

    try {
      await interaction.update(buildPlainView('✅ Done.'));
    } catch {
      // ignore
    }

    if (logger) logger.info({ provider, userId: ownerId }, 'session done');
    await refreshDeployMessage({ client: interaction.client, db, bot, queue, provider, logger });
  };
}

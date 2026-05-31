import {
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from 'discord.js';
import { refreshDeployMessage } from '../deploy.js';

/**
 * Handler for the "Request Code" button (custom_id: codebot:request:<provider>).
 * Behaviour depends on provider:
 *   - amex: directly add the user to the Amex queue (Safekey codes need no hint)
 *   - eno : open a modal asking for the 3-char Google Pay hint, then queue
 *
 * The dashboard refresh + (for first-in-line) the session embed handle visible
 * feedback for the amex path. The eno modal handler does both after submission.
 */
export function requestButtonHandler({ db, bot, queues, logger }) {
  return async function handle(interaction, args) {
    const provider = args[0];
    const queue = queues[provider];
    if (!queue) {
      // Unknown provider — stale button from before the refactor, probably. Ack and bail.
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    const existing = queue.getByUserId(interaction.user.id);
    if (existing) {
      // Already queued for this provider — nothing to do.
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (provider === 'eno') {
      // Eno needs a 3-char hint from the worker's Google Pay flow; can't add
      // them to the queue until we have it. Show modal; queue add happens on
      // modal submit.
      const modal = new ModalBuilder()
        .setCustomId(bot.customId('eno-req'))
        .setTitle('Request Eno Code')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('hint')
              .setLabel('Google Pay Code')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMinLength(3)
              .setMaxLength(3),
          ),
        );
      await interaction.showModal(modal);
      return;
    }

    // amex path: queue immediately.
    await interaction.deferUpdate();
    queue.add({
      userId: interaction.user.id,
      username: interaction.user.username,
    });
    if (logger) {
      logger.info(
        { provider, userId: interaction.user.id, pos: queue.positionOf(interaction.user.id) },
        'queue add',
      );
    }
    await refreshDeployMessage({ client: interaction.client, db, bot, queue, provider, logger });
    // Silence unused-var lint for MessageFlags import (kept for future ephemeral replies).
    void MessageFlags;
  };
}

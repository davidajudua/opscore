import { MessageFlags } from 'discord.js';
import { ephemeralError } from '@platform/bot-core/discord';
import { refreshDeployMessage } from '../deploy.js';

/**
 * Eno Request Code modal submission. Validates the 3-char hint and adds the
 * worker to the Eno queue with the hint stored on match_code.
 *
 * Flow mirrors Amex exactly — worker waits their turn, gets the "It's your
 * turn" panel, clicks Get Code, fetcher uses match_code as the hint. Only
 * difference vs Amex's Request Code button is the modal step here.
 */
export function enoModalHandler({ db, bot, queues, logger }) {
  return async function handle(interaction) {
    const queue = queues.eno;
    const raw = interaction.fields.getTextInputValue('hint').trim().toUpperCase();
    if (!/^[A-Z0-9]{3}$/.test(raw)) {
      await ephemeralError(interaction, 'Code must be exactly 3 characters (letters or digits).');
      return;
    }

    const existing = queue.getByUserId(interaction.user.id);
    if (existing) {
      await ephemeralError(interaction, 'You\'re already in the Eno queue.');
      return;
    }

    queue.add({
      userId: interaction.user.id,
      username: interaction.user.username,
      matchCode: raw,
    });
    if (logger) {
      logger.info(
        {
          provider: 'eno',
          userId: interaction.user.id,
          hint: raw,
          pos: queue.positionOf(interaction.user.id),
        },
        'queue add',
      );
    }

    await interaction.deferUpdate().catch(() => {});
    await refreshDeployMessage({ client: interaction.client, db, bot, queue, provider: 'eno', logger });
    void MessageFlags;
  };
}

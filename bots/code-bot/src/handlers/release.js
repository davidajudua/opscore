import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { ephemeralError } from '@platform/bot-core/discord';
import { buildPlainView } from '../session.js';
import { refreshDeployMessage, getDeployRecord } from '../deploy.js';

/**
 * "Release" button — custom_id: codebot:release:<provider>.
 * Admin-only nuke for the provider's queue. Clears every entry, rewrites
 * their session messages to "Skipped @user", refreshes the dashboard.
 *
 * Pending entries are removed first so removing the active one doesn't trigger
 * a cascade of 'activate' → postSession → immediately-removed promotions.
 */
export function releaseButtonHandler({ db, bot, queues, logger }) {
  return async function handle(interaction, args) {
    const provider = args[0];
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await ephemeralError(interaction, 'Admin only.');
      return;
    }
    const queue = queues[provider];
    if (!queue) {
      await ephemeralError(interaction, 'Unknown provider.');
      return;
    }

    const entries = queue.list();
    if (!entries.length) {
      await interaction.reply({
        content: 'Queue is already empty.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const active = entries.find(
      (e) => e.status === 'active' || e.status === 'fetching',
    );
    const pending = entries.filter((e) => e !== active);

    for (const e of pending) queue.remove(e.user_id);
    if (active) queue.remove(active.user_id);

    // Overwrite each user's session message in the provider's deploy channel.
    const rec = getDeployRecord(db, provider);
    if (rec) {
      const channel = await interaction.client.channels
        .fetch(rec.channel_id)
        .catch(() => null);
      if (channel?.isTextBased()) {
        for (const e of entries) {
          if (!e.session_message_id) continue;
          try {
            const msg = await channel.messages.fetch(e.session_message_id);
            await msg.edit(buildPlainView(`💤 Skipped <@${e.user_id}>`));
          } catch {
            // message already deleted or unreachable
          }
        }
      }
    }

    await refreshDeployMessage({ client: interaction.client, db, bot, queue, provider, logger });

    if (logger) {
      logger.info(
        { provider, admin: interaction.user.id, cleared: entries.length },
        'queue released',
      );
    }

    await interaction.editReply({
      content: `🧹 Released ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from the ${provider} queue.`,
    });
  };
}

import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  deployMessagePayload,
  getDeployRecord,
  setDeployRecord,
  clearDeployRecord,
  PROVIDERS,
} from '../deploy.js';

export const deployCommandDefinition = new SlashCommandBuilder()
  .setName('deploy')
  .setDescription('Post a code dashboard for a provider')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((o) =>
    o
      .setName('provider')
      .setDescription('Which code provider this dashboard handles')
      .setRequired(true)
      .addChoices(...PROVIDERS.map((p) => ({ name: p, value: p }))),
  );

/**
 * Handler for /deploy <provider>. Posts the dashboard for the chosen provider
 * in whichever channel the command was invoked from. If a deploy for that
 * provider already exists somewhere, replace it (delete old, post new).
 * Different providers can coexist in different channels.
 */
export function deployCommandHandler({ db, bot, queues, logger }) {
  return async function handle(interaction) {
    const provider = interaction.options.getString('provider', true);
    const queue = queues[provider];
    if (!queue) {
      await interaction.reply({
        content: `Unknown provider \`${provider}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Silent ack: send zero-width ephemeral and delete. No "Bot is thinking..."
    await interaction.reply({ content: '​', flags: MessageFlags.Ephemeral });
    try {
      await interaction.deleteReply();
    } catch {
      // ignore — best-effort
    }

    const existing = getDeployRecord(db, provider);
    if (existing) {
      try {
        const channel = await interaction.client.channels.fetch(existing.channel_id);
        const oldMsg = await channel.messages.fetch(existing.message_id);
        await oldMsg.delete();
      } catch {
        // already gone — ignore
      }
      clearDeployRecord(db, provider);
    }

    const channel = await interaction.client.channels.fetch(interaction.channelId);
    const msg = await channel.send(deployMessagePayload({ queue, bot, provider }));
    setDeployRecord(db, provider, channel.id, msg.id);

    if (logger) {
      logger.info(
        { provider, messageId: msg.id, channelId: channel.id },
        '/deploy posted',
      );
    }
  };
}

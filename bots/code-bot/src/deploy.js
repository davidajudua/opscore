import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} from 'discord.js';

// Provider catalog. Adding a new code provider (e.g. Discover) means adding an
// entry here, an EnoFetcher-shaped class, and wiring it in index.js.
export const PROVIDERS = ['amex', 'eno'];

const PROVIDER_META = {
  amex: { title: 'Safekey', emoji: '' },
  eno:  { title: 'Eno',     emoji: '' },
};

export function providerTitle(provider) {
  return PROVIDER_META[provider]?.title ?? provider;
}

/**
 * Build the deploy dashboard for a given provider. Provider determines the
 * layout — Amex has a queue + Release button, Eno is queue-less (each request
 * runs in parallel via the modal flow, no serialization needed).
 */
function buildDeployContainer({ queue, bot, provider }) {
  const meta = PROVIDER_META[provider] ?? { title: provider, emoji: '' };
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${meta.emoji} ${meta.title}`.trim()),
  );

  // All providers share the same Amex-style layout: queue display + Request +
  // Release. Eno's only difference is the modal that opens on Request Code
  // (handled by request.js, not visible here).
  const entries = queue.list();
  const queueText = entries.length
    ? entries.map((e) => `<@${e.user_id}>`).join(', ')
    : 'empty';
  return container
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Queue:** ${queueText}`))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(bot.customId('request', provider))
          .setLabel('Request Code')
          .setStyle(ButtonStyle.Success)
          .setEmoji('📨'),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(bot.customId('release', provider))
          .setLabel('Release')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🧹'),
      ),
    );
}

export function deployMessagePayload({ queue, bot, provider }) {
  return {
    components: [buildDeployContainer({ queue, bot, provider })],
    flags: MessageFlags.IsComponentsV2,
  };
}

// One deploy_message row per provider (PRIMARY KEY). Re-deploying for the same
// provider overwrites the pointer (old message in Discord becomes orphaned).

export function getDeployRecord(db, provider) {
  return db.get(
    `SELECT provider, channel_id, message_id, updated_at FROM deploy_message WHERE provider = ?`,
    provider,
  );
}

export function listDeployRecords(db) {
  return db.all(`SELECT provider, channel_id, message_id, updated_at FROM deploy_message`);
}

export function setDeployRecord(db, provider, channelId, messageId) {
  db.run(
    `INSERT INTO deploy_message (provider, channel_id, message_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       channel_id = excluded.channel_id,
       message_id = excluded.message_id,
       updated_at = excluded.updated_at`,
    provider,
    channelId,
    messageId,
    Date.now(),
  );
}

export function clearDeployRecord(db, provider) {
  db.run(`DELETE FROM deploy_message WHERE provider = ?`, provider);
}

/**
 * Refresh the persistent deploy message for a given provider. If the stored
 * message is missing (deleted from Discord), the record is cleared so the next
 * /deploy posts fresh. Callers route by which queue changed.
 */
export async function refreshDeployMessage({ client, db, bot, queue, provider, logger }) {
  const rec = getDeployRecord(db, provider);
  if (!rec) return null;

  try {
    const channel = await client.channels.fetch(rec.channel_id);
    if (!channel?.isTextBased()) {
      clearDeployRecord(db, provider);
      return null;
    }
    const msg = await channel.messages.fetch(rec.message_id);
    await msg.edit(deployMessagePayload({ queue, bot, provider }));
    return msg;
  } catch (err) {
    if (logger) logger.warn({ provider, err: err.message }, 'deploy refresh failed; clearing record');
    clearDeployRecord(db, provider);
    return null;
  }
}

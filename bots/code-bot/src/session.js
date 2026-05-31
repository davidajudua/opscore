import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} from 'discord.js';

// Accent colors used by V2 ContainerBuilder.setAccentColor — semantic per state.
const COLOR_ACTIVE = 0xfee75c;
const COLOR_FETCHING = 0xfee75c;
const COLOR_CODE = 0x57f287;
const COLOR_TIMEOUT = 0xed4245;
// Skipped: no accent (transparent sidebar)

const v2 = (container) => ({
  components: [container],
  flags: MessageFlags.IsComponentsV2,
});

/** "It's your turn" — Get Code + Cancel buttons inside the embed. */
export function buildActiveView(bot, { mention, provider, hint } = {}) {
  const ping = mention ? `<@${mention}>\n` : '';
  const hintLine = hint ? `\n_Your code: \`${hint}\`_` : '';
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_ACTIVE)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${ping}### It's your turn\nPlace your order, then click **Get Code** below.${hintLine}`,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(bot.customId('get', provider))
          .setLabel('Get Code')
          .setEmoji('📩')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(bot.customId('cancel', provider))
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Danger),
      ),
    );
  return v2(container);
}

/** While polling for a code — no buttons. */
export function buildFetchingView() {
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_FETCHING)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '### Fetching code…\nPolling the inbox now. This usually takes a few seconds.',
      ),
    );
  return v2(container);
}

/** Code arrived — Done button inside. Auto-advances after 10s if not clicked. */
export function buildCodeView({ code, bot, userId, provider }) {
  const label = provider === 'eno' ? 'Eno Code' : 'Safekey Code';
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_CODE)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `<@${userId}>\n### ${label}:\n\`\`\`${code}\`\`\``,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(bot.customId('done', provider, userId))
          .setLabel('Next ➡️')
          .setStyle(ButtonStyle.Success),
      ),
    );
  return v2(container);
}

/** No code received — Try Again + Cancel inside. Auto-advances after 10s. */
export function buildTimeoutView(bot, { mention, provider } = {}) {
  const ping = mention ? `<@${mention}>\n` : '';
  const sourceLabel = provider === 'eno' ? 'Capital One' : 'Safekey';
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_TIMEOUT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${ping}### No code received\nNo matching ${sourceLabel} email arrived within 60 seconds.`,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(bot.customId('retry', provider))
          .setLabel('Try Again')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(bot.customId('cancel', provider))
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Danger),
      ),
    );
  return v2(container);
}

/**
 * Plain text V2 container — used for terminal states (Cancelled / Done /
 * Auto-advanced). V2 messages can't switch back to classic `content + embeds`
 * once the IsComponentsV2 flag is set; everything must stay in components.
 */
export function buildPlainView(text) {
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(text),
  );
  return v2(container);
}

/**
 * Code arrived — no buttons. Used by auto-fire flows where the worker
 * never clicks anything (Eno). The queue auto-advances after 10s.
 */
export function buildAutoCodeView({ code, userId, provider }) {
  const label = provider === 'eno' ? 'Eno Code' : 'Safekey Code';
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_CODE)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `<@${userId}>\n### ${label}:\n\`\`\`${code}\`\`\``,
      ),
    );
  return v2(container);
}

/** Timeout view without buttons — used by auto-fire timeout path. */
export function buildAutoTimeoutView({ userId, provider }) {
  const sourceLabel = provider === 'eno' ? 'Capital One' : 'Safekey';
  const window = provider === 'eno' ? '3 minutes' : '60 seconds';
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_TIMEOUT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `<@${userId}>\n### No code received\nNo matching ${sourceLabel} email arrived within ${window}.`,
      ),
    );
  return v2(container);
}

/** Skipped — no buttons, transparent sidebar. */
export function buildSkippedView() {
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '### Skipped\nYou were idle for 60 seconds and got skipped. The next worker is up.',
    ),
  );
  return v2(container);
}

/**
 * Post the active-worker session message to the configured channel. Stores the message
 * id on the queue entry so we can edit/delete it later.
 */
export async function postSession({ client, bot, channelId, queue, provider, entry }) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error('configured channel is not a text channel');
  const msg = await channel.send(
    buildActiveView(bot, {
      mention: entry.user_id,
      provider,
      hint: entry.match_code ?? null,
    }),
  );
  queue.setSessionMessageId(entry.user_id, msg.id);
  return msg;
}

export async function deleteSession({ client, channelId, entry }) {
  if (!entry.session_message_id) return;
  try {
    const channel = await client.channels.fetch(channelId);
    const msg = await channel.messages.fetch(entry.session_message_id);
    await msg.delete();
  } catch {
    // already gone
  }
}

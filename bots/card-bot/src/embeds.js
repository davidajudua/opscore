import {
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';

const COLOR_OK = 0x57f287;
const COLOR_WARN = 0xfee75c;
const COLOR_ERR = 0xed4245;

/* ------------------------------------------------------------ helpers */

function pad(s, n) {
  return String(s).padEnd(n);
}
function padNum(n, w) {
  return String(n).padStart(w);
}

/**
 * Build a Components V2 message payload that posts publicly with no accent
 * color (transparent side bar). Used as the default look for /stock, etc.
 */
export function v2Payload(container) {
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/**
 * Low-stock alert posted as a follow-up after a /card claim that leaves a
 * provider's pool at or below the threshold. Yellow accent + ⚠️ so it reads as a
 * warning without being mistaken for an error.
 */
export function lowStockPayload({ provider, count, threshold }) {
  void threshold;
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_WARN)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### ⚠️ Low stock\n\`${provider}\` has **${count}** cards left.`,
      ),
    );
  return v2Payload(container);
}

/**
 * Standard error container — red accent, ❌ prefix, single line message.
 */
export function errorPayload(message) {
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_ERR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ❌ ${message}`),
    );
  return v2Payload(container);
}

/* ------------------------------------------------------------ /card */

/**
 * V2 container labeled-block — bold label followed by a full-width code block.
 * V2 containers render each TextDisplay at the embed's full content width, so
 * values never clip regardless of viewport.
 */
function labeledBlock(label, value) {
  return new TextDisplayBuilder().setContent(`**${label}**\n\`\`\`\n${value}\n\`\`\``);
}

function buildCardActionRow(bot) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(bot.customId('cardact', 'used'))
      .setLabel('Used')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(bot.customId('cardact', 'error'))
      .setLabel('Error')
      .setEmoji('⚠️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(bot.customId('cardact', 'return'))
      .setLabel('Return')
      .setEmoji('↩️')
      .setStyle(ButtonStyle.Secondary),
  );
}

function cardContainer({ card, provider, accentColor }) {
  const expDate =
    card.mm && card.yy
      ? `${card.mm}/${String(card.yy).length === 2 ? '20' + card.yy : card.yy}`
      : (provider.exp_date ?? 'N/A');
  const zip = card.zip ?? provider.zip ?? 'N/A';
  const c = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### Provider: ${provider.name}`),
    )
    .addTextDisplayComponents(labeledBlock('Card Number', card.card_number))
    .addTextDisplayComponents(labeledBlock('CVV', card.cvv))
    .addTextDisplayComponents(labeledBlock('Exp Date', expDate))
    .addTextDisplayComponents(labeledBlock('Zip Code', zip));
  if (accentColor != null) c.setAccentColor(accentColor);
  return c;
}

export function cardEmbed({ card, provider, bot }) {
  const c = cardContainer({ card, provider });
  c.addActionRowComponents(buildCardActionRow(bot));
  return v2Payload(c);
}

export function cardFinalEmbed({ card, provider, action }) {
  const accent =
    action === 'used' ? COLOR_OK : action === 'error' ? COLOR_ERR : COLOR_WARN;
  const label =
    action === 'used' ? 'Used' : action === 'error' ? 'Errored' : 'Returned';
  const c = cardContainer({ card, provider, accentColor: accent });
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`_${label}_`),
  );
  return v2Payload(c);
}

/* ------------------------------------------------------------ /stock */

/**
 * Build the /stock panel as a Components V2 Container with NO accent color
 * (transparent side bar): a Cards section with per-provider counts + total.
 */
export function statusContainer({ cards, cardMode = 'all' }) {
  const cardTotal = cards.reduce((sum, p) => sum + (p.count ?? 0), 0);

  const cardLines = cards.length
    ? cards.map((p) => `${pad(p.id, 8)} ${padNum(p.count, 4)}`).join('\n')
    : '(no providers)';

  const cardsBlock =
    `### 🗂️ Cards\n` +
    '```\n' +
    cardLines +
    `\n${'─'.repeat(13)}\n` +
    `${pad('Total', 8)} ${padNum(cardTotal, 4)}\n` +
    '```';

  // cardMode intentionally unused here — the active provider is already visible
  // via the highlighted button in /providers.
  void cardMode;

  return new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(cardsBlock));
}

/* ------------------------------------------------------------ /stats */

/**
 * /stats — paginated one-worker-per-page V2 container with [Today][Week] tab
 * row at top and ◀ Name (3/20) ▶ nav row at bottom. Shows per-worker card
 * claims plus a grand total across all workers in the current tab.
 */
export function workersStatsPageContainer({ bot, tab, sorted, pageIdx, prices }) {
  const fmtMoney = (cents) => `$${(cents / 100).toFixed(2)}`;
  const costOf = (r) => r.cards * prices.card;

  const totalPages = Math.max(1, sorted.length);
  const safeIdx = Math.max(0, Math.min(pageIdx, totalPages - 1));

  const tabLabel = tab === 'week' ? 'Week' : 'Today';
  const c = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 📊 Stats — ${tabLabel}`),
    );

  if (sorted.length === 0) {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('_No activity in this window._'),
    );
  } else {
    const r = sorted[safeIdx];
    const workerBlock =
      '```\n' +
      `cards    ${padNum(r.cards, 4)}   ${pad(fmtMoney(r.cards * prices.card), 8)}\n` +
      `${'─'.repeat(26)}\n` +
      `total           ${pad(fmtMoney(costOf(r)), 8)}\n` +
      '```';
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`<@${r.userId}>\n${workerBlock}`),
    );

    // Grand total — shown below the current worker on every page so totals
    // are always visible without needing to navigate to a separate page.
    const cardTotal = sorted.reduce((s, r2) => s + r2.cards, 0);
    const grandTotal = sorted.reduce((s, r2) => s + costOf(r2), 0);
    const totalBlock =
      '```\n' +
      `cards    ${padNum(cardTotal, 4)}\n` +
      `${'─'.repeat(26)}\n` +
      `total           ${pad(fmtMoney(grandTotal), 8)}\n` +
      '```';
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### Grand total (${sorted.length} workers)\n${totalBlock}`,
      ),
    );
  }

  // Tab row: [Today] [Week]
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(bot.customId('stats', 'tab', 'today'))
        .setLabel('Today')
        .setStyle(tab === 'today' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(tab === 'today'),
      new ButtonBuilder()
        .setCustomId(bot.customId('stats', 'tab', 'week'))
        .setLabel('Week')
        .setStyle(tab === 'week' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(tab === 'week'),
    ),
  );

  // Nav row: ◀ Page X / N ▶
  if (sorted.length > 0) {
    c.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(bot.customId('stats', 'nav', tab, String(Math.max(0, safeIdx - 1))))
          .setLabel('◀')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safeIdx === 0),
        new ButtonBuilder()
          .setCustomId(bot.customId('stats', 'nav', 'noop'))
          .setLabel(`${safeIdx + 1} / ${totalPages}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(bot.customId('stats', 'nav', tab, String(Math.min(totalPages - 1, safeIdx + 1))))
          .setLabel('▶')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safeIdx >= totalPages - 1),
      ),
    );
  }

  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`*Price per card: ${fmtMoney(prices.card)}*`),
  );

  return c;
}

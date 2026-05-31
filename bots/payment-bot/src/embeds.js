import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} from 'discord.js';

const COLOR_INCOMING = 0x57f287;
const COLOR_OUTGOING = 0xed4245;
const COLOR_PENDING = 0xfee75c;

function fmt(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Shared between /dashboard and /history so both render method rows the same
// way and in the same order. Promoted to module scope from dashboardPayload's
// previous inline declaration so historyPayload can reuse it verbatim.
const KNOWN_METHODS = ['zelle', 'venmo', 'paypal', 'crypto'];
const METHOD_LABELS = { zelle: 'Zelle', venmo: 'Venmo', paypal: 'PayPal', crypto: 'Crypto' };

/** Format a date as "May 2 at 8:04 PM EST" in America/New_York time.
 *  Always labels the timezone "EST" — even during daylight saving (May–Nov, when the
 *  actual zone name is EDT). By design: consistent label over technical
 *  accuracy. */
function formatDateTime(date) {
  return (
    date
      .toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
      .replace(', ', ' at ') + ' EST'
  );
}

export function paymentEmbed({ provider, amount, name, receivedAt }) {
  const date = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
  return new EmbedBuilder()
    .setColor(COLOR_INCOMING)
    .setTitle(`${provider.label} Payment Received`)
    .addFields(
      { name: '👤  From', value: `\`${name ?? 'unknown'}\``, inline: true },
      { name: '💵  Amount', value: `\`$${fmt(amount)}\``, inline: true },
      { name: '🕐  Date & Time', value: `\`${formatDateTime(date)}\``, inline: false },
    );
}

/* ============================================================== /refund */

const REFUND_METHOD_LABELS = { zelle: 'Zelle', venmo: 'Venmo', paypal: 'PayPal', crypto: 'Crypto' };

/**
 * Per-method embed field config — emoji + label for each modal value, in display order.
 * The amount is always shown as USD; everything else is rendered as a copyable code block.
 */
const REFUND_EMBED_FIELDS = {
  zelle: [
    { id: 'zelleName', name: '👤  Zelle Name' },
    { id: 'zelleContact', name: '📧  Zelle Contact' },
    { id: 'amount', name: '💰  Refund Amount', isAmount: true },
    { id: 'reason', name: '📝  Reason' },
  ],
  venmo: [
    { id: 'venmoName', name: '👤  Venmo Name' },
    { id: 'venmoUsername', name: '🆔  Venmo Username' },
    { id: 'amount', name: '💰  Refund Amount', isAmount: true },
    { id: 'reason', name: '📝  Reason' },
  ],
  paypal: [
    { id: 'paypalName', name: '👤  PayPal Name' },
    { id: 'paypalEmail', name: '📧  PayPal Contact' },
    { id: 'amount', name: '💰  Refund Amount', isAmount: true },
    { id: 'reason', name: '📝  Reason' },
  ],
  crypto: [
    { id: 'cryptoCurrency', name: '🪙  Crypto Currency' },
    { id: 'cryptoAddress', name: '📬  Crypto Address' },
    { id: 'amount', name: '💰  Refund Amount', isAmount: true },
    { id: 'reason', name: '📝  Reason' },
  ],
};

function refundFields(method, values) {
  const block = (v) => '```\n' + v + '\n```';
  return REFUND_EMBED_FIELDS[method].map((f) => {
    let v = values[f.id];
    if (f.isAmount) {
      const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
      v = `$${fmt(Number.isFinite(n) ? n : 0)}`;
    }
    return { name: f.name, value: block(v ?? ''), inline: false };
  });
}

export function refundPendingEmbed({ user, method, values, screenshotUrl }) {
  const label = REFUND_METHOD_LABELS[method] ?? method;
  const ticket = values.ticketLink;
  const embed = new EmbedBuilder()
    .setColor(COLOR_PENDING)
    .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
    .setTitle(`Pending: ${label}`)
    .setTimestamp(new Date())
    .addFields(...refundFields(method, values));
  if (screenshotUrl) embed.setImage(screenshotUrl);
  if (/^https?:\/\//i.test(ticket)) {
    embed.setDescription(`🎫  **[Ticket](${ticket})**`);
  } else if (ticket) {
    embed.setDescription(`🎫  **${ticket}**`);
  }
  return embed;
}

/**
 * Recolor + retitle an existing pending embed for approve/deny. Preserves
 * fields, image, ticket link so the audit trail stays in the message.
 */
export function refundFinalEmbed({ original, method, action }) {
  const label = REFUND_METHOD_LABELS[method] ?? method;
  return EmbedBuilder.from(original)
    .setColor(action === 'approve' ? COLOR_INCOMING : COLOR_OUTGOING)
    .setTitle(`${action === 'approve' ? 'Refunded' : 'Denied'}: ${label}`);
}

const DASHBOARD_PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'allTime', label: 'All time' },
];

function periodLines(period) {
  const labels = [...KNOWN_METHODS.map((m) => METHOD_LABELS[m]), 'Cashout', 'Total'];
  const amts = [
    ...KNOWN_METHODS.map((m) => period.byMethod[m] ?? 0),
    period.cashouts ?? 0,
    period.balance,
  ].map((v) => '$' + fmt(v));
  const labelMax = Math.max(...labels.map((l) => l.length + 1));
  const amountMax = Math.max(...amts.map((a) => a.length));
  const row = (label, amount) =>
    `${(label + ':').padEnd(labelMax)} ${('$' + fmt(amount)).padStart(amountMax)}`;
  const lines = [];
  for (const m of KNOWN_METHODS) {
    lines.push(row(METHOD_LABELS[m], period.byMethod[m] ?? 0));
  }
  lines.push(row('Cashout', period.cashouts ?? 0));
  lines.push('─'.repeat(Math.max(...lines.map((l) => l.length))));
  lines.push(row('Total', period.balance));
  return lines;
}

/**
 * /dashboard — V2 container with all 4 periods stacked as full-width code
 * blocks (Today, Week, Month, All time). No tab pagination since V2 lifts the
 * inline-column width constraint, so everything fits on a single page.
 */
export function dashboardPayload({ today, week, month, allTime, locked, bot }) {
  const periods = { today, week, month, allTime };

  const c = new ContainerBuilder();
  for (const { key, label } of DASHBOARD_PERIODS) {
    const lines = periodLines(periods[key]);
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ${label}`),
    );
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('```\n' + lines.join('\n') + '\n```'),
    );
  }
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(bot.customId('dash', 'page', 'h0'))
        .setLabel('History')
        .setEmoji('📅')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(bot.customId('dash', 'restart'))
        .setLabel('Restart')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(bot.customId('dash', locked ? 'unlock' : 'lock'))
        .setLabel(locked ? 'Unlock' : 'Lock')
        .setEmoji(locked ? '🔓' : '🔒')
        .setStyle(locked ? ButtonStyle.Success : ButtonStyle.Danger),
    ),
  );

  if (locked) {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('🔒  **Workers are locked out.**'),
    );
  }

  return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

/**
 * /history — last 7 completed days, each one a full 12 AM → 12 AM Eastern
 * window. Mirrors dashboardPayload's classic-EmbedBuilder layout: 7 inline
 * fields (one per day) + 2 trailing spacers → 3-column grid. Each block uses
 * the same column-padded code-block style as dashboardPayload so the two
 * commands feel visually unified. No buttons — /history is a snapshot.
 *
 * `days` is the array returned by dailyRevenueHistory(db, { days: 7 }) —
 * newest first, each row { dayStart, dayEnd, total, byMethod }.
 */
export function historyPayload({ days, index, bot }) {
  const i = Math.max(0, Math.min(days.length - 1, index ?? 0));
  const day = days[i];

  const fmtDayLabel = (epochMs, isToday) => {
    if (isToday) return 'Today';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(new Date(epochMs));
  };

  // Right-align $ amounts in a fixed column so values stack cleanly across rows.
  const labels = [...KNOWN_METHODS.map((m) => METHOD_LABELS[m]), 'Total'];
  const amts = [
    ...KNOWN_METHODS.map((m) => day.byMethod[m] ?? 0),
    day.total ?? 0,
  ].map((v) => '$' + fmt(v));
  const labelMax = Math.max(...labels.map((l) => l.length + 1));
  const amountMax = Math.max(...amts.map((a) => a.length));
  const row = (label, amount) =>
    `${(label + ':').padEnd(labelMax)} ${('$' + fmt(amount)).padStart(amountMax)}`;
  const lines = [];
  for (const m of KNOWN_METHODS) {
    lines.push(row(METHOD_LABELS[m], day.byMethod[m] ?? 0));
  }
  lines.push('─'.repeat(Math.max(...lines.map((l) => l.length))));
  lines.push(row('Total', day.total ?? 0));

  const c = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ${fmtDayLabel(day.dayStart, i === 0)}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('```\n' + lines.join('\n') + '\n```'),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(bot.customId('dash', 'page', `h${Math.max(0, i - 1)}`))
          .setLabel('◀')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(i === 0),
        new ButtonBuilder()
          .setCustomId(bot.customId('dash', 'page', 'noop'))
          .setLabel(`${i + 1} / ${days.length}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(bot.customId('dash', 'page', `h${Math.min(days.length - 1, i + 1)}`))
          .setLabel('▶')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(i >= days.length - 1),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(bot.customId('dash', 'page', 'dashboard'))
          .setLabel('Back to Dashboard')
          .setEmoji('🔙')
          .setStyle(ButtonStyle.Secondary),
      ),
    );

  return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

export function cashoutEmbed({ amount, note }) {
  const fields = [
    { name: '💸  Amount', value: `\`$${fmt(amount)}\``, inline: true },
    { name: '🕐  Date & Time', value: `\`${formatDateTime(new Date())}\``, inline: true },
  ];
  if (note) {
    fields.push({ name: '📝  Note', value: `\`${note}\``, inline: false });
  }
  return new EmbedBuilder()
    .setColor(COLOR_OUTGOING)
    .setTitle('Cashout Recorded')
    .addFields(...fields);
}

/**
 * Crypto transaction embed. `tx` is the result of fetchTransaction(); `displayAddr`
 * is the canonical address (raw if unknown, our env value if matched). `matched`
 * is true when `tx.toAddress` is one of our configured addresses.
 */
export function cryptoEmbed({ tx, displayAddr, matched, txUrl }) {
  const usdAtSend =
    tx.historicalPrice != null && tx.amountNative != null
      ? `$${fmt(tx.amountNative * tx.historicalPrice)}`
      : 'N/A';
  const usdNow =
    tx.currentPrice != null && tx.amountNative != null
      ? `$${fmt(tx.amountNative * tx.currentPrice)}`
      : 'N/A';
  const date = tx.timestamp ? new Date(tx.timestamp) : new Date();
  const txType = tx.tokenAddress ? `${tx.unit} Transaction` : `${tx.coin} Transaction`;

  const sentToValue = matched
    ? `\`${displayAddr}\``
    : `\`${displayAddr}\`\n❗ **This transaction was NOT sent to our address.**`;

  const embed = new EmbedBuilder()
    .setColor(matched ? COLOR_INCOMING : COLOR_OUTGOING)
    .setTitle(matched ? 'Crypto Payment Received' : 'Wrong Address')
    .setDescription(`🔗 **[${txType}](${txUrl})**`)
    .addFields(
      { name: '📬  Sent To', value: sentToValue, inline: false },
      { name: '💸  Amount Paid', value: `\`${usdAtSend}\``, inline: true },
      { name: '💰  Current Value', value: `\`${usdNow}\``, inline: true },
      { name: '🕐  Date & Time', value: `\`${formatDateTime(date)}\``, inline: false },
    );
  return embed;
}

export function adjustmentEmbed({ method, amount, note }) {
  const fields = [
    { name: '🏦  Method', value: `\`${method}\``, inline: true },
    { name: '➖  Amount', value: `\`-$${fmt(amount)}\``, inline: true },
    { name: '🕐  Date & Time', value: `\`${formatDateTime(new Date())}\``, inline: false },
  ];
  if (note) {
    fields.push({ name: '📝  Note', value: `\`${note}\``, inline: false });
  }
  return new EmbedBuilder()
    .setColor(COLOR_OUTGOING)
    .setTitle('Adjustment Recorded')
    .addFields(...fields);
}

import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} from 'discord.js';
import { ephemeralError, hasAnyRole } from '@platform/bot-core/discord';
import { isLockedDown, setLockdown } from '@platform/bot-core';
import {
  computeTotals,
  dailyRevenueHistory,
  recordCashout,
  recordAdjustment,
  recordPayment,
  purgeAll,
  startOfTodayEastern,
  startOfWeekEastern,
  startOfMonthEastern,
  saveDashboardPointer,
  listDashboardPointers,
  removeDashboardPointer,
  setDashboardPage,
} from './ledger.js';
import {
  dashboardPayload,
  historyPayload,
  cashoutEmbed,
  adjustmentEmbed,
  cryptoEmbed,
  refundPendingEmbed,
  refundFinalEmbed,
} from './embeds.js';
import {
  parseTransactionInput,
  fetchTransaction,
  buildAddressIndex,
  isOurAddress,
  getDisplayAddress,
  EXPLORER_BASES,
} from './blockchain.js';
import { pm2RestartAll } from './pm2.js';

export const dashboardCommand = new SlashCommandBuilder()
  .setName('dashboard')
  .setDescription('Payment totals + fleet controls');

export const cashoutCommand = new SlashCommandBuilder()
  .setName('cashout')
  .setDescription('Record a cashout')
  .addNumberOption((o) =>
    o.setName('amount').setDescription('USD amount').setRequired(true).setMinValue(0.01),
  )
  .addStringOption((o) => o.setName('note').setDescription('Optional note').setRequired(false));

export const minusCommand = new SlashCommandBuilder()
  .setName('minus')
  .setDescription('Deduct from a payment method')
  .addStringOption((o) =>
    o
      .setName('method')
      .setDescription('Payment method')
      .setRequired(true)
      .addChoices(
        { name: 'zelle', value: 'zelle' },
        { name: 'venmo', value: 'venmo' },
        { name: 'paypal', value: 'paypal' },
        { name: 'crypto', value: 'crypto' },
      ),
  )
  .addNumberOption((o) =>
    o.setName('amount').setDescription('USD amount').setRequired(true).setMinValue(0.01),
  )
  .addStringOption((o) => o.setName('note').setDescription('Optional note').setRequired(false));

/**
 * Render the dashboard for whichever page this pointer is currently on.
 * page='totals' (default) → Today/Week/Month/All time grid + fleet controls.
 * page='history' → 8-cell daily revenue grid (today + 7 prior).
 */
function buildDashboardPayload({ db, bot, repoRoot, page = 'dashboard' }) {
  // Legacy page names from older versions — remap so existing pointers work.
  if (page === 'totals' || page === 'today' || page === 'week'
      || page === 'month' || page === 'allTime') {
    page = 'dashboard';
  }
  if (page === 'history') page = 'h0';

  // History view: one day per page, navigated by Prev/Next.
  if (typeof page === 'string' && page.startsWith('h')) {
    const index = parseInt(page.slice(1), 10) || 0;
    const days = dailyRevenueHistory(db, { days: 8 });
    return historyPayload({ days, index, bot });
  }

  // Dashboard view: all 4 periods stacked on a single V2 page.
  const today = computeTotals(db, { since: startOfTodayEastern() });
  const week = computeTotals(db, { since: startOfWeekEastern() });
  const month = computeTotals(db, { since: startOfMonthEastern() });
  const allTime = computeTotals(db, {});
  const locked = isLockedDown(repoRoot);
  return dashboardPayload({ today, week, month, allTime, locked, bot });
}

/**
 * Re-render every saved /dashboard message in place. Called on every ledger
 * change (payment, cashout, minus, refund-approve, crypto) so live dashboards
 * stay current without the user having to re-run /dashboard. Stale pointers
 * (deleted message / unreachable channel) are pruned from the table.
 */
export async function refreshDashboards({ db, bot, repoRoot, logger }) {
  const pointers = listDashboardPointers(db);
  if (!pointers.length) return;
  // Each pointer's saved current_page determines which view it re-renders to —
  // a worker viewing /history doesn't get yanked back to totals on every payment.
  for (const p of pointers) {
    const payload = buildDashboardPayload({
      db, bot, repoRoot,
      page: p.current_page ?? 'totals',
    });
    try {
      const channel =
        bot.client.channels.cache.get(p.channel_id) ??
        (await bot.client.channels.fetch(p.channel_id));
      const msg = await channel.messages.fetch(p.message_id);
      await msg.edit(payload);
    } catch (err) {
      const m = err?.message ?? String(err);
      // Drop the pointer if the message/channel is gone — Discord error codes
      // 10003 (Unknown Channel) and 10008 (Unknown Message).
      if (/Unknown Message|10008|Unknown Channel|10003/.test(m)) {
        logger?.warn({ channelId: p.channel_id, messageId: p.message_id }, 'dashboard: pointer stale, removing');
        removeDashboardPointer(db, p.message_id);
      } else {
        logger?.warn({ err: m, channelId: p.channel_id }, 'dashboard: refresh failed');
      }
    }
  }
}

export function dashboardHandler({ db, env, bot, repoRoot }) {
  const isAdmin = hasAnyRole([env.ADMIN_ROLE_NAME]);
  return async function (interaction) {
    if (!isAdmin(interaction)) {
      return ephemeralError(interaction, `Requires the **${env.ADMIN_ROLE_NAME}** role.`);
    }
    // First post lands on the dashboard view (all 4 periods stacked).
    await interaction.reply(buildDashboardPayload({ db, bot, repoRoot, page: 'dashboard' }));
    try {
      const sent = await interaction.fetchReply();
      saveDashboardPointer(db, { channelId: sent.channel.id, messageId: sent.id });
    } catch {
      // Best-effort — if pointer save fails, dashboard still works as one-shot.
    }
  };
}

export function dashboardButtonHandler({ db, env, bot, logger, repoRoot }) {
  const isAdmin = hasAnyRole([env.ADMIN_ROLE_NAME]);
  return async function (interaction, args) {
    const [action, ...rest] = args;

    // Page navigation is open to everyone — viewing history isn't a fleet action.
    if (action === 'page') {
      const page = rest[0] || 'today';
      setDashboardPage(db, interaction.message.id, page);
      await interaction.update(buildDashboardPayload({ db, bot, repoRoot, page }));
      return;
    }

    // Everything below is admin-only (Restart, Lock, Unlock).
    if (!isAdmin(interaction)) {
      return ephemeralError(interaction, `Requires the **${env.ADMIN_ROLE_NAME}** role.`);
    }

    if (action === 'lock' || action === 'unlock') {
      setLockdown(repoRoot, action === 'lock');
      logger?.warn({ admin: interaction.user.id, locked: action === 'lock' }, 'fleet lockdown toggled');
      await interaction.update(buildDashboardPayload({ db, bot, repoRoot }));
      return;
    }

    // Refresh the panel first — for restart-self, it's the user's last view before pm2 SIGTERMs us.
    await interaction.update(buildDashboardPayload({ db, bot, repoRoot }));

    const fire = (fn, label) => {
      logger?.warn({ admin: interaction.user.id, label }, 'fleet pm2 action from dashboard');
      try { logger?.flush?.(); } catch { /* flush is best-effort */ }
      setTimeout(() => {
        fn().catch((err) => logger?.error({ err: err.message, label }, 'pm2 action failed'));
      }, 1000);
    };

    if (action === 'restart') fire(() => pm2RestartAll(), 'restart all');
  };
}

export function cashoutHandler({ db, env, bot, logger, repoRoot }) {
  const isAdmin = hasAnyRole([env.ADMIN_ROLE_NAME]);
  return async function (interaction) {
    if (!isAdmin(interaction)) {
      return ephemeralError(interaction, `Requires the **${env.ADMIN_ROLE_NAME}** role.`);
    }
    const amount = interaction.options.getNumber('amount', true);
    const note = interaction.options.getString('note') ?? undefined;
    recordCashout(db, { amount, note });
    if (logger) logger.info({ amount, note }, 'cashout recorded');
    await interaction.reply({ embeds: [cashoutEmbed({ amount, note })] });
    refreshDashboards({ db, bot, repoRoot, logger }).catch(() => {});
  };
}

export function minusHandler({ db, env, bot, logger, repoRoot }) {
  const isAdmin = hasAnyRole([env.ADMIN_ROLE_NAME]);
  return async function (interaction) {
    if (!isAdmin(interaction)) {
      return ephemeralError(interaction, `Requires the **${env.ADMIN_ROLE_NAME}** role.`);
    }
    const method = interaction.options.getString('method', true);
    const amount = interaction.options.getNumber('amount', true);
    const note = interaction.options.getString('note') ?? undefined;
    recordAdjustment(db, { method, amount, note });
    if (logger) logger.info({ method, amount, note }, 'adjustment recorded');
    await interaction.reply({ embeds: [adjustmentEmbed({ method, amount, note })] });
    refreshDashboards({ db, bot, repoRoot, logger }).catch(() => {});
  };
}

/* ============================================================== /crypto */

export const cryptoCommand = new SlashCommandBuilder()
  .setName('crypto')
  .setDescription('Track a crypto transaction');

// `/crypto` opens a modal with a single field; the user pastes the hash/URL there.
export function cryptoHandler({ bot }) {
  return async function (interaction) {
    const modal = new ModalBuilder()
      .setCustomId(bot.customId('crypto-track'))
      .setTitle('Track Transaction')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('input')
            .setLabel('Submit a transaction')
            .setPlaceholder('Link or Hash')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
  };
}

export function cryptoModalHandler({ db, env, bot, logger, repoRoot }) {
  return async function (interaction) {
    await interaction.deferReply();
    const raw = interaction.fields.getTextInputValue('input').trim();

    const parsed = parseTransactionInput(raw);
    if (!parsed) {
      await interaction.editReply({
        content: [
          '❌ **Could not parse that transaction.**',
          'Please use:',
          '• A block explorer URL (e.g. `etherscan.io/tx/0x...`)',
          '• A prefixed hash (e.g. `btc:abc...`, `eth:0x...`, `sol:...`)',
        ].join('\n'),
      });
      return;
    }

    const { addressSet, coinAddresses } = buildAddressIndex(env);
    const candidateAddrs = parsed.coin
      ? coinAddresses[parsed.coin] || []
      : Object.values(coinAddresses).flat();

    let tx;
    try {
      tx = await fetchTransaction(parsed.coin, parsed.hash, candidateAddrs, parsed.autoDetect);
    } catch (err) {
      logger?.error({ err: err.message, raw }, 'crypto fetch failed');
      const isNotFound =
        err.message?.toLowerCase().includes('not found') || err.message?.includes('404');
      await interaction.editReply({
        content: isNotFound
          ? '❌ **Transaction not found.** It may be unconfirmed, invalid, or on a testnet.'
          : `❌ **Error fetching transaction:**\n\`\`\`${err.message}\`\`\``,
      });
      return;
    }

    const matched = isOurAddress(addressSet, tx.toAddress);
    const displayAddr = getDisplayAddress(addressSet, tx.toAddress);
    const txUrl = (EXPLORER_BASES[tx.coin] || '') + tx.hash;

    // If matched, record into the ledger (deduped by tx hash via UNIQUE(method, external_id)).
    if (matched) {
      const usdAtSend =
        tx.historicalPrice != null && tx.amountNative != null
          ? tx.amountNative * tx.historicalPrice
          : null;
      if (usdAtSend != null && usdAtSend > 0) {
        const result = recordPayment(db, {
          method: 'crypto',
          amount: usdAtSend,
          name: tx.coin,
          externalId: tx.hash,
          receivedAt: tx.timestamp ?? Date.now(),
        });
        logger?.info(
          { coin: tx.coin, hash: tx.hash, usd: usdAtSend, inserted: result.inserted },
          'crypto payment processed',
        );
        if (result.inserted) {
          refreshDashboards({ db, bot, repoRoot, logger }).catch(() => {});
        }
      } else {
        logger?.warn({ coin: tx.coin, hash: tx.hash }, 'matched crypto tx but USD amount unavailable');
      }
    } else {
      logger?.info({ coin: tx.coin, hash: tx.hash, to: tx.toAddress }, 'crypto tx not for us');
    }

    await interaction.editReply({
      embeds: [cryptoEmbed({ tx, displayAddr, matched, txUrl })],
    });
  };
}

/* ============================================================== /refund */

const REFUND_METHOD_CHOICES = [
  { name: 'Zelle', value: 'zelle' },
  { name: 'Venmo', value: 'venmo' },
  { name: 'PayPal', value: 'paypal' },
  { name: 'Crypto', value: 'crypto' },
];

// Modal field config — keep within Discord's 5-row limit. The amount/ticket/reason
// rows are common; the first two rows are method-specific identifiers.
const REFUND_MODAL_FIELDS = {
  zelle: [
    { id: 'zelleName',    label: 'Zelle Name',          style: TextInputStyle.Short,     max: 100,  ph: "Recipient's name on Zelle" },
    { id: 'zelleContact', label: 'Zelle Contact',       style: TextInputStyle.Short,     max: 100,  ph: 'Email or phone number' },
    { id: 'amount',       label: 'Refund Amount (USD)', style: TextInputStyle.Short,     max: 20,   ph: 'e.g. 25.00' },
    { id: 'ticketLink',   label: 'Ticket Link',         style: TextInputStyle.Short,     max: 500 },
    { id: 'reason',       label: 'Reason for Refund',   style: TextInputStyle.Paragraph, max: 1000 },
  ],
  venmo: [
    { id: 'venmoName',     label: 'Venmo Name',          style: TextInputStyle.Short,     max: 100,  ph: "Recipient's name on Venmo" },
    { id: 'venmoUsername', label: 'Venmo Username',      style: TextInputStyle.Short,     max: 100,  ph: 'e.g. @username' },
    { id: 'amount',        label: 'Refund Amount (USD)', style: TextInputStyle.Short,     max: 20,   ph: 'e.g. 25.00' },
    { id: 'ticketLink',    label: 'Ticket Link',         style: TextInputStyle.Short,     max: 500 },
    { id: 'reason',        label: 'Reason for Refund',   style: TextInputStyle.Paragraph, max: 1000 },
  ],
  paypal: [
    { id: 'paypalName',  label: 'PayPal Name',         style: TextInputStyle.Short,     max: 100,  ph: "Recipient's name on PayPal" },
    { id: 'paypalEmail', label: 'PayPal Contact',      style: TextInputStyle.Short,     max: 100,  ph: 'Email or @username' },
    { id: 'amount',      label: 'Refund Amount (USD)', style: TextInputStyle.Short,     max: 20,   ph: 'e.g. 25.00' },
    { id: 'ticketLink',  label: 'Ticket Link',         style: TextInputStyle.Short,     max: 500 },
    { id: 'reason',      label: 'Reason for Refund',   style: TextInputStyle.Paragraph, max: 1000 },
  ],
  crypto: [
    { id: 'cryptoCurrency', label: 'Crypto Currency',     style: TextInputStyle.Short,     max: 30,   ph: 'e.g. BTC, ETH, USDT' },
    { id: 'cryptoAddress',  label: 'Crypto Address',      style: TextInputStyle.Short,     max: 200,  ph: 'Recipient wallet address' },
    { id: 'amount',         label: 'Refund Amount (USD)', style: TextInputStyle.Short,     max: 20,   ph: 'e.g. 25.00' },
    { id: 'ticketLink',     label: 'Ticket Link',         style: TextInputStyle.Short,     max: 500 },
    { id: 'reason',         label: 'Reason for Refund',   style: TextInputStyle.Paragraph, max: 1000 },
  ],
};

// In-memory bridge from /refund slash → modal submit. Keyed by user id; expires
// after 5 min so a stale modal can't bleed state into a new request.
const refundBridge = new Map();
const REFUND_BRIDGE_TTL_MS = 5 * 60 * 1000;
function bridgeSet(userId, payload) {
  refundBridge.set(userId, { ...payload, expiresAt: Date.now() + REFUND_BRIDGE_TTL_MS });
}
function bridgeTake(userId) {
  const entry = refundBridge.get(userId);
  refundBridge.delete(userId);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry;
}

function parseAmount(str) {
  const n = parseFloat(String(str ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function buildRefundModal(bot, method) {
  const labels = { zelle: 'Zelle', venmo: 'Venmo', paypal: 'PayPal', crypto: 'Crypto' };
  const modal = new ModalBuilder()
    .setCustomId(bot.customId('refund-modal', method))
    .setTitle(`${labels[method]} Refund Request`);
  for (const f of REFUND_MODAL_FIELDS[method]) {
    const input = new TextInputBuilder()
      .setCustomId(f.id)
      .setLabel(f.label)
      .setStyle(f.style)
      .setRequired(true)
      .setMaxLength(f.max);
    if (f.ph) input.setPlaceholder(f.ph);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

function buildRefundButtons(bot, method, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(bot.customId('refund', 'approve', method))
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(bot.customId('refund', 'deny', method))
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

export const refundCommand = new SlashCommandBuilder()
  .setName('refund')
  .setDescription('Submit a refund request')
  .addStringOption((o) =>
    o
      .setName('method')
      .setDescription('Payment method to refund')
      .setRequired(true)
      .addChoices(...REFUND_METHOD_CHOICES),
  )
  .addAttachmentOption((o) =>
    o
      .setName('screenshot')
      .setDescription('Required for Zelle / Venmo / PayPal')
      .setRequired(false),
  );

export function refundHandler({ bot }) {
  return async function (interaction) {
    const method = interaction.options.getString('method', true);
    const screenshot = interaction.options.getAttachment('screenshot');

    if (method !== 'crypto') {
      if (!screenshot) {
        return ephemeralError(interaction, 'Screenshot is required for Zelle / Venmo / PayPal refunds.');
      }
      if (!screenshot.contentType?.startsWith('image/')) {
        return ephemeralError(interaction, 'Screenshot must be an image file.');
      }
    }

    bridgeSet(interaction.user.id, {
      method,
      screenshotUrl: screenshot?.url ?? null,
    });
    await interaction.showModal(buildRefundModal(bot, method));
  };
}

export function refundModalHandler({ env, bot, logger }) {
  return async function (interaction, args) {
    const [method] = args;
    if (!REFUND_MODAL_FIELDS[method]) {
      return ephemeralError(interaction, 'Unknown refund method.');
    }
    const bridge = bridgeTake(interaction.user.id);
    if (!bridge) {
      return ephemeralError(interaction, 'Session expired. Please re-run /refund.');
    }
    if (!env.REFUND_CHANNEL_ID) {
      return ephemeralError(interaction, 'Refund channel not configured. Set REFUND_CHANNEL_ID in .env.');
    }

    const values = {};
    for (const f of REFUND_MODAL_FIELDS[method]) {
      values[f.id] = interaction.fields.getTextInputValue(f.id).trim();
    }
    const amount = parseAmount(values.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return ephemeralError(interaction, 'Invalid refund amount.');
    }

    let channel;
    try {
      channel = await interaction.client.channels.fetch(env.REFUND_CHANNEL_ID);
    } catch (err) {
      logger?.error({ err: err.message }, 'failed to fetch refund channel');
      return ephemeralError(interaction, 'Refund channel is invalid.');
    }
    if (!channel?.isTextBased?.()) {
      return ephemeralError(interaction, 'Refund channel is invalid.');
    }

    const embed = refundPendingEmbed({
      user: interaction.user,
      method,
      values,
      screenshotUrl: bridge.screenshotUrl,
    });
    await channel.send({ embeds: [embed], components: [buildRefundButtons(bot, method, false)] });

    await interaction.reply({
      content: '✅ Refund request submitted.',
      flags: MessageFlags.Ephemeral,
    });
    logger?.info(
      { user: interaction.user.id, method, amount },
      'refund request posted',
    );
  };
}

export function refundButtonHandler({ db, env, bot, logger, repoRoot }) {
  return async function (interaction, args) {
    const [action, method] = args;
    if (action !== 'approve' && action !== 'deny') return;

    // No role gate — only admins see the refund channel anyway.
    // Concurrency guard: refuse if buttons are already disabled (already processed).
    const firstBtn = interaction.message.components?.[0]?.components?.[0];
    if (firstBtn?.disabled) {
      return ephemeralError(interaction, 'Already processed.');
    }

    await interaction.deferUpdate();

    const original = interaction.message.embeds[0];
    const amountField = original?.fields?.find((f) => f.name.includes('Amount'));
    const amount = parseAmount(amountField?.value);

    if (action === 'approve') {
      if (!Number.isFinite(amount) || amount <= 0) {
        await interaction.followUp({
          content: '❌ Could not parse refund amount from embed.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      recordAdjustment(db, { method, amount, note: 'Refund' });
      logger?.info({ approver: interaction.user.id, method, amount }, 'refund approved');
      refreshDashboards({ db, bot, repoRoot, logger }).catch(() => {});
    } else {
      logger?.info({ approver: interaction.user.id, method, amount }, 'refund denied');
    }

    const updated = refundFinalEmbed({ original, method, action });
    await interaction.editReply({
      embeds: [updated],
      components: [buildRefundButtons(bot, method, true)],
    });
  };
}

/* ============================================================== /purge */

export const purgeCommand = new SlashCommandBuilder()
  .setName('purge')
  .setDescription('Wipe ALL bot data');

export function purgeHandler({ env, bot }) {
  const isAdmin = hasAnyRole([env.ADMIN_ROLE_NAME]);
  return async function (interaction) {
    if (!isAdmin(interaction)) {
      return ephemeralError(interaction, `Requires the **${env.ADMIN_ROLE_NAME}** role.`);
    }

    const container = new ContainerBuilder()
      .setAccentColor(0xed4245)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          [
            '### ⚠️  Wipe ALL bot data?',
            '',
            'This permanently deletes:',
            '• All ledger entries (payments, cashouts, adjustments)',
            '• All IMAP cursor positions (re-scan from scratch)',
            '',
            '**This cannot be undone.**',
          ].join('\n'),
        ),
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(bot.customId('purge', 'confirm'))
        .setLabel('Wipe everything')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(bot.customId('purge', 'cancel'))
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({
      components: [container, row],
      flags: MessageFlags.IsComponentsV2,
    });
  };
}

export function purgeButtonHandler({ db, env, logger }) {
  const isAdmin = hasAnyRole([env.ADMIN_ROLE_NAME]);
  return async function (interaction, args) {
    if (!isAdmin(interaction)) {
      return ephemeralError(interaction, `Requires the **${env.ADMIN_ROLE_NAME}** role.`);
    }
    const [action] = args;

    if (action === 'cancel') {
      const container = new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent('### Cancelled.'),
      );
      await interaction.update({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (action === 'confirm') {
      const counts = purgeAll(db);
      logger?.warn({ userId: interaction.user.id, counts }, 'all data purged');

      const container = new ContainerBuilder()
        .setAccentColor(0x57f287)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            [
              '### ✅  Wiped clean.',
              '',
              `• ${counts.ledger} ledger entries`,
              `• ${counts.imap_cursor} IMAP cursor rows`,
            ].join('\n'),
          ),
        );

      await interaction.update({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  };
}

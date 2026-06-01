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
  AttachmentBuilder,
  MessageFlags,
} from 'discord.js';
import { hasAnyRole } from '@platform/bot-core/discord';
import { isLockedDown } from '@platform/bot-core';
import {
  claimCard,
  cardCounts,
  cardCount,
  isAlertFired,
  fireAlert,
  LOW_STOCK_THRESHOLD,
  PRICE_KINDS,
  getPrices,
  setPrice,
  getDailyWorkerStats,
  getStatsClearAt,
  setStatsClearAt,
  purgeClaimHistory,
  purgeStockAlerts,
  purgeOrphanSessions,
  startOfTodayEastern,
  startOfWeekEastern,
  loadCards,
  parseCardFile,
  addProvider,
  listProviders,
  setActiveProvider,
  isChannelWhitelisted,
  setWhitelist,
  listWhitelist,
  openCardSession,
  getCardSession,
  closeCardSession,
  returnCardToPool,
  purgeAll,
  getCardMode,
  setMixMode,
  toggleProviderInMix,
  exportCardsForProvider,
  deleteProvider,
  eraseProviderCards,
  editProvider,
} from './inventory.js';
import {
  cardEmbed,
  cardFinalEmbed,
  statusContainer,
  v2Payload,
  errorPayload,
  lowStockPayload,
  workersStatsPageContainer,
} from './embeds.js';

/* ============================================================== definitions */

export const cardCmd = new SlashCommandBuilder()
  .setName('card')
  .setDescription('Generate a card');

export const whitelistCmd = new SlashCommandBuilder()
  .setName('whitelist')
  .setDescription('Whitelist channel');

export const providersCmd = new SlashCommandBuilder()
  .setName('providers')
  .setDescription('Manage card providers');

const TYPE_CHOICES = [
  { name: 'cards', value: 'cards' },
];
const APPEND_REPLACE = [
  { name: 'append', value: 'append' },
  { name: 'replace', value: 'replace' },
];

export const loadCmd = new SlashCommandBuilder()
  .setName('load')
  .setDescription('Upload cards')
  .addStringOption((o) =>
    o.setName('type').setDescription('What to upload').setRequired(true).addChoices(...TYPE_CHOICES),
  )
  .addStringOption((o) =>
    o
      .setName('provider')
      .setDescription('Card provider id')
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addAttachmentOption((o) =>
    o.setName('file').setDescription('File to upload').setRequired(true),
  )
  .addStringOption((o) =>
    o.setName('mode').setDescription('Append or replace').addChoices(...APPEND_REPLACE),
  );

export const exportCmd = new SlashCommandBuilder()
  .setName('export')
  .setDescription('Download cards')
  .addStringOption((o) =>
    o.setName('type').setDescription('What to export').setRequired(true).addChoices(...TYPE_CHOICES),
  )
  .addStringOption((o) =>
    o
      .setName('provider')
      .setDescription('Card provider id')
      .setRequired(true)
      .setAutocomplete(true),
  );

export const purgeCmd = new SlashCommandBuilder()
  .setName('purge')
  .setDescription('Wipe all bot data');

/* ============================================================== helpers */

async function postError(interaction, message) {
  const payload = errorPayload(message);
  if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
  return interaction.reply(payload);
}

/**
 * After a successful /card claim, post a low-stock alert in the same
 * channel if the remaining count just crossed under the threshold. Fires once
 * per crossing — re-armed by /load, Return, or Erase via the inventory helpers.
 */
async function maybeAlertLowStock(interaction, { db, kind, provider, count }) {
  if (count > LOW_STOCK_THRESHOLD) return;
  // Per-count dedup keys → fires once at 10, 9, 8 … 1 as stock drains.
  const key = `${kind}:${provider}:${count}`;
  if (isAlertFired(db, key)) return;
  fireAlert(db, key);
  try {
    await interaction.followUp(
      lowStockPayload({ kind, provider, count, threshold: LOW_STOCK_THRESHOLD }),
    );
  } catch {
    // best-effort; don't fail the original claim if Discord rejects the followUp
  }
}

function requireFeature(db, feature) {
  return async function (interaction) {
    if (!isChannelWhitelisted(db, interaction.channelId, feature)) {
      await postError(
        interaction,
        `This channel isn't whitelisted for **${feature}**.`,
      );
      return false;
    }
    return true;
  };
}

function requireOpen(repoRoot) {
  return async function (interaction) {
    if (isLockedDown(repoRoot)) {
      await postError(interaction, 'Bot is currently disabled by an admin.');
      return false;
    }
    return true;
  };
}

function requireAdmin(env) {
  const isAdmin = hasAnyRole([env.ADMIN_ROLE_NAME]);
  return async function (interaction) {
    if (!isAdmin(interaction)) {
      await postError(interaction, `Requires the **${env.ADMIN_ROLE_NAME}** role.`);
      return false;
    }
    return true;
  };
}

/* ============================================================== /card */

function buildCardComponents(bot) {
  const row = new ActionRowBuilder().addComponents(
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
  return [row];
}

export function cardHandler({ db, env, bot, logger, repoRoot }) {
  const openGate = requireOpen(repoRoot);
  const gate = requireFeature(db, 'card');
  return async function (interaction) {
    if (!(await openGate(interaction))) return;
    if (!(await gate(interaction))) return;
    const result = claimCard(db);
    if (!result) {
      await postError(interaction, 'No cards available, all providers are empty.');
      return;
    }
    // Discord network calls can fail (5xx, rate limit, timeout). If reply or
    // fetchReply throws, the card is already DELETE'd from inventory but no
    // session row exists — silent loss. Wrap and recover by re-queueing the card.
    let replyMsg;
    try {
      await interaction.reply(
        cardEmbed({ card: result.card, provider: result.provider, bot }),
      );
      replyMsg = await interaction.fetchReply();
    } catch (err) {
      returnCardToPool(db, {
        provider_id: result.provider.id,
        card_number: result.card.card_number,
        mm: result.card.mm,
        yy: result.card.yy,
        cvv: result.card.cvv,
        zip: result.card.zip ?? null,
        message_id: null,
      });
      logger?.error(
        {
          err: err.message,
          provider: result.provider.id,
          cardLast4: result.card.card_number.slice(-4),
        },
        'card claim discord failure — card returned to pool',
      );
      return;
    }
    openCardSession(db, {
      messageId: replyMsg.id,
      userId: interaction.user.id,
      providerId: result.provider.id,
      card: result.card,
    });
    void env;
    await maybeAlertLowStock(interaction, {
      db,
      kind: 'card',
      provider: result.provider.id,
      count: cardCount(db, result.provider.id),
    });
    logger?.info(
      {
        userId: interaction.user.id,
        provider: result.provider.id,
        messageId: replyMsg.id,
        cardLast4: result.card.card_number.slice(-4),
      },
      'card claimed',
    );
  };
}

export function cardActionHandler({ db, bot, logger }) {
  return async function (interaction, args) {
    const [action] = args;
    const session = getCardSession(db, interaction.message.id);
    if (!session) {
      await postError(interaction, 'This card session has expired.');
      return;
    }
    if (session.user_id !== interaction.user.id) {
      await postError(interaction, 'Only the worker who claimed this card can use these buttons.');
      return;
    }

    const provider = listProviders(db).find((p) => p.id === session.provider_id) ?? {
      id: session.provider_id,
      name: session.provider_id,
      zip: null,
    };

    const cardLast4 = session.card_number.slice(-4);
    if (action === 'used') {
      closeCardSession(db, interaction.message.id);
      await interaction.update(cardFinalEmbed({ card: session, provider, action: 'used' }));
      logger?.info({ userId: interaction.user.id, providerId: session.provider_id, cardLast4 }, 'card marked used');
      return;
    }
    if (action === 'error') {
      closeCardSession(db, interaction.message.id);
      await interaction.update(cardFinalEmbed({ card: session, provider, action: 'error' }));
      logger?.warn({ userId: interaction.user.id, providerId: session.provider_id, cardLast4 }, 'card flagged as error');
      return;
    }
    if (action === 'return') {
      returnCardToPool(db, session);
      closeCardSession(db, interaction.message.id); // match 'used'/'error': don't leave an orphan session row
      await interaction.update(cardFinalEmbed({ card: session, provider, action: 'returned' }));
      logger?.info({ userId: interaction.user.id, providerId: session.provider_id, cardLast4 }, 'card returned to pool');
      return;
    }
  };
}

/**
 * Autocomplete for /load and /export. Suggests existing card provider ids.
 */
export function loadExportAutocompleteHandler({ db }) {
  return async function (interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'provider') {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const query = (focused.value ?? '').toLowerCase();

    const candidates = listProviders(db).map((p) => p.id);

    const suggestions = candidates
      .filter((c) => !query || c.toLowerCase().includes(query))
      .slice(0, 25)
      .map((c) => ({ name: c, value: c }));
    await interaction.respond(suggestions).catch(() => {});
  };
}

/* ============================================================== /stock */

function buildStockPayload(db) {
  return v2Payload(
    statusContainer({
      cards: cardCounts(db),
      cardMode: getCardMode(db),
    }),
  );
}

/* ============================================================== /whitelist */

const FEATURES = ['card'];

function whitelistRow(bot, enabled) {
  return new ActionRowBuilder().addComponents(
    ...FEATURES.map((f) => {
      const on = enabled.includes(f);
      return new ButtonBuilder()
        .setCustomId(bot.customId('wl', f))
        .setLabel(f)
        .setEmoji(on ? '✅' : '❌')
        .setStyle(on ? ButtonStyle.Success : ButtonStyle.Danger);
    }),
  );
}

export function whitelistHandler({ db, env, bot }) {
  const gate = requireAdmin(env);
  return async function (interaction) {
    if (!(await gate(interaction))) return;
    const features = listWhitelist(db, interaction.channelId);
    await interaction.reply({
      components: [whitelistRow(bot, features)],
      flags: MessageFlags.Ephemeral,
    });
  };
}

export function whitelistButtonHandler({ db, env, bot }) {
  const gate = requireAdmin(env);
  return async function (interaction, args) {
    if (!(await gate(interaction))) return;
    const [feature] = args;
    const enabled = isChannelWhitelisted(db, interaction.channelId, feature);
    setWhitelist(db, interaction.channelId, feature, !enabled);
    const features = listWhitelist(db, interaction.channelId);
    await interaction.update({ components: [whitelistRow(bot, features)] });
  };
}

/* ============================================================== /providers */

function providersPanel(bot, db) {
  const providers = listProviders(db);
  const cardMode = getCardMode(db);

  const container = new ContainerBuilder();

  // --- Card providers section ---
  const cardLines = providers
    .map((p) => {
      const marker = cardMode === 'mix' && p.in_mix ? ' ✓' : '';
      const zip = p.zip ? ` -> \`${p.zip}\`` : '';
      return `\`${p.name}\`${zip}${marker}`;
    })
    .join('\n');
  const cardsBlock = providers.length ? `**Card Providers**\n${cardLines}` : '**Card Providers**';
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(cardsBlock));

  // Card row(s): "All" + "Mix" first, then provider buttons (5 per row).
  let row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(bot.customId('prov', 'all'))
      .setLabel('All')
      .setStyle(cardMode === 'all' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(bot.customId('prov', 'mix'))
      .setLabel('Mix')
      .setStyle(cardMode === 'mix' ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  let count = 2;
  for (const p of providers) {
    if (count === 5) {
      container.addActionRowComponents(row);
      row = new ActionRowBuilder();
      count = 0;
    }
    const isHighlighted =
      cardMode === 'mix' ? Boolean(p.in_mix) : Boolean(p.is_active);
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(bot.customId('prov', 'set', p.id))
        .setLabel(p.id)
        .setStyle(isHighlighted ? ButtonStyle.Success : ButtonStyle.Secondary),
    );
    count++;
  }
  if (count > 0) container.addActionRowComponents(row);

  // --- Browse section (read-only) ---
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('**Browse**'),
  );
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(bot.customId('prov', 'openstock'))
        .setLabel('Stock')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(bot.customId('prov', 'opencards'))
        .setLabel('Cards')
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  // --- Manage section ---
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('**Manage**'),
  );
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(bot.customId('prov', 'create'))
        .setLabel('Create +')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(bot.customId('prov', 'edit'))
        .setLabel('Edit')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(bot.customId('prov', 'erase'))
        .setLabel('Erase')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(bot.customId('prov', 'delete'))
        .setLabel('Delete')
        .setStyle(ButtonStyle.Danger),
    ),
  );

  return container;
}

// Paginated browsers for /providers. Code-block listing, filterable by
// provider, ◀ Prev / Next ▶ pagination. Ephemeral.
//
// customId layout:
//   prov:opencards                — open the cards browser fresh (first click)
//   prov:cards:<filter>:<page>    — navigate within the cards browser
// where <filter> is 'all' or a provider id, <page> is zero-based.

const PREVIEW_PAGE_SIZE = 15;

function paginationRow(bot, kind, filter, safePage, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(bot.customId('prov', kind, filter, String(safePage - 1)))
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage === 0),
    new ButtonBuilder()
      .setCustomId(bot.customId('prov', 'pageinfo'))
      .setLabel(`${safePage + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(bot.customId('prov', kind, filter, String(safePage + 1)))
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
  );
}

// Filter actions are distinct from pagination actions:
//   filter:    prov:cfilter:<id>   /  prov:efilter:<id>
//   paginate:  prov:cards:<filter>:<page>  /  prov:emails:<filter>:<page>
// This avoids customId collisions (filter button for "A" and pagination Prev
// from page 1 of "A" would otherwise both encode to prov:cards:A:0).
function filterRow(bot, kind, filter, options) {
  const filterAction = kind === 'cards' ? 'cfilter' : 'efilter';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(bot.customId('prov', filterAction, 'all'))
      .setLabel('All')
      .setStyle(filter === 'all' ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  // Discord caps at 5 buttons per row → All + up to 4 provider buttons.
  for (const opt of options.slice(0, 4)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(bot.customId('prov', filterAction, opt.id))
        .setLabel(opt.label)
        .setStyle(filter === opt.id ? ButtonStyle.Success : ButtonStyle.Secondary),
    );
  }
  return row;
}

function cardsBrowserPanel(bot, db, filter = 'all', page = 0) {
  const providers = listProviders(db);
  const validFilter =
    filter === 'all' || providers.some((p) => p.id === filter) ? filter : 'all';

  const rows =
    validFilter === 'all'
      ? db.all(
          `SELECT provider_id, card_number, mm, yy, cvv, zip
           FROM cards
           ORDER BY provider_id, id`,
        )
      : db.all(
          `SELECT provider_id, card_number, mm, yy, cvv, zip
           FROM cards
           WHERE provider_id = ?
           ORDER BY id`,
          validFilter,
        );

  const totalPages = Math.max(1, Math.ceil(rows.length / PREVIEW_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = rows.slice(safePage * PREVIEW_PAGE_SIZE, safePage * PREVIEW_PAGE_SIZE + PREVIEW_PAGE_SIZE);

  const filterLabel = validFilter === 'all' ? '' : ` · ${validFilter}`;
  const header = `### 🗂️ Cards${filterLabel} (${rows.length})`;
  const body =
    slice.length === 0
      ? '_No cards in this view._'
      : '```\n' +
        slice
          .map((c) => {
            const zipPart = c.zip ? `  ${c.zip}` : '';
            return `[${c.provider_id}] ${c.card_number}  ${c.mm}/${c.yy}  ${c.cvv}${zipPart}`;
          })
          .join('\n') +
        '\n```';

  return new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addActionRowComponents(
      filterRow(
        bot,
        'cards',
        validFilter,
        providers.map((p) => ({ id: p.id, label: p.id })),
      ),
    )
    .addActionRowComponents(paginationRow(bot, 'cards', validFilter, safePage, totalPages));
}

export function providersHandler({ db, env, bot }) {
  const gate = requireAdmin(env);
  return async function (interaction) {
    if (!(await gate(interaction))) return;
    const container = providersPanel(bot, db);
    await interaction.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  };
}

export function providersButtonHandler({ db, env, bot, logger }) {
  const gate = requireAdmin(env);
  return async function (interaction, args) {
    if (!(await gate(interaction))) return;
    const [action, ...rest] = args;

    if (action === 'set') {
      const id = rest[0];
      // In Mix mode the per-provider button toggles membership; in any other
      // mode it pins that provider as the single active one.
      if (getCardMode(db) === 'mix') {
        toggleProviderInMix(db, id);
      } else {
        setActiveProvider(db, id);
      }
        const container = providersPanel(bot, db);
      await interaction.update({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (action === 'all') {
      setActiveProvider(db, null);
        const container = providersPanel(bot, db);
      await interaction.update({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (action === 'mix') {
      // Idempotent — clicking Mix while already in Mix mode is a no-op (no
      // visual flicker). Entering Mix mode preserves whatever in_mix flags
      // were already set so workers don't re-pick after a quick mode switch.
      if (getCardMode(db) !== 'mix') setMixMode(db);
        const container = providersPanel(bot, db);
      await interaction.update({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (action === 'opencards') {
      await interaction.reply({
        components: [cardsBrowserPanel(bot, db, 'all', 0)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === 'openstock') {
      // Ephemeral preview — admin-only one-shot lookup, no persistence,
      // no auto-refresh. Same UX shape as Cards / Emails browse buttons.
      const payload = buildStockPayload(db);
      await interaction.reply({
        ...payload,
        flags: (payload.flags ?? 0) | MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === 'cards') {
      const filter = rest[0] || 'all';
      const page = Number.parseInt(rest[1], 10) || 0;
      await interaction.update({
        components: [cardsBrowserPanel(bot, db, filter, page)],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (action === 'cfilter') {
      const filter = rest[0] || 'all';
      await interaction.update({
        components: [cardsBrowserPanel(bot, db, filter, 0)],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (action === 'pageinfo') {
      // Display-only button; nothing to do but acknowledge if Discord ever fires it.
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (action === 'create') {
      const modal = new ModalBuilder()
        .setCustomId(bot.customId('prov-create'))
        .setTitle('Create card provider')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('name')
              .setLabel('Provider Name')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMinLength(1)
              .setMaxLength(16),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('zip')
              .setLabel('Zip Code')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(10),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('exp_date')
              .setLabel('Exp Date (MM/YY)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setPlaceholder('05/30')
              .setMaxLength(7),
          ),
        );
      await interaction.showModal(modal);
      return;
    }

    if (action === 'edit') {
      const modal = new ModalBuilder()
        .setCustomId(bot.customId('prov-edit'))
        .setTitle('Edit card provider')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('name')
              .setLabel('Provider Name (which one to edit)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMinLength(1)
              .setMaxLength(16),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('new_name')
              .setLabel('New Name (blank = keep existing)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(16),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('zip')
              .setLabel('Zip Code (blank = keep existing)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(10),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('exp_date')
              .setLabel('Exp Date MM/YY (blank = keep existing)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setPlaceholder('05/30')
              .setMaxLength(7),
          ),
        );
      await interaction.showModal(modal);
      return;
    }

    if (action === 'erase') {
      const modal = new ModalBuilder()
        .setCustomId(bot.customId('prov-erase'))
        .setTitle('Erase provider cards')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('name')
              .setLabel('Provider Name (cards will be wiped)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMinLength(1)
              .setMaxLength(16),
          ),
        );
      await interaction.showModal(modal);
      return;
    }

    if (action === 'delete') {
      const modal = new ModalBuilder()
        .setCustomId(bot.customId('prov-delete'))
        .setTitle('Delete card provider')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('name')
              .setLabel('Provider Name (provider + cards gone)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMinLength(1)
              .setMaxLength(16),
          ),
        );
      await interaction.showModal(modal);
      return;
    }
  };
}

export function providersCreateModalHandler({ db, env, bot, logger }) {
  const gate = requireAdmin(env);
  return async function (interaction) {
    if (!(await gate(interaction))) return;
    const name = interaction.fields.getTextInputValue('name').trim();
    const zipRaw = interaction.fields.getTextInputValue('zip')?.trim();
    const zip = zipRaw || undefined;
    const expDateRaw = interaction.fields.getTextInputValue('exp_date')?.trim();
    const expDate = expDateRaw || undefined;

    // Provider name doubles as the id (used in button custom_ids), so it has to be
    // safe characters: letters, digits, underscores, hyphens.
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      await postError(
        interaction,
        'Provider Name can only contain letters, digits, underscores, or hyphens.',
      );
      return;
    }
    // Loose MM/YY validation — accept "5/30", "05/30", "05/2030".
    if (expDate && !/^(0?[1-9]|1[0-2])\/(\d{2}|\d{4})$/.test(expDate)) {
      await postError(
        interaction,
        'Exp Date must be in MM/YY or MM/YYYY format (e.g. 05/30).',
      );
      return;
    }

    try {
      addProvider(db, { id: name, name, zip, expDate });
    } catch (err) {
      await postError(interaction, `Could not create: ${err.message}`);
      return;
    }

    const container = providersPanel(bot, db);
    await interaction.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  };
}

export function providersEditModalHandler({ db, env, bot, logger }) {
  const gate = requireAdmin(env);
  return async function (interaction) {
    if (!(await gate(interaction))) return;
    const name = interaction.fields.getTextInputValue('name').trim();
    const newNameRaw = interaction.fields.getTextInputValue('new_name')?.trim();
    const zipRaw = interaction.fields.getTextInputValue('zip')?.trim();
    const expDateRaw = interaction.fields.getTextInputValue('exp_date')?.trim();

    // Case-insensitive lookup so "venture" matches "Venture" — the panel shows
    // ids exactly as stored, but admins shouldn't have to memorize capitalization.
    const providers = listProviders(db);
    const found = providers.find(
      (p) => p.id.toLowerCase() === name.toLowerCase(),
    );
    if (!found) {
      await postError(interaction, `Unknown card provider \`${name}\`.`);
      return;
    }

    if (expDateRaw && !/^(0?[1-9]|1[0-2])\/(\d{2}|\d{4})$/.test(expDateRaw)) {
      await postError(
        interaction,
        'Exp Date must be in MM/YY or MM/YYYY format (e.g. 05/30).',
      );
      return;
    }

    // New name validation — same charset as Create, must not collide with another provider.
    let newId;
    if (newNameRaw && newNameRaw.toLowerCase() !== found.id.toLowerCase()) {
      if (!/^[a-zA-Z0-9_-]+$/.test(newNameRaw)) {
        await postError(
          interaction,
          'New Name can only contain letters, digits, underscores, or hyphens.',
        );
        return;
      }
      const collision = providers.find(
        (p) => p.id !== found.id && p.id.toLowerCase() === newNameRaw.toLowerCase(),
      );
      if (collision) {
        await postError(interaction, `Provider \`${newNameRaw}\` already exists.`);
        return;
      }
      newId = newNameRaw;
    }

    // Build the update payload. Empty inputs = keep existing.
    const updates = {};
    if (newId) updates.newId = newId;
    if (zipRaw) updates.zip = zipRaw;
    if (expDateRaw) updates.expDate = expDateRaw;
    if (Object.keys(updates).length === 0) {
      await postError(interaction, 'Nothing to update, fill at least one field.');
      return;
    }

    const result = editProvider(db, { id: found.id, ...updates });
    logger?.info(
      { admin: interaction.user.id, providerId: found.id, ...updates, renamed: result.renamed },
      'edited provider',
    );

    const container = providersPanel(bot, db);
    await interaction.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  };
}

export function providersEraseModalHandler({ db, env, bot, logger }) {
  const gate = requireAdmin(env);
  return async function (interaction) {
    if (!(await gate(interaction))) return;
    const name = interaction.fields.getTextInputValue('name').trim();
    const found = listProviders(db).find((p) => p.id === name);
    if (!found) {
      await postError(interaction, `Unknown card provider \`${name}\`.`);
      return;
    }
    const removed = eraseProviderCards(db, name);
    logger?.info({ admin: interaction.user.id, providerId: name, removed }, 'erased provider cards');
    const container = providersPanel(bot, db);
    await interaction.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  };
}

export function providersDeleteModalHandler({ db, env, bot, logger }) {
  const gate = requireAdmin(env);
  return async function (interaction) {
    if (!(await gate(interaction))) return;
    const name = interaction.fields.getTextInputValue('name').trim();
    const found = listProviders(db).find((p) => p.id === name);
    if (!found) {
      await postError(interaction, `Unknown card provider \`${name}\`.`);
      return;
    }
    const { cardsDeleted } = deleteProvider(db, name);
    logger?.warn(
      { admin: interaction.user.id, providerId: name, cardsDeleted },
      'deleted provider',
    );
    const container = providersPanel(bot, db);
    await interaction.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  };
}

/* ============================================================== /loadcards + /loademails */

/**
 * /load cards|emails — unified loader. Subcommand picks the type; the handler
 * dispatches to the right parser + table.
 */
export function loadHandler({ db, env, bot, logger }) {
  const gate = requireAdmin(env);
  return async function (interaction) {
    if (!(await gate(interaction))) return;

    // Silent ack — invisible ephemeral, delete. Result posted as a regular channel message.
    await interaction.reply({ content: '​', flags: MessageFlags.Ephemeral });
    try {
      await interaction.deleteReply();
    } catch {
      // ignore
    }

    const type = interaction.options.getString('type', true);
    const provider = interaction.options.getString('provider', true);
    const file = interaction.options.getAttachment('file', true);
    const mode = interaction.options.getString('mode') ?? 'append';
    const channel = await interaction.client.channels.fetch(interaction.channelId);

    // The silent-ack reply is already deleted, so a fetch failure has no reply to fall
    // back on — surface it as a channel message instead of throwing unhandled.
    let text;
    try {
      text = await fetch(file.url).then((r) => r.text());
    } catch (err) {
      logger?.error({ err: err.message, admin: interaction.user.id }, 'load: attachment fetch failed');
      await channel.send({ content: '❌ Failed to download the uploaded file. Please try again.' });
      return;
    }

    if (type === 'cards') {
      const found = listProviders(db).find((p) => p.id === provider);
      if (!found) {
        await channel.send({ content: `❌ Unknown card provider \`${provider}\`.` });
        return;
      }
      const parsed = parseCardFile(text);
      if (!parsed.length) {
        await channel.send({ content: '❌ No valid card lines found in that file.' });
        return;
      }
      const { inserted, skipped } = loadCards(db, provider, parsed, { mode });
      logger?.info({ provider, inserted, skipped, mode }, 'loaded cards');
        const skippedNote = skipped > 0 ? ` (skipped ${skipped} duplicate${skipped === 1 ? '' : 's'})` : '';
      await channel.send({
        content: `✅ Loaded **${inserted}** card${inserted === 1 ? '' : 's'} into \`${found.name}\` (${mode})${skippedNote}.`,
      });
      return;
    }
  };
}

/**
 * /export cards|emails — DMs the admin a .txt dump of the chosen provider's
 * data, in the same format /load expects on re-import. Ephemeral so sensitive
 * data (card numbers, account passwords) doesn't broadcast to the channel.
 */
export function exportHandler({ db, env, logger }) {
  const gate = requireAdmin(env);
  return async function (interaction) {
    if (!(await gate(interaction))) return;

    const type = interaction.options.getString('type', true);
    const provider = interaction.options.getString('provider', true);

    let text;
    let filename;
    if (type === 'cards') {
      const found = listProviders(db).find((p) => p.id === provider);
      if (!found) {
        await postError(interaction, `Unknown card provider \`${provider}\`.`);
        return;
      }
      text = exportCardsForProvider(db, provider);
      filename = `cards-${provider}.txt`;
    } else {
      return;
    }

    if (!text) {
      await postError(interaction, `No ${type} found for \`${provider}\`.`);
      return;
    }

    const file = new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: filename });
    // Ephemeral: the attachment contains full card numbers, CVVs and expiries — it must
    // be visible only to the admin who ran /export, never posted to the channel.
    await interaction.reply({ files: [file], flags: MessageFlags.Ephemeral });
    logger?.info({ admin: interaction.user.id, type, provider }, 'exported');
  };
}

/* ============================================================== /purge */

export function purgeHandler({ env, bot }) {
  const gate = requireAdmin(env);
  return async function (interaction) {
    if (!(await gate(interaction))) return;

    const container = new ContainerBuilder()
      .setAccentColor(0xed4245)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          [
            '### ⚠️  Wipe ALL bot data?',
            '',
            'This permanently deletes:',
            '• All cards',
            '• All providers',
            '• All channel whitelists',
            '• All in-flight card sessions',
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

/* ============================================================== /purge buttons */

export function purgeButtonHandler({ db, env, logger }) {
  const gate = requireAdmin(env);
  return async function (interaction, args) {
    if (!(await gate(interaction))) return;
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
      logger?.warn(
        { userId: interaction.user.id, channelId: interaction.channelId, counts },
        'all data purged',
      );

      const container = new ContainerBuilder()
        .setAccentColor(0x57f287)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            [
              '### ✅  Wiped clean.',
              '',
              `• ${counts.cards} cards`,
              `• ${counts.providers} providers`,
              `• ${counts.whitelist} channel rules`,
              `• ${counts.card_sessions} card sessions`,
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

/* ============================================================ /stats */

export const statsCmd = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('Daily worker stats');

function buildStatsPayload(db, bot, { tab, pageIdx }) {
  const windowStart = tab === 'week' ? startOfWeekEastern() : startOfTodayEastern();
  const since = Math.max(windowStart, getStatsClearAt(db));
  const rows = getDailyWorkerStats(db, since);
  const prices = getPrices(db);
  const costOf = (r) => r.cards * prices.card;
  const sorted = [...rows].sort((a, b) => costOf(b) - costOf(a));
  return v2Payload(
    workersStatsPageContainer({ bot, tab, sorted, pageIdx, prices }),
  );
}

export function statsHandler({ db, env, bot }) {
  const gate = requireAdmin(env);
  return async function handle(interaction) {
    if (!(await gate(interaction))) return;
    await interaction.reply(buildStatsPayload(db, bot, { tab: 'today', pageIdx: 0 }));
  };
}

export function statsButtonHandler({ db, env, bot }) {
  const gate = requireAdmin(env);
  return async function handle(interaction, args) {
    if (!(await gate(interaction))) return;
    const [kind, ...rest] = args;
    if (kind === 'tab') {
      // [tab, today|week] — switch tab, reset to page 0
      const tab = rest[0] === 'week' ? 'week' : 'today';
      await interaction.update(buildStatsPayload(db, bot, { tab, pageIdx: 0 }));
      return;
    }
    if (kind === 'nav') {
      // [nav, today|week, pageIdx]  or  [nav, noop]
      if (rest[0] === 'noop') return; // disabled middle button — shouldn't fire
      const tab = rest[0] === 'week' ? 'week' : 'today';
      const pageIdx = parseInt(rest[1] ?? '0', 10) || 0;
      await interaction.update(buildStatsPayload(db, bot, { tab, pageIdx }));
      return;
    }
  };
}

/**
 * Midnight cleanup. Wipes everything safe to reset on a daily cadence:
 *   - claim_history (cards) — stats source
 *   - stock_alerts — re-arms low-stock countdown notifications
 *   - orphan card sessions older than 24h — abandoned claims
 * Then bumps stats_clear_at so /stats reads cleanly past the cut.
 */
export function resetDailyStats(db) {
  purgeClaimHistory(db);
  purgeStockAlerts(db);
  purgeOrphanSessions(db);
  setStatsClearAt(db, Date.now());
}

/**
 * Schedule a Monday 12 AM EST wipe of claim_history + stock_alerts +
 * orphan sessions. The /stats Week tab needs 7 days of data
 * available, so a daily wipe would defeat the purpose — weekly cadence aligns
 * with the Mon-Sun stats window. Re-arms itself each tick so the next fire is
 * always exactly the upcoming Monday midnight EST.
 */
export function scheduleWeeklyStatsReset(db, logger) {
  const fire = () => {
    try {
      resetDailyStats(db);
      logger?.info('weekly stats auto-cleared at Monday 12 AM EST');
    } catch (err) {
      logger?.warn({ err: err.message }, 'weekly stats clear failed');
    }
    schedule();
  };
  const schedule = () => {
    // startOfWeekEastern() returns *this* week's Monday 12 AM EST; +7d = next.
    const nextMonday = startOfWeekEastern() + 7 * 86_400_000;
    const ms = Math.max(60_000, nextMonday - Date.now());
    const t = setTimeout(fire, ms);
    t.unref?.();
  };
  schedule();
}

/* ============================================================ /setprice */

const PRICE_CHOICES = [
  { name: 'card', value: 'card' },
];

export const setPriceCmd = new SlashCommandBuilder()
  .setName('setprice')
  .setDescription('Set unit price for stats')
  .addStringOption((o) =>
    o.setName('kind').setDescription('What to price').setRequired(true).addChoices(...PRICE_CHOICES),
  )
  .addNumberOption((o) =>
    o.setName('amount').setDescription('USD Amount').setRequired(true).setMinValue(0),
  );

export function setPriceHandler({ db, env }) {
  const gate = requireAdmin(env);
  return async function handle(interaction) {
    if (!(await gate(interaction))) return;
    const kind = interaction.options.getString('kind', true);
    const amount = interaction.options.getNumber('amount', true);
    if (!PRICE_KINDS.includes(kind)) {
      await postError(interaction, `Unknown kind: ${kind}.`);
      return;
    }
    const cents = Math.round(amount * 100);
    setPrice(db, kind, cents);
    await interaction.reply({
      content: `✅ ${kind} price set to **$${(cents / 100).toFixed(2)}**.`,
      flags: MessageFlags.Ephemeral,
    });
  };
}

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js';

/**
 * Build a Discord.js client + a small handler router.
 *
 * The router is the main value-add over raw discord.js: each bot defines slash
 * commands, buttons, and modals declaratively, and the router dispatches
 * Discord interactions to the right handler based on either the command name
 * or the customId namespace prefix.
 *
 * customId convention: `<botPrefix>:<action>:<arg1>:<arg2>...`
 * Example: `codebot:request:email`, `aiobot:status:used:userId-123`
 *
 * Each bot picks its own `botPrefix` (e.g. 'codebot') and registers handlers by
 * (action, fn). The router strips the prefix before matching.
 */
export class DiscordBot {
  /**
   * @param {object} opts
   * @param {string} opts.token
   * @param {string} opts.clientId
   * @param {string|null} [opts.guildId]      If set, slash commands register only to this guild (instant). If null, global (slow propagation).
   * @param {string} opts.botPrefix           Custom-ID prefix used by this bot (e.g. 'codebot')
   * @param {GatewayIntentBits[]|number[]} [opts.intents]
   * @param {object} [opts.logger]
   */
  constructor({ token, clientId, guildId = null, botPrefix, intents, logger }) {
    if (!token || !clientId || !botPrefix) {
      throw new Error('DiscordBot: token, clientId, botPrefix are required');
    }

    this.token = token;
    this.clientId = clientId;
    this.guildId = guildId;
    this.prefix = botPrefix;
    this.logger = logger;

    this.client = new Client({
      intents: intents ?? [GatewayIntentBits.Guilds],
    });

    this.commands = new Map(); // name -> { definition, handler }
    this.buttonHandlers = new Map(); // action -> handler
    this.modalHandlers = new Map(); // action -> handler
    this.selectHandlers = new Map(); // action -> handler
    this.autocompleteHandlers = new Map(); // commandName -> handler

    this.client.on(Events.InteractionCreate, (i) => this.dispatch(i));
    this.client.on(Events.Error, (err) => {
      if (this.logger) this.logger.error({ err: err.message }, 'discord client error');
    });
  }

  /**
   * Register a slash command + its handler.
   * @param {object} definition  Discord.js SlashCommandBuilder or its plain JSON form
   * @param {(interaction: import('discord.js').ChatInputCommandInteraction) => Promise<void>} handler
   */
  command(definition, handler) {
    const json =
      typeof definition.toJSON === 'function' ? definition.toJSON() : definition;
    this.commands.set(json.name, { definition: json, handler });
    return this;
  }

  /**
   * Register a button handler keyed by its action segment.
   *   bot.button('request', async (i, args) => { ... })
   * matches custom IDs like `codebot:request:email`.
   * `args` is an array of the segments after the action.
   */
  button(action, handler) {
    this.buttonHandlers.set(action, handler);
    return this;
  }

  modal(action, handler) {
    this.modalHandlers.set(action, handler);
    return this;
  }

  select(action, handler) {
    this.selectHandlers.set(action, handler);
    return this;
  }

  /**
   * Register an autocomplete handler for a slash command. The handler receives the
   * autocomplete interaction and is responsible for calling `interaction.respond([...])`
   * with up to 25 suggestions.
   *
   *   bot.autocomplete('renew', async (i) => {
   *     const focused = i.options.getFocused(true);
   *     if (focused.name !== 'number') return i.respond([]);
   *     ...
   *   });
   */
  autocomplete(commandName, handler) {
    this.autocompleteHandlers.set(commandName, handler);
    return this;
  }

  /** Build a custom_id from segments, prefixed with the bot's namespace. */
  customId(action, ...args) {
    return [this.prefix, action, ...args].join(':');
  }

  /** Parse a custom_id, returning { action, args } if it matches this bot's prefix; null otherwise. */
  parseCustomId(customId) {
    const parts = customId.split(':');
    if (parts[0] !== this.prefix) return null;
    return { action: parts[1], args: parts.slice(2) };
  }

  async dispatch(interaction) {
    try {
      if (interaction.isChatInputCommand()) {
        const entry = this.commands.get(interaction.commandName);
        if (!entry) return;
        await entry.handler(interaction);
        return;
      }

      if (interaction.isAutocomplete()) {
        const handler = this.autocompleteHandlers.get(interaction.commandName);
        if (!handler) {
          await interaction.respond([]).catch(() => {});
          return;
        }
        await handler(interaction);
        return;
      }

      const customId = interaction.customId ?? null;
      if (!customId) return;
      const parsed = this.parseCustomId(customId);
      if (!parsed) return;

      const { action, args } = parsed;
      let handler = null;
      if (interaction.isButton()) handler = this.buttonHandlers.get(action);
      else if (interaction.isModalSubmit()) handler = this.modalHandlers.get(action);
      else if (interaction.isAnySelectMenu()) handler = this.selectHandlers.get(action);

      if (!handler) {
        if (this.logger) this.logger.warn({ customId, action }, 'no handler for interaction');
        return;
      }

      await handler(interaction, args);
    } catch (err) {
      if (this.logger)
        this.logger.error(
          { err: err?.message ?? String(err), stack: err?.stack, customId: interaction.customId },
          'interaction handler threw',
        );
      try {
        if (interaction.isAutocomplete()) {
          // Autocomplete interactions are not repliable; close them with an empty
          // completion so the client doesn't show a stale loading indicator until timeout.
          await interaction.respond([]);
        } else {
          const reply = {
            content: 'Something went wrong handling that. Try again, or ping an admin.',
            flags: MessageFlags.Ephemeral,
          };
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp(reply);
          } else if (interaction.isRepliable?.()) {
            await interaction.reply(reply);
          }
        }
      } catch {
        // double-fault — give up, the original error is logged
      }
    }
  }

  /**
   * Push command definitions to Discord (guild or global). Returns the registered list.
   *
   * A `PUT` to Discord's command endpoint is a full replace, so an empty body would
   * permanently delete every existing slash command for this application. We guard
   * against that: with no registered commands this is a no-op (returns `[]`) unless
   * the caller explicitly opts into wiping commands via `{ allowEmpty: true }`.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.allowEmpty=false]  Permit an empty PUT (deletes all commands).
   */
  async registerCommands({ allowEmpty = false } = {}) {
    const body = [...this.commands.values()].map((c) => c.definition);

    if (body.length === 0 && !allowEmpty) {
      if (this.logger)
        this.logger.warn(
          { scope: this.guildId ? 'guild' : 'global' },
          'registerCommands: no commands registered; skipping PUT to avoid wiping existing commands (pass { allowEmpty: true } to override)',
        );
      return [];
    }

    const rest = this.rest ?? new REST({ version: '10' }).setToken(this.token);

    const route = this.guildId
      ? Routes.applicationGuildCommands(this.clientId, this.guildId)
      : Routes.applicationCommands(this.clientId);

    const result = await rest.put(route, { body });
    if (this.logger)
      this.logger.info(
        { count: body.length, scope: this.guildId ? 'guild' : 'global' },
        'registered slash commands',
      );
    return result;
  }

  async start({ registerCommands = true } = {}) {
    if (registerCommands) await this.registerCommands();
    await this.client.login(this.token);
    if (this.logger) this.logger.info('discord client logged in');
    return this.client;
  }

  async stop() {
    try {
      await this.client.destroy();
    } catch (err) {
      if (this.logger) this.logger.warn({ err: err.message }, 'error during discord stop');
    }
  }
}

/**
 * Convenience helper: send a quick ephemeral text reply.
 */
export async function ephemeral(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral };
  if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
  return interaction.reply(payload);
}

/**
 * Send an ephemeral error reply.
 */
export async function ephemeralError(interaction, message) {
  return ephemeral(interaction, `❌ ${message}`);
}

/**
 * Build a permission predicate that returns true if the member has ANY of the named roles.
 */
export function hasAnyRole(roleNames) {
  const wanted = new Set(roleNames.map((r) => r.toLowerCase()));
  return (interaction) => {
    const member = interaction.member;
    if (!member?.roles?.cache) return false;
    for (const role of member.roles.cache.values()) {
      if (wanted.has(role.name.toLowerCase())) return true;
    }
    return false;
  };
}

export { GatewayIntentBits, EmbedBuilder, MessageFlags };

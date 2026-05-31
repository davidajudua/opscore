import { z } from '@platform/bot-core/env';

export const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  DISCORD_GUILD_ID: z.string().min(1, 'DISCORD_GUILD_ID is required'),
  DISCORD_CHANNEL_ID: z.string().min(1, 'DISCORD_CHANNEL_ID is required'),

  PROTON_IMAP_USER: z.string().min(1, 'PROTON_IMAP_USER is required'),
  PROTON_IMAP_PASS: z.string().min(1, 'PROTON_IMAP_PASS is required'),
  PROTON_IMAP_HOST: z.string().default('127.0.0.1'),
  PROTON_IMAP_PORT: z.coerce.number().int().positive().default(1143),
  MAIL_FOLDER: z.string().default('INBOX'),

  // Optional: enable a second code source that polls a Discord channel where a
  // webhook (e.g. "Forward SMS for iOS") posts Amex SafeKey codes. Both env vars
  // must be set together — if either is missing, the webhook fetcher is disabled
  // and the bot runs IMAP-only (backwards compatible).
  WEBHOOK_CODE_CHANNEL_ID: z.string().optional(),
  WEBHOOK_CODE_AUTHOR_ID: z.string().optional(),

  LOG_LEVEL: z.string().default('info'),
});

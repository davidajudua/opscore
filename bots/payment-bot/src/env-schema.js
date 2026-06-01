import { z } from '@platform/bot-core/env';

const optionalString = z.string().optional().or(z.literal('')).transform((v) => (v ? v : undefined));

export const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_PAYMENT_CHANNEL_ID: z.string().min(1),

  GMAIL_ADDRESS_ZELLE: optionalString,
  GMAIL_APP_PASSWORD_ZELLE: optionalString,
  GMAIL_ADDRESS_VENMO: optionalString,
  GMAIL_APP_PASSWORD_VENMO: optionalString,
  GMAIL_ADDRESS_PAYPAL: optionalString,
  GMAIL_APP_PASSWORD_PAYPAL: optionalString,

  // Crypto address book — match any tx whose recipient equals one of these.
  CRYPTO_ADDRESS_BTC: optionalString,
  CRYPTO_ADDRESS_ETH: optionalString,
  CRYPTO_ADDRESS_LTC: optionalString,
  CRYPTO_ADDRESS_SOL: optionalString,
  CRYPTO_ADDRESS_TRX: optionalString,

  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  ADMIN_ROLE_NAME: z.string().default('owner'),
  LOG_LEVEL: z.string().default('info'),

  // /refund — channel where pending requests are posted.
  REFUND_CHANNEL_ID: optionalString,
});

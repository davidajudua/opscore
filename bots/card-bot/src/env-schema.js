import { z } from '@platform/bot-core/env';

const GENERATE_KEY =
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`;

// 32 bytes in base64 is exactly 43 characters plus one '=' of padding.
const cardEncryptionKey = z
  .string({ required_error: `is required. Generate one with: ${GENERATE_KEY}` })
  .trim()
  .regex(/^[A-Za-z0-9+/]{43}=$/, `must be 32 random bytes in base64. Generate one with: ${GENERATE_KEY}`)
  .transform((v) => Buffer.from(v, 'base64'));

export const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),

  ADMIN_ROLE_NAME: z.string().default('owner'),

  CARD_ENCRYPTION_KEY: cardEncryptionKey,

  LOG_LEVEL: z.string().default('info'),
});

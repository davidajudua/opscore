import { z } from '@platform/bot-core/env';

export const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),

  ADMIN_ROLE_NAME: z.string().default('owner'),

  LOG_LEVEL: z.string().default('info'),
});

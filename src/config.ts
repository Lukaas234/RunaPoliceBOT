import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_PATH: z.string().default('./data/run-a-police.sqlite'),
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  DISCORD_REDIRECT_URI: z.string().url(),
  DISCORD_GUILD_ID: z.string().regex(/^\d{17,20}$/),
  SESSION_SECRET: z.string().min(32),
  APP_BASE_URL: z.string().url(),
  BOOTSTRAP_ADMIN_ROLE_IDS: z.string().default('')
});

// Bot-Hosting exposes the public service port as SERVER_PORT; PORT remains a local fallback.
const parsed = schema.safeParse({ ...process.env, PORT: process.env.SERVER_PORT ?? process.env.PORT ?? '3000' });
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  throw new Error('Set the required environment variables from .env.example');
}

export const config = {
  ...parsed.data,
  bootstrapAdminRoleIds: parsed.data.BOOTSTRAP_ADMIN_ROLE_IDS.split(',').map(v => v.trim()).filter(Boolean),
  // The hosted app is always served over HTTPS even if the panel does not set NODE_ENV.
  // Derive cookie security from the public URL so OAuth cookies are accepted reliably.
  secureCookies: parsed.data.NODE_ENV === 'production' || new URL(parsed.data.APP_BASE_URL).protocol === 'https:'
};

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
require("dotenv/config");
const zod_1 = require("zod");
const schema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'test', 'production']).default('development'),
    PORT: zod_1.z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: zod_1.z.string().default('0.0.0.0'),
    DATABASE_PATH: zod_1.z.string().default('./data/run-a-police.sqlite'),
    DISCORD_TOKEN: zod_1.z.string().min(1),
    DISCORD_CLIENT_ID: zod_1.z.string().min(1),
    DISCORD_CLIENT_SECRET: zod_1.z.string().min(1),
    DISCORD_REDIRECT_URI: zod_1.z.string().url(),
    DISCORD_GUILD_ID: zod_1.z.string().regex(/^\d{17,20}$/),
    SESSION_SECRET: zod_1.z.string().min(32),
    APP_BASE_URL: zod_1.z.string().url(),
    BOOTSTRAP_ADMIN_ROLE_IDS: zod_1.z.string().default('')
});
// Bot-Hosting exposes the public service port as SERVER_PORT; PORT remains a local fallback.
const parsed = schema.safeParse({ ...process.env, PORT: process.env.SERVER_PORT ?? process.env.PORT ?? '3000' });
if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    throw new Error('Set the required environment variables from .env.example');
}
exports.config = {
    ...parsed.data,
    bootstrapAdminRoleIds: parsed.data.BOOTSTRAP_ADMIN_ROLE_IDS.split(',').map(v => v.trim()).filter(Boolean),
    // The hosted app is always served over HTTPS even if the panel does not set NODE_ENV.
    // Derive cookie security from the public URL so OAuth cookies are accepted reliably.
    secureCookies: parsed.data.NODE_ENV === 'production' || new URL(parsed.data.APP_BASE_URL).protocol === 'https:'
};

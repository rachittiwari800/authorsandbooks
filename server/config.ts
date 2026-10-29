import 'dotenv/config';

const nodeEnv = process.env.NODE_ENV || 'development';
const sessionSecret = process.env.SESSION_SECRET || (nodeEnv === 'test' ? 'test-only-session-secret-not-for-deployment' : '');
const seedPassword = process.env.SEED_PASSWORD || (nodeEnv === 'test' ? 'test-only-bookleaf-password' : '');
const cookieSecure = (process.env.COOKIE_SECURE || (nodeEnv === 'production' ? 'true' : 'false')).toLowerCase() === 'true';
const cookieSameSite = (process.env.COOKIE_SAME_SITE || 'lax') as 'lax' | 'strict' | 'none';
const enableDemoAccounts = process.env.ENABLE_DEMO_ACCOUNTS === 'true' || nodeEnv !== 'production';

if (sessionSecret.length < 32) {
  throw new Error('Set a unique SESSION_SECRET of at least 32 characters before starting the application.');
}
if (enableDemoAccounts && seedPassword.length < 12) {
  throw new Error('Set a unique SEED_PASSWORD of at least 12 characters before starting local demo accounts.');
}
if (cookieSameSite === 'none' && !cookieSecure) {
  throw new Error('COOKIE_SECURE must be true when COOKIE_SAME_SITE=none.');
}
if (nodeEnv === 'production' && process.env.ENABLE_DEMO_ACCOUNTS === 'true') {
  throw new Error('Demo accounts must not be enabled in production.');
}

export const config = {
  port: Number(process.env.PORT || 3001),
  sessionSecret,
  nodeEnv,
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  databaseUrl: process.env.DATABASE_URL || './bookleaf.db',
  seedPassword,
  enableDemoAccounts,
  openAiKey: process.env.OPENAI_API_KEY || '',
  openAiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  cookieSecure,
  cookieSameSite,
};

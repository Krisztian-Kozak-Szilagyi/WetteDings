function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Umgebungsvariable ${name} fehlt (siehe .env.example).`);
  return value;
}

function eurosToCents(value, fallbackEuros) {
  const n = Number(value);
  return Math.round((Number.isFinite(n) && n > 0 ? n : fallbackEuros) * 100);
}

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

function parseTrustProxy(value) {
  if (value === undefined || value === '') return isProd ? 1 : false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

const sessionSecret = required('SESSION_SECRET');
if (isProd && sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET muss in Produktion mindestens 32 Zeichen lang sein.');
}

module.exports = {
  env,
  isProd,
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '127.0.0.1',
  mongoUri: required('MONGODB_URI'),
  sessionSecret,
  appName: process.env.APP_NAME || 'Wettstube',
  timezone: 'Europe/Berlin',
  // Alle Geldbeträge werden intern in Cent (Ganzzahlen) gespeichert.
  startBalance: eurosToCents(process.env.START_BALANCE_EUR, 1000),
  minStake: eurosToCents(process.env.MIN_STAKE_EUR, 1),
  adminUsernames: (process.env.ADMIN_USERNAMES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  autoVoidDays: Number(process.env.AUTO_VOID_DAYS) || 14,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  secureCookies: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd,
};

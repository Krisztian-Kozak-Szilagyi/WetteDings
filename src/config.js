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
  appName: process.env.APP_NAME || 'BfW Holdings',
  timezone: 'Europe/Berlin',
  // Alle Geldbeträge werden intern in Cent (Ganzzahlen) gespeichert.
  startBalance: eurosToCents(process.env.START_BALANCE_EUR, 1000),
  minStake: eurosToCents(process.env.MIN_STAKE_EUR, 1),
  adminUsernames: (process.env.ADMIN_USERNAMES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  autoVoidDays: Number(process.env.AUTO_VOID_DAYS) || 14,
  // Tagesbonus für alle (unabhängig vom Vermögen), in Cent. Standardwert – im Admin-Panel änderbar.
  dailyBonus: eurosToCents(process.env.DAILY_BONUS_EUR, 100),
  // Ab dieser Uhrzeit (deutsche Zeit, "HH:MM") gibt es den Tagesbonus des neuen Tages
  bonusTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(process.env.BONUS_TIME || '') ? process.env.BONUS_TIME : '07:45',
  // Lotterie: Lospreis und Startzeit der täglichen Lotterie (deutsche Zeit, "HH:MM").
  // Die Ziehung ist immer 1 Minute vor dem Start der nächsten Lotterie.
  lotteryTicketPrice: eurosToCents(process.env.LOTTERY_TICKET_EUR, 100),
  lotteryTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(process.env.LOTTERY_TIME || '') ? process.env.LOTTERY_TIME : '20:00',
  lotteryMaxTicketsPerPurchase: 10,
  // Einladungslinks: Booster Packs für den Einlader je neuem Mitglied. Standardwert – im Admin-Panel änderbar.
  inviteRewardPacks: Math.min(20, Math.max(0, Number.parseInt(process.env.INVITE_REWARD_PACKS, 10) || 1)),
  // TCG: Preis eines Booster Packs (5 Karten)
  tcgPackPrice: eurosToCents(process.env.TCG_PACK_EUR, 90),
  // Support-Bot (Groq API). Ohne Schlüssel ist der Chat ausgeblendet.
  groqApiKey: process.env.GROQ_API_KEY || '',
  // Modelle der Reihe nach (bei Limit/Überlastung wird das nächste versucht), kommagetrennt
  groqModels: (process.env.GROQ_MODELS || 'openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Gesamtprovision in % vom Topf (gilt für neu erstellte Wetten). Wettersteller und
  // Schiedsrichter teilen sie sich zur Hälfte (siehe lib/payout → splitFee).
  creatorFeePercent: Math.min(100, Math.max(0, Number(process.env.CREATOR_FEE_PERCENT ?? 8) || 0)),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  secureCookies: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd,
};

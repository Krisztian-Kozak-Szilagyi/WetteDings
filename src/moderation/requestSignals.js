// Manipulationserkennung, Teil "kein normaler Browser": merkt sich bei jeder Spiel-Aktion (POST), ob sie aus einem
// normalen Browser kommt. Läuft neben der Anfrage her – Fehler werden nur ausgegeben und verzögern nichts.
// Ausgewertet wird das in suspicionService.js (browserFinding in suspicionLogic.js).
const config = require('../config');
const ScriptSignal = require('../models/ScriptSignal');
const { toZonedLocalInput } = require('../lib/time');

// Bereiche, deren Formulare als Spiel-Aktion zählen (erster Pfadteil)
const GAME_AREAS = new Set(['tcg', 'inventar', 'handel', 'ihk', 'dungeon', 'grading', 'broker', 'wetten', 'duell', 'lotterie']);
// Hintergrund-Abfragen der Seiten zählen nicht (Chat, "gesehen"-Meldungen)
const IGNORE = /^\/dungeon\/(chat|beute-gesehen)\b/;
// Skript-Werkzeuge und Headless-Browser im User-Agent
const BOT_UA = /HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium|python|curl|wget|axios|node-fetch|undici|got\/|Go-http|okhttp|Java\/|libwww|Scrapy|httpx|aiohttp|Postman|Insomnia/i;
const UA_MAX = 3;

const isGameAction = (req) => req.method === 'POST' && GAME_AREAS.has(String(req.path || '/').split('/')[1] || '') && !IGNORE.test(req.path);

/** Merkmale einer Anfrage: { noProbe, noFetchMeta, bare, webdriver, botUa } (je 0 oder 1) */
function signalsOf(req) {
  const ua = req.get('user-agent') || '';
  const noProbe = req.session && req.session.fp ? 0 : 1;
  const noFetchMeta = req.get('sec-fetch-mode') || req.get('sec-fetch-site') ? 0 : 1;
  return {
    noProbe,
    noFetchMeta,
    bare: noProbe && noFetchMeta ? 1 : 0,
    webdriver: req.session && req.session.webdriver ? 1 : 0,
    botUa: !ua || BOT_UA.test(ua) ? 1 : 0,
  };
}

function trackSignals(req, res, next) {
  if (req.user && isGameAction(req)) {
    const s = signalsOf(req);
    const now = new Date();
    const key = { user: req.user._id, day: toZonedLocalInput(now, config.timezone).slice(0, 10) };
    const odd = s.botUa || s.webdriver || s.bare;
    const ua = (req.get('user-agent') || '(leer)').slice(0, 120);
    ScriptSignal.updateOne(key, { $inc: { actions: 1, ...s }, $set: { lastAt: now }, $setOnInsert: { firstAt: now } }, { upsert: true })
      // auffälligen User-Agent merken, solange noch Platz ist (höchstens UA_MAX verschiedene)
      .then(() => odd && ScriptSignal.updateOne({ ...key, uas: { $ne: ua }, [`uas.${UA_MAX - 1}`]: { $exists: false } }, { $push: { uas: ua } }))
      .catch((err) => console.error('Skript-Merkmale:', err.message));
  }
  next();
}

module.exports = { trackSignals, signalsOf, isGameAction, BOT_UA };

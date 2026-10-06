// Manipulationserkennung: merkt sich bei jeder Spiel-Aktion (POST), ob sie aus einem normalen Browser kommt, ob vorher
// eine Seite geladen wurde (Aktions-Token, actionToken.js), wie lange danach abgeschickt wurde, ob es echte Eingaben
// gab, aus welchem Netz sie kommt und von welchem Gerät. Stufe 1: nur messen, nichts wird abgelehnt. Läuft neben der
// Anfrage her – Fehler werden nur ausgegeben und verzögern nichts. Ausgewertet in suspicionService.js.
const express = require('express');
const config = require('../config');
const ScriptSignal = require('../models/ScriptSignal');
const ActionTrace = require('../models/ActionTrace');
const { toZonedLocalInput } = require('../lib/time');
const { ipHash } = require('../device/deviceLogic');
const actionToken = require('./actionToken');
const network = require('./network');

// Bereiche, deren Formulare als Spiel-Aktion zählen (erster Pfadteil)
const GAME_AREAS = new Set(['tcg', 'inventar', 'handel', 'ihk', 'dungeon', 'grading', 'broker', 'wetten', 'duell', 'lotterie']);
// Hintergrund-Abfragen der Seiten zählen nicht (Chat, "gesehen"-Meldungen)
const IGNORE = /^\/dungeon\/(chat|beute-gesehen)\b/;
// Skript-Werkzeuge und Headless-Browser im User-Agent
const BOT_UA = /HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium|python|curl|wget|axios|node-fetch|undici|got\/|Go-http|okhttp|Java\/|libwww|Scrapy|httpx|aiohttp|Postman|Insomnia/i;
const LIST_MAX = 3; // so viele auffällige User-Agents bzw. Netzbetreiber merken wir je Tag
const FAST_MS = 400; // schneller kann niemand nach dem Laden einer Seite klicken (sie ist dann noch nicht einmal dargestellt)
const DWELL_MAX_MS = 10 * 60 * 1000; // längere Zeiten sagen nichts (Seite offen gelassen)
const DWELL_KEEP = 300; // so viele Reaktionszeiten je Tag
// Falle: unsichtbarer Link in jeder Seite (partials/head.ejs), den ein Mensch nie anklickt
const TRAP_PATH = '/tcg/gratis-packs';

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

/**
 * Aktions-Token und Eingaben einer Aktion: { inc, dwell, double }. double = Doppelklick (gleiches Token sofort
 * noch einmal) – dann wird nichts gezählt.
 */
function tokenSignals(req, userId, now = Date.now()) {
  const body = req.body || {};
  const tok = actionToken.check(req.get('x-action-token') || body._at, userId, now);
  const input = actionToken.parseInput(req.get('x-action-ev') || body._ev);
  return {
    double: tok.state === 'double',
    dwell: tok.state === 'ok' && tok.ageMs <= DWELL_MAX_MS ? tok.ageMs : null,
    inc: {
      tokenOk: tok.state === 'ok' ? 1 : 0,
      tokenMissing: tok.state === 'missing' ? 1 : 0,
      tokenBad: tok.state === 'bad' ? 1 : 0,
      tokenReused: tok.state === 'reused' ? 1 : 0,
      fast: tok.state === 'ok' && tok.ageMs < FAST_MS ? 1 : 0,
      withInput: input ? 1 : 0,
      noInput: input && input.trusted === 0 ? 1 : 0,
      synthetic: input && input.trusted === 0 && input.synthetic > 0 ? 1 : 0,
    },
  };
}

const dayKey = (userId, now) => ({ user: userId, day: toZonedLocalInput(now, config.timezone).slice(0, 10) });

/** Wert an eine Liste des Tages-Dokuments hängen, solange dort noch Platz ist (höchstens LIST_MAX verschiedene) */
const pushLimited = (key, field, value) => ScriptSignal.updateOne({ ...key, [field]: { $ne: value }, [`${field}.${LIST_MAX - 1}`]: { $exists: false } }, { $push: { [field]: value } });

function record(req) {
  const now = new Date();
  const userId = req.user._id;
  const t = tokenSignals(req, userId, now.getTime());
  if (t.double) return;
  const s = signalsOf(req);
  const net = network.lookup(req.ip);
  const hosting = net && net.hosting ? 1 : 0;
  const key = dayKey(userId, now);
  const update = { $inc: { actions: 1, ...s, ...t.inc, hosting }, $set: { lastAt: now }, $setOnInsert: { firstAt: now } };
  if (t.dwell !== null) update.$push = { dwell: { $each: [t.dwell], $slice: -DWELL_KEEP } };
  const ua = (req.get('user-agent') || '(leer)').slice(0, 120);
  ScriptSignal.updateOne(key, update, { upsert: true })
    .then(() => (s.botUa || s.webdriver || s.bare ? pushLimited(key, 'uas', ua) : null))
    .then(() => (hosting ? pushLimited(key, 'nets', `${net.org || 'unbekannt'} (AS${net.asn})`) : null))
    .catch((err) => console.error('Skript-Merkmale:', err.message));
  ActionTrace.create({ user: userId, dev: req.deviceId ? String(req.deviceId).slice(0, 12) : null, net: req.ip ? ipHash(config.sessionSecret, network.netOf(req.ip)) : null, at: now }).catch((err) =>
    console.error('Aktions-Herkunft:', err.message)
  );
}

function trackSignals(req, res, next) {
  if (req.user) {
    // Token für die nächste Aktion: in jeder Seite (partials/head.ejs) und in der Antwort auf jede Spiel-Aktion
    res.locals.actionToken = actionToken.issue(req.user._id);
    if (isGameAction(req)) {
      res.set('X-Action-Token', res.locals.actionToken);
      try {
        record(req);
      } catch (err) {
        console.error('Skript-Merkmale:', err.message);
      }
    }
  }
  next();
}

/** Falle: wer den unsichtbaren Link aufruft, liest die Seite automatisch aus. Danach normale 404-Seite. */
const trap = express.Router();
trap.all(TRAP_PATH, (req, res, next) => {
  if (req.user) {
    const now = new Date();
    ScriptSignal.updateOne(dayKey(req.user._id, now), { $inc: { trap: 1 }, $set: { lastAt: now }, $setOnInsert: { firstAt: now } }, { upsert: true }).catch((err) => console.error('Falle:', err.message));
  }
  next();
});

module.exports = { trackSignals, trap, signalsOf, tokenSignals, isGameAction, BOT_UA, TRAP_PATH, FAST_MS };

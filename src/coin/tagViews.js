/**
 * Datenquelle des MK Coin (MIA): die Aufrufzahlen der meistgesehenen Videos zu einem Schlagwort, über eine
 * öffentliche Webmaster-Schnittstelle (ohne Schlüssel). Das Schlagwort steht NICHT im Code, sondern in der
 * Umgebungsvariable MIA_COIN_TAG; ohne sie wird nichts abgerufen und der Coin läuft ohne Trend.
 *
 * Stündlich: Aufrufe je Video speichern (TagReading). Daraus der Trend (driftFrom, rein und testbar):
 * Zuwachs der letzten 24 Stunden gegen den Schnitt der Vortage (bis zu 7) – m = log2(heute / Schnitt), begrenzt
 * auf −1 … +1, Trend = m · MAX_DRIFT (Log-Rendite pro Tag). Gezählt wird nur der Zuwachs von Videos, die in beiden
 * Abrufen vorkommen – rutscht ein Video in die Liste oder heraus, springt die Summe also nicht.
 * Es werden keine Daten von Mitgliedern übertragen.
 */
const config = require('../config');
const TagReading = require('../models/TagReading');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FETCH_MS = HOUR;
const FETCH_TIMEOUT_MS = 20000;
const KEEP_MS = 9 * DAY; // für 24 Stunden + 7 Vortage
const MATCH_TOLERANCE = 2 * HOUR; // so weit darf ein Abruf vom gesuchten Zeitpunkt abweichen
const BASE_DAYS = 7;
const MAX_DRIFT = 0.25; // Log-Rendite pro Tag bei voller Stimmung (≈ ±28 %)

let readings = []; // aufsteigend nach t (ms): { t, views: { id: n } }
let current = { mu: 0, sentiment: 0 };
let timer = null;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** Antwort der Schnittstelle → { Video-ID: Aufrufe } (unbrauchbare Einträge fallen weg) */
function parseVideos(json) {
  const out = {};
  for (const v of (json && json.videos) || []) {
    const id = String(v.video_id || v.url || '').slice(0, 200);
    const n = Number(v.views);
    if (id && Number.isFinite(n) && n >= 0) out[id] = n;
  }
  return out;
}

/** Letzter Abruf bis atMs, höchstens MATCH_TOLERANCE davor – sonst null */
function readingAt(list, atMs) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].t <= atMs) return atMs - list[i].t <= MATCH_TOLERANCE ? list[i] : null;
  }
  return null;
}

/** Zuwachs pro Tag zwischen zwei Abrufen (nur Videos, die in beiden vorkommen) oder null */
function growth(a, b) {
  if (!a || !b || b.t <= a.t) return null;
  let sum = 0;
  let common = 0;
  for (const [id, n] of Object.entries(b.views)) {
    if (a.views[id] === undefined) continue;
    common += 1;
    sum += Math.max(0, n - a.views[id]);
  }
  return common ? (sum * DAY) / (b.t - a.t) : null;
}

/** Trend aus den Abrufen: { mu (Log-Rendite/Tag), sentiment (−1 … +1), today, base } */
function driftFrom(list, now) {
  const last = readingAt(list, now);
  if (!last) return { mu: 0, sentiment: 0, today: null, base: null };
  const dayGrowth = (k) => growth(readingAt(list, last.t - (k + 1) * DAY + MATCH_TOLERANCE / 2), readingAt(list, last.t - k * DAY + MATCH_TOLERANCE / 2));
  const today = growth(readingAt(list, last.t - DAY + MATCH_TOLERANCE / 2), last);
  const past = [];
  for (let k = 1; k <= BASE_DAYS; k++) {
    const g = dayGrowth(k);
    if (g !== null) past.push(g);
  }
  if (today === null || !past.length) return { mu: 0, sentiment: 0, today, base: null };
  const base = past.reduce((s, g) => s + g, 0) / past.length;
  const sentiment = clamp(Math.log2((today + 1) / (base + 1)), -1, 1);
  return { mu: sentiment * MAX_DRIFT, sentiment, today, base };
}

function merge(list) {
  const map = new Map(readings.map((r) => [r.t, r]));
  for (const r of list) map.set(r.t, r);
  const cutoff = Date.now() - KEEP_MS;
  readings = [...map.values()].filter((r) => r.t >= cutoff).sort((a, b) => a.t - b.t);
  current = driftFrom(readings, Date.now());
}

/** Aufrufe abrufen und speichern (nur mit MIA_COIN_TAG) */
async function refresh() {
  if (!config.miaCoinTag) return 0;
  const url = `https://www.pornhub.com/webmasters/search?tags[]=${encodeURIComponent(config.miaCoinTag)}&ordering=mostviewed&page=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Schnittstelle antwortet mit ${res.status}`);
  const views = parseVideos(await res.json());
  if (!Object.keys(views).length) throw new Error('keine Videos in der Antwort');
  const t = Math.floor(Date.now() / MIN) * MIN;
  await TagReading.updateOne({ t: new Date(t) }, { $set: { views } }, { upsert: true });
  merge([{ t, views }]);
  return Object.keys(views).length;
}

async function start() {
  const docs = await TagReading.find({ t: { $gte: new Date(Date.now() - KEEP_MS) } }).sort({ t: 1 }).lean();
  merge(docs.map((d) => ({ t: d.t.getTime(), views: d.views || {} })));
  const run = () => refresh().catch((err) => console.error('MK Coin – Datenquelle:', err.message));
  await run();
  timer = setInterval(run, FETCH_MS);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

/** Aktueller Trend für die Engine (wird nach jedem Abruf neu berechnet) */
const now = () => current;

module.exports = { MAX_DRIFT, parseVideos, readingAt, growth, driftFrom, start, stop, refresh, now };

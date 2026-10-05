/**
 * Wetterdaten der NOAA-Boje 51101 (Pazifik, nordwestlich von Hawaii) für den 51101 Coin.
 * Die NOAA veröffentlicht die Messwerte der letzten 45 Tage im 10-Minuten-Takt als Textdatei.
 * Wir rufen sie alle 10 Minuten ab, speichern sie in MongoDB (für Neustarts und das Nachsimulieren)
 * und halten die letzten Tage im Speicher.
 */
const BuoyReading = require('../models/BuoyReading');

const STATION = '51101';
const URL = `https://www.ndbc.noaa.gov/data/realtime2/${STATION}.txt`;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FETCH_MS = 10 * MIN;
const FETCH_TIMEOUT_MS = 15000;
const MAX_AGE = 2 * HOUR; // ältere Messung = Boje meldet nichts
const KEEP_MS = 31 * DAY; // so weit zurück braucht die Engine Daten (längste nachsimulierte Lücke: 30 Tage)

let readings = []; // aufsteigend nach t (ms): { t, w, g, p }
let timer = null;

/** Textdatei der NOAA in Messungen umwandeln; Zeilen ohne Wind, Böen oder Druck ("MM") fallen weg */
function parse(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const c = line.trim().split(/\s+/);
    if (c.length < 13) continue;
    const num = (i) => (c[i] === 'MM' ? NaN : Number(c[i]));
    const t = Date.UTC(+c[0], +c[1] - 1, +c[2], +c[3], +c[4]);
    const r = { t, w: num(6), g: num(7), p: num(12) };
    if ([r.t, r.w, r.g, r.p].every(Number.isFinite)) out.push(r);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Neue Messungen in die Liste im Speicher übernehmen (doppelte ersetzen, alte verwerfen) */
function merge(list) {
  const map = new Map(readings.map((r) => [r.t, r]));
  for (const r of list) map.set(r.t, r);
  const cutoff = Date.now() - KEEP_MS;
  readings = [...map.values()].filter((r) => r.t >= cutoff).sort((a, b) => a.t - b.t);
}

/** Aktuelle Daten von der NOAA holen und speichern. Gibt die Zahl der Messungen zurück. */
async function refresh() {
  const res = await fetch(URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'WetteDings-Broker' } });
  if (!res.ok) throw new Error(`NOAA antwortet mit ${res.status}`);
  const list = parse(await res.text()).filter((r) => r.t >= Date.now() - KEEP_MS);
  merge(list);
  if (list.length) {
    await BuoyReading.bulkWrite(
      list.map((r) => ({
        updateOne: { filter: { station: STATION, t: new Date(r.t) }, update: { $set: { w: r.w, g: r.g, p: r.p } }, upsert: true },
      })),
      { ordered: false }
    );
  }
  return list.length;
}

/** Gespeicherte Messungen laden, dann (wenn erreichbar) die NOAA abfragen und regelmäßig aktualisieren */
async function start() {
  const docs = await BuoyReading.find({ station: STATION, t: { $gte: new Date(Date.now() - KEEP_MS) } }).sort({ t: 1 }).lean();
  merge(docs.map((d) => ({ t: d.t.getTime(), w: d.w, g: d.g, p: d.p })));
  await refresh().catch((err) => console.error('Boje 51101:', err.message));
  timer = setInterval(() => refresh().catch((err) => console.error('Boje 51101:', err.message)), FETCH_MS);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

/** Letzte Messung zum Zeitpunkt atMs (höchstens 2 Stunden alt) oder null, wenn die Boje nichts meldet */
function at(atMs, list = readings) {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= atMs) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0 || atMs - list[found].t > MAX_AGE) return null;
  return list[found];
}

module.exports = { STATION, start, stop, refresh, parse, at, MAX_AGE };

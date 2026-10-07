/**
 * Alle Werte im Broker: vier Coins und ein ETF. Jeder Wert hat seine eigene Kurs-Engine (engine.js).
 */
const model = require('./model');
const { createEngine, DAY } = require('./engine');
const buoy = require('./buoy');
const tagViews = require('./tagViews');

const LIST = [
  createEngine({ symbol: 'SAM', name: 'Samantha Coin', kind: 'coin', startPrice: 10, params: model.PARAMS, surgeWindow: DAY / 2 }),
  createEngine({ symbol: 'COW', name: 'Coinye West', kind: 'coin', startPrice: 10, params: model.COW_PARAMS, surgeWindow: DAY }),
  // 51101 Coin: Das Wetter an der NOAA-Boje 51101 bestimmt, wie wild der Kurs ist; bei Sturm alle 3 Stunden ein Würfelwurf
  // für den großen Sprung. Statt eines Mindestkurses gibt es Splits: unter 1 € 10:1 zusammenlegen, über 1.000 € 1:10 aufteilen.
  createEngine({
    symbol: 'BOJE',
    name: '51101 Coin',
    kind: 'coin',
    startPrice: 10,
    params: model.BOJE_PARAMS,
    surgeWindow: DAY / 8,
    weather: { at: (ms) => buoy.at(ms), params: model.bojeParams, storm: model.isStorm },
    rebase: { min: 1, max: 1000, factor: 10 },
  }),
  // MK Coin: so unruhig wie der Samantha Coin, große Sprünge nur halb so weit; die Richtung kommt aus den Video-Aufrufen eines Schlagworts (tagViews.js):
  // mehr Zuwachs als im Schnitt der Vortage → Trend nach oben, weniger → nach unten. Splits wie beim 51101 Coin.
  createEngine({
    symbol: 'MIA',
    name: 'MK Coin',
    kind: 'coin',
    startPrice: 10,
    params: model.MIA_PARAMS,
    surgeWindow: DAY / 2,
    drift: { now: () => tagViews.now() },
    rebase: { min: 1, max: 1000, factor: 10 },
  }),
  createEngine({
    symbol: 'BTCG',
    name: 'BfW-TCG ETF',
    kind: 'etf',
    startPrice: 100,
    params: model.ETF_PARAMS,
    report: true, // Sprung nach dem täglichen Börsenbericht (reportService.js); Stimmung = letzter Bericht
  }),
];

const FIXED = LIST.map((e) => e.SYMBOL);
const SYMBOLS = [...FIXED];

/** Engine zu einem Symbol (feste Liste und gehandelte eSports-Teams) oder null */
const get = (symbol) => LIST.find((e) => e.SYMBOL === symbol) || null;

/** eSports-Team-ETF zur Laufzeit aufnehmen (src/esports/esportsService.js) – startet die Engine */
async function add(engine) {
  if (get(engine.SYMBOL)) return get(engine.SYMBOL);
  await engine.start();
  LIST.push(engine);
  SYMBOLS.push(engine.SYMBOL);
  return engine;
}

/** eSports-Team-ETF entfernen (Konkurs/Auflösung): Kurs speichern, aus der Liste nehmen. Feste Werte bleiben. */
async function remove(symbol) {
  const e = get(symbol);
  if (!e || FIXED.includes(symbol)) return;
  LIST.splice(LIST.indexOf(e), 1);
  SYMBOLS.splice(SYMBOLS.indexOf(symbol), 1);
  await e.stop();
}

// Einmalige Kurssprünge (Krisztian): jeder Schlüssel läuft genau einmal, auch über Neustarts hinweg (Merker im CoinState)
const ONE_TIME_JUMPS = [{ key: 'mia-median-2026-10-07', symbol: 'MIA', change: 0.75 }];

async function oneTimeJumps() {
  const { CoinState } = require('../models/Coin');
  for (const j of ONE_TIME_JUMPS) {
    const e = get(j.symbol);
    if (!e || !e.isRunning()) continue;
    // Merker zuerst setzen: lieber ein Sprung verloren als zwei
    const res = await CoinState.updateOne({ _id: j.symbol, oneTimeJumps: { $ne: j.key } }, { $addToSet: { oneTimeJumps: j.key } }, { strict: false });
    if (!res.modifiedCount) continue;
    const { before, after } = await e.jump(Math.log1p(j.change), tagViews.now().sentiment);
    console.log(`${e.NAME}: einmaliger Sprung (${j.key}) ${before.toFixed(4)} € → ${after.toFixed(4)} €`);
  }
}

async function start() {
  await buoy.start(); // Wetterdaten zuerst – der 51101 Coin braucht sie schon beim Nachsimulieren
  await tagViews.start(); // ebenso die Aufrufzahlen für den MK Coin
  for (const e of LIST) await e.start();
  await oneTimeJumps().catch((err) => console.error('Einmaliger Kurssprung:', err.message));
}

async function stop() {
  buoy.stop();
  tagViews.stop();
  await Promise.all(LIST.map((e) => e.stop()));
}

/** Aktuelle Kurse je Symbol (nur laufende Engines) */
function prices() {
  const out = {};
  for (const e of LIST) if (e.isRunning()) out[e.SYMBOL] = e.getPrice();
  return out;
}

module.exports = { LIST, FIXED, SYMBOLS, get, add, remove, start, stop, prices };

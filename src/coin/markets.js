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

/**
 * Einmalige Aktionen (Krisztian): jeder Schlüssel läuft höchstens einmal – nie durch einen Neustart oder Deploy erneut.
 * Dreifach gesichert: Merker im CoinState (oneTimeJumps, direkt über den MongoDB-Treiber gesetzt), Frist "until"
 * (danach läuft die Aktion nie mehr) und erledigte Einträge werden aus der Liste gelöscht.
 * Bisher erledigt: 'mia-median-2026-10-07' (+75 %) – lief durch einen Fehler bei jedem Deploy erneut (strictQuery
 * strich die $ne-Bedingung, timestamps meldeten trotzdem "geändert"); deshalb die Rückführung unten.
 *   glide: { target (€), hours } – Gleitflug auf den Zielkurs (src/coin/glide.js), danach normal weiter
 */
const ONE_TIME_ACTIONS = [
  { key: 'mia-rueckfuehrung-2026-10-07', symbol: 'MIA', glide: { target: 6.5, hours: 8 }, until: Date.parse('2026-10-09T00:00:00+02:00') },
];

/** Merker setzen; true nur, wenn er vorher wirklich fehlte (Treiber direkt: kein strictQuery, keine timestamps) */
async function claimOnce(symbol, key) {
  const { CoinState } = require('../models/Coin');
  const res = await CoinState.collection.updateOne({ _id: symbol, oneTimeJumps: { $ne: key } }, { $addToSet: { oneTimeJumps: key } });
  return res.matchedCount === 1 && res.modifiedCount === 1;
}

async function oneTimeActions(now = Date.now()) {
  for (const a of ONE_TIME_ACTIONS) {
    if (!(now < a.until)) continue;
    const e = get(a.symbol);
    if (!e || !e.isRunning()) continue;
    // Merker zuerst setzen: lieber eine Aktion verloren als zwei
    if (!(await claimOnce(a.symbol, a.key))) continue;
    if (a.glide) {
      const r = await e.startGlide(a.key, a.glide.target, now + a.glide.hours * DAY / 24);
      console.log(`${e.NAME}: einmaliger Gleitflug (${a.key}) ${r.from.toFixed(4)} € → ${r.target} € bis ${new Date(r.endAt).toISOString()}`);
    }
  }
}

async function start() {
  await buoy.start(); // Wetterdaten zuerst – der 51101 Coin braucht sie schon beim Nachsimulieren
  await tagViews.start(); // ebenso die Aufrufzahlen für den MK Coin
  for (const e of LIST) await e.start();
  await oneTimeActions().catch((err) => console.error('Einmalige Aktion:', err.message));
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

module.exports = { LIST, FIXED, SYMBOLS, ONE_TIME_ACTIONS, claimOnce, get, add, remove, start, stop, prices };

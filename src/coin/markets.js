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
  // MK Coin: so unruhig wie der Samantha Coin; die Richtung kommt aus den Video-Aufrufen eines Schlagworts (tagViews.js):
  // mehr Zuwachs als im Schnitt der Vortage → Trend nach oben, weniger → nach unten. Splits wie beim 51101 Coin.
  createEngine({
    symbol: 'MIA',
    name: 'MK Coin',
    kind: 'coin',
    startPrice: 10,
    params: model.PARAMS,
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

const SYMBOLS = LIST.map((e) => e.SYMBOL);

/** Engine zu einem Symbol (nur aus der festen Liste) oder null */
const get = (symbol) => LIST.find((e) => e.SYMBOL === symbol) || null;

async function start() {
  await buoy.start(); // Wetterdaten zuerst – der 51101 Coin braucht sie schon beim Nachsimulieren
  await tagViews.start(); // ebenso die Aufrufzahlen für den MK Coin
  for (const e of LIST) await e.start();
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

module.exports = { LIST, SYMBOLS, get, start, stop, prices };

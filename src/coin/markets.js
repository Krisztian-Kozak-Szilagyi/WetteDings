/**
 * Alle Werte im Broker: zwei Coins und ein ETF. Jeder Wert hat seine eigene Kurs-Engine (engine.js).
 */
const model = require('./model');
const { createEngine, DAY } = require('./engine');
const etfTrend = require('./etfTrend');

const LIST = [
  createEngine({ symbol: 'SAM', name: 'Samantha Coin', kind: 'coin', startPrice: 10, params: model.PARAMS, surgeWindow: DAY / 2 }),
  createEngine({ symbol: 'COW', name: 'Coinye West', kind: 'coin', startPrice: 10, params: model.COW_PARAMS, surgeWindow: DAY }),
  createEngine({
    symbol: 'BTCG',
    name: 'BfW-TCG ETF',
    kind: 'etf',
    startPrice: 100,
    params: model.ETF_PARAMS,
    trend: { target: () => etfTrend.target(), tauDays: 0.25 },
  }),
];

const SYMBOLS = LIST.map((e) => e.SYMBOL);

/** Engine zu einem Symbol (nur aus der festen Liste) oder null */
const get = (symbol) => LIST.find((e) => e.SYMBOL === symbol) || null;

async function start() {
  for (const e of LIST) await e.start();
}

async function stop() {
  await Promise.all(LIST.map((e) => e.stop()));
}

/** Aktuelle Kurse je Symbol (nur laufende Engines) */
function prices() {
  const out = {};
  for (const e of LIST) if (e.isRunning()) out[e.SYMBOL] = e.getPrice();
  return out;
}

module.exports = { LIST, SYMBOLS, get, start, stop, prices };

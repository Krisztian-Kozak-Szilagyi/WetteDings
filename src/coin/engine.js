/**
 * Kurs-Engine der Broker-Werte (Samantha Coin, Coinye West, BfW-TCG ETF). createEngine() baut eine Engine je Wert,
 * die Liste aller Werte steht in markets.js.
 * Läuft im Serverprozess: alle 5 Sekunden ein neuer Kurs (auch wenn niemand online ist).
 * Minuten- und Stundenkerzen werden gesammelt und alle 15 Sekunden in MongoDB gespeichert.
 * War der Server offline, wird die verpasste Zeit beim Start in Minutenschritten nachsimuliert,
 * damit der Kursverlauf lückenlos bleibt.
 */
const model = require('./model');
const { CoinState, CoinMinute, CoinHour, CoinEvent } = require('../models/Coin');

const TICK_MS = 5000;
const FLUSH_MS = 15000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BACKFILL_DAYS = 14; // beim allerersten Start: so viel Vorgeschichte simulieren
const MAX_GAP_DAYS = 30; // längere Ausfälle werden nicht vollständig nachsimuliert
const MINUTE_RETENTION = 3 * DAY;
const EVENT_MIN_CHANGE = 0.1; // Ereignisse ab 10 % werden als Marktereignis gespeichert
const TREND_REFRESH_MS = 10 * MIN; // so oft wird beim ETF die Aktivität der Seite neu bewertet

const bucket = (ms, size) => Math.floor(ms / size) * size;

function updateCandle(cur, pending, size, price, atMs) {
  const t = bucket(atMs, size);
  if (!cur || cur.t !== t) {
    if (cur) pending.set(cur.t, cur);
    const o = cur ? cur.c : price;
    return { t, o, h: Math.max(o, price), l: Math.min(o, price), c: price };
  }
  cur.h = Math.max(cur.h, price);
  cur.l = Math.min(cur.l, price);
  cur.c = price;
  return cur;
}

const RANGES = {
  '1h': { src: 'min', span: HOUR, size: MIN },
  '24h': { src: 'min', span: DAY, size: 5 * MIN },
  '7d': { src: 'hour', span: 7 * DAY, size: HOUR },
  '30d': { src: 'hour', span: 30 * DAY, size: 2 * HOUR },
  all: { src: 'hour', span: null, size: null },
};

/**
 * @param {object} cfg
 * @param {string} cfg.symbol  z. B. "SAM"
 * @param {string} cfg.name
 * @param {'coin'|'etf'} cfg.kind
 * @param {number} cfg.startPrice
 * @param {object} cfg.params  Kursmodell (model.PARAMS, COW_PARAMS, ETF_PARAMS)
 * @param {number|null} cfg.surgeWindow  Würfelfenster für den großen Sprung in ms (null = kein großer Sprung)
 * @param {{target: () => Promise<{mu: number, sentiment: number}>, tauDays: number}|null} cfg.trend
 *        Trend (ETF): Zielwert aus der Aktivität; der Kurs-Trend folgt ihm gleitend (Zeitkonstante tauDays).
 */
function createEngine(cfg) {
  const { symbol: SYMBOL, name: NAME, kind = 'coin', startPrice: START_PRICE, params: PARAMS } = cfg;
  const SURGE_WINDOW = cfg.surgeWindow || null;
  const trend = cfg.trend || null;
  const LN_MAX = model.lnMaxOf(PARAMS);

  let state = null;
  let timers = [];
  let curMin = null;
  let curHour = null;
  const pendingMin = new Map();
  const pendingHour = new Map();
  let pendingEvents = [];
  let stats24 = { open: null, high: null, low: null };
  let flushChain = Promise.resolve();

  function record(price, atMs) {
    curMin = updateCandle(curMin, pendingMin, MIN, price, atMs);
    curHour = updateCandle(curHour, pendingHour, HOUR, price, atMs);
    if (price > state.ath) {
      state.ath = price;
      state.athAt = new Date(atMs);
    }
  }

  /**
   * Großer Sprung: Zu Beginn jedes Würfelfensters wird einmal gewürfelt (model.rollSurge); fällt der Wurf
   * positiv aus, passiert der Sprung zu einem zufälligen Zeitpunkt im Fenster. Gibt den fälligen Sprung zurück oder null.
   */
  function dueSurge(atMs) {
    if (!SURGE_WINDOW) return null;
    const slot = bucket(atMs, SURGE_WINDOW);
    if (!state.surge || state.surge.slot !== slot) {
      const roll = model.rollSurge(Math.random, PARAMS.surge);
      state.surge = { slot, at: roll ? atMs + Math.random() * (slot + SURGE_WINDOW - atMs) : null, log: roll ? roll.log : 0 };
    }
    const { at, log } = state.surge;
    if (at === null || atMs < at) return null;
    state.surge.at = null; // pro Fenster höchstens ein Sprung
    return { log, change: Math.expm1(log), type: log >= 0 ? 'pump' : 'crash' };
  }

  function advance(dtDays, atMs) {
    if (trend) state.mu += (state.muTarget - state.mu) * (1 - Math.exp(-dtDays / trend.tauDays));
    const next = model.step(state, dtDays, Math.random, PARAMS);
    const surge = dueSurge(atMs);
    if (surge) {
      next.price = Math.max(PARAMS.floor, next.price * Math.exp(surge.log));
      next.lv = Math.min(LN_MAX, next.lv + PARAMS.surge.volBoost); // danach geht es unruhig weiter
      next.events.push({ type: surge.type, change: surge.change });
    }
    state.price = next.price;
    state.lv = next.lv;
    state.lastTickAt = new Date(atMs);
    for (const e of next.events) {
      if (Math.abs(e.change) < EVENT_MIN_CHANGE) continue;
      pendingEvents.push({ coin: SYMBOL, at: new Date(atMs), type: e.type, change: e.change, price: next.price });
    }
    record(state.price, atMs);
  }

  async function simulateGap(fromMs, toMs) {
    let n = 0;
    for (let t = fromMs + MIN; t <= toMs; t += MIN) {
      advance(1 / 1440, t);
      if (++n % 3000 === 0) await flush();
    }
  }

  function tick() {
    const now = Date.now();
    const dt = (now - state.lastTickAt.getTime()) / DAY;
    if (dt <= 0) return;
    advance(Math.min(dt, 5 / 1440), now);
  }

  /** ETF: Zielwert des Trends aus der Aktivität der Seite neu bestimmen */
  async function refreshTrend() {
    if (!trend) return;
    const t = await trend.target();
    state.muTarget = t.mu;
    state.sentiment = t.sentiment;
  }

  async function doFlush() {
    const minCutoff = Date.now() - MINUTE_RETENTION;
    const mins = [...pendingMin.values(), ...(curMin ? [{ ...curMin }] : [])].filter((c) => c.t >= minCutoff);
    const hours = [...pendingHour.values(), ...(curHour ? [{ ...curHour }] : [])];
    const events = pendingEvents;
    pendingMin.clear();
    pendingHour.clear();
    pendingEvents = [];

    const toOps = (list) =>
      list.map((c) => ({
        updateOne: {
          filter: { coin: SYMBOL, t: new Date(c.t) },
          update: { $set: { o: c.o, h: c.h, l: c.l, c: c.c } },
          upsert: true,
        },
      }));

    try {
      if (mins.length) await CoinMinute.bulkWrite(toOps(mins), { ordered: false });
      if (hours.length) await CoinHour.bulkWrite(toOps(hours), { ordered: false });
      if (events.length) await CoinEvent.insertMany(events, { ordered: false });
      await CoinState.updateOne(
        { _id: SYMBOL },
        {
          $set: {
            price: state.price,
            lv: state.lv,
            lastTickAt: state.lastTickAt,
            ath: state.ath,
            athAt: state.athAt,
            startedAt: state.startedAt,
            surge: state.surge,
            mu: state.mu,
            muTarget: state.muTarget,
            sentiment: state.sentiment,
          },
          $unset: { manual: '' }, // alte Admin-Kurssteuerung (entfernt)
        },
        { upsert: true, strict: false } // strict aus, damit das alte Feld wirklich entfernt wird
      );
    } catch (err) {
      // Beim nächsten Mal erneut versuchen
      for (const c of mins) if (!pendingMin.has(c.t) && (!curMin || curMin.t !== c.t)) pendingMin.set(c.t, c);
      for (const c of hours) if (!pendingHour.has(c.t) && (!curHour || curHour.t !== c.t)) pendingHour.set(c.t, c);
      pendingEvents = events.concat(pendingEvents);
      throw err;
    }
  }

  /** Speichert serialisiert (nie zwei Schreibvorgänge gleichzeitig) */
  function flush() {
    flushChain = flushChain.catch(() => {}).then(doFlush);
    return flushChain;
  }

  async function refreshStats() {
    const since = new Date(Date.now() - DAY);
    const [agg] = await CoinMinute.aggregate([
      { $match: { coin: SYMBOL, t: { $gte: since } } },
      { $sort: { t: 1 } },
      { $group: { _id: null, open: { $first: '$o' }, high: { $max: '$h' }, low: { $min: '$l' } } },
    ]);
    stats24 = agg ? { open: agg.open, high: agg.high, low: agg.low } : { open: state.price, high: state.price, low: state.price };
  }

  async function start() {
    const now = Date.now();
    const doc = await CoinState.findById(SYMBOL).lean();
    if (!doc) {
      const startMs = now - BACKFILL_DAYS * DAY;
      const init = model.initialState(START_PRICE, PARAMS);
      state = {
        price: init.price,
        lv: init.lv,
        lastTickAt: new Date(startMs),
        ath: init.price,
        athAt: new Date(startMs),
        startedAt: new Date(startMs),
        surge: null,
        mu: 0,
        muTarget: 0,
        sentiment: 0,
      };
      record(state.price, startMs);
      console.log(`${NAME}: erster Start – simuliere ${BACKFILL_DAYS} Tage Vorgeschichte …`);
      await simulateGap(startMs, now);
    } else {
      state = {
        price: doc.price,
        lv: doc.lv,
        lastTickAt: new Date(doc.lastTickAt),
        ath: doc.ath,
        athAt: new Date(doc.athAt),
        startedAt: new Date(doc.startedAt),
        surge: doc.surge && Number.isFinite(doc.surge.slot) ? { slot: doc.surge.slot, at: doc.surge.at ?? null, log: doc.surge.log || 0 } : null,
        mu: doc.mu || 0,
        muTarget: doc.muTarget || 0,
        sentiment: doc.sentiment || 0,
      };
      let from = state.lastTickAt.getTime();
      if (now - from > MAX_GAP_DAYS * DAY) from = now - MAX_GAP_DAYS * DAY;
      if (now - from > MIN) {
        console.log(`${NAME}: simuliere ${Math.round((now - from) / MIN)} verpasste Minuten nach …`);
        await simulateGap(from, now);
      }
    }
    await flush();
    await refreshStats();
    await refreshTrend().catch((err) => console.error(`${NAME}:`, err.message));
    console.log(`${NAME} läuft – aktueller Kurs ${state.price.toFixed(4)} €`);

    const safe = (fn) => () => Promise.resolve().then(fn).catch((err) => console.error(`${NAME}:`, err.message));
    timers = [setInterval(tick, TICK_MS), setInterval(safe(flush), FLUSH_MS), setInterval(safe(refreshStats), MIN)];
    if (trend) timers.push(setInterval(safe(refreshTrend), TREND_REFRESH_MS));
  }

  async function stop() {
    timers.forEach(clearInterval);
    timers = [];
    if (state) await flush().catch(() => {});
  }

  const isRunning = () => !!state;

  function getPrice() {
    if (!state) throw new Error('Kurs-Engine läuft nicht.');
    return state.price;
  }

  function snapshot() {
    const price = state.price;
    return {
      symbol: SYMBOL,
      name: NAME,
      kind,
      price,
      at: state.lastTickAt.getTime(),
      change24h: stats24.open ? price / stats24.open - 1 : 0,
      high24h: Math.max(stats24.high ?? price, price),
      low24h: Math.min(stats24.low ?? price, price),
      ath: state.ath,
      athAt: state.athAt.getTime(),
      tickMs: TICK_MS,
      sentiment: trend ? state.sentiment : null, // ETF: Marktstimmung −1 … +1
    };
  }

  /** Kursverlauf als [[Zeit ms, Schlusskurs], …] (max. ~400 Punkte) */
  async function history(range) {
    const cfgR = RANGES[range] || RANGES['24h'];
    const now = Date.now();
    const base = cfgR.src === 'min' ? MIN : HOUR;
    const from = cfgR.span ? now - cfgR.span : state.startedAt.getTime();
    const Model = cfgR.src === 'min' ? CoinMinute : CoinHour;

    const docs = await Model.find({ coin: SYMBOL, t: { $gte: new Date(bucket(from, base)) } })
      .sort({ t: 1 })
      .select('t c -_id')
      .lean();
    const map = new Map(docs.map((d) => [d.t.getTime(), d.c]));
    const unsaved = cfgR.src === 'min' ? [...pendingMin.values(), curMin] : [...pendingHour.values(), curHour];
    for (const c of unsaved) if (c && c.t >= bucket(from, base)) map.set(c.t, c.c);

    const size = cfgR.size || Math.max(HOUR, Math.ceil((now - from) / 400 / HOUR) * HOUR);
    let points = [...map.entries()].sort((a, b) => a[0] - b[0]);
    if (size > base) {
      const grouped = new Map();
      for (const [t, c] of points) grouped.set(bucket(t, size), c);
      points = [...grouped.entries()];
    }
    // Zeitstempel = Ende des Zeitraums (der Wert ist der Schlusskurs)
    points = points.map(([t, c]) => [Math.min(t + size, now), c]).filter(([t]) => t < now);
    points.push([now, state.price]);
    return points;
  }

  async function recentEvents(limit = 8) {
    const saved = await CoinEvent.find({ coin: SYMBOL }).sort({ at: -1 }).limit(limit).lean();
    return [...pendingEvents.filter((e) => e.coin === SYMBOL).reverse(), ...saved].slice(0, limit);
  }

  return {
    SYMBOL,
    NAME,
    kind,
    start,
    stop,
    isRunning,
    getPrice,
    snapshot,
    history,
    recentEvents,
    flush,
  };
}

module.exports = { createEngine, TICK_MS, DAY };

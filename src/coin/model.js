/**
 * Kursmodelle der Broker-Werte – Simulation volatiler Kurse mit Spielgeld.
 * Bewusst deutlich wilder als echte Märkte: Es sind Spiel-Werte mit Spielgeld.
 *
 * Bausteine (alle Zeitangaben in Tagen):
 *  1. Stochastische Volatilität: log(σ) schwankt um eine Basis (ruhige und wilde Phasen, Volatilitäts-Cluster).
 *  2. Diffusion mit fetten Rändern: Student-t verteilte Zufallsrenditen statt Normalverteilung.
 *  3. Sprünge: kleine (etwa alle 20 Min., 1–4 %) und große (etwa 4× täglich, 5–20 %, manchmal mehr).
 *  4. Großer Sprung ("Surge"): Die Engine würfelt in festen Fenstern (SAM 2× täglich, COW 1× täglich);
 *     mit der Chance des Werts springt der Kurs kräftig nach oben oder unten (rollSurge).
 *  5. Nach Sprüngen steigt die Volatilität (Panik / FOMO) und klingt langsam wieder ab.
 *  6. Kein Ankerkurs: Der Kurs ist ein Zufallspfad im Log-Maß. Weil Einbrüche größer ausfallen können als
 *     Anstiege, geht der große Sprung etwas öfter nach oben (upChance) – so heben sie sich im Log-Maß auf.
 *  7. Optionaler Trend (state.mu, Log-Rendite pro Tag): derzeit von keinem Wert genutzt (der ETF springt stattdessen täglich, siehe marketReport.js).
 *  8. 51101 Coin: Das Wetter an der NOAA-Boje 51101 (siehe buoy.js) bestimmt nur, wie wild der Kurs ist –
 *     nie die Richtung. So lässt sich aus dem Wetter kein sicherer Gewinn ableiten.
 */

const surgeParams = (s) => ({
  ...s,
  // Log-Grenzen: nach oben upMin … upMax, nach unten downMin … downMax (Beträge)
  upMin: Math.log(1 + s.up[0]),
  upMax: Math.log(1 + s.up[1]),
  downMin: -Math.log(1 - s.down[0]),
  downMax: -Math.log(1 - s.down[1]),
});

/** Anteil der großen Sprünge nach oben, bei dem sich Anstiege und Einbrüche im Log-Maß aufheben */
const upChanceOf = (s) => (s.downMin + s.downMax) / (s.upMin + s.upMax + s.downMin + s.downMax);

// Samantha Coin
const PARAMS = {
  baseVol: 0.15, // Grundvolatilität pro Tag (15 %)
  volMeanRev: 4, // 1/Tag: wie schnell die Volatilität zur Basis zurückkehrt
  volOfVol: 1.2, // Schwankung der Volatilität
  minVol: 0.06,
  maxVol: 1.5,
  dof: 4, // Freiheitsgrade der Student-t-Verteilung (kleiner = fettere Ränder)
  small: { rate: 72, scale: 0.015, clamp: 0.12, volBoost: 0.02 }, // ~alle 20 Min., ~1–4 %
  big: { rate: 4, scale: 0.06, clamp: 0.4, volBoost: 0.2 }, // ~4x täglich, 5–20 %, manchmal mehr
  // Großer Sprung: pro Würfelfenster (2× täglich) mit dieser Chance; nach oben +20 … +100 %, nach unten −17 … −70 %
  surge: surgeParams({ chance: 0.5, up: [0.2, 1], down: [1 - 1 / 1.2, 0.7], volBoost: 0.8 }),
  floor: 0.0001, // Mindestkurs in €
};

// Coinye West: läuft wie der SAM, der große Sprung wird aber nur 1× täglich gewürfelt, seltener und kleiner
const COW_PARAMS = {
  ...PARAMS,
  surge: surgeParams({ chance: 0.35, up: [0.15, 0.6], down: [0.12, 0.5], volBoost: 0.6 }),
};

// MK Coin: wie der SAM, der große Sprung aber nur halb so weit (Krisztian): nach oben +10 … +50 %, nach unten −8 … −35 %
const MIA_PARAMS = {
  ...PARAMS,
  surge: surgeParams({ chance: 0.5, up: [0.1, 0.5], down: [(1 - 1 / 1.2) / 2, 0.35], volBoost: 0.8 }),
};

// ETF: ruhige Grundbewegung (~5 % pro Tag), keine großen Sprünge; die Richtung gibt der Trend (state.mu) vor
const ETF_PARAMS = {
  baseVol: 0.05,
  volMeanRev: 3,
  volOfVol: 0.5,
  minVol: 0.025,
  maxVol: 0.15,
  dof: 5,
  small: { rate: 24, scale: 0.006, clamp: 0.03, volBoost: 0.01 }, // ~stündlich ein kleiner Ruck, < 3 %
  big: null,
  surge: null,
  floor: 0.01,
};

// 51101 Coin: Grundmodell; Unruhe und Sprungrate setzt bojeParams() aus dem Wetter, große Sprünge gibt es nur bei Sturm
const BOJE_PARAMS = {
  baseVol: 0.3,
  volMeanRev: 4,
  volOfVol: 0.8,
  minVol: 0.06,
  maxVol: 1.5,
  dof: 4,
  small: { rate: 72, scale: 0.015, clamp: 0.12, volBoost: 0.005 },
  big: { rate: 1, scale: 0.05, clamp: 0.3, volBoost: 0.15 },
  surge: PARAMS.surge, // großer Sprung wie beim SAM, aber nur bei Sturm (die Engine würfelt dann alle 3 Stunden)
  floor: 0.01,
};

const BOJE_WEATHER = {
  calmVol: 0.12, // Grundvolatilität pro Tag bei Windstille …
  volPerWind: 0.03, // … plus so viel je m/s Wind (8 m/s → 36 %, 20 m/s → 72 %)
  offlineVol: 0.25, // Boje meldet nichts
  gustSlack: 2, // Böen bis 2 m/s über dem Wind sind normal …
  gustRate: 4, // … jeder m/s darüber bringt 4 große Sprünge pro Tag mehr
  stormWind: 13, // Sturm ab 13 m/s Wind …
  stormPressure: 1008, // … oder ab 1008 hPa Luftdruck abwärts
};

/** Kursmodell des 51101 Coin für eine Wetterlage { w: Wind m/s, g: Böen m/s, p: Druck hPa } oder null (keine Daten) */
function bojeParams(c) {
  const W = BOJE_WEATHER;
  if (!c) return { ...BOJE_PARAMS, baseVol: W.offlineVol };
  return {
    ...BOJE_PARAMS,
    baseVol: W.calmVol + W.volPerWind * c.w,
    big: { ...BOJE_PARAMS.big, rate: BOJE_PARAMS.big.rate + W.gustRate * Math.max(0, c.g - c.w - W.gustSlack) },
  };
}

/** Herrscht an der Boje Sturm? */
const isStorm = (c) => !!c && (c.w >= BOJE_WEATHER.stormWind || c.p <= BOJE_WEATHER.stormPressure);

const SURGE_UP_CHANCE = upChanceOf(PARAMS.surge);

/** Deterministischer Zufallsgenerator (für Tests und die Kompensationsberechnung) */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Student-t mit Varianz 1 (dof ganzzahlig > 2) */
function studentT(rng, dof) {
  let chi2 = 0;
  for (let i = 0; i < dof; i++) {
    const z = normal(rng);
    chi2 += z * z;
  }
  const t = normal(rng) / Math.sqrt(chi2 / dof);
  return t / Math.sqrt(dof / (dof - 2));
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Log-Sprunggröße: t-verteilt (3 Freiheitsgrade), begrenzt */
function jumpSize(rng, j) {
  return clamp(j.scale * studentT(rng, 3), -j.clamp, j.clamp);
}

const uniform = (rng, a, b) => a + (b - a) * rng();

/**
 * Ein Simulationsschritt.
 * @param {{price: number, lv: number, mu?: number}} state  lv = log(Volatilität pro Tag), mu = Trend pro Tag
 * @param {number} dt  Schrittweite in Tagen
 * @param {() => number} rng
 * @param {object} params  Kursmodell (PARAMS, COW_PARAMS, ETF_PARAMS)
 * @returns {{price: number, lv: number, events: {type: string, change: number}[]}}
 */
function step(state, dt, rng = Math.random, params = PARAMS) {
  const sigma = Math.exp(state.lv);
  const lnBase = Math.log(params.baseVol);
  const events = [];

  let r = (state.mu || 0) * dt + sigma * Math.sqrt(dt) * studentT(rng, params.dof);
  let lv = state.lv + params.volMeanRev * (lnBase - state.lv) * dt + params.volOfVol * Math.sqrt(dt) * normal(rng);

  if (params.small && rng() < params.small.rate * dt) {
    r += jumpSize(rng, params.small);
    lv += params.small.volBoost;
  }
  if (params.big && rng() < params.big.rate * dt) {
    const j = jumpSize(rng, params.big);
    r += j;
    lv += params.big.volBoost;
    events.push({ type: j >= 0 ? 'anstieg' : 'einbruch', change: Math.expm1(j) });
  }

  const price = Math.max(params.floor, state.price * Math.exp(r));
  return { price, lv: clamp(lv, Math.log(params.minVol), Math.log(params.maxVol)), events };
}

/**
 * Würfelt einen großen Sprung aus (ein Würfelfenster): null oder { log, change, type, volBoost }.
 * log = Änderung im Log-Maß, change = relative Änderung (z. B. -0.35 oder +0.8).
 */
function rollSurge(rng = Math.random, surge = PARAMS.surge) {
  if (!surge || rng() >= surge.chance) return null;
  const up = rng() < upChanceOf(surge);
  const log = up ? uniform(rng, surge.upMin, surge.upMax) : -uniform(rng, surge.downMin, surge.downMax);
  return { log, change: Math.expm1(log), type: up ? 'pump' : 'crash', volBoost: surge.volBoost };
}

const lnMaxOf = (params) => Math.log(params.maxVol);
const LN_MAX = lnMaxOf(PARAMS);

const initialState = (price = 10, params = PARAMS) => ({ price, lv: Math.log(params.baseVol) });

module.exports = {
  PARAMS,
  COW_PARAMS,
  MIA_PARAMS,
  ETF_PARAMS,
  BOJE_PARAMS,
  BOJE_WEATHER,
  bojeParams,
  isStorm,
  step,
  rollSurge,
  upChanceOf,
  lnMaxOf,
  LN_MAX,
  SURGE_UP_CHANCE,
  initialState,
  mulberry32,
};

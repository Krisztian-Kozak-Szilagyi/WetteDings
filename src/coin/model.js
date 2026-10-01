/**
 * Kursmodell für den Samantha Coin – Simulation eines sehr volatilen Krypto-Kurses.
 * Bewusst deutlich wilder als ein echter Coin: Es ist ein Spiel-Coin mit Spielgeld.
 *
 * Bausteine (alle Zeitangaben in Tagen):
 *  1. Stochastische Volatilität: log(σ) schwankt um eine Basis (ruhige und wilde Phasen, Volatilitäts-Cluster).
 *  2. Diffusion mit fetten Rändern: Student-t verteilte Zufallsrenditen statt Normalverteilung.
 *  3. Sprünge: kleine (etwa alle 20 Min., 1–4 %) und große (etwa 4× täglich, 5–20 %, manchmal mehr).
 *  4. Großer Sprung ("Surge"): zweimal am Tag wird gewürfelt, mit 50 % Chance springt der Kurs kräftig –
 *     nach unten um bis zu −70 %, nach oben um bis zu +100 %. Den Zeitpunkt steuert die Engine (rollSurge).
 *  5. Nach Sprüngen steigt die Volatilität (Panik / FOMO) und klingt langsam wieder ab.
 *  6. Keine Drift und kein Ankerkurs: Der Kurs ist ein reiner Zufallspfad im Log-Maß. Der typische (mediane)
 *     Kurs bleibt gleich, er kann aber beliebig weit steigen oder fallen. Weil Einbrüche größer ausfallen
 *     können als Anstiege, geht der große Sprung etwas öfter nach oben (upChance) – so heben sie sich im
 *     Log-Maß genau auf.
 */

const PARAMS = {
  baseVol: 0.15, // Grundvolatilität pro Tag (15 %)
  volMeanRev: 4, // 1/Tag: wie schnell die Volatilität zur Basis zurückkehrt
  volOfVol: 1.2, // Schwankung der Volatilität
  minVol: 0.06,
  maxVol: 1.5,
  dof: 4, // Freiheitsgrade der Student-t-Verteilung (kleiner = fettere Ränder)
  small: { rate: 72, scale: 0.015, clamp: 0.12, volBoost: 0.02 }, // ~alle 20 Min., ~1–4 %
  big: { rate: 4, scale: 0.06, clamp: 0.4, volBoost: 0.2 }, // ~4x täglich, 5–20 %, manchmal mehr
  // Großer Sprung: pro Würfelfenster (die Engine würfelt 2× täglich) mit dieser Chance.
  // Größe im Log-Maß gleichverteilt: nach oben +20 % … +100 %, nach unten −17 % … −70 %.
  surge: { chance: 0.5, min: Math.log(1.2), upMax: Math.log(2), downMax: -Math.log(0.3), volBoost: 0.8 },
  floor: 0.0001, // Mindestkurs in €
};

const LN_BASE = Math.log(PARAMS.baseVol);
const LN_MIN = Math.log(PARAMS.minVol);
const LN_MAX = Math.log(PARAMS.maxVol);

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

// Anteil der großen Sprünge nach oben, bei dem sich Anstiege und Einbrüche im Log-Maß aufheben (≈ 61 %)
const SURGE_UP_CHANCE = (PARAMS.surge.min + PARAMS.surge.downMax) / (2 * PARAMS.surge.min + PARAMS.surge.upMax + PARAMS.surge.downMax);

/**
 * Ein Simulationsschritt.
 * @param {{price: number, lv: number}} state  lv = log(Volatilität pro Tag)
 * @param {number} dt  Schrittweite in Tagen
 * @param {() => number} rng
 * @returns {{price: number, lv: number, events: {type: string, change: number}[]}}
 */
function step(state, dt, rng = Math.random) {
  const sigma = Math.exp(state.lv);
  const events = [];

  let r = sigma * Math.sqrt(dt) * studentT(rng, PARAMS.dof);
  let lv = state.lv + PARAMS.volMeanRev * (LN_BASE - state.lv) * dt + PARAMS.volOfVol * Math.sqrt(dt) * normal(rng);

  if (rng() < PARAMS.small.rate * dt) {
    r += jumpSize(rng, PARAMS.small);
    lv += PARAMS.small.volBoost;
  }
  if (rng() < PARAMS.big.rate * dt) {
    const j = jumpSize(rng, PARAMS.big);
    r += j;
    lv += PARAMS.big.volBoost;
    events.push({ type: j >= 0 ? 'anstieg' : 'einbruch', change: Math.expm1(j) });
  }

  const price = Math.max(PARAMS.floor, state.price * Math.exp(r));
  return { price, lv: clamp(lv, LN_MIN, LN_MAX), events };
}

/**
 * Würfelt einen großen Sprung aus (ein Würfelfenster): null oder { log, change, type, volBoost }.
 * log = Änderung im Log-Maß, change = relative Änderung (z. B. -0.35 oder +0.8).
 */
function rollSurge(rng = Math.random) {
  const j = PARAMS.surge;
  if (rng() >= j.chance) return null;
  const up = rng() < SURGE_UP_CHANCE;
  const log = up ? uniform(rng, j.min, j.upMax) : -uniform(rng, j.min, j.downMax);
  return { log, change: Math.expm1(log), type: up ? 'pump' : 'crash', volBoost: j.volBoost };
}

const initialState = (price = 10) => ({ price, lv: LN_BASE });

module.exports = { PARAMS, step, rollSurge, LN_MAX, SURGE_UP_CHANCE, initialState, mulberry32 };

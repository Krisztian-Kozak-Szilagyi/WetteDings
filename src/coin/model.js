/**
 * Kursmodell für den Samantha Coin – Simulation eines sehr volatilen Krypto-Kurses.
 * Bewusst etwas "spielerischer" als ein echter Coin: mehr Bewegung, häufigere Sprünge.
 *
 * Bausteine (alle Zeitangaben in Tagen):
 *  1. Stochastische Volatilität: log(σ) schwankt um eine Basis (ruhige und wilde Phasen, Volatilitäts-Cluster).
 *  2. Diffusion mit fetten Rändern: Student-t verteilte Zufallsrenditen statt Normalverteilung.
 *  3. Sprünge: kleine (etwa halbstündlich, 1–3 %) und große (etwa 2× täglich, 5–15 %, manchmal 30 %+).
 *  4. Extremereignisse: Pump (+40…+150 %, etwa alle 2 Monate) und Crash (−80…−99 %, selten).
 *  5. Nach Sprüngen steigt die Volatilität (Panik / FOMO) und klingt langsam wieder ab.
 *  6. Drift-Kompensation: Der erwartete Kurs steigt nur leicht (≈ +0,05 %/Tag). Der Median fällt dabei
 *     – wie bei echten, sehr volatilen Coins – eher, wenige Ausreißer nach oben gleichen das aus.
 */

const PARAMS = {
  expectedDailyReturn: 0.0005, // erwartete Rendite pro Tag (≈ +20 % pro Jahr)
  baseVol: 0.07, // Grundvolatilität pro Tag (7 %)
  volMeanRev: 4, // 1/Tag: wie schnell die Volatilität zur Basis zurückkehrt
  volOfVol: 1.0, // Schwankung der Volatilität
  minVol: 0.03,
  maxVol: 1.0,
  dof: 4, // Freiheitsgrade der Student-t-Verteilung (kleiner = fettere Ränder)
  small: { rate: 36, scale: 0.01, clamp: 0.1, volBoost: 0.02 }, // ~alle 40 Min., ~1–3 %
  big: { rate: 1.5, scale: 0.045, clamp: 0.5, volBoost: 0.2 }, // ~1–2x täglich, 5–15 %, manchmal 30 %+
  pump: { rate: 1 / 60, min: 0.4, max: 1.5, volBoost: 0.9 }, // +40 % … +150 % (etwa alle 2 Monate)
  crash: { rate: 1 / 500, min: 0.8, max: 0.99, volBoost: 1.0 }, // −80 % … −99 % (≈ 50 % Chance pro Jahr)
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

/**
 * Kompensator: erwartete relative Kursänderung pro Tag durch alle Sprungarten.
 * Wird von der Drift abgezogen, damit der Erwartungswert kontrolliert bleibt.
 */
const JUMP_COMPENSATION = (() => {
  const rng = mulberry32(12345);
  const n = 200000;
  let small = 0;
  let big = 0;
  for (let i = 0; i < n; i++) {
    small += Math.expm1(jumpSize(rng, PARAMS.small));
    big += Math.expm1(jumpSize(rng, PARAMS.big));
  }
  const pumpMean = (PARAMS.pump.min + PARAMS.pump.max) / 2;
  const crashMean = -(PARAMS.crash.min + PARAMS.crash.max) / 2;
  return (
    PARAMS.small.rate * (small / n) +
    PARAMS.big.rate * (big / n) +
    PARAMS.pump.rate * pumpMean +
    PARAMS.crash.rate * crashMean
  );
})();

const LOG_DRIFT_BASE = Math.log(1 + PARAMS.expectedDailyReturn) - JUMP_COMPENSATION;

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

  let r = (LOG_DRIFT_BASE - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * studentT(rng, PARAMS.dof);
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
  if (rng() < PARAMS.pump.rate * dt) {
    const up = uniform(rng, PARAMS.pump.min, PARAMS.pump.max);
    r += Math.log1p(up);
    lv += PARAMS.pump.volBoost;
    events.push({ type: 'pump', change: up });
  }
  if (rng() < PARAMS.crash.rate * dt) {
    const down = uniform(rng, PARAMS.crash.min, PARAMS.crash.max);
    r += Math.log1p(-down);
    lv += PARAMS.crash.volBoost;
    events.push({ type: 'crash', change: -down });
  }

  const price = Math.max(PARAMS.floor, state.price * Math.exp(r));
  return { price, lv: clamp(lv, LN_MIN, LN_MAX), events };
}

const initialState = (price = 10) => ({ price, lv: LN_BASE });

module.exports = { PARAMS, step, initialState, mulberry32, JUMP_COMPENSATION };

// Live-Turm für eSports-Teams: reine Spiellogik ohne Datenbank und Express (getestet in test/live-tower.test.js).
// Ablauf: Kampf → taktische Pause (höchstens PAUSE_SECONDS, oder bis alle „Weiter“ drücken) → nächster Kampf, bis ein
// Stockwerk verloren geht. Das Team hat eine gemeinsame Energie (ENERGY) für Fähigkeiten, jeder Spieler seinen „Bock“
// (0–100 %): Bosse nehmen am Kampfbeginn und zur Halbzeit einem Spieler DRAIN Bock, bei 0 % zählt seine Karte nicht mehr.
// Alle eSports-Teams bekommen in einer Woche dieselben Stockwerke und Boss-Eigenschaften (weekPlan, fester Seed).
// Werte von Krisztian (2026-10-09), Simulation in .claude/notes – Energie, Kosten und Bock-Abzug.

const ENERGY = 8; // Team-Energie zum Start (und nach einem BfW Energy)
const COSTS = { boost: 3, einzel: 1, wechsel: 2, verl: 3 };
const OVERLOAD = 1; // jede weitere Fähigkeit in derselben Pause kostet so viel mehr
const BOOST_FACTOR = 1.2;
const BOOST_SECONDS = 40; // ab Kampfbeginn, läuft in der Pause danach weiter
const EXT_SECONDS = 7; // Verlängerung (echte Sekunden der Wiedergabe)
const PAUSE_SECONDS = 40;
const START_SECONDS = 5; // Countdown vor dem ersten Kampf
const DRAIN = 17.5; // Bock-Abzug je Treffer (Kampfbeginn und Halbzeit)
const SWITCH_BOCK = 50; // Kartenwechsel: unter so viel Bock startet die neue Karte mit genau so viel, darüber bleibt der Bock
const COFFEE = { 'casino-kaffee-1-crumpled': 20, 'casino-kaffee-2-bfwler': 35, 'casino-kaffee-3-gold': 60 };
const ENERGY_CARD = 'bfw-energy-gold';
const STATS = ['fia', 'fis', 'bwl'];

// Boss-Eigenschaften: jede Woche neu verteilt (ab Stockwerk 2)
const TRAITS = [
  { key: 'dieb', label: 'Dieb', text: 'Nimmt dem stärksten Spieler Bock.' },
  { key: 'bannkreis', label: 'Bannkreis', text: 'Boosts wirken hier nicht.' },
  { key: 'wut', label: 'Wut', text: 'In der zweiten Hälfte läuft die Zeit schneller.' },
  { key: 'panzer', label: 'Panzer', text: 'Die ersten 15 % der Punkte prallen ab.' },
  { key: 'blutdurst', label: 'Blutdurst', text: 'Nimmt doppelt so viel Bock.' },
  { key: 'nebel', label: 'Nebel', text: 'Danach ist nicht zu sehen, was der nächste Boss will.' },
  { key: 'zeitfresser', label: 'Zeitfresser', text: 'Die Verlängerung wirkt nur halb.' },
  { key: 'fluch', label: 'Fluch', text: 'Die stärkste Karte bringt 20 % weniger.' },
];
const traitByKey = Object.fromEntries(TRAITS.map((t) => [t.key, t]));
const PANZER = 0.15;
const FLUCH = 0.8;
const WUT = 1.5; // so viel schneller läuft die Zeit in der zweiten Hälfte

/** Zufall mit festem Seed (Text) – gleiche Woche, gleicher Turm */
function seeded(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Turm der Woche: Stockwerk n (Index n-1) = { key, stat, trait }. Jedes Stockwerk bekommt für die Woche eine
 * Eigenschaft (gemischt, damit alle vorkommen); das erste Stockwerk hat keine. Nie zweimal dasselbe hintereinander.
 */
function weekPlan(week, floors, count = 80) {
  const rand = seeded(`mage-tower:${week}`);
  const traitOf = {};
  let bag = [];
  for (const f of floors) {
    if (!bag.length) bag = shuffle(TRAITS.map((t) => t.key), rand);
    traitOf[f.key] = bag.pop();
  }
  const plan = [];
  let prev = null;
  for (let n = 1; n <= count; n++) {
    const stat = STATS[Math.floor(rand() * STATS.length)];
    const pool = floors.filter((f) => f.stat === stat && f.key !== prev);
    const f = pool[Math.floor(rand() * pool.length)];
    prev = f.key;
    plan.push({ key: f.key, stat, trait: n === 1 ? null : traitOf[f.key] });
  }
  return plan;
}

/** Ziel mit Panzer (die ersten 15 % prallen ab) */
const effectiveRequired = (required, trait) => Math.round(required * (trait === 'panzer' ? 1 + PANZER : 1));

/**
 * Ein Kampf.
 * sims[m] = { ticks: [{ t, p, crit, ability, destroy, st }], freeze, extend, speed } – Takte aus ihkService.simulate
 *   (Fähigkeiten der Karten inklusive); bock[m] = Bock vor dem Kampf; values[m] = Kartenwert für den Stat.
 * o = { required (schon mit Panzer), trait, boostUntil: [echte Sekunden ab Kampfbeginn je Spieler], ext (echte s),
 *       rand, workTime (Spiel-Sekunden), fightSeconds (echte Sekunden für workTime) }
 * → { ticks: [{ m, t, p, crit, boost }], drains: [{ m, t, amount, bock }], total, success, doneAt, limit, seconds, bock }
 */
function playFight(sims, bockIn, values, o) {
  const W = o.workTime;
  const F = o.fightSeconds;
  const toReal = (t) => (t * F) / W;
  const ext = (o.trait === 'zeitfresser' ? o.ext / 2 : o.ext) || 0;
  const extGame = (ext * W) / F;
  const bock = [...bockIn];
  const events = [];
  let limit = W;
  sims.forEach((s, m) => {
    const own = W + (s.freeze || 0) + (s.extend || 0);
    limit = Math.max(limit, own);
    s.ticks.forEach((x) => events.push({ m, t: x.t, p: x.p, crit: !!x.crit, destroy: !!x.destroy }));
    // Verlängerung: weitere Takte im Grundtempo nach Ablauf der eigenen Zeit
    if (extGame > 0 && values[m] > 0) {
      const iv = W / (10 + Math.max(0, s.speed || 0) / 10);
      const last = s.ticks.length ? s.ticks[s.ticks.length - 1].t : 0;
      for (let t = last + iv; t <= own + extGame; t += iv) {
        const crit = o.rand() < 0.1;
        events.push({ m, t: Math.round(t * 10) / 10, p: Math.max(1, Math.round(values[m] * (0.8 + 0.4 * o.rand()) * (crit ? 2 : 1))), crit });
      }
    }
  });
  limit += extGame;
  // Wut: ab der Halbzeit läuft die Deadline WUT-mal so schnell
  if (o.trait === 'wut') limit = W / 2 + (limit - W / 2) / WUT;
  events.sort((a, b) => a.t - b.t || a.m - b.m);

  // Fluch: die Karte mit dem höchsten Wert (bei Gleichstand die erste)
  const strongest = values.indexOf(Math.max(...values));
  const drains = [];
  const drain = (t) => {
    const alive = bock.map((b, m) => (b > 0 ? m : -1)).filter((m) => m >= 0);
    if (!alive.length) return;
    const m = o.trait === 'dieb' ? alive.reduce((best, i) => (values[i] > values[best] ? i : best), alive[0]) : alive[Math.floor(o.rand() * alive.length)];
    const amount = DRAIN * (o.trait === 'blutdurst' ? 2 : 1);
    bock[m] = Math.max(0, Math.round((bock[m] - amount) * 10) / 10);
    drains.push({ m, t, amount, bock: bock[m] });
  };
  drain(0);
  let half = false;
  let total = 0;
  let doneAt = null;
  const ticks = [];
  for (const e of events) {
    if (e.t > limit + 1e-9) break;
    if (!half && e.t > W / 2) {
      drain(W / 2);
      half = true;
    }
    if (bock[e.m] <= 0) continue;
    const boost = o.trait !== 'bannkreis' && !e.destroy && toReal(e.t) < (o.boostUntil[e.m] || 0);
    let p = e.p;
    if (!e.destroy) p = Math.max(1, Math.round(p * (boost ? BOOST_FACTOR : 1) * (o.trait === 'fluch' && e.m === strongest ? FLUCH : 1)));
    total += p;
    ticks.push({ m: e.m, t: e.t, p, crit: e.crit, boost });
    if (total >= o.required) {
      doneAt = e.t;
      break;
    }
  }
  if (!half && doneAt === null) drain(W / 2); // Kampf ohne Takte nach der Halbzeit: der Treffer kommt trotzdem
  const success = total >= o.required;
  const seconds = Math.max(1, Math.round(toReal(success ? doneAt : limit) * 10) / 10);
  return { ticks, drains, total: Math.min(total, o.required), success, doneAt, limit, seconds, bock };
}

// ---------- Fähigkeiten in der Pause ----------
/** Verbrauchte Energie der gewählten Fähigkeiten (in Wahl-Reihenfolge; ab der zweiten +OVERLOAD) */
const spentOf = (chosen) => chosen.reduce((s, c, i) => s + COSTS[c.key] + (i > 0 ? OVERLOAD : 0), 0);

/**
 * Fähigkeit wählen oder abwählen (Team-Fähigkeiten: boost, einzel, verl). Jeder im Team darf das, auch für andere.
 * Boost für alle und für eine Karte schließen sich aus; dieselbe Wahl noch einmal = abwählen.
 * → { chosen } oder { error }
 */
function toggleChoice(chosen, energy, { key, by, target = null }) {
  if (!['boost', 'einzel', 'verl'].includes(key)) return { error: 'Diese Fähigkeit gibt es nicht.' };
  if (key === 'einzel' && !(Number.isInteger(target) && target >= 0 && target <= 2)) return { error: 'Für welche Karte?' };
  const i = chosen.findIndex((c) => c.key === key);
  if (i >= 0 && (key !== 'einzel' || chosen[i].target === target)) return { chosen: chosen.filter((_, k) => k !== i) };
  const rival = key === 'boost' ? 'einzel' : key === 'einzel' ? 'boost' : null;
  const next = [...chosen.filter((c) => c.key !== key && c.key !== rival), { key, by, target: key === 'einzel' ? target : null }];
  if (spentOf(next) > energy) return { error: 'Zu wenig Energie.' };
  return { chosen: next };
}

/** Kartenwechsel: kostet wie eine Fähigkeit (bleibt gewählt). → { chosen } oder { error } */
function addSwitch(chosen, energy, by) {
  if (chosen.some((c) => c.key === 'wechsel' && c.by === by)) return { error: 'Du hast in dieser Pause schon gewechselt.' };
  const next = [...chosen, { key: 'wechsel', by, target: by }];
  if (spentOf(next) > energy) return { error: 'Zu wenig Energie.' };
  return { chosen: next };
}

/**
 * Was die Wahl für den nächsten Kampf bedeutet: Boost-Ende je Spieler (ms, absolut), Verlängerung, Energie danach.
 * boostUntil = bisheriges Boost-Ende je Spieler (ms) – ein laufender Boost bleibt, ein neuer beginnt mit dem Kampf.
 */
function applyChoices(chosen, energy, boostUntil, fightStart) {
  const until = [...boostUntil];
  const end = fightStart + BOOST_SECONDS * 1000;
  for (const c of chosen) {
    if (c.key === 'boost') for (let m = 0; m < until.length; m++) until[m] = Math.max(until[m] || 0, end);
    if (c.key === 'einzel') until[c.target] = Math.max(until[c.target] || 0, end);
  }
  return { boostUntil: until, ext: chosen.some((c) => c.key === 'verl') ? EXT_SECONDS : 0, energy: energy - spentOf(chosen) };
}

module.exports = {
  ENERGY,
  COSTS,
  OVERLOAD,
  BOOST_FACTOR,
  BOOST_SECONDS,
  EXT_SECONDS,
  PAUSE_SECONDS,
  START_SECONDS,
  DRAIN,
  SWITCH_BOCK,
  COFFEE,
  ENERGY_CARD,
  TRAITS,
  traitByKey,
  PANZER,
  seeded,
  weekPlan,
  effectiveRequired,
  playFight,
  spentOf,
  toggleChoice,
  addSwitch,
  applyChoices,
};

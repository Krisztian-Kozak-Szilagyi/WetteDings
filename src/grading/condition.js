// Zustand einer Karte: konkrete Mängel (Kratzer, Ecken, Kantenmacken, Knick) und die Note, die daraus folgt.
// Gilt für die Kundenkarten im Grading-Shop (Profil "kunde") und für jede Karte im Besitz eines Mitglieds
// (Profil "frisch", siehe TcgCard.condition) – dort ist er geheim, bis die Karte foliert wird (#73).
// Die Mängel werden gespeichert, nicht nur die Note: so kann eine eigene Karte später 1:1 in den Grading-Shop.
// Nur crypto – das Karten-Modell lädt dieses Modul, darum keine weiteren Abhängigkeiten.
const crypto = require('crypto');

// Version der Würfel-Regeln: ändern sie sich, bleiben gespeicherte Zustände gültig und unterscheidbar
const CONDITION_VERSION = 1;

const rnd = (min, max) => min + (crypto.randomInt(1000000) / 1000000) * (max - min);
const chance = (p) => crypto.randomInt(1000000) < p * 1000000;
const pick = (list) => list[crypto.randomInt(list.length)];
/** Index nach Gewichten, z. B. [40, 35, 18, 7] */
function weighted(weights) {
  let roll = crypto.randomInt(weights.reduce((s, w) => s + w, 0));
  for (let i = 0; i < weights.length; i++) {
    if (roll < weights[i]) return i;
    roll -= weights[i];
  }
  return 0;
}

// Zentrierung je Achse (links/rechts, oben/unten) als Anteil der breiteren Seite, z. B. 58 = 58/42.
// Bereiche, aus denen gewürfelt wird, und die Höchstnote je Bereich (wie bei PSA: Zentrierung begrenzt die Note)
const CENTERING = [
  { max: 55, cap: 10 },
  { max: 60, cap: 9 },
  { max: 65, cap: 8 },
  { max: 70, cap: 7 },
  { max: 80, cap: 6 },
];
// Ein Knick begrenzt die Note auf höchstens … (wie bei echtem Grading)
const CREASE_CAP = 4;

// Wie oft welche Mängel vorkommen. scratches/edges: Gewichte für 0, 1, 2 … Stück; corner/crease: Wahrscheinlichkeit;
// centering: Gewichte je Achse für die Bereiche in CENTERING (null = immer perfekt zentriert).
// kunde: gebrauchte Karten der Kunden im Grading-Shop – ohne Zentrierung, die stellt der Shop (noch) nicht dar
// frisch: Karten aus dem Pack, dem Black Market oder vom Team – Note 8 am häufigsten (≈ 30 %), 9 ≈ 27 %,
// 10 ≈ 9 %, Ø 7,9 (exakt nachrechenbar; test/condition.test.js prüft die Form)
const PROFILES = {
  kunde: { scratches: [40, 35, 18, 7], corner: 0.15, edges: [60, 30, 10], crease: 0.08, centering: null },
  frisch: { scratches: [34, 38, 21, 7], corner: 0.12, edges: [72, 22, 6], crease: 0.02, centering: [80, 12, 5, 2, 1] },
};

/** Zentrierung einer Achse: Bereich nach Gewichten, darin ein ganzzahliger Wert (50 = perfekt) */
function rollAxis(weights) {
  const i = weighted(weights);
  const min = i === 0 ? 50 : CENTERING[i - 1].max + 1;
  return min + crypto.randomInt(CENTERING[i].max - min + 1);
}

/** Höchstnote durch die Zentrierung (schlechtere Achse zählt); ohne Angabe 10 */
function centeringCap(centering) {
  if (!centering) return 10;
  const worst = Math.max(centering.lr || 50, centering.tb || 50);
  const range = CENTERING.find((c) => worst <= c.max) || CENTERING[CENTERING.length - 1];
  return range.cap;
}

/** Mängel der Vorderseite (Positionen in % der Kartenfläche) – Form wie GradingJob.defects */
function rollDefects(profile = 'kunde') {
  const p = PROFILES[profile] || PROFILES.kunde;
  const scratches = Array.from({ length: weighted(p.scratches) }, () => ({
    x: Math.round(rnd(20, 80)),
    y: Math.round(rnd(18, 82)),
    len: Math.round(rnd(14, 30)),
    angle: Math.round(rnd(-70, 70)),
  }));
  const corners = [0, 1, 2, 3].filter(() => chance(p.corner));
  const edges = Array.from({ length: weighted(p.edges) }, () => ({ side: crypto.randomInt(4), pos: Math.round(rnd(20, 80)) }));
  const crease = chance(p.crease);
  const defects = { scratches, corners, edges, crease };
  if (p.centering) defects.centering = { lr: rollAxis(p.centering), tb: rollAxis(p.centering) };
  return defects;
}

/**
 * Note aus den Mängeln: Start 10 (mit Knick: Start CREASE_CAP), Kratzer, Ecke, Kantenmacke je −1.
 * Die Zentrierung begrenzt die Note nach oben (siehe CENTERING). Mindestens 1.
 */
function gradeFor(defects) {
  const minus = defects.scratches.length + defects.corners.length + defects.edges.length;
  const start = defects.crease ? CREASE_CAP : 10;
  return Math.max(1, Math.min(start - minus, centeringCap(defects.centering)));
}

/** Zustand einer Karte im Besitz eines Mitglieds: { v, grade, defects } */
function rollCondition(profile = 'frisch') {
  const defects = rollDefects(profile);
  return { v: CONDITION_VERSION, grade: gradeFor(defects), defects };
}

/**
 * Sichtbarer Versatz einer folierten Karte aus ihrer Zentrierung: { x, y } von −1 bis 1 (0 = mittig).
 * Gespeichert ist nur, wie schief (z. B. 62/38) – in welche Richtung, ergibt sich fest aus der Exemplar-ID,
 * damit dasselbe Exemplar immer gleich aussieht. Ohne Zentrierung: null.
 */
function centerShift(centering, id) {
  if (!centering) return null;
  const bits = Number.parseInt(String(id || '').slice(-2), 16) || 0;
  const sx = bits & 1 ? -1 : 1;
  const sy = bits & 2 ? -1 : 1;
  const r = (v) => Math.round(v * 1000) / 1000;
  return { x: r((sx * ((centering.lr || 50) - 50)) / 50), y: r((sy * ((centering.tb || 50) - 50)) / 50) };
}

// Bezeichnungen der Noten (wie auf echten Grading-Etiketten)
const GRADE_NAMES = { 10: 'GEM MINT', 9: 'MINT', 8: 'NM-MT', 7: 'NEAR MINT', 6: 'EX-MT', 5: 'EXCELLENT', 4: 'VG-EX', 3: 'VERY GOOD', 2: 'GOOD', 1: 'POOR' };
const gradeWord = (grade) => GRADE_NAMES[grade] || '';

/**
 * Kennzahlen der gegradeten (= folierten, Note sichtbar) Karten einer Sammlung: { count, best, bestCount, avg, dist }
 * (dist[g] = Anzahl mit Note g, Index 1–10)
 * oder null, wenn keine dabei ist. Unfolierte Karten zählen nie mit – ihr Zustand bleibt geheim.
 */
function gradeStats(grades) {
  const list = grades.filter((g) => Number.isInteger(g) && g >= 1 && g <= 10);
  if (!list.length) return null;
  const best = Math.max(...list);
  const dist = Array(11).fill(0);
  list.forEach((g) => (dist[g] += 1));
  return { count: list.length, best, bestCount: dist[best], avg: list.reduce((s, g) => s + g, 0) / list.length, dist };
}

module.exports = { CONDITION_VERSION, PROFILES, CENTERING, CREASE_CAP, centeringCap, rnd, chance, pick, weighted, rollDefects, gradeFor, rollCondition, GRADE_NAMES, gradeWord, gradeStats, centerShift };

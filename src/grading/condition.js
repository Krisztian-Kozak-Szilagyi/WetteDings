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

// Wie oft welche Mängel vorkommen. scratches/edges: Gewichte für 0, 1, 2 … Stück; corner/crease: Wahrscheinlichkeit.
// kunde: gebrauchte Karten der Kunden im Grading-Shop (Note 10 ≈ 11 %)
// frisch: Karten aus dem Pack, dem Black Market oder vom Team (Note 10 ≈ 30 %, meist 8–10)
const PROFILES = {
  kunde: { scratches: [40, 35, 18, 7], corner: 0.15, edges: [60, 30, 10], crease: 0.08 },
  frisch: { scratches: [55, 30, 12, 3], corner: 0.08, edges: [80, 17, 3], crease: 0.02 },
};

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
  return { scratches, corners, edges, crease };
}

/** Note aus den Mängeln: Kratzer, Ecke, Kantenmacke je −1, Knick −3 */
function gradeFor(defects) {
  const minus = defects.scratches.length + defects.corners.length + defects.edges.length + (defects.crease ? 3 : 0);
  return Math.max(1, 10 - minus);
}

/** Zustand einer Karte im Besitz eines Mitglieds: { v, grade, defects } */
function rollCondition(profile = 'frisch') {
  const defects = rollDefects(profile);
  return { v: CONDITION_VERSION, grade: gradeFor(defects), defects };
}

// Bezeichnungen der Noten (wie auf echten Grading-Etiketten)
const GRADE_NAMES = { 10: 'GEM MINT', 9: 'MINT', 8: 'NM-MT', 7: 'NEAR MINT', 6: 'EX-MT', 5: 'EXCELLENT', 4: 'VG-EX', 3: 'VERY GOOD', 2: 'GOOD', 1: 'POOR' };
const gradeWord = (grade) => GRADE_NAMES[grade] || '';

module.exports = { CONDITION_VERSION, PROFILES, rnd, chance, pick, weighted, rollDefects, gradeFor, rollCondition, GRADE_NAMES, gradeWord };

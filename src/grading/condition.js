// Zustand einer Karte: konkrete Mängel (Kratzer, Ecken, Kantenmacken, Knick) und die Note, die daraus folgt.
// Gilt für die Kundenkarten im Grading-Shop (Profil "kunde") und für jede Karte im Besitz eines Mitglieds
// (Profil "frisch", siehe TcgCard.condition) – dort ist er geheim, bis die Karte foliert wird (#73).
// Die Mängel werden gespeichert, nicht nur die Note: so kann eine eigene Karte später 1:1 in den Grading-Shop.
// Nur crypto – das Karten-Modell lädt dieses Modul, darum keine weiteren Abhängigkeiten.
const crypto = require('crypto');

// Version der Würfel-Regeln: ändern sie sich, bleiben gespeicherte Zustände gültig und unterscheidbar
// 2: Zentrierung nur noch links/rechts (oben/unten wird nicht mehr gewürfelt und zählt nicht)
// 3: frische Karten ohne Kratzer und Knick (#204) – die entstehen erst im Spiel (src/grading/damage.js)
const CONDITION_VERSION = 3;

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

// Zentrierung links/rechts als Anteil der breiteren Seite, z. B. 58 = 58/42. Oben/unten zählt nicht (ältere
// Zustände haben noch tb gespeichert – es wird ignoriert).
// Bereiche, aus denen gewürfelt wird, und die Höchstnote je Bereich (wie bei PSA: Zentrierung begrenzt die Note)
const CENTERING = [
  { max: 55, cap: 10 },
  { max: 60, cap: 9 },
  { max: 65, cap: 8 },
  { max: 70, cap: 7 },
  { max: 80, cap: 6 },
];
// Ein Knick setzt die Obergrenze auf … (wie bei echtem Grading) – gebügelt höher, siehe ironCap
const CREASE_CAP = 4;

// Wie oft welche Mängel vorkommen. scratches/edges: Gewichte für 0, 1, 2 … Stück; corner/crease: Wahrscheinlichkeit;
// centering: Gewichte für die Bereiche in CENTERING (null = immer perfekt zentriert, z. B. alte Aufträge).
// Die Gewichte entsprechen genau der schlechteren von zwei Achsen mit [78, 13, 5, 3, 1] bzw. [86, 9, 3, 1, 1] –
// so blieb die Notenverteilung gleich, als oben/unten wegfiel (Version 2).
// kunde: gebrauchte Karten der Kunden im Grading-Shop – Note 8 am häufigsten (≈ 23 %), 10 ≈ 9 %, Ø 7,2
// frisch: Karten aus dem Pack, dem Black Market oder vom Team – nur Zentrierung, Ecken und Kanten, nie Kratzer
// oder Knick (#204): Note 10 am häufigsten (≈ 36 %), 9 ≈ 35 %, 8 ≈ 18 %, Ø 8,9 (exakt nachrechenbar;
// test/condition.test.js prüft die Form)
const PROFILES = {
  kunde: { scratches: [42, 35, 18, 5], corner: 0.13, edges: [62, 30, 8], crease: 0.06, centering: [6084, 2197, 935, 585, 199] },
  frisch: { scratches: [100], corner: 0.10, edges: [74, 22, 4], crease: 0, centering: [7396, 1629, 579, 197, 199] },
};

/** Zentrierung links/rechts: Bereich nach Gewichten, darin ein ganzzahliger Wert (50 = perfekt) */
function rollAxis(weights) {
  const i = weighted(weights);
  const min = i === 0 ? 50 : CENTERING[i - 1].max + 1;
  return min + crypto.randomInt(CENTERING[i].max - min + 1);
}

/** Höchstnote durch die Zentrierung (nur links/rechts); ohne Angabe 10 */
function centeringCap(centering) {
  if (!centering) return 10;
  const lr = centering.lr || 50;
  const range = CENTERING.find((c) => lr <= c.max) || CENTERING[CENTERING.length - 1];
  return range.cap;
}

/** Ein Kratzer irgendwo auf der Vorderseite (Positionen in % der Kartenfläche) */
const rollScratch = () => ({ x: Math.round(rnd(20, 80)), y: Math.round(rnd(18, 82)), len: Math.round(rnd(14, 30)), angle: Math.round(rnd(-70, 70)) });

/** Mängel der Vorderseite (Positionen in % der Kartenfläche) – Form wie GradingJob.defects */
function rollDefects(profile = 'kunde') {
  const p = PROFILES[profile] || PROFILES.kunde;
  const scratches = Array.from({ length: weighted(p.scratches) }, rollScratch);
  const corners = [0, 1, 2, 3].filter(() => chance(p.corner));
  const edges = Array.from({ length: weighted(p.edges) }, () => ({ side: crypto.randomInt(4), pos: Math.round(rnd(20, 80)) }));
  const crease = chance(p.crease);
  const defects = { scratches, corners, edges, crease };
  if (p.centering) defects.centering = { lr: rollAxis(p.centering) };
  return defects;
}

/**
 * Obergrenze einer Karte: der niedrigste Wert aus Knick (CREASE_CAP) und Zentrierung (CENTERING), sonst 10.
 * { cap, by: 'knick' | 'zentrierung' | null }
 */
function gradeCap(defects) {
  const center = centeringCap(defects.centering);
  const crease = defects.creaseCap || CREASE_CAP; // gebügelt: höhere Obergrenze
  if (defects.crease && crease <= center) return { cap: crease, by: 'knick' };
  return { cap: center, by: center < 10 ? 'zentrierung' : null };
}

/**
 * Note in zwei Schritten (so steht es auch im Grading-Shop): erst die Obergrenze (Knick, Zentrierung),
 * dann davon je Kratzer, bestoßene Ecke und Kantenmacke −1. Mindestens 1.
 */
function gradeFor(defects) {
  const minus = defects.scratches.length + defects.corners.length + defects.edges.length;
  return Math.max(1, gradeCap(defects).cap - minus);
}

/** Zustand einer Karte im Besitz eines Mitglieds: { v, grade, defects } */
function rollCondition(profile = 'frisch') {
  const defects = rollDefects(profile);
  return { v: CONDITION_VERSION, grade: gradeFor(defects), defects };
}

// Tiefe Kopie der Mängel (gespeicherte Zustände sind schlichte Objekte) – die Helfer unten ändern nie das Original
const copyDefects = (defects) => JSON.parse(JSON.stringify(defects || {}));

/**
 * Schaden im Spiel (#204): 'kratzer' oder 'knick'. Ein zweiter Knick auf einer geknickten Karte wird zum Kratzer;
 * ein neuer Knick hebt ein früheres Bügeln auf (er darf wieder gebügelt werden). Gibt neue Mängel zurück.
 */
function addDamage(defects, kind) {
  const d = copyDefects(defects);
  d.scratches = d.scratches || [];
  if (kind === 'knick' && !d.crease) {
    d.crease = true;
    delete d.creaseCap;
    delete d.ironed;
  } else d.scratches.push(rollScratch());
  return d;
}

/**
 * Zustand auf Version 3 heben (Migration, #204): unfolierte Karten verlieren Kratzer und Knick (frische Karten haben
 * keine mehr, ihre Note ist ohnehin geheim); folierte behalten ihre sichtbaren Mängel und ihre Note.
 * Ab Version 3 bleibt alles, wie es ist – so löscht die Migration nie einen späteren Schaden.
 */
function conditionV3(cond, foiled) {
  if (!cond || cond.v >= 3) return cond;
  if (foiled) return { ...cond, v: 3 };
  const defects = { ...copyDefects(cond.defects), scratches: [], crease: false };
  delete defects.creaseCap;
  delete defects.ironed;
  return { v: 3, grade: gradeFor(defects), defects };
}

// ---------- Bügeln (#204) ----------
// Der Knick ist eine Linie quer über die Karte aus CREASE_SEGMENTS Stücken. Wie viel davon glatt wird, bestimmt die
// neue Obergrenze: 0 % bleibt bei CREASE_CAP, je 20 % eine Note mehr, höchstens 9 (ein Knick bleibt sichtbar).
const CREASE_SEGMENTS = 10;
const IRON_MAX_CAP = 9;
/** Knick-Obergrenze nach dem Bügeln, smooth = geglättet in % */
const ironCap = (smooth) => Math.min(IRON_MAX_CAP, CREASE_CAP + Math.floor(Math.max(0, Math.min(100, smooth || 0)) / 20));

/**
 * Lage des Knicks: { y, angle } – waagerecht quer über die Karte, Höhe y in % und leichte Schräge in Grad.
 * Fest aus der ID (Exemplar oder Auftrag), damit derselbe Knick immer gleich aussieht – wie centerShift.
 */
function creaseLine(id) {
  const bits = Number.parseInt(String(id || '').slice(-4), 16) || 0;
  return { y: 30 + (bits % 41), angle: ((bits >> 6) % 25) - 12 };
}

/**
 * Gebügelten Knick eintragen: neue Obergrenze aus smooth (0–100 %), jeder Brandfleck (zu lange auf einer Stelle)
 * zählt als Kratzer auf der Knicklinie. Ohne Knick oder schon gebügelt: unverändert. Gibt neue Mängel zurück.
 */
function applyIron(defects, { smooth, burns }, line = { y: 50, angle: 0 }) {
  const d = copyDefects(defects);
  if (!d.crease || d.ironed) return d;
  const n = Math.max(0, Math.min(CREASE_SEGMENTS, Math.floor(Number(burns) || 0)));
  d.scratches = d.scratches || [];
  for (let i = 0; i < n; i++) {
    const x = Math.round(10 + ((i + 0.5) * 80) / n);
    d.scratches.push({ x, y: Math.round(line.y + Math.tan((line.angle * Math.PI) / 180) * (x - 50)), len: 8, angle: line.angle });
  }
  return Object.assign(d, { creaseCap: ironCap(smooth), ironed: true });
}

/**
 * Sichtbare Spuren eines Exemplars (#204) – nur das, was man an der Karte sieht, wenn man genau hinschaut: Kratzer
 * und Knick. Ecken, Kanten, Zentrierung und die Note bleiben geheim. defects darf unvollständig sein (geladen werden
 * nur condition.defects.scratches und .crease). id legt die Lage des Knicks fest (creaseLine), ironed = gebügelt.
 * Gibt { s: [[x, y, len, angle]], c: { y, angle } | null, i } zurück – kompakt für ein data-Attribut.
 */
function visibleMarks(defects, id, ironed = false) {
  const d = defects || {};
  const num = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
  return {
    s: (d.scratches || []).map((x) => [num(x.x), num(x.y), num(x.len), num(x.angle)]),
    c: d.crease ? creaseLine(id) : null,
    i: !!(d.crease && (ironed || d.ironed)),
  };
}

/**
 * Sichtbarer Versatz einer folierten Karte aus ihrer Zentrierung: { x, y } von −1 bis 1 (0 = mittig).
 * Gespeichert ist nur, wie schief (z. B. 62/38) – in welche Richtung, ergibt sich fest aus der Exemplar-ID,
 * damit dasselbe Exemplar immer gleich aussieht. Nur waagerecht (oben/unten zählt nicht), y ist immer 0.
 * Ohne Zentrierung: null.
 */
function centerShift(centering, id) {
  if (!centering) return null;
  const bits = Number.parseInt(String(id || '').slice(-2), 16) || 0;
  const sx = bits & 1 ? -1 : 1;
  const r = (v) => Math.round(v * 1000) / 1000;
  return { x: r((sx * ((centering.lr || 50) - 50)) / 50), y: 0 };
}

// Bezeichnungen der Noten (wie auf echten Grading-Etiketten)
const GRADE_NAMES = { 10: 'GEM MINT', 9: 'MINT', 8: 'NM-MT', 7: 'NEAR MINT', 6: 'EX-MT', 5: 'EXCELLENT', 4: 'VG-EX', 3: 'VERY GOOD', 2: 'GOOD', 1: 'POOR' };
const gradeWord = (grade) => GRADE_NAMES[grade] || '';

/**
 * Kennzahlen der gegradeten (= Slabs, Note sichtbar – #204) Karten einer Sammlung: { count, best, bestCount, avg, dist }
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

module.exports = { visibleMarks, CONDITION_VERSION, PROFILES, CENTERING, CREASE_CAP, centeringCap, rnd, chance, pick, weighted, rollDefects, gradeFor, rollCondition, GRADE_NAMES, gradeWord, gradeStats, centerShift, gradeCap, addDamage, conditionV3, CREASE_SEGMENTS, IRON_MAX_CAP, ironCap, creaseLine, applyIron };

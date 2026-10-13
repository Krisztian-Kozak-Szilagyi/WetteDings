// Rating und Reputation der Grading-Shops (#204, Etappe B) – reine Rechnungen ohne Datenbank, getestet.
// Rating = Arbeitsqualität (automatisch) + Sterne der Kunden + Treffsicherheit (Anteil exakter Noten, nur gesammelt).
// Reputation wächst mit jedem erledigten Auftrag, aber nur, wenn die Note stimmt: exakt = Zuwachs, ±1 = unverändert,
// ≥2 daneben = Abzug. Ausgestellte Slabs (Vitrine) beschleunigen den Zuwachs, Inaktivität lässt ihn verfallen. Die Stufe
// schaltet etwas frei (TIER_PERKS): mehr Aufträge von Mitgliedern am Tag, mehr Vitrinenplätze, reichere Kundschaft.

const BASE_GAIN = 10; // Reputation je Auftrag bei mittlerer Qualität (Faktor 1)
const PLAYER_FACTOR = 2; // Spieler-Aufträge zählen doppelt
const SHOWCASE_CAP = 0.5; // Vitrine: höchstens +50 %
const STAR_STEP = 5; // je Stern über bzw. unter 3: ±5 Reputation
const GRADE_PENALTY = 15; // Note ≥2 neben der echten: −15 je Punkt über 1 (2 → −15, 3 → −30, 4 → −45 …)
const GRADELESS_FACTOR = 0.5; // Aufträge ohne Benoten (nur Reinigen oder Bügeln): halber Zuwachs – ohne Notenkönnen soll niemand hochfarmen
const DECAY_GRACE_DAYS = 7; // so lange darf ein Shop ohne Auftrag bleiben, bevor der Ruf verfällt
const DECAY_RATE = 0.01; // danach −1 % pro Tag …
const DECAY_FLOOR = 100; // … aber nie unter „Bekannt“: eine Pause macht niemanden wieder zum Neuling

const TIERS = [
  { min: 0, label: 'Neuling' },
  { min: 100, label: 'Bekannt' },
  { min: 1000, label: 'Renommiert' },
  { min: 5000, label: 'Elite' },
  { min: 15000, label: 'Legende' },
];
// Was eine Stufe freischaltet (je Eintrag in TIERS):
//   playerJobs = Anteil des Tageslimits für Aufträge von Mitgliedern (Admin-Wert playerJobs × Faktor),
//   showcase   = Vitrinenplätze (höchstens der Admin-Wert showcaseMax),
//   richness   = Gewicht-Faktor für seltene NPC-Kundenkarten (Bockhaber und höher) – Kunden zieht es zum renommierten Shop
const TIER_PERKS = [
  { playerJobs: 0.3, showcase: 3, richness: 1 },
  { playerJobs: 0.5, showcase: 4, richness: 1 },
  { playerJobs: 0.8, showcase: 5, richness: 1.25 },
  { playerJobs: 1, showcase: 6, richness: 1.5 },
  { playerJobs: 1.2, showcase: 6, richness: 2 },
];

const pct = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null);

/** Arbeitsqualität eines erledigten Auftrags (0–100): Ø aus Sauberkeit, Versiegelung und – wenn gebügelt – Glätte */
function qualityOf({ clean, seal, iron } = {}) {
  const parts = [pct(clean), pct(seal), iron ? pct(iron.smooth) : null].filter((v) => v !== null);
  return parts.length ? Math.round(parts.reduce((s, v) => s + v, 0) / parts.length) : 0;
}

/**
 * Boost der Vitrine als Anteil (0 … SHOWCASE_CAP): je Slab (Rang der Seltenheit + 1) × Punkte über Note 5, in Prozent.
 * Eine Glitch-Karte (Rang 5) mit Note 10 bringt 6 × 5 = +30 %. slabs: [{ rank, grade }]
 */
function showcaseBoost(slabs = []) {
  const points = slabs.reduce((s, x) => s + (Math.max(0, x.rank || 0) + 1) * Math.max(0, (x.grade || 0) - 5), 0);
  return Math.min(SHOWCASE_CAP, points / 100);
}

/** Zuwachs für einen sauber erledigten Auftrag: Grundwert × Spieler-Faktor × Qualitätsfaktor (0,5–1,5) × (1 + Vitrine) */
function reputationGain({ quality = 0, player = false, boost = 0 } = {}) {
  const q = 0.5 + (pct(quality) || 0) / 100;
  return Math.round(BASE_GAIN * (player ? PLAYER_FACTOR : 1) * q * (1 + Math.max(0, Math.min(SHOWCASE_CAP, boost))));
}

/**
 * Rufänderung eines erledigten Auftrags (positiv, 0 oder negativ). guess = Note des Shops, grade = die echte Note:
 * exakt → Zuwachs (reputationGain), ±1 → 0, ≥2 daneben → −GRADE_PENALTY je Punkt über 1. Ohne Note (Reinigen/Bügeln,
 * guess fehlt) zählt der Zuwachs nur halb (GRADELESS_FACTOR).
 */
function gradeRepChange({ guess, grade, quality = 0, player = false, boost = 0 } = {}) {
  const gain = reputationGain({ quality, player, boost });
  if (!Number.isFinite(guess) || !Number.isFinite(grade)) return Math.round(gain * GRADELESS_FACTOR);
  const diff = Math.abs(guess - grade);
  if (diff === 0) return gain;
  if (diff === 1) return 0;
  return -GRADE_PENALTY * (diff - 1);
}

/** Reputation aus einer Kundenbewertung (1–5 Sterne): 3 ist neutral */
const starGain = (stars) => (stars - 3) * STAR_STEP;

/** Index der Stufe zur Reputation (negativer Ruf zählt wie ein Neuling) */
function tierIndex(reputation = 0) {
  let i = 0;
  while (i + 1 < TIERS.length && reputation >= TIERS[i + 1].min) i++;
  return i;
}

/** Stufe zur Reputation: { label, min, index, next } (next = Schwelle der nächsten Stufe oder null) */
function tierOf(reputation = 0) {
  const i = tierIndex(reputation);
  return { ...TIERS[i], index: i, next: TIERS[i + 1] ? TIERS[i + 1].min : null };
}

/**
 * Was die Stufe freischaltet, mit den Admin-Werten verrechnet: { tier, playerJobs, showcase, richness } –
 * playerJobs = Aufträge von Mitgliedern am Tag, showcase = Vitrinenplätze, richness = Faktor für seltene NPC-Kunden.
 */
function perksOf(reputation = 0, { playerJobs = 10, showcaseMax = 6 } = {}) {
  const i = tierIndex(reputation);
  const p = TIER_PERKS[i];
  return {
    tier: TIERS[i].label,
    playerJobs: playerJobs > 0 ? Math.max(1, Math.round(playerJobs * p.playerJobs)) : 0,
    showcase: Math.min(Math.max(0, showcaseMax), p.showcase),
    richness: p.richness,
  };
}

/**
 * Ruf nach days Tagen Verfall (je −DECAY_RATE, Zinseszins), nie unter DECAY_FLOOR; liegt er schon darunter, bleibt er.
 * Die Karenz (DECAY_GRACE_DAYS) prüft der Aufrufer, siehe idleDecayDays.
 */
function decayedReputation(reputation, days = 1) {
  if (!(days > 0) || reputation <= DECAY_FLOOR) return reputation;
  return Math.max(DECAY_FLOOR, Math.round(reputation * (1 - DECAY_RATE) ** days));
}

/** Wie viele Tage Verfall jetzt anstehen: Tage seit dem letzten Auftrag über die Karenz hinaus, abzüglich schon verrechneter */
function idleDecayDays({ idleDays, appliedDays = 0 }) {
  return Math.max(0, Math.floor(idleDays) - DECAY_GRACE_DAYS - appliedDays);
}

/** Kennzahlen eines Shops zum Anzeigen: Sterne (Ø, n), Qualität (Ø %), Treffsicherheit (% exakt, n), Stufe */
function ratingOf(shop = {}) {
  const avg = (a, b) => (b > 0 ? a / b : null);
  const stars = shop.stars || {};
  const quality = shop.quality || {};
  const hits = shop.hits || {};
  return {
    stars: avg(stars.sum || 0, stars.n || 0),
    starCount: stars.n || 0,
    quality: avg(quality.sum || 0, quality.n || 0),
    hitRate: hits.n ? (100 * (hits.exact || 0)) / hits.n : null,
    graded: hits.n || 0,
    reputation: shop.reputation || 0,
    tier: tierOf(shop.reputation || 0),
  };
}

module.exports = {
  BASE_GAIN, PLAYER_FACTOR, SHOWCASE_CAP, STAR_STEP, GRADE_PENALTY, GRADELESS_FACTOR, DECAY_GRACE_DAYS, DECAY_RATE, DECAY_FLOOR,
  TIERS, TIER_PERKS, qualityOf, showcaseBoost, reputationGain, gradeRepChange, starGain, tierOf, tierIndex, perksOf, decayedReputation, idleDecayDays, ratingOf,
};

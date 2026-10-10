// Rating und Reputation der Grading-Shops (#204, Etappe B) – reine Rechnungen ohne Datenbank, getestet.
// Rating = Arbeitsqualität (automatisch) + Sterne der Kunden + Treffsicherheit (Anteil exakter Noten, nur gesammelt).
// Reputation wächst mit jedem erledigten Auftrag; ausgestellte Slabs (Vitrine) beschleunigen das.

const BASE_GAIN = 10; // Reputation je Auftrag bei mittlerer Qualität (Faktor 1)
const PLAYER_FACTOR = 2; // Spieler-Aufträge zählen doppelt
const SHOWCASE_CAP = 1; // Vitrine: höchstens +100 %
const STAR_STEP = 5; // je Stern über bzw. unter 3: ±5 Reputation
const TIERS = [
  { min: 0, label: 'Neuling' },
  { min: 100, label: 'Bekannt' },
  { min: 500, label: 'Renommiert' },
  { min: 2000, label: 'Legende' },
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

/** Reputation für einen erledigten Auftrag: Grundwert × Spieler-Faktor × Qualitätsfaktor (0,5–1,5) × (1 + Vitrine) */
function reputationGain({ quality = 0, player = false, boost = 0 } = {}) {
  const q = 0.5 + (pct(quality) || 0) / 100;
  return Math.round(BASE_GAIN * (player ? PLAYER_FACTOR : 1) * q * (1 + Math.max(0, Math.min(SHOWCASE_CAP, boost))));
}

/** Reputation aus einer Kundenbewertung (1–5 Sterne): 3 ist neutral */
const starGain = (stars) => (stars - 3) * STAR_STEP;

/** Stufe zur Reputation: { label, min, next } (next = Schwelle der nächsten Stufe oder null) */
function tierOf(reputation = 0) {
  let i = 0;
  while (i + 1 < TIERS.length && reputation >= TIERS[i + 1].min) i++;
  return { ...TIERS[i], next: TIERS[i + 1] ? TIERS[i + 1].min : null };
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

module.exports = { BASE_GAIN, PLAYER_FACTOR, SHOWCASE_CAP, STAR_STEP, TIERS, qualityOf, showcaseBoost, reputationGain, starGain, tierOf, ratingOf };

// Verbreitung und Population der Karten (#204, Etappe C) – wie der „Population Report“ echter Grading-Firmen:
// Wie viele aktive Spieler besitzen eine Karte, wie viele Exemplare gibt es, wie viele Slabs je Note (und je Shop).
// Das wird angezeigt und fließt in den geschätzten Marktpreis ein (trade/marketPrice.estimate) – nie in den gemessenen.
const { TcgCard } = require('../models/Tcg');
const UserActivity = require('../models/UserActivity');
const { GradingShop } = require('../models/Grading');

const ACTIVE_DAYS = 30; // aktiv = in den letzten 30 Tagen gesehen (wie die Statistik „Aktiv letzte 30 Tage“)
const CACHE_MS = 10 * 60 * 1000;

let cache = null; // { at, data }

/** Cache leeren (Tests, nach größeren Änderungen) */
const invalidate = () => {
  cache = null;
};

/**
 * Verbreitung und Population aller Karten:
 *   active – Zahl der aktiven Spieler
 *   spread – Map Karte → { owners, share } (aktive Besitzer, Anteil 0–1)
 *   pop    – Map Karte → { copies, slabs: { Note: n }, byCode: { Kürzel: { Note: n } } }
 *   grades – alle Slabs aller Karten je Note: { Note: n }
 *   reps   – Map Shop-Kürzel (auch frühere) → Reputation des Shops
 */
async function all(now = Date.now()) {
  if (cache && now - cache.at < CACHE_MS) return cache.data;
  const since = new Date(now - ACTIVE_DAYS * 864e5).toISOString().slice(0, 10);
  const activeIds = await UserActivity.distinct('user', { day: { $gte: since } });
  const [owners, copies, slabs, shops] = await Promise.all([
    activeIds.length ? TcgCard.aggregate([{ $match: { user: { $in: activeIds } } }, { $group: { _id: '$card', users: { $addToSet: '$user' } } }, { $project: { n: { $size: '$users' } } }]) : [],
    TcgCard.aggregate([{ $group: { _id: '$card', n: { $sum: 1 } } }]),
    TcgCard.aggregate([{ $match: { 'slab.grade': { $type: 'number' } } }, { $group: { _id: { card: '$card', grade: '$slab.grade', code: '$slab.code' }, n: { $sum: 1 } } }]),
    GradingShop.find({ code: { $type: 'string' } }).select('code codeHistory reputation').lean(),
  ]);
  const active = activeIds.length;
  const spread = new Map(owners.map((o) => [o._id, { owners: o.n, share: active ? o.n / active : 0 }]));
  const pop = new Map(copies.map((c) => [c._id, { copies: c.n, slabs: {}, byCode: {} }]));
  const grades = {};
  for (const s of slabs) {
    grades[s._id.grade] = (grades[s._id.grade] || 0) + s.n;
    const p = pop.get(s._id.card) || { copies: 0, slabs: {}, byCode: {} };
    pop.set(s._id.card, p);
    p.slabs[s._id.grade] = (p.slabs[s._id.grade] || 0) + s.n;
    const code = s._id.code || '?';
    p.byCode[code] = p.byCode[code] || {};
    p.byCode[code][s._id.grade] = (p.byCode[code][s._id.grade] || 0) + s.n;
  }
  const reps = new Map();
  for (const s of shops) for (const code of [s.code, ...(s.codeHistory || [])]) reps.set(code, s.reputation || 0);
  const data = { active, spread, pop, grades, reps };
  cache = { at: now, data };
  return data;
}

/** Slabs einer Karte mit mindestens dieser Note (aus pop) */
const slabsAtLeast = (p, grade) => Object.entries((p && p.slabs) || {}).reduce((s, [g, n]) => s + (Number(g) >= grade ? n : 0), 0);

/**
 * Kurztext für die Anzeige: "besitzen 12 % · 3 Slabs, 1 × Note 10". grade: Note des gezeigten Slabs (dann „1 × Note 10“
 * genau für diese Note), sonst die beste Note. Ohne Daten: ''.
 */
function popText(cardId, data, grade = null) {
  if (!data) return '';
  const s = data.spread.get(cardId);
  const p = data.pop.get(cardId);
  const parts = [];
  if (data.active) parts.push(`besitzen ${Math.round(100 * (s ? s.share : 0))} %`);
  const total = p ? Object.values(p.slabs).reduce((a, n) => a + n, 0) : 0;
  if (total) {
    const g = grade || Math.max(...Object.keys(p.slabs).map(Number));
    parts.push(`${total} ${total === 1 ? 'Slab' : 'Slabs'}, ${p.slabs[g] || 0} × Note ${g}`);
  } else if (p) parts.push('noch kein Slab');
  return parts.join(' · ');
}

// Seltenheit in der Note: Anteil der Exemplare einer Karte, die als Slab genau diese Note tragen (die erste passende Stufe gilt)
const GRADE_RARITY = [
  { key: 'einzig', label: 'Einzigartig', test: (r) => r.at <= 1 },
  { key: 'rar', label: 'Sehr selten', test: (r) => r.share <= 0.02 || r.at <= 3 },
  { key: 'selten', label: 'Selten', test: (r) => r.share <= 0.1 },
  { key: 'normal', label: 'Verbreitet', test: () => true },
];

/**
 * Wie selten ist dieser Slab in seiner Note? (#204, Messingschild in der Vitrine) – wie der Population Report echter
 * Grading-Firmen: at = Slabs der Karte mit genau dieser Note, higher = mit besserer Note, total = alle Slabs der Karte,
 * copies = alle Exemplare, share = at / copies, dist = Slabs je Note 1–10, tier = { key, label } aus GRADE_RARITY.
 * null ohne Daten.
 */
function gradeRarity(cardId, data, grade) {
  const p = data && data.pop.get(cardId);
  if (!p || !grade) return null;
  const dist = Array.from({ length: 10 }, (_, i) => p.slabs[i + 1] || 0);
  const sum = (a) => a.reduce((s, n) => s + n, 0);
  const total = sum(dist);
  const at = p.slabs[grade] || 0;
  const copies = Math.max(p.copies || 0, total);
  const r = { grade, at, higher: sum(dist.slice(grade)), total, copies, share: copies ? at / copies : 0, dist };
  const tier = GRADE_RARITY.find((t) => t.test(r));
  return { ...r, tier: { key: tier.key, label: tier.label } };
}

// Wie sehr ein renommierter Shop einen Slab seltener macht: je höher seine Stufe, desto kleiner der Faktor (0,35 = Legende)
const SHOP_FACTOR = [
  { min: 15000, factor: 0.35, label: 'Legende' },
  { min: 5000, factor: 0.45, label: 'Elite' },
  { min: 1000, factor: 0.6, label: 'Renommiert' },
  { min: 100, factor: 0.8, label: 'Bekannt' },
  { min: 0, factor: 1, label: 'Neuling' },
];
const SLAB_TIERS = [
  { key: 'legend', label: 'Legendär', max: 0.03 },
  { key: 'rar', label: 'Sehr selten', max: 0.08 },
  { key: 'selten', label: 'Selten', max: 0.2 },
  { key: 'ungewoehnlich', label: 'Ungewöhnlich', max: 0.45 },
  { key: 'normal', label: 'Verbreitet', max: Infinity },
];

/**
 * Seltenheit eines Slabs (#204): Anteil aller Slabs mit mindestens dieser Note (je höher die Note, desto seltener),
 * gewichtet mit dem Ruf des Shops, der ihn ausgestellt hat (Legende ×0,35 … Neuling ×1), und eine halbe Stufe seltener, wenn
 * es von dieser Karte nur einen Slab in genau dieser Note gibt. Gibt { key, label, tail, shop, at } oder null ohne Daten:
 * tail = Anteil der Slabs mit Note ≥ grade (0–1), shop = Stufe des Shops, at = Slabs dieser Karte in genau dieser Note.
 */
function slabRarity(cardId, data, slab) {
  if (!data || !slab || !slab.grade) return null;
  const total = Object.values(data.grades || {}).reduce((s, n) => s + n, 0);
  if (!total) return null;
  const tail = Object.entries(data.grades).reduce((s, [g, n]) => s + (Number(g) >= slab.grade ? n : 0), 0) / total;
  const rep = (data.reps && data.reps.get(slab.code)) || 0;
  // negativer Ruf (Strafe aus der Zweitprüfung, schlechte Sterne) zählt wie ein Neuling
  const shop = SHOP_FACTOR.find((x) => rep >= x.min) || SHOP_FACTOR[SHOP_FACTOR.length - 1];
  const p = data.pop.get(cardId);
  const at = (p && p.slabs[slab.grade]) || 0;
  const eff = tail * shop.factor * (at <= 1 ? 0.5 : 1);
  const tier = SLAB_TIERS.find((t) => eff <= t.max);
  return { key: tier.key, label: tier.label, tail, shop: shop.label, at, grade: slab.grade, code: slab.code };
}

/** Verbreitung einer Karte ohne Slab: Anteil der aktiven Spieler, die sie besitzen (0–100) – oder null ohne Daten */
function spreadOf(cardId, data) {
  if (!data || !data.active) return null;
  const s = data.spread.get(cardId);
  return { pct: Math.round(100 * (s ? s.share : 0)), owners: s ? s.owners : 0, active: data.active };
}

module.exports = { ACTIVE_DAYS, all, invalidate, slabsAtLeast, popText, gradeRarity, GRADE_RARITY, slabRarity, spreadOf, SLAB_TIERS, SHOP_FACTOR };

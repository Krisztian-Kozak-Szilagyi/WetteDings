// Verbreitung und Population der Karten (#204, Etappe C) – wie der „Population Report“ echter Grading-Firmen:
// Wie viele aktive Spieler besitzen eine Karte, wie viele Exemplare gibt es, wie viele Slabs je Note (und je Shop).
// Das wird angezeigt und fließt in den geschätzten Marktpreis ein (trade/marketPrice.estimate) – nie in den gemessenen.
const { TcgCard } = require('../models/Tcg');
const UserActivity = require('../models/UserActivity');

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
 */
async function all(now = Date.now()) {
  if (cache && now - cache.at < CACHE_MS) return cache.data;
  const since = new Date(now - ACTIVE_DAYS * 864e5).toISOString().slice(0, 10);
  const activeIds = await UserActivity.distinct('user', { day: { $gte: since } });
  const [owners, copies, slabs] = await Promise.all([
    activeIds.length ? TcgCard.aggregate([{ $match: { user: { $in: activeIds } } }, { $group: { _id: '$card', users: { $addToSet: '$user' } } }, { $project: { n: { $size: '$users' } } }]) : [],
    TcgCard.aggregate([{ $group: { _id: '$card', n: { $sum: 1 } } }]),
    TcgCard.aggregate([{ $match: { 'slab.grade': { $type: 'number' } } }, { $group: { _id: { card: '$card', grade: '$slab.grade', code: '$slab.code' }, n: { $sum: 1 } } }]),
  ]);
  const active = activeIds.length;
  const spread = new Map(owners.map((o) => [o._id, { owners: o.n, share: active ? o.n / active : 0 }]));
  const pop = new Map(copies.map((c) => [c._id, { copies: c.n, slabs: {}, byCode: {} }]));
  for (const s of slabs) {
    const p = pop.get(s._id.card) || { copies: 0, slabs: {}, byCode: {} };
    pop.set(s._id.card, p);
    p.slabs[s._id.grade] = (p.slabs[s._id.grade] || 0) + s.n;
    const code = s._id.code || '?';
    p.byCode[code] = p.byCode[code] || {};
    p.byCode[code][s._id.grade] = (p.byCode[code][s._id.grade] || 0) + s.n;
  }
  const data = { active, spread, pop };
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

module.exports = { ACTIVE_DAYS, all, invalidate, slabsAtLeast, popText };

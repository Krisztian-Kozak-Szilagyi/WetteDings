// Komfort bei der Team-Auswahl (IHK-Quests, Dungeon, Mage Tower): Favoriten stehen oben, und wer keine gesetzt hat,
// bekommt einen Knopf mit den Karten, die er am häufigsten spielt.
const { IhkRun } = require('../models/Ihk');
const { DungeonRun } = require('../models/Dungeon');

const FREQUENT_MAX = 6; // so viele „häufig verwendete“ Karten je Liste

/**
 * Wie oft der Nutzer eine Karte als Charakter bzw. Boost gespielt hat: { card: [id, …], boost: [id, …] },
 * häufigste zuerst. area: 'ihk' | 'dungeon' | 'tower'
 */
async function usedCards(userId, area) {
  const roles = area === 'ihk'
    ? [{ id: '$card', role: 'card' }, { id: '$boost', role: 'boost' }, { id: '$boost2', role: 'boost' }]
    : [{ id: '$members.card', role: 'card' }, { id: '$members.boost', role: 'boost' }];
  const pipeline = area === 'ihk'
    ? [{ $match: { user: userId } }]
    : [{ $match: { 'members.user': userId, mode: area } }, { $unwind: '$members' }, { $match: { 'members.user': userId } }];
  const rows = await (area === 'ihk' ? IhkRun : DungeonRun).aggregate([
    ...pipeline,
    { $project: { used: roles } },
    { $unwind: '$used' },
    { $match: { 'used.id': { $type: 'string' } } },
    { $group: { _id: { id: '$used.id', role: '$used.role' }, n: { $sum: 1 } } },
    { $sort: { n: -1, '_id.id': 1 } },
  ]);
  const out = { card: [], boost: [] };
  rows.forEach((r) => out[r._id.role].push(r._id.id));
  return out;
}

/**
 * Favoriten und häufig verwendete Karten für eine Kartenliste.
 * list = wählbare Karten, favoriteIds = tcgFavorites des Nutzers (folierte Einträge "f:…" passen auf keine Karten-ID),
 * usedIds = Karten-IDs nach Häufigkeit. Gibt zurück:
 *  list – dieselben Karten, Favoriten zuerst
 *  favs – Set der Favoriten-IDs in dieser Liste
 *  freq – Map ID → Rang (0 = am häufigsten); nur gefüllt, wenn es keine Favoriten gibt
 */
function pickShortcuts(list, favoriteIds, usedIds, max = FREQUENT_MAX) {
  const ids = new Set(favoriteIds || []);
  const favCards = list.filter((c) => ids.has(c.id));
  const favs = new Set(favCards.map((c) => c.id));
  const freq = new Map();
  if (!favs.size) {
    const inList = new Set(list.map((c) => c.id));
    (usedIds || []).filter((id) => inList.has(id)).slice(0, max).forEach((id, i) => freq.set(id, i));
  }
  return { list: favs.size ? [...favCards, ...list.filter((c) => !favs.has(c.id))] : list, favs, freq };
}

module.exports = { usedCards, pickShortcuts, FREQUENT_MAX };

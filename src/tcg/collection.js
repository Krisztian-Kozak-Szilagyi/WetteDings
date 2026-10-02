// Sammlung eines Nutzers mit allen Kennzahlen – für TCG-Seite, Album, Handel und fremde Sammlungen
const { TcgCard } = require('../models/Tcg');
const { lockedDocs } = require('./locks');
const catalog = require('./catalog');
const { inventory } = require('./tcgService');

async function collection(user) {
  const [owned, locked] = await Promise.all([inventory(user._id), lockedDocs(user._id)]);
  // Gesperrte Exemplare je Karte (Quest/Handel): { cardId: { n, reason } }
  const lockedByCard = {};
  for (const d of await TcgCard.find({ _id: { $in: locked.docs } }).select('card').lean()) {
    const e = (lockedByCard[d.card] = lockedByCard[d.card] || { n: 0, reason: locked.reasons.get(String(d._id)) });
    e.n += 1;
  }
  const counts = Object.fromEntries(owned.map((o) => [o._id, o.n]));
  // Freie Exemplare je Karte (nicht auf Quest, nicht im Handel)
  const free = Object.fromEntries(owned.map((o) => [o._id, o.n - (lockedByCard[o._id] ? lockedByCard[o._id].n : 0)]));
  const sell = (o) => (catalog.rarityByKey[o.rarity] ? catalog.rarityByKey[o.rarity].sell : 0);
  // Geschützte Karten zählen nicht zu den Duplikaten, die "Alle Duplikate verkaufen" verkauft
  const protectedIds = new Set(user.tcgProtected || []);
  const dups = owned.filter((o) => !protectedIds.has(o._id));
  return {
    counts,
    free,
    lockedByCard,
    protectedIds,
    uniqueOwned: catalog.CARDS.filter((c) => counts[c.id]).length,
    cardCount: owned.reduce((s, o) => s + o.n, 0),
    collectionValue: owned.reduce((s, o) => s + sell(o) * o.n, 0),
    dupCount: dups.reduce((s, o) => s + o.n - 1, 0),
    dupValue: dups.reduce((s, o) => s + sell(o) * (o.n - 1), 0),
  };
}

module.exports = { collection };

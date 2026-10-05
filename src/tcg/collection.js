// Sammlung eines Nutzers mit allen Kennzahlen – für TCG-Seite, Album, Handel und fremde Sammlungen
const { TcgCard } = require('../models/Tcg');
const { lockedDocs } = require('./locks');
const catalog = require('./catalog');
const foil = require('../items/foil');
const { inventory } = require('./tcgService');

async function collection(user) {
  const [owned, locked, foiledDocs] = await Promise.all([
    inventory(user._id),
    lockedDocs(user._id),
    TcgCard.find({ user: user._id, foiledAt: { $ne: null } }).select('card rarity foiledAt condition.grade').sort({ foiledAt: 1 }).lean(),
  ]);
  // Folierte Exemplare je Karte – im Album und in fremden Sammlungen eigene Plätze: { cardId: [{ id, foiledAt }] }
  const foiledCopies = {};
  for (const d of foiledDocs) {
    const r = catalog.rarityByKey[d.rarity];
    const lock = locked.reasons.get(String(d._id));
    (foiledCopies[d.card] = foiledCopies[d.card] || []).push({
      id: String(d._id),
      foiledAt: d.foiledAt,
      grade: d.condition ? d.condition.grade : null, // Note auf der Folie (#73)
      value: foil.cardValue(r ? r.sell : 0, d.foiledAt),
      lock: lock && lock !== 'folie' ? lock : null, // 'handel' | 'quest'
    });
  }
  // Gesperrte Exemplare je Karte (Quest/Handel): { cardId: { n, reason } }
  const lockedByCard = {};
  const tradingByCard = {}; // unfolierte Exemplare in einem Handelsangebot – gehen weg, zählen nicht als Duplikat
  for (const d of await TcgCard.find({ _id: { $in: locked.docs } }).select('card foiledAt').lean()) {
    const reason = locked.reasons.get(String(d._id));
    if ((reason === 'handel' || reason === 'duell') && !d.foiledAt) tradingByCard[d.card] = (tradingByCard[d.card] || 0) + 1;
    const e = (lockedByCard[d.card] = lockedByCard[d.card] || { n: 0, reason });
    if (e.reason === 'folie' && reason !== 'folie') e.reason = reason; // Quest/Handel sind wichtiger als die Folie
    e.n += 1;
  }
  const counts = Object.fromEntries(owned.map((o) => [o._id, o.n]));
  // Folierte Exemplare je Karte (Markierung im Album)
  const foiledByCard = Object.fromEntries(owned.filter((o) => o.foiled).map((o) => [o._id, o.foiled]));
  // Freie Exemplare je Karte (nicht auf Quest, nicht im Handel, nicht foliert)
  const free = Object.fromEntries(owned.map((o) => [o._id, o.n - (lockedByCard[o._id] ? lockedByCard[o._id].n : 0)]));
  const sell = (o) => (catalog.rarityByKey[o.rarity] ? catalog.rarityByKey[o.rarity].sell : 0);
  // Geschützte Karten und Boss-Karten (die Bank kauft sie nicht) zählen nicht zu den Duplikaten, die "Alle Duplikate verkaufen" verkauft, folierte Exemplare und solche im Handel auch nicht
  const protectedIds = new Set(user.tcgProtected || []);
  const dups = owned.filter((o) => !protectedIds.has(o._id) && !(catalog.rarityByKey[o.rarity] || {}).noBank).map((o) => ({ ...o, n: o.n - (o.foiled || 0) - (tradingByCard[o._id] || 0) })).filter((o) => o.n > 1);
  return {
    counts,
    free,
    lockedByCard,
    foiledByCard,
    foiledCopies,
    protectedIds,
    uniqueOwned: catalog.CARDS.filter((c) => counts[c.id]).length,
    cardCount: owned.reduce((s, o) => s + o.n, 0),
    collectionValue: owned.reduce((s, o) => s + (o.v || 0), 0), // mit Wertsteigerung folierter Karten
    dupCount: dups.reduce((s, o) => s + o.n - 1, 0),
    dupValue: dups.reduce((s, o) => s + sell(o) * (o.n - 1), 0),
  };
}

module.exports = { collection };

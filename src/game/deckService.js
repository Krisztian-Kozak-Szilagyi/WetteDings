// Decks speichern und laden – die Regeln selbst stehen in src/game/deck.js
const mongoose = require('mongoose');
const Deck = require('../models/Deck');
const catalog = require('../tcg/catalog');
const { inventory } = require('../tcg/tcgService');
const { UserError } = require('../lib/util');
const rules = require('./deck');

/** Eigene Exemplare je Karte: { cardId: Anzahl } */
async function ownedCounts(userId) {
  return Object.fromEntries((await inventory(userId)).map((o) => [o._id, o.n]));
}

/** Kampfkarten, die der Spieler besitzt, mit Anzahl und Deck-Grenze */
function poolFor(owned) {
  return catalog.CARDS.filter((c) => rules.isBattleCard(c) && owned[c.id]).map((c) => ({
    id: c.id,
    name: c.name,
    rarity: c.rarity,
    image: c.image,
    owned: owned[c.id],
    limit: rules.copyLimit(c),
  }));
}

const deckView = (d, owned) => ({
  id: String(d._id),
  name: d.name,
  cards: d.cards.map((e) => ({ card: e.card, n: e.n })),
  check: rules.validateDeck(rules.expand(d.cards), catalog.cardById, owned),
  updatedAt: d.updatedAt,
});

/** Alles für den Deckbau: Regeln, eigene Kampfkarten, Decks mit Prüfung */
async function overview(userId) {
  const [owned, decks] = await Promise.all([ownedCounts(userId), Deck.find({ user: userId }).sort({ createdAt: 1 }).lean()]);
  return { rules: rules.RULES, pool: poolFor(owned), decks: decks.map((d) => deckView(d, owned)) };
}

/**
 * Deck anlegen (ohne deckId) oder ändern. Unvollständige Decks (< 30) dürfen gespeichert werden,
 * Regelverstöße und Karten, die man nicht besitzt, nicht.
 */
async function saveDeck(userId, { deckId, name, ids }) {
  const owned = await ownedCounts(userId);
  const check = rules.validateDeck(ids, catalog.cardById, owned);
  if (check.errors.length) throw new UserError('Das Deck verstößt gegen die Deckregeln.');
  if (check.missing.length) throw new UserError('Du besitzt nicht alle Karten in diesem Deck.');
  const cards = rules.countCards(ids);
  if (deckId) {
    if (!mongoose.isValidObjectId(deckId)) throw new UserError('Deck nicht gefunden.');
    const d = await Deck.findOneAndUpdate({ _id: deckId, user: userId }, { $set: { name: rules.cleanName(name), cards } }, { new: true }).lean();
    if (!d) throw new UserError('Deck nicht gefunden.');
    return deckView(d, owned);
  }
  if ((await Deck.countDocuments({ user: userId })) >= rules.MAX_DECKS) throw new UserError('Du hast schon die Höchstzahl an Decks.');
  const d = await Deck.create({ user: userId, name: rules.cleanName(name), cards });
  return deckView(d.toObject(), owned);
}

async function deleteDeck(userId, deckId) {
  if (!mongoose.isValidObjectId(deckId)) throw new UserError('Deck nicht gefunden.');
  const r = await Deck.deleteOne({ _id: deckId, user: userId });
  if (!r.deletedCount) throw new UserError('Deck nicht gefunden.');
}

module.exports = { overview, saveDeck, deleteDeck, poolFor };

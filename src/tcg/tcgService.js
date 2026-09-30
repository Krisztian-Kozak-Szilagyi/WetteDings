const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgCard, TcgOpening } = require('../models/Tcg');
const { lockedDocs, isLocked } = require('./locks');
const { inTransaction } = require('../services/betService');
const { UserError } = require('../lib/util');
const catalog = require('./catalog');
const settings = require('./settings');

/** Booster Pack kaufen und sofort öffnen. Gibt die gezogenen Karten zurück. */
async function openPack({ user }) {
  const cost = settings.getPackPrice();
  if (!catalog.CARDS.length) throw new UserError('Der TCG-Shop ist gerade geschlossen.');
  const drawn = catalog.drawPack();

  return inTransaction(async (session) => {
    const updatedUser = await User.findOneAndUpdate(
      { _id: user._id, balance: { $gte: cost } },
      { $inc: { balance: -cost } },
      { new: true, session }
    );
    if (!updatedUser) throw new UserError('Dein Guthaben reicht für kein Booster Pack.');

    const best = Math.max(...drawn.map((c) => catalog.rarityByKey[c.rarity].rank));
    const [opening] = await TcgOpening.create(
      [{ user: user._id, username: user.username, cost, cards: drawn.map((c) => ({ card: c.id, rarity: c.rarity })), best }],
      { session }
    );
    await TcgCard.insertMany(
      drawn.map((c) => ({ user: user._id, card: c.id, rarity: c.rarity, opening: opening._id })),
      { session }
    );
    await Ledger.create([{ user: user._id, type: 'tcg_pack', amount: -cost }], { session });
    return { cards: drawn, cost, balance: updatedUser.balance, openingId: opening._id };
  });
}

/**
 * Karten verkaufen: count Stück der Karte cardId (die ältesten zuerst).
 * keepOne = true verkauft alle Duplikate und behält genau eine.
 */
async function sellCards({ user, cardId, count = 1, keepOne = false }) {
  return inTransaction(async (session) => {
    const owned = await TcgCard.find({ user: user._id, card: cardId }).sort({ createdAt: 1 }).select('_id rarity').session(session).lean();
    if (!owned.length) throw new UserError('Du besitzt diese Karte nicht.');
    // Exemplare auf einer IHK-Quest oder in einem Handelsangebot sind gesperrt
    const locked = await lockedDocs(user._id, session);
    const sellable = owned.filter((c) => !isLocked(locked, c));

    const n = keepOne ? owned.length - 1 : count;
    if (!Number.isInteger(n) || n < 1) throw new UserError('Du hast keine Duplikate dieser Karte.');
    if (!sellable.length) throw new UserError('Diese Karte ist gerade auf einer IHK-Quest oder im Handel und kann nicht verkauft werden.');
    if (n > sellable.length) throw new UserError(`Du kannst nur ${sellable.length} Stück dieser Karte verkaufen.`);

    const toSell = sellable.slice(0, n);
    const rarity = catalog.rarityByKey[toSell[0].rarity];
    if (!rarity) throw new UserError('Diese Karte kann nicht verkauft werden.');
    const res = await TcgCard.deleteMany({ _id: { $in: toSell.map((c) => c._id) }, user: user._id }, { session });
    if (res.deletedCount !== n) throw new UserError('Dein Bestand hat sich geändert. Bitte versuche es erneut.');

    const proceeds = rarity.sell * n;
    const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { balance: proceeds } }, { new: true, session });
    await Ledger.create([{ user: user._id, type: 'tcg_verkauf', amount: proceeds }], { session });
    return { count: n, proceeds, remaining: owned.length - n, balance: updated.balance };
  });
}

/**
 * Alle Duplikate auf einmal verkaufen: von jeder Karte bleibt genau eine (die neueste) übrig.
 * Eine Buchung im Kontoauszug über den Gesamtbetrag.
 */
async function sellAllDuplicates({ user }) {
  return inTransaction(async (session) => {
    const owned = await TcgCard.find({ user: user._id }).sort({ createdAt: 1, _id: 1 }).select('_id card rarity').session(session).lean();
    const byCard = new Map();
    for (const c of owned) {
      if (!byCard.has(c.card)) byCard.set(c.card, []);
      byCard.get(c.card).push(c);
    }
    // Gesperrte Exemplare (Quest/Handel) bleiben; gibt es keins, bleibt das neueste
    const locked = await lockedDocs(user._id, session);
    const toSell = [];
    for (const list of byCard.values()) {
      const free = list.filter((c) => !isLocked(locked, c));
      toSell.push(...(free.length === list.length ? free.slice(0, -1) : free));
    }
    if (!toSell.length) throw new UserError('Du hast keine doppelten Karten.');

    const proceeds = toSell.reduce((s, c) => s + (catalog.rarityByKey[c.rarity] ? catalog.rarityByKey[c.rarity].sell : 0), 0);
    const res = await TcgCard.deleteMany({ _id: { $in: toSell.map((c) => c._id) }, user: user._id }, { session });
    if (res.deletedCount !== toSell.length) throw new UserError('Dein Bestand hat sich geändert. Bitte versuche es erneut.');

    const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { balance: proceeds } }, { new: true, session });
    if (proceeds > 0) await Ledger.create([{ user: user._id, type: 'tcg_verkauf', amount: proceeds }], { session });
    return { count: toSell.length, proceeds, balance: updated.balance };
  });
}

/** Sammlung eines Nutzers: { cardId: Anzahl } */
async function inventory(userId) {
  const agg = await TcgCard.aggregate([{ $match: { user: userId } }, { $group: { _id: '$card', n: { $sum: 1 }, rarity: { $first: '$rarity' } } }]);
  return agg;
}

/** MongoDB-Ausdruck: Verkaufswert (Cent) einer Karte anhand von $rarity – für Ranglisten-Aggregationen */
function sellValueExpr(field = '$rarity') {
  return {
    $switch: {
      branches: catalog.RARITIES.map((r) => ({ case: { $eq: [field, r.key] }, then: r.sell })),
      default: 0,
    },
  };
}

/** Verkaufswert aller Karten eines Nutzers in Cent */
async function cardValueCents(userId) {
  const agg = await TcgCard.aggregate([{ $match: { user: userId } }, { $group: { _id: null, s: { $sum: sellValueExpr() } } }]);
  return agg[0] ? agg[0].s : 0;
}

module.exports = { openPack, sellCards, sellAllDuplicates, inventory, sellValueExpr, cardValueCents };

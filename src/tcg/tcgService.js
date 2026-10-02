const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgCard, TcgOpening, TcgPack } = require('../models/Tcg');
const { lockedDocs, isLocked } = require('./locks');
const { inTransaction } = require('../services/betService');
const { UserError } = require('../lib/util');
const catalog = require('./catalog');
const settings = require('./settings');

const packType = (type) => {
  const t = catalog.packTypeByKey[type || catalog.DEFAULT_PACK];
  if (!t) throw new UserError('Dieses Booster Pack gibt es nicht.');
  return t;
};

const MAX_PACKS_PER_PURCHASE = 100; // Obergrenze pro Kauf (Schutz vor Vertippern)

/** Booster Packs kaufen (1 bis MAX_PACKS_PER_PURCHASE): Sie landen ungeöffnet im Inventar. */
async function buyPack({ user, type, count = 1 }) {
  const t = packType(type);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PACKS_PER_PURCHASE) {
    throw new UserError(`Du kannst 1 bis ${MAX_PACKS_PER_PURCHASE} Packs auf einmal kaufen.`);
  }
  const price = settings.getPackPrice();
  const cost = price * count;
  if (!catalog.CARDS.length) throw new UserError('Der TCG-Shop ist gerade geschlossen.');

  return inTransaction(async (session) => {
    const updatedUser = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: cost } }, { $inc: { balance: -cost } }, { new: true, session });
    if (!updatedUser) throw new UserError(count === 1 ? 'Dein Guthaben reicht für kein Booster Pack.' : `Dein Guthaben reicht nicht für ${count} Booster Packs.`);
    await TcgPack.insertMany(Array.from({ length: count }, () => ({ user: user._id, type: t.key, source: 'kauf', cost: price })), { session });
    await Ledger.create([{ user: user._id, type: 'tcg_pack', amount: -cost, betTitle: `${count}× ${t.label}` }], { session });
    return { type: t, count, cost, balance: updatedUser.balance };
  });
}

/** Booster Packs verschenken (Quest-Fund, Admin). Optional innerhalb einer laufenden Transaktion. */
async function grantPacks({ userId, type, count = 1, source, session }) {
  const t = packType(type);
  await TcgPack.insertMany(Array.from({ length: count }, () => ({ user: userId, type: t.key, source, cost: 0 })), { session });
  return t;
}

/** Ein Booster Pack aus dem Inventar öffnen (das älteste dieser Art). Gibt die gezogenen Karten zurück. */
async function openPack({ user, type }) {
  const t = packType(type);
  if (!catalog.CARDS.length) throw new UserError('Der TCG-Shop ist gerade geschlossen.');
  const drawn = catalog.drawPack();

  return inTransaction(async (session) => {
    const pack = await TcgPack.findOneAndDelete({ user: user._id, type: t.key }, { sort: { createdAt: 1 }, session });
    if (!pack) throw new UserError('Du hast kein ungeöffnetes Booster Pack dieser Art.');

    const best = Math.max(...drawn.map((c) => catalog.rarityByKey[c.rarity].rank));
    const [opening] = await TcgOpening.create(
      [{ user: user._id, username: user.username, cost: pack.cost, cards: drawn.map((c) => ({ card: c.id, rarity: c.rarity })), best }],
      { session }
    );
    await TcgCard.insertMany(
      drawn.map((c) => ({ user: user._id, card: c.id, rarity: c.rarity, opening: opening._id })),
      { session }
    );
    const packsLeft = await TcgPack.countDocuments({ user: user._id, type: t.key }).session(session);
    return { cards: drawn, packsLeft, openingId: opening._id };
  });
}

/** Ungeöffnete Packs eines Nutzers: [{ ...Pack-Art, count }] (nur Arten mit mindestens einem Pack) */
async function packInventory(userId) {
  const agg = await TcgPack.aggregate([{ $match: { user: userId } }, { $group: { _id: '$type', n: { $sum: 1 } } }]);
  const counts = Object.fromEntries(agg.map((a) => [a._id, a.n]));
  return catalog.PACK_TYPES.filter((t) => counts[t.key]).map((t) => ({ ...t, count: counts[t.key] }));
}

/**
 * Karten verkaufen: count Stück der Karte cardId (die ältesten zuerst).
 * keepOne = true verkauft alle Duplikate und behält genau eine.
 */
async function sellCards({ user, cardId, count = 1, keepOne = false }) {
  if (keepOne && (user.tcgProtected || []).includes(cardId)) throw new UserError('Diese Karte ist geschützt. Hebe den Schutz auf, um ihre Duplikate zu verkaufen.');
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
 * Geschützte Karten (user.tcgProtected) werden komplett ausgelassen.
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
    const keep = new Set(user.tcgProtected || []);
    const toSell = [];
    for (const [cardId, list] of byCard) {
      if (keep.has(cardId)) continue;
      const free = list.filter((c) => !isLocked(locked, c));
      toSell.push(...(free.length === list.length ? free.slice(0, -1) : free));
    }
    if (!toSell.length) throw new UserError('Du hast keine doppelten Karten, die verkauft werden können.');

    const proceeds = toSell.reduce((s, c) => s + (catalog.rarityByKey[c.rarity] ? catalog.rarityByKey[c.rarity].sell : 0), 0);
    const res = await TcgCard.deleteMany({ _id: { $in: toSell.map((c) => c._id) }, user: user._id }, { session });
    if (res.deletedCount !== toSell.length) throw new UserError('Dein Bestand hat sich geändert. Bitte versuche es erneut.');

    const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { balance: proceeds } }, { new: true, session });
    if (proceeds > 0) await Ledger.create([{ user: user._id, type: 'tcg_verkauf', amount: proceeds }], { session });
    return { count: toSell.length, proceeds, balance: updated.balance };
  });
}

const MAX_FAVORITES = 4;

/** Karten-ID in einer Liste am Nutzer ein- bzw. austragen. Gibt true zurück, wenn sie danach enthalten ist. */
async function toggleCard(user, field, cardId, check) {
  if (!catalog.cardById[cardId]) throw new UserError('Diese Karte gibt es nicht.');
  if ((user[field] || []).includes(cardId)) {
    await User.updateOne({ _id: user._id }, { $pull: { [field]: cardId } });
    return false;
  }
  if (!(await TcgCard.exists({ user: user._id, card: cardId }))) throw new UserError('Du besitzt diese Karte nicht.');
  if (check) check();
  await User.updateOne({ _id: user._id }, { $addToSet: { [field]: cardId } });
  return true;
}

/** Schutz vor dem Duplikat-Verkauf umschalten */
const toggleProtected = ({ user, cardId }) => toggleCard(user, 'tcgProtected', cardId);

/** Favorit (Anzeige auf der TCG-Seite) umschalten – höchstens MAX_FAVORITES */
const toggleFavorite = ({ user, cardId }) =>
  toggleCard(user, 'tcgFavorites', cardId, () => {
    if ((user.tcgFavorites || []).length >= MAX_FAVORITES) throw new UserError(`Du kannst höchstens ${MAX_FAVORITES} Favoriten zeigen. Entferne zuerst einen.`);
  });

/** Anzahl neuer geschenkter Packs (Quest, Admin) seit dem letzten Besuch der TCG-Seite – für das Abzeichen im Menü */
const newPackCount = (user) => TcgPack.countDocuments({ user: user._id, source: { $ne: 'kauf' }, createdAt: { $gt: user.packsSeenAt || user.createdAt } });

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

/** Wert aller Karten eines Nutzers in Cent: Verkaufswert der Karten + ungeöffnete Packs zum aktuellen Packpreis */
async function cardValueCents(userId) {
  const [agg, packs] = await Promise.all([
    TcgCard.aggregate([{ $match: { user: userId } }, { $group: { _id: null, s: { $sum: sellValueExpr() } } }]),
    TcgPack.countDocuments({ user: userId }),
  ]);
  return (agg[0] ? agg[0].s : 0) + packs * settings.getPackPrice();
}

module.exports = { MAX_FAVORITES, MAX_PACKS_PER_PURCHASE,toggleProtected, toggleFavorite, newPackCount, buyPack, grantPacks, openPack, packInventory, sellCards, sellAllDuplicates, inventory, sellValueExpr, cardValueCents };

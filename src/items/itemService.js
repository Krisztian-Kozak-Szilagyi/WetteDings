// Inventar: Gegenstände (vorerst nur die Folie) und folierte Karten.
// Eine folierte Karte gewinnt mit der Zeit an Wert, kann aber weder an die Bank verkauft noch auf Quests
// (oder künftige Dungeons) geschickt werden – nur behalten oder im Handel weitergeben (siehe tcg/locks).
const crypto = require('crypto');
const { Item } = require('../models/Item');
const { TcgCard } = require('../models/Tcg');
const { Trade, openFilter } = require('../models/Trade');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { lockedDocs, claim } = require('../tcg/locks');
const { inTransaction } = require('../services/betService');
const { notify } = require('../services/notifyService');
const { UserError } = require('../lib/util');
const catalog = require('../tcg/catalog');
const foil = require('./foil');

// Gegenstands-Arten. Später kommen weitere dazu (eigener Schlüssel, Name, Bild, Beschreibung).
// sell = Ankaufspreis der Bank in Cent.
const ITEM_TYPES = [
  {
    key: 'folie',
    label: 'Folie',
    sell: 1000,
    image: '/img/items/folie.svg',
    text: 'Schweißt eine deiner Karten ein. Folierte Karten steigen im Wert, können aber nicht an die Bank verkauft und nicht auf Quests geschickt werden.',
  },
];
const itemTypeByKey = Object.fromEntries(ITEM_TYPES.map((t) => [t.key, t]));

const MAX_GRANT = 50;
const MAX_SELL = 100;

// Im Handel steht ein Gegenstand wie eine Karte: Trade.card = "item:<Art>", Trade.cardDoc = das Item-Dokument
const ITEM_PREFIX = 'item:';
const itemCardId = (key) => ITEM_PREFIX + key;
/** Gegenstands-Art zu einer Handels-"Karten"-ID – oder null, wenn es eine echte Karte ist */
const itemByCardId = (id) => (typeof id === 'string' && id.startsWith(ITEM_PREFIX) ? ITEM_TYPES.find((t) => itemCardId(t.key) === id) || null : null);
/** Anzeige-Daten wie bei einer Karte (Name, Bild, "Seltenheit" item) */
const itemCard = (t) => ({ id: itemCardId(t.key), name: t.label, rarity: 'item', image: t.image, isItem: true, sell: t.sell });
/** "Seltenheit" der Gegenstände für die Handelsansicht */
const ITEM_RARITY = { key: 'item', label: 'Gegenstand', rank: -1, sell: ITEM_TYPES[0].sell };

/** Item-IDs eines Nutzers, die gerade in einem offenen Handelsangebot stehen */
async function lockedItemIds(userId, session) {
  const trades = await Trade.find({ ...openFilter(), seller: userId, card: { $regex: '^item:' } }).select('cardDoc').session(session || null).lean();
  return new Set(trades.map((t) => String(t.cardDoc)));
}

/** Freie Gegenstände einer Art (nicht im Handel), älteste zuerst */
async function freeItems(userId, type, session) {
  const [docs, locked] = await Promise.all([
    Item.find({ user: userId, type }).sort({ createdAt: 1 }).select('_id').session(session || null).lean(),
    lockedItemIds(userId, session),
  ]);
  return docs.filter((d) => !locked.has(String(d._id)));
}

/** Gegenstände per Schreibzugriff beanspruchen (gleichzeitiger Verkauf/Handel/Folieren kollidiert, siehe tcg/locks.claim) */
async function claimItems(docs, userId, session) {
  const ids = docs.map((d) => d._id);
  const res = await Item.updateMany({ _id: { $in: ids }, user: userId }, { $set: { lastClaimedAt: new Date() } }, { session });
  if (res.matchedCount !== ids.length) throw new UserError('Dein Inventar hat sich geändert. Bitte versuche es erneut.');
}

/** Gegenstände eines Nutzers: [{ ...Art, count, inTrade }] (alle Arten, auch mit 0) */
async function itemInventory(userId) {
  const [agg, locked] = await Promise.all([Item.find({ user: userId }).select('type').lean(), lockedItemIds(userId)]);
  const counts = {};
  const inTrade = {};
  for (const d of agg) {
    counts[d.type] = (counts[d.type] || 0) + 1;
    if (locked.has(String(d._id))) inTrade[d.type] = (inTrade[d.type] || 0) + 1;
  }
  return ITEM_TYPES.map((t) => ({ ...t, count: counts[t.key] || 0, inTrade: inTrade[t.key] || 0 }));
}

/** Gegenstände an die Bank verkaufen (nur freie, nicht im Handel) */
async function sellItems({ user, type, count = 1 }) {
  const t = itemTypeByKey[type];
  if (!t) throw new UserError('Diesen Gegenstand gibt es nicht.');
  if (!Number.isInteger(count) || count < 1 || count > MAX_SELL) throw new UserError(`Du kannst 1 bis ${MAX_SELL} Stück auf einmal verkaufen.`);
  return inTransaction(async (session) => {
    const free = await freeItems(user._id, t.key, session);
    if (free.length < count) throw new UserError(free.length ? `Du hast nur ${free.length} freie ${t.label} (der Rest steht im Handel).` : `Du hast keine freie ${t.label}.`);
    const docs = free.slice(0, count);
    await claimItems(docs, user._id, session);
    const res = await Item.deleteMany({ _id: { $in: docs.map((d) => d._id) }, user: user._id }, { session });
    if (res.deletedCount !== count) throw new UserError('Dein Inventar hat sich geändert. Bitte versuche es erneut.');
    const proceeds = t.sell * count;
    await User.updateOne({ _id: user._id }, { $inc: { balance: proceeds } }, { session });
    await Ledger.create([{ user: user._id, type: 'item_verkauf', amount: proceeds, betTitle: `${count}× ${t.label}`, meta: { item: t.key, count } }], { session });
    return { type: t, count, proceeds };
  });
}

/**
 * Gegenstände aus dem Inventar entfernen (Admin/Dev, z. B. nach einer falschen Vergabe). Gegenstände in einem
 * offenen Handelsangebot bleiben. Gibt { type, removed, remaining } zurück.
 */
async function revokeItems({ userId, type, count = 1 }) {
  const t = itemTypeByKey[type];
  if (!t) throw new UserError('Diesen Gegenstand gibt es nicht.');
  const result = await inTransaction(async (session) => {
    const free = await freeItems(userId, t.key, session);
    if (free.length < count) throw new UserError(free.length ? `Das Mitglied hat nur ${free.length} freie ${t.label} (der Rest steht im Handel).` : `Das Mitglied hat keine freie ${t.label}.`);
    const docs = free.slice(-count); // die neuesten
    await claimItems(docs, userId, session);
    const res = await Item.deleteMany({ _id: { $in: docs.map((d) => d._id) }, user: userId }, { session });
    if (res.deletedCount !== docs.length) throw new UserError('Das Inventar hat sich geändert. Bitte versuche es erneut.');
    return { type: t, removed: docs.length, remaining: free.length - docs.length };
  });
  await notify(userId, { area: 'Inventar', href: '/inventar', text: `Das Team hat ${result.removed > 1 ? result.removed + '× ' : 'eine '}${t.label} aus deinem Inventar entfernt.` });
  return result;
}

/** Gegenstände verschenken (Admin/Dev oder Fund). Optional in einer laufenden Transaktion. */
async function grantItems({ userIds, type, count = 1, source, session }) {
  const t = itemTypeByKey[type];
  if (!t) throw new UserError('Diesen Gegenstand gibt es nicht.');
  if (!Number.isInteger(count) || count < 1 || count > MAX_GRANT) throw new UserError(`Die Anzahl muss zwischen 1 und ${MAX_GRANT} liegen.`);
  await Item.insertMany(userIds.flatMap((user) => Array.from({ length: count }, () => ({ user, type: t.key, source }))), { session });
  return t;
}

/** Folierte Karten eines Nutzers, neueste Folie zuerst – mit aktuellem Wert und Sperre (Handel) */
async function foiledCards(userId, now = Date.now()) {
  const [docs, locked] = await Promise.all([
    TcgCard.find({ user: userId, foiledAt: { $ne: null } }).select('+condition').sort({ foiledAt: -1 }).lean(), // folierte Karten zeigen ihre Note
    lockedDocs(userId),
  ]);
  return docs
    .filter((d) => catalog.cardById[d.card])
    .map((d) => {
      const card = catalog.cardById[d.card];
      const r = catalog.rarityByKey[d.rarity] || { sell: 0, label: d.rarity };
      const reason = locked.reasons.get(String(d._id));
      return {
        id: String(d._id),
        card,
        rarity: r,
        foiledAt: d.foiledAt,
        grade: d.condition ? d.condition.grade : null,
        days: foil.foilDays(d.foiledAt, now),
        percent: foil.foilPercent(d.foiledAt, now),
        sell: r.sell,
        value: foil.cardValue(r.sell, d.foiledAt, now),
        lock: reason && reason !== 'folie' ? reason : null, // 'handel' | 'quest' | 'dungeon'
      };
    });
}

/**
 * Karten, die sich folieren lassen: mindestens ein freies, unfoliertes Exemplar.
 * [{ card, rarity, free }] nach Seltenheit (selten zuerst) und Name.
 */
async function foilableCards(userId) {
  const [docs, locked] = await Promise.all([TcgCard.find({ user: userId, foiledAt: null }).select('card').lean(), lockedDocs(userId)]);
  const free = {};
  for (const d of docs) if (!locked.reasons.has(String(d._id))) free[d.card] = (free[d.card] || 0) + 1;
  return Object.keys(free)
    .map((id) => catalog.cardById[id])
    .filter(Boolean)
    .map((card) => ({ card, rarity: catalog.rarityByKey[card.rarity], free: free[card.id] }))
    .sort((a, b) => b.rarity.rank - a.rarity.rank || a.card.name.localeCompare(b.card.name, 'de'));
}

/**
 * Eine Karte folieren: verbraucht eine Folie, nimmt das älteste freie, unfolierte Exemplar.
 * Gibt { copyId, grade } zurück – mit der Folie wird die Note des Exemplars sichtbar (#73).
 */
async function foilCard({ user, cardId }) {
  const card = catalog.cardById[cardId];
  if (!card) throw new UserError('Bitte wähle eine Karte aus.');
  return inTransaction(async (session) => {
    const locked = await lockedDocs(user._id, session);
    const docs = await TcgCard.find({ user: user._id, card: card.id, foiledAt: null }).sort({ createdAt: 1 }).select('_id condition.grade').session(session).lean();
    const doc = docs.find((d) => !locked.reasons.has(String(d._id)));
    if (!doc) throw new UserError(docs.length ? 'Alle unfolierten Exemplare dieser Karte sind gerade gesperrt (Quest oder Handel).' : 'Du hast kein unfoliertes Exemplar dieser Karte.');
    // eine freie Folie (nicht im Handel) verbrauchen
    const [used] = await freeItems(user._id, 'folie', session);
    if (!used) throw new UserError('Du hast keine freie Folie mehr (oder sie steht im Handel).');
    await claimItems([used], user._id, session);
    await Item.deleteOne({ _id: used._id, user: user._id }, { session });
    await claim([doc], user._id, session);
    await TcgCard.updateOne({ _id: doc._id, user: user._id }, { $set: { foiledAt: new Date() } }, { session });
    return { copyId: String(doc._id), grade: doc.condition ? doc.condition.grade : null };
  });
}

/** Folie abziehen: Die Karte ist danach wieder normal (Bankwert, Quests), die Folie ist kaputt. */
async function unfoilCard({ user, copyId }) {
  return inTransaction(async (session) => {
    const doc = await TcgCard.findOne({ _id: copyId, user: user._id, foiledAt: { $ne: null } }).select('_id card').session(session).lean();
    if (!doc) throw new UserError('Diese folierte Karte gibt es nicht (mehr).');
    const reason = (await lockedDocs(user._id, session)).reasons.get(String(doc._id));
    if (reason === 'handel') throw new UserError('Die Karte ist gerade im Handel. Zieh zuerst das Angebot zurück.');
    await claim([doc], user._id, session);
    await TcgCard.updateOne({ _id: doc._id, user: user._id }, { $set: { foiledAt: null } }, { session });
    return catalog.cardById[doc.card] || null;
  });
}

/**
 * Grading-Shop: Wer eine Karte versiegelt, findet mit kleiner Chance eine Folie (Einstellung gradingChance).
 * Läuft in der Transaktion des Auftrags; gibt true zurück, wenn eine Folie gefunden wurde.
 */
async function rollGradingFoil({ userId, session, roll = () => crypto.randomInt(10000) }) {
  if (roll() >= foil.settings.gradingChance) return false;
  await grantItems({ userIds: [userId], type: 'folie', source: 'grading', session });
  return true;
}

/** Neue Gegenstände seit dem letzten Besuch des Inventars (gleiche Marke wie bei den Packs) – für das Leuchten an „TCG“ */
const newItemCount = (user) => Item.countDocuments({ user: user._id, createdAt: { $gt: user.packsSeenAt || user.createdAt } });

/** Glocke: geschenkte Gegenstände (nach der Transaktion aufrufen) */
const notifyGift = (userIds, t, count) =>
  notify(userIds, { area: 'Inventar', href: '/inventar', text: `Du hast ${count > 1 ? count + '× ' : 'eine '}${t.label} geschenkt bekommen.` });

module.exports = { newItemCount, revokeItems, ITEM_TYPES, itemTypeByKey, MAX_GRANT, MAX_SELL, ITEM_RARITY, itemCardId, itemByCardId, itemCard, lockedItemIds, freeItems, claimItems, sellItems, itemInventory, grantItems, foiledCards, foilableCards, foilCard, unfoilCard, rollGradingFoil, notifyGift };

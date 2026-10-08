const mongoose = require('mongoose');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgCard, TcgOpening, TcgPack } = require('../models/Tcg');
const { lockedDocs, isLocked } = require('./locks');
const { inTransaction } = require('../services/betService');
const { UserError } = require('../lib/util');
const { notify } = require('../services/notifyService');
const catalog = require('./catalog');
const settings = require('./settings');
const foil = require('../items/foil');
const { centerShift } = require('../grading/condition');

const packType = (type) => {
  const t = catalog.packTypeByKey[type || catalog.DEFAULT_PACK];
  if (!t) throw new UserError('Dieses Booster Pack gibt es nicht.');
  return t;
};

const MAX_PACKS_PER_PURCHASE = 100; // Obergrenze pro Kauf (Schutz vor Vertippern)

/** Verkaufte Exemplare für den Kontoauszug zusammenfassen: [{ card, rarity, count }] je Karte */
function soldMeta(docs) {
  const byCard = new Map();
  for (const d of docs) {
    const entry = byCard.get(d.card) || { card: d.card, rarity: d.rarity, count: 0 };
    entry.count++;
    byCard.set(d.card, entry);
  }
  // Exemplare (wenn bekannt): Ende des Verlaufs in der Kartenhistorie (moderation/cardHistory.js)
  const sold = docs.filter((d) => d._id).map((d) => ({ doc: d._id, card: d.card }));
  return sold.length ? { cards: [...byCard.values()], docs: sold } : { cards: [...byCard.values()] };
}

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
    await Ledger.create([{ user: user._id, type: 'tcg_pack', amount: -cost, betTitle: `${count}× ${t.label}`, meta: { pack: t.key, count, price } }], { session });
    return { type: t, count, cost, balance: updatedUser.balance };
  });
}

/**
 * Karten als "schon besessen" merken (Album, "Neu" beim Packöffnen). Optional in einer Transaktion.
 * looted: selbst erbeutet (Pack, Black Market) – zählt dann auch für den Erfolg „Der Archivar“ (#127); Handel nicht.
 */
async function markSeen(userId, cardIds, session, { looted = false } = {}) {
  const ids = [...new Set(cardIds.filter(Boolean))];
  if (!ids.length) return;
  const add = { tcgSeen: { $each: ids } };
  if (looted) add.tcgLooted = { $each: ids };
  await User.updateOne({ _id: userId }, { $addToSet: add }, { session });
}

const packGiftText = (t, count) => `Du hast ${count > 1 ? count + '× ' : 'ein '}${t.label} geschenkt bekommen.`;

/** Booster Packs verschenken (Quest-Fund, Admin). Optional innerhalb einer laufenden Transaktion. */
async function grantPacks({ userId, type, count = 1, source, session }) {
  const t = packType(type);
  await TcgPack.insertMany(Array.from({ length: count }, () => ({ user: userId, type: t.key, source, cost: 0 })), { session });
  // Quest-Funde sieht man beim Abholen selbst; Geschenke vom Team kommen in die Glocke
  if (source === 'admin') await notify(userId, { area: 'Inventar', href: '/inventar', text: packGiftText(t, count) });
  return t;
}

/** Booster Packs an viele Mitglieder auf einmal verschenken ("Bless everyone"): count Packs je Mitglied */
async function grantPacksToMany({ userIds, type, count = 1, source = 'admin' }) {
  const t = packType(type);
  await TcgPack.insertMany(userIds.flatMap((user) => Array.from({ length: count }, () => ({ user, type: t.key, source, cost: 0 }))));
  await notify(userIds, { area: 'Inventar', href: '/inventar', text: packGiftText(t, count) });
  return t;
}

/**
 * Eine bestimmte Karte verschenken (Admin/Dev, z. B. nach einem Fehler oder für eine Aktion): count Exemplare je
 * Mitglied. Die Karte gilt danach als "schon besessen" (Album).
 */
async function grantCards({ userIds, cardId, count = 1 }) {
  const card = catalog.cardById[cardId];
  if (!card) throw new UserError('Diese Karte gibt es nicht.');
  await TcgCard.insertMany(userIds.flatMap((user) => Array.from({ length: count }, () => ({ user, card: card.id, rarity: card.rarity }))));
  await User.updateMany({ _id: { $in: userIds } }, { $addToSet: { tcgSeen: card.id } });
  await notify(userIds, { area: 'TCG', href: '/tcg/album', text: `Du hast ${count > 1 ? count + '× ' : ''}die Karte „${card.name}“ geschenkt bekommen.` });
  return card;
}

/**
 * Exemplare einer Karte aus der Sammlung eines Mitglieds entfernen (Admin/Dev, z. B. nach einem Fehler).
 * Gesperrte Exemplare (laufende Quest, offenes Handelsangebot) bleiben unangetastet.
 * Gibt { card, removed, remaining, docs } zurück (docs = entfernte Exemplare, für das Vergabe-Protokoll).
 */
async function revokeCards({ userId, cardId, count = 1 }) {
  const card = catalog.cardById[cardId];
  if (!card) throw new UserError('Diese Karte gibt es nicht.');
  const result = await inTransaction(async (session) => {
    const owned = await TcgCard.find({ user: userId, card: card.id }).sort({ createdAt: -1 }).session(session).lean();
    if (!owned.length) throw new UserError('Das Mitglied besitzt diese Karte nicht.');
    const locked = await lockedDocs(userId, session);
    const free = owned.filter((d) => !isLocked(locked, d));
    if (free.length < count) {
      const lockedN = owned.length - free.length;
      throw new UserError(`Das Mitglied hat nur ${free.length} freie${lockedN ? ` (dazu ${lockedN} gesperrte: Quest, Handelsangebot oder foliert)` : ''} Exemplar(e) dieser Karte.`);
    }
    const ids = free.slice(0, count).map((d) => d._id);
    const res = await TcgCard.deleteMany({ _id: { $in: ids }, user: userId }, { session });
    if (res.deletedCount !== ids.length) throw new UserError('Der Bestand hat sich geändert. Bitte versuche es erneut.');
    const remaining = owned.length - ids.length;
    // Letztes Exemplar weg: auch „schon besessen“ (Album) und „selbst erbeutet“ entfernen, dazu Favoriten/Schutz –
    // eine entzogene Karte soll aussehen, als hätte das Mitglied sie nie gehabt
    if (!remaining) {
      await User.updateOne({ _id: userId }, { $pull: { tcgSeen: card.id, tcgLooted: card.id, tcgFavorites: card.id, tcgProtected: card.id } }, { session });
    }
    return { card, removed: ids.length, remaining, docs: ids };
  });
  await notify(userId, { area: 'TCG', href: '/tcg/album', text: `Das Team hat ${result.removed > 1 ? result.removed + ' Exemplare' : 'ein Exemplar'} von „${card.name}“ aus deiner Sammlung entfernt.` });
  return result;
}

/**
 * Ungeöffnete Booster Packs einer Art aus dem Inventar entfernen (Admin/Dev, z. B. nach einer falschen Vergabe),
 * die neuesten zuerst. Gibt { type, removed, remaining } zurück.
 */
async function revokePacks({ userId, type, count = 1 }) {
  const t = packType(type);
  const result = await inTransaction(async (session) => {
    const packs = await TcgPack.find({ user: userId, type: t.key }).sort({ createdAt: -1 }).select('_id').session(session).lean();
    if (packs.length < count) throw new UserError(packs.length ? `Das Mitglied hat nur ${packs.length} ungeöffnete ${t.label}.` : `Das Mitglied hat kein ungeöffnetes ${t.label}.`);
    const ids = packs.slice(0, count).map((p) => p._id);
    const res = await TcgPack.deleteMany({ _id: { $in: ids }, user: userId }, { session });
    if (res.deletedCount !== ids.length) throw new UserError('Das Inventar hat sich geändert. Bitte versuche es erneut.');
    return { type: t, removed: ids.length, remaining: packs.length - ids.length };
  });
  await notify(userId, { area: 'Inventar', href: '/inventar', text: `Das Team hat ${result.removed > 1 ? result.removed + '× ' : 'ein '}${t.label} aus deinem Inventar entfernt.` });
  return result;
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
      [{ user: user._id, username: user.username, cost: pack.cost, type: t.key, source: pack.source, cards: drawn.map((c) => ({ card: c.id, rarity: c.rarity })), best }],
      { session }
    );
    await TcgCard.insertMany(
      drawn.map((c) => ({ user: user._id, card: c.id, rarity: c.rarity, opening: opening._id })),
      { session }
    );
    // "Neu" = noch nie besessen; zieht ein Pack dieselbe neue Karte doppelt, ist nur die erste neu
    const me = await User.findById(user._id).select('tcgSeen').session(session).lean();
    const seen = new Set((me && me.tcgSeen) || []);
    const isNew = drawn.map((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    await markSeen(user._id, drawn.map((c) => c.id), session, { looted: true });
    const packsLeft = await TcgPack.countDocuments({ user: user._id, type: t.key }).session(session);
    return { cards: drawn, isNew, packsLeft, openingId: opening._id };
  });
}

/** Ungeöffnete Packs eines Nutzers: [{ ...Pack-Art, count }] (nur Arten mit mindestens einem Pack) */
async function packInventory(userId) {
  const agg = await TcgPack.aggregate([{ $match: { user: userId } }, { $group: { _id: '$type', n: { $sum: 1 } } }]);
  const counts = Object.fromEntries(agg.map((a) => [a._id, a.n]));
  return catalog.PACK_TYPES.filter((t) => counts[t.key]).map((t) => ({ ...t, count: counts[t.key] }));
}

/**
 * Welche unfolierten Exemplare einer Karte sind Duplikate (Liste nach Alter sortiert, älteste zuerst)?
 * Es bleibt immer eins: ein Exemplar auf Quest oder im Dungeon (kommt zurück) oder sonst das neueste freie.
 * Exemplare im Handelsangebot werden weder verkauft noch als das verbleibende gezählt – sie gehen ja weg (#72).
 */
function pickDuplicates(list, locked) {
  const free = list.filter((c) => !isLocked(locked, c));
  const returns = list.some((c) => isLocked(locked, c) && !['handel', 'duell'].includes(locked.reasons.get(String(c._id))));
  return returns ? free : free.slice(0, -1);
}

/**
 * Karten verkaufen: count Stück der Karte cardId (die ältesten zuerst).
 * keepOne = true verkauft alle Duplikate und behält genau eine.
 */
async function sellCards({ user, cardId, count = 1, keepOne = false }) {
  if (keepOne && (user.tcgProtected || []).includes(cardId)) throw new UserError('Diese Karte ist geschützt. Hebe den Schutz auf, um ihre Duplikate zu verkaufen.');
  return inTransaction(async (session) => {
    const all = await TcgCard.find({ user: user._id, card: cardId }).sort({ createdAt: 1 }).select('_id rarity foiledAt').session(session).lean();
    if (!all.length) throw new UserError('Du besitzt diese Karte nicht.');
    // Boss-Karten (noBank) kauft die Bank nicht – nur Handel
    if (all.some((c) => (catalog.rarityByKey[c.rarity] || {}).noBank)) throw new UserError('Diese Karte kauft die Bank nicht. Du kannst sie im Handel anbieten.');
    // Folierte Exemplare kauft die Bank nicht (nur Handel); sie zählen auch nicht als Duplikate
    const owned = all.filter((c) => !c.foiledAt);
    if (!owned.length) throw new UserError('Folierte Karten kauft die Bank nicht. Biete sie im Handel an oder zieh vorher die Folie ab.');
    // Exemplare auf einer IHK-Quest oder in einem Handelsangebot sind gesperrt
    const locked = await lockedDocs(user._id, session);
    const sellable = owned.filter((c) => !isLocked(locked, c));

    const n = keepOne ? pickDuplicates(owned, locked).length : count;
    if (!Number.isInteger(n) || n < 1) throw new UserError('Du hast keine Duplikate dieser Karte.');
    if (!sellable.length) throw new UserError('Diese Karte ist gerade auf einer IHK-Quest, im Handel oder im Duell und kann nicht verkauft werden.');
    if (n > sellable.length) throw new UserError(`Du kannst nur ${sellable.length} Stück dieser Karte verkaufen.`);

    const toSell = sellable.slice(0, n);
    const rarity = catalog.rarityByKey[toSell[0].rarity];
    if (!rarity) throw new UserError('Diese Karte kann nicht verkauft werden.');
    const res = await TcgCard.deleteMany({ _id: { $in: toSell.map((c) => c._id) }, user: user._id }, { session });
    if (res.deletedCount !== n) throw new UserError('Dein Bestand hat sich geändert. Bitte versuche es erneut.');

    const proceeds = rarity.sell * n;
    const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { balance: proceeds } }, { new: true, session });
    await Ledger.create([{ user: user._id, type: 'tcg_verkauf', amount: proceeds, meta: soldMeta(toSell.map((c) => ({ _id: c._id, card: cardId, rarity: c.rarity }))) }], { session });
    return { count: n, proceeds, remaining: all.length - n, balance: updated.balance };
  });
}

/**
 * Alle Duplikate auf einmal verkaufen: von jeder Karte bleibt genau eine (die neueste) übrig.
 * Geschützte Karten (user.tcgProtected) werden komplett ausgelassen.
 * Eine Buchung im Kontoauszug über den Gesamtbetrag.
 */
async function sellAllDuplicates({ user }) {
  return inTransaction(async (session) => {
    // folierte Exemplare bleiben immer (die Bank kauft sie nicht)
    const owned = await TcgCard.find({ user: user._id, foiledAt: null }).sort({ createdAt: 1, _id: 1 }).select('_id card rarity').session(session).lean();
    const byCard = new Map();
    for (const c of owned) {
      if (!byCard.has(c.card)) byCard.set(c.card, []);
      byCard.get(c.card).push(c);
    }
    // Gesperrte Exemplare bleiben; von jeder Karte bleibt eins (siehe pickDuplicates)
    const locked = await lockedDocs(user._id, session);
    const keep = new Set(user.tcgProtected || []);
    const toSell = [];
    for (const [cardId, list] of byCard) {
      if (keep.has(cardId)) continue;
      if ((catalog.rarityByKey[list[0].rarity] || {}).noBank) continue; // Boss-Karten kauft die Bank nicht
      toSell.push(...pickDuplicates(list, locked));
    }
    if (!toSell.length) throw new UserError('Du hast keine doppelten Karten, die verkauft werden können.');

    const proceeds = toSell.reduce((s, c) => s + (catalog.rarityByKey[c.rarity] ? catalog.rarityByKey[c.rarity].sell : 0), 0);
    const res = await TcgCard.deleteMany({ _id: { $in: toSell.map((c) => c._id) }, user: user._id }, { session });
    if (res.deletedCount !== toSell.length) throw new UserError('Dein Bestand hat sich geändert. Bitte versuche es erneut.');

    const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { balance: proceeds } }, { new: true, session });
    if (proceeds > 0) await Ledger.create([{ user: user._id, type: 'tcg_verkauf', amount: proceeds, meta: soldMeta(toSell) }], { session });
    return { count: toSell.length, proceeds, balance: updated.balance };
  });
}

const MAX_FAVORITES = 4;

// Favoriten können auch ein bestimmtes foliertes Exemplar sein: "f:<Exemplar-ID>" (statt der Karten-ID)
const FOIL_FAV = 'f:';
const isFoilFav = (id) => typeof id === 'string' && id.startsWith(FOIL_FAV);
const foilFavDoc = (id) => (isFoilFav(id) && mongoose.isValidObjectId(id.slice(FOIL_FAV.length)) ? id.slice(FOIL_FAV.length) : null);

/** Folierte Exemplare (aus "f:<id>"-Einträgen), die der Nutzer noch besitzt und die noch foliert sind: Map docId → Dokument */
async function ownedFoilFavs(userId, ids) {
  const docIds = ids.map(foilFavDoc).filter(Boolean);
  if (!docIds.length) return new Map();
  const docs = await TcgCard.find({ _id: { $in: docIds }, user: userId, foiledAt: { $ne: null } }).select('card foiledAt condition.grade condition.defects.centering').lean();
  return new Map(docs.map((d) => [String(d._id), d]));
}

/** Karten-ID in einer Liste am Nutzer ein- bzw. austragen. Gibt true zurück, wenn sie danach enthalten ist. */
async function toggleCard(user, field, cardId, check) {
  if (!catalog.cardById[cardId]) throw new UserError('Diese Karte gibt es nicht.');
  if ((user[field] || []).includes(cardId)) {
    await User.updateOne({ _id: user._id }, { $pull: { [field]: cardId } });
    return false;
  }
  if (!(await TcgCard.exists({ user: user._id, card: cardId, foiledAt: null }))) throw new UserError('Du besitzt diese Karte nicht (folierte Exemplare zählen hier einzeln).');
  if (check) check();
  await User.updateOne({ _id: user._id }, { $addToSet: { [field]: cardId } });
  return true;
}

/** Schutz vor dem Duplikat-Verkauf umschalten */
const toggleProtected = ({ user, cardId }) => toggleCard(user, 'tcgProtected', cardId);

/**
 * Favoriten und geschützte Karten, die man nicht mehr besitzt (verkauft, getauscht), aus den Listen entfernen.
 * Gibt die bereinigten Listen zurück. Ohne das würden verkaufte Karten weiter Favoriten-Plätze belegen.
 */
async function pruneCardLists(user) {
  const lists = { tcgFavorites: user.tcgFavorites || [], tcgProtected: user.tcgProtected || [] };
  const ids = [...new Set([...lists.tcgFavorites, ...lists.tcgProtected])];
  if (!ids.length) return lists;
  const cardIds = ids.filter((id) => !isFoilFav(id));
  const [ownedCards, foils] = await Promise.all([
    cardIds.length ? TcgCard.distinct('card', { user: user._id, card: { $in: cardIds }, foiledAt: null }) : [],
    ownedFoilFavs(user._id, ids),
  ]);
  const owned = new Set([...ownedCards, ...[...foils.keys()].map((k) => FOIL_FAV + k)]);
  const gone = ids.filter((id) => !owned.has(id));
  if (!gone.length) return lists;
  await User.updateOne({ _id: user._id }, { $pull: { tcgFavorites: { $in: gone }, tcgProtected: { $in: gone } } });
  return { tcgFavorites: lists.tcgFavorites.filter((id) => owned.has(id)), tcgProtected: lists.tcgProtected.filter((id) => owned.has(id)) };
}

/** Favorit (Anzeige auf der TCG-Seite) umschalten – höchstens MAX_FAVORITES (gezählt werden nur Karten, die man noch besitzt) */
async function toggleFavorite({ user, cardId }) {
  const { tcgFavorites } = await pruneCardLists(user);
  if (isFoilFav(cardId)) {
    if (tcgFavorites.includes(cardId)) {
      await User.updateOne({ _id: user._id }, { $pull: { tcgFavorites: cardId } });
      return false;
    }
    if (!(await ownedFoilFavs(user._id, [cardId])).size) throw new UserError('Diese folierte Karte besitzt du nicht.');
    if (tcgFavorites.length >= MAX_FAVORITES) throw new UserError(`Du kannst höchstens ${MAX_FAVORITES} Favoriten zeigen. Entferne zuerst einen.`);
    await User.updateOne({ _id: user._id }, { $addToSet: { tcgFavorites: cardId } });
    return true;
  }
  return toggleCard({ ...user, tcgFavorites }, 'tcgFavorites', cardId, () => {
    if (tcgFavorites.length >= MAX_FAVORITES) throw new UserError(`Du kannst höchstens ${MAX_FAVORITES} Favoriten zeigen. Entferne zuerst einen.`);
  });
}

/**
 * Favoriten eines Mitglieds zum Anzeigen: [{ key, card, foiledAt, grade }] – foiledAt und grade (Note auf der Folie) nur bei folierten Exemplaren.
 * counts = { cardId: Anzahl } des Mitglieds; Karten, die es nicht mehr besitzt, fallen weg.
 */
async function favoriteList(owner, counts) {
  const ids = owner.tcgFavorites || [];
  const foils = await ownedFoilFavs(owner._id, ids);
  return ids
    .map((id) => {
      if (isFoilFav(id)) {
        const d = foils.get(id.slice(FOIL_FAV.length));
        return d && catalog.cardById[d.card] ? { key: id, card: catalog.cardById[d.card], foiledAt: d.foiledAt, grade: d.condition ? d.condition.grade : null, center: d.condition ? centerShift(d.condition.defects && d.condition.defects.centering, d._id) : null } : null;
      }
      const card = catalog.cardById[id];
      return card && counts[id] ? { key: id, card, foiledAt: null, grade: null, center: null } : null;
    })
    .filter(Boolean);
}

/** Anzahl neuer geschenkter Packs (Quest, Admin) seit dem letzten Besuch des Inventars – für das Abzeichen im Menü */
const newPackCount = (user) => TcgPack.countDocuments({ user: user._id, source: { $ne: 'kauf' }, createdAt: { $gt: user.packsSeenAt || user.createdAt } });

/** Sammlung eines Nutzers: [{ _id: cardId, n, rarity, foiled: folierte Exemplare, v: Wert in Cent (mit Folie) }] */
async function inventory(userId) {
  const agg = await TcgCard.aggregate([
    { $match: { user: userId } },
    { $group: { _id: '$card', n: { $sum: 1 }, rarity: { $first: '$rarity' }, foiled: { $sum: { $cond: [{ $eq: [{ $type: '$foiledAt' }, 'date'] }, 1, 0] } }, v: { $sum: sellValueExpr() } } },
  ]);
  return agg;
}

/**
 * MongoDB-Ausdruck: Wert (Cent) einer Karte – Verkaufswert anhand von $rarity, foliert plus Wertsteigerung
 * (src/items/foil.js). Für Ranglisten-Aggregationen.
 */
function sellValueExpr(field = '$rarity') {
  const sell = {
    $switch: {
      branches: catalog.ALL_RARITIES.map((r) => ({ case: { $eq: [field, r.key] }, then: r.sell })),
      default: 0,
    },
  };
  return { $floor: { $add: [{ $multiply: [sell, foil.factorExpr()] }, 1e-9] } };
}

/** Wert aller Karten eines Nutzers in Cent: Wert der Karten (foliert mit Steigerung) + ungeöffnete Packs zum aktuellen Packpreis */
async function cardValueCents(userId) {
  const [agg, packs] = await Promise.all([
    TcgCard.aggregate([{ $match: { user: userId } }, { $group: { _id: null, s: { $sum: sellValueExpr() } } }]),
    TcgPack.countDocuments({ user: userId }),
  ]);
  return (agg[0] ? agg[0].s : 0) + packs * settings.getPackPrice();
}

module.exports = {
  revokePacks, soldMeta, pickDuplicates, MAX_FAVORITES, favoriteList, MAX_PACKS_PER_PURCHASE, pruneCardLists, toggleProtected, toggleFavorite, newPackCount, buyPack, grantPacks, grantPacksToMany, grantCards, revokeCards, markSeen, openPack, packInventory, sellCards, sellAllDuplicates, inventory, sellValueExpr, cardValueCents };

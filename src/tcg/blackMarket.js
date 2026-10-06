// Black Market: jeden Tag von 16:30 bis 19:00 (deutsche Zeit) vier zufällige Angebote – Karten von Holo bis Glitch,
// selten eine Dungeon-Bosskarte oder eine Folie (Gegenstand).
// Alle sehen dieselben vier; jedes Angebot gibt es nur einmal – wer zuerst kauft, bekommt es.
// Preis: 170 % des Verkaufspreises (was die Karte beim Verkauf an die Bank bringt), Gegenstände mindestens 1.000 €.
const crypto = require('crypto');
const config = require('../config');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const BlackMarket = require('../models/BlackMarket');
const { TcgCard } = require('../models/Tcg');
const { inTransaction } = require('../services/betService');
const { parseZonedLocal, toZonedLocalInput } = require('../lib/time');
const { UserError } = require('../lib/util');
const catalog = require('./catalog');
const { markSeen } = require('./tcgService');
const itemService = require('../items/itemService');
const { ITEM_PREFIX } = require('../trade/lines');
const { DUNGEONS } = require('../dungeon/dungeons');

const OPEN = '16:30';
const CLOSE = '19:00';
const OFFER_COUNT = 4;
const PRICE_PERCENT = 170;
// Chancen pro Karte in Prozent (zusammen 100) – mindestens Holo; Anteile wie früher ohne Gold (30 : 6 : 2)
const ODDS = [
  { rarity: 'holo', percent: 79 },
  { rarity: 'bockhaber', percent: 16 },
  { rarity: 'glitch', percent: 5 },
];
// Sonderangebote pro Angebot in Prozent (Rest: Karte nach ODDS)
const FOIL_PERCENT = 5; // Gegenstand Folie statt einer Karte
const BOSS_PERCENT = 1; // Dungeon-Bosskarte
const FOIL_KEY = 'folie';
const MIN_ITEM_PRICE = 100000; // Gegenstände kosten mindestens 1.000 €

const dayOf = (ms) => toZonedLocalInput(new Date(ms), config.timezone).slice(0, 10);
const at = (day, time) => parseZonedLocal(`${day}T${time}`, config.timezone);
function addDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Öffnungszeiten rund um now: { open, day, opensAt, closesAt } – opensAt ist bei geschlossenem Markt die nächste Öffnung */
function windowAt(now = Date.now()) {
  const day = dayOf(now);
  const opensAt = at(day, OPEN);
  const closesAt = at(day, CLOSE);
  if (now >= opensAt.getTime() && now < closesAt.getTime()) return { open: true, day, opensAt, closesAt };
  const next = now < opensAt.getTime() ? day : addDays(day, 1);
  return { open: false, day: next, opensAt: at(next, OPEN), closesAt: at(next, CLOSE) };
}

/** Seltenheit würfeln: roll = 0 … 99 */
function rarityForRoll(roll) {
  let acc = 0;
  for (const o of ODDS) {
    acc += o.percent;
    if (roll < acc) return o.rarity;
  }
  return ODDS[0].rarity;
}

/** Art eines Angebots würfeln: roll = 0 … 99 → 'folie' (0–4), 'boss' (5), sonst 'karte' */
function drawKindForRoll(roll) {
  if (roll < FOIL_PERCENT) return 'folie';
  if (roll < FOIL_PERCENT + BOSS_PERCENT) return 'boss';
  return 'karte';
}

/** Preis in Cent: 170 % des aktuellen Verkaufspreises der Seltenheit */
const priceFor = (rarity) => Math.round((catalog.rarityByKey[rarity].sell * PRICE_PERCENT) / 100);
/** Preis eines Gegenstands in Cent: 170 % des Bank-Ankaufspreises, mindestens 1.000 € */
const itemPriceFor = (t) => Math.max(MIN_ITEM_PRICE, Math.round(((t.sell || 0) * PRICE_PERCENT) / 100));

/**
 * Bosskarten aller Dungeons, die wirklich im Katalog stehen (jede nur einmal). Eine Bosskarte, die noch nicht
 * gezeichnet ist (keine Datei in public/img/tcg), fehlt hier – dann entfällt die Chance auf sie.
 */
function bossCards(dungeons = DUNGEONS, cardById = catalog.cardById) {
  const ids = [...new Set(dungeons.map((d) => d.bossCard).filter(Boolean))];
  return ids.map((id) => cardById[id]).filter(Boolean);
}

/** Art eines gespeicherten Angebots – alte Tagesdokumente ohne Feld kind sind Karten */
const offerKind = (o) => (o && o.kind === 'gegenstand' ? 'gegenstand' : 'karte');
/** Gegenstands-Art eines Angebots ("item:folie" → Folie) oder null */
const offerItem = (o) =>
  offerKind(o) === 'gegenstand' && typeof o.card === 'string' && o.card.startsWith(ITEM_PREFIX) ? itemService.itemType(o.card.slice(ITEM_PREFIX.length)) : null;

const cardOffer = (card) => ({ kind: 'karte', card: card.id, rarity: card.rarity, price: priceFor(card.rarity) });
const itemOffer = (t) => ({ kind: 'gegenstand', card: itemService.itemCardId(t.key), rarity: 'item', price: itemPriceFor(t) });

/**
 * Vier verschiedene Angebote würfeln. Würfe je Angebot, in dieser Reihenfolge:
 *   1. Art: randomInt(100) – 0–4 Folie (5 %), 5 Bosskarte (1 %), 6–99 normale Karte (94 %)
 *   2. nur bei normaler Karte: Seltenheit randomInt(100) nach ODDS (Holo 79 %, Bockhaber 16 %, Glitch 5 %)
 *   3. bei Karte und Bosskarte: welche, randomInt(Anzahl der noch nicht angebotenen Karten)
 * Keine Duplikate: jede Karte und jeder Gegenstand (card-ID) höchstens einmal pro Tag. Ist die Folie schon dabei
 * oder gibt es keine (freie) Bosskarte, wird das Angebot eine normale Karte – die Sonderchance entfällt ohne Fehler.
 * Gibt es für eine Seltenheit keine freie Karte, wird das Angebot neu gewürfelt.
 */
function drawOffers(randomInt = crypto.randomInt, { bosses = bossCards(), foil = itemService.itemType(FOIL_KEY) } = {}) {
  const offers = [];
  const taken = new Set();
  const free = (cards) => cards.filter((c) => !taken.has(c.id));
  const add = (offer) => {
    taken.add(offer.card);
    offers.push(offer);
  };
  for (let guard = 0; offers.length < OFFER_COUNT && guard < 500; guard++) {
    let kind = drawKindForRoll(randomInt(100));
    if (kind === 'folie' && (!foil || taken.has(itemService.itemCardId(foil.key)))) kind = 'karte';
    const bossPool = kind === 'boss' ? free(bosses) : [];
    if (kind === 'boss' && !bossPool.length) kind = 'karte';
    if (kind === 'folie') {
      add(itemOffer(foil));
      continue;
    }
    if (kind === 'boss') {
      add(cardOffer(bossPool[randomInt(bossPool.length)]));
      continue;
    }
    const pool = free(catalog.cardsByRarity[rarityForRoll(randomInt(100))] || []);
    if (!pool.length) continue;
    add(cardOffer(pool[randomInt(pool.length)]));
  }
  return offers;
}

/** Angebot von heute holen; beim ersten Aufruf nach der Öffnung wird es gewürfelt (gleichzeitige Aufrufe: einer gewinnt) */
async function today(now = Date.now()) {
  const w = windowAt(now);
  if (!w.open) return { ...w, offers: [] };
  let doc = await BlackMarket.findById(w.day).lean();
  if (!doc) {
    try {
      doc = (await BlackMarket.create({ _id: w.day, offers: drawOffers() })).toObject();
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
      doc = await BlackMarket.findById(w.day).lean();
    }
  }
  return { ...w, offers: doc.offers.map((o) => ({ ...o, kind: offerKind(o) })) };
}

/** Angebot Nummer index kaufen – Karte ins Album, Gegenstand ins Inventar */
async function buy({ user, index, now = Date.now() }) {
  const w = windowAt(now);
  if (!w.open) throw new UserError(`Der Black Market hat geschlossen. Er öffnet täglich um ${OPEN} Uhr.`);
  const i = Number.parseInt(index, 10);
  if (!Number.isInteger(i) || i < 0 || i >= OFFER_COUNT) throw new UserError('Dieses Angebot gibt es nicht.');
  await today(now); // Angebot sicher anlegen

  return inTransaction(async (session) => {
    const doc = await BlackMarket.findById(w.day).session(session);
    const offer = doc && doc.offers[i];
    if (!offer) throw new UserError('Dieses Angebot gibt es nicht.');
    const kind = offerKind(offer);
    const item = offerItem(offer);
    const card = kind === 'karte' ? catalog.cardById[offer.card] : null;
    const what = kind === 'gegenstand' ? 'Diesen Gegenstand' : 'Diese Karte';
    if (offer.buyer) throw new UserError(offer.buyer.equals(user._id) ? `${what} hast du schon gekauft.` : `Zu spät – ${offer.buyerName} war schneller.`);
    if (!card && !item) throw new UserError(`${what} gibt es nicht mehr.`);
    const paid = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: offer.price } }, { $inc: { balance: -offer.price } }, { new: true, session });
    if (!paid) throw new UserError('Dein Guthaben reicht dafür nicht aus.');
    // nur verkaufen, wenn noch niemand zugegriffen hat (gleichzeitige Käufe: einer gewinnt)
    const sold = await BlackMarket.updateOne(
      { _id: w.day, [`offers.${i}.buyer`]: null },
      { $set: { [`offers.${i}.buyer`]: user._id, [`offers.${i}.buyerName`]: user.username, [`offers.${i}.soldAt`]: new Date() } },
      { session }
    );
    if (sold.modifiedCount !== 1) throw new UserError('Zu spät – jemand anderes war schneller.');
    if (card) {
      await TcgCard.create([{ user: user._id, card: card.id, rarity: card.rarity }], { session });
      await Ledger.create([{ user: user._id, type: 'black_market', amount: -offer.price, betTitle: `${card.name} (${catalog.rarityByKey[card.rarity].label})`, meta: { card: card.id, rarity: card.rarity } }], { session });
      await markSeen(user._id, [card.id], session);
    } else {
      await itemService.addItems({ userIds: [user._id], type: item.key, source: 'blackmarket', session });
      await Ledger.create([{ user: user._id, type: 'black_market', amount: -offer.price, betTitle: `${item.label} (Gegenstand)`, meta: { item: item.key, count: 1 } }], { session });
    }
    return { kind, card, item, price: offer.price, balance: paid.balance };
  });
}

module.exports = { OPEN, CLOSE, OFFER_COUNT, PRICE_PERCENT, ODDS, FOIL_PERCENT, BOSS_PERCENT, MIN_ITEM_PRICE, windowAt, rarityForRoll, drawKindForRoll, priceFor, itemPriceFor, bossCards, offerKind, offerItem, drawOffers, today, buy };

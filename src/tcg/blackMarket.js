// Black Market: jeden Tag von 16:30 bis 19:00 (deutsche Zeit) vier zufällige Karten von Gold bis Glitch.
// Alle sehen dieselben vier; jede Karte gibt es nur einmal – wer zuerst kauft, bekommt sie.
// Preis: 170 % des Verkaufspreises (was die Karte beim Verkauf an die Bank bringt).
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

const OPEN = '16:30';
const CLOSE = '19:00';
const OFFER_COUNT = 4;
const PRICE_PERCENT = 170;
// Chancen pro Karte in Prozent (zusammen 100)
const ODDS = [
  { rarity: 'gold', percent: 62 },
  { rarity: 'holo', percent: 30 },
  { rarity: 'bockhaber', percent: 6 },
  { rarity: 'glitch', percent: 2 },
];

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

/** Preis in Cent: 170 % des aktuellen Verkaufspreises der Seltenheit */
const priceFor = (rarity) => Math.round((catalog.rarityByKey[rarity].sell * PRICE_PERCENT) / 100);

/** Vier verschiedene Karten würfeln (gibt es für eine Seltenheit keine Karte, wird neu gewürfelt) */
function drawOffers(randomInt = crypto.randomInt) {
  const offers = [];
  const taken = new Set();
  for (let guard = 0; offers.length < OFFER_COUNT && guard < 500; guard++) {
    const rarity = rarityForRoll(randomInt(100));
    const pool = (catalog.cardsByRarity[rarity] || []).filter((c) => !taken.has(c.id));
    if (!pool.length) continue;
    const card = pool[randomInt(pool.length)];
    taken.add(card.id);
    offers.push({ card: card.id, rarity, price: priceFor(rarity) });
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
  return { ...w, offers: doc.offers };
}

/** Karte Nummer index kaufen */
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
    if (offer.buyer) throw new UserError(offer.buyer.equals(user._id) ? 'Diese Karte hast du schon gekauft.' : `Zu spät – ${offer.buyerName} war schneller.`);
    const card = catalog.cardById[offer.card];
    if (!card) throw new UserError('Diese Karte gibt es nicht mehr.');
    const paid = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: offer.price } }, { $inc: { balance: -offer.price } }, { new: true, session });
    if (!paid) throw new UserError('Dein Guthaben reicht dafür nicht aus.');
    // nur verkaufen, wenn noch niemand zugegriffen hat (gleichzeitige Käufe: einer gewinnt)
    const sold = await BlackMarket.updateOne(
      { _id: w.day, [`offers.${i}.buyer`]: null },
      { $set: { [`offers.${i}.buyer`]: user._id, [`offers.${i}.buyerName`]: user.username, [`offers.${i}.soldAt`]: new Date() } },
      { session }
    );
    if (sold.modifiedCount !== 1) throw new UserError('Zu spät – jemand anderes war schneller.');
    await TcgCard.create([{ user: user._id, card: card.id, rarity: card.rarity }], { session });
    await Ledger.create([{ user: user._id, type: 'black_market', amount: -offer.price, betTitle: `${card.name} (${catalog.rarityByKey[card.rarity].label})` }], { session });
    await markSeen(user._id, [card.id], session);
    return { card, price: offer.price, balance: paid.balance };
  });
}

module.exports = { OPEN, CLOSE, OFFER_COUNT, PRICE_PERCENT, ODDS, windowAt, rarityForRoll, priceFor, drawOffers, today, buy };

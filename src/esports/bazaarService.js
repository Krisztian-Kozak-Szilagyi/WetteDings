// Lil Dré's Bazaar – Laden für spielfähige eSports-Teams (Status "aktiv", mindestens TEAM_SIZE Mitglieder) im Handel.
// Logik in bazaar.js; hier Datenbank, Kauf (Transaktion) und Öffnungs-Tag.
const crypto = require('crypto');
const config = require('../config');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const Bazaar = require('../models/Bazaar');
const { EsportsTeam } = require('../models/Esports');
const { TcgCard } = require('../models/Tcg');
const { inTransaction } = require('../services/betService');
const { parseZonedLocal, toZonedLocalInput } = require('../lib/time');
const { UserError } = require('../lib/util');
const catalog = require('../tcg/catalog');
const { markSeen } = require('../tcg/tcgService');
const league = require('./league');
const bazaar = require('./bazaar');

const dayOf = (ms) => toZonedLocalInput(new Date(ms), config.timezone).slice(0, 10);
function nextDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Team, für das der Spieler im Bazaar einkaufen darf – oder null */
async function teamFor(userId) {
  const team = await EsportsTeam.findOne({ status: 'aktiv', 'members.user': userId }).select('_id name members.user').lean();
  return team && team.members.length >= league.TEAM_SIZE ? team : null;
}

/** Laden von heute für ein Team; beim ersten Aufruf des Tages wird gewürfelt (gleichzeitige Aufrufe: einer gewinnt) */
async function shelf(team, now = Date.now()) {
  const day = dayOf(now);
  const _id = `${team._id}:${day}`;
  let doc = await Bazaar.findById(_id).lean();
  if (!doc) {
    try {
      doc = (await Bazaar.create({ _id, team: team._id, day, offers: bazaar.drawOffers(crypto.randomInt) })).toObject();
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
      doc = await Bazaar.findById(_id).lean();
    }
  }
  return { day, offers: doc.offers, restockAt: parseZonedLocal(`${nextDay(day)}T00:00`, config.timezone) };
}

/** Für die Handelsseite: null, wenn der Spieler kein spielfähiges eSports-Team hat */
async function forUser(user, now = Date.now()) {
  const team = await teamFor(user._id);
  return team ? { team: { id: String(team._id), name: team.name }, ...(await shelf(team, now)) } : null;
}

/** Platz Nummer index kaufen – die Karte kommt ins Album des Käufers, der Platz ist fürs ganze Team weg */
async function buy({ user, index, now = Date.now() }) {
  const team = await teamFor(user._id);
  if (!team) throw new UserError("Lil Dré's Bazaar ist nur für eSports-Teams mit mindestens drei Mitgliedern.");
  const i = Number.parseInt(index, 10);
  if (!Number.isInteger(i) || i < 0 || i >= bazaar.OFFER_COUNT) throw new UserError('Dieses Angebot gibt es nicht.');
  const { day } = await shelf(team, now); // Laden sicher anlegen
  const _id = `${team._id}:${day}`;

  return inTransaction(async (session) => {
    const doc = await Bazaar.findById(_id).session(session);
    const offer = doc && doc.offers[i];
    if (!offer) throw new UserError('Dieses Angebot gibt es nicht.');
    if (offer.buyer) throw new UserError(offer.buyer.equals(user._id) ? 'Das hast du schon gekauft.' : `Zu spät – ${offer.buyerName} war schneller.`);
    const card = catalog.cardById[offer.card];
    if (!card) throw new UserError('Diese Karte gibt es nicht mehr.');
    const paid = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: offer.price } }, { $inc: { balance: -offer.price } }, { new: true, session });
    if (!paid) throw new UserError('Dein Guthaben reicht dafür nicht aus.');
    const sold = await Bazaar.updateOne(
      { _id, [`offers.${i}.buyer`]: null },
      { $set: { [`offers.${i}.buyer`]: user._id, [`offers.${i}.buyerName`]: user.username, [`offers.${i}.soldAt`]: new Date() } },
      { session }
    );
    if (sold.modifiedCount !== 1) throw new UserError('Zu spät – jemand aus deinem Team war schneller.');
    await TcgCard.create([{ user: user._id, card: card.id, rarity: card.rarity }], { session });
    await Ledger.create(
      [{ user: user._id, type: 'bazaar_kauf', amount: -offer.price, betTitle: `${card.name} (${catalog.rarityByKey[card.rarity].label})`, meta: { card: card.id, rarity: card.rarity, team: team._id } }],
      { session }
    );
    await markSeen(user._id, [card.id], session, { looted: true }); // wie Black Market: zählt als selbst erbeutet
    return { card, price: offer.price, balance: paid.balance };
  });
}

module.exports = { teamFor, shelf, forUser, buy };

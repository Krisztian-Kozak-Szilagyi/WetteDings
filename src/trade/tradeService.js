const mongoose = require('mongoose');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgCard } = require('../models/Tcg');
const { Trade, TradeSettings } = require('../models/Trade');
const { inTransaction } = require('../services/betService');
const { UserError } = require('../lib/util');
const catalog = require('../tcg/catalog');
const { lockedDocs, isLocked, claim } = require('../tcg/locks');

const PRIVATE_HOURS = 48; // private Angebote laufen nach 48 Stunden ab
const MARKET_DAYS = 7; // Markt-Angebote nach 7 Tagen
const MAX_PRICE = 100000000; // 1 Mio. €
const MAX_OPEN = 20; // offene Angebote pro Person

// ---------- Einstellungen (Admin) ----------
const settings = { taxPercent: 0 };

async function loadSettings() {
  const doc = await TradeSettings.findById('handel').lean();
  if (doc && Number.isFinite(doc.taxPercent)) settings.taxPercent = doc.taxPercent;
}

async function saveSettings({ taxPercent, admin }) {
  await TradeSettings.updateOne({ _id: 'handel' }, { $set: { taxPercent, updatedByName: admin.username } }, { upsert: true });
  settings.taxPercent = taxPercent;
}

/** Steuer in Cent (abgerundet), die dem Verkäufer abgezogen wird */
const taxFor = (price, percent = settings.taxPercent) => Math.floor((price * Math.min(100, Math.max(0, percent))) / 100);

// ---------- Abfragen ----------
const openFilter = () => ({ status: 'offen', expiresAt: { $gt: new Date() } });

/** Anzahl neuer privater Angebote an einen Nutzer (für das Abzeichen im Menü) */
const incomingCount = (userId) => Trade.countDocuments({ ...openFilter(), kind: 'privat', to: userId });

/** Offene Markt-Angebote anderer, die seit dem letzten Besuch der Handelsseite eingestellt wurden */
const marketNewFilter = (user) => ({
  ...openFilter(),
  kind: 'markt',
  seller: { $ne: user._id },
  createdAt: { $gt: user.marketSeenAt || user.createdAt },
});
const marketNewCount = (user) => Trade.countDocuments(marketNewFilter(user));

// ---------- Aktionen ----------
/** Angebot erstellen: privat (an toName) oder auf dem Markt (toName leer) */
async function create({ user, cardId, price, toName }) {
  const card = catalog.cardById[cardId];
  if (!card) throw new UserError('Bitte wähle eine Karte aus.');
  if (!Number.isInteger(price) || price < 1 || price > MAX_PRICE) throw new UserError('Bitte gib einen gültigen Preis an.');

  let to = null;
  if (toName) {
    to = await User.findOne({ usernameLower: toName.trim().toLowerCase() }).select('_id username').lean();
    if (!to) throw new UserError('Diesen Benutzer gibt es nicht.');
    if (to._id.equals(user._id)) throw new UserError('Du kannst dir nicht selbst ein Angebot machen.');
  }
  if ((await Trade.countDocuments({ ...openFilter(), seller: user._id })) >= MAX_OPEN) {
    throw new UserError(`Du hast schon ${MAX_OPEN} offene Angebote.`);
  }

  const hours = to ? PRIVATE_HOURS : MARKET_DAYS * 24;
  try {
    // Sperrprüfung und Angebot in einer Transaktion, damit die Karte nicht gleichzeitig verkauft oder auf eine Quest geschickt wird
    return await inTransaction(async (session) => {
      // freies Exemplar suchen (nicht auf einer Quest, nicht schon im Handel)
      const locked = await lockedDocs(user._id, session);
      const docs = await TcgCard.find({ user: user._id, card: cardId }).sort({ createdAt: 1 }).select('_id').session(session).lean();
      const doc = docs.find((d) => !isLocked(locked, d));
      if (!doc) throw new UserError(docs.length ? 'Alle Exemplare dieser Karte sind gerade gesperrt (Quest oder Handel).' : 'Diese Karte besitzt du nicht.');
      await claim([doc], user._id, session);

      // abgelaufene Angebote für dieses Exemplar schließen, damit der eindeutige Index nicht blockiert
      await Trade.updateMany({ cardDoc: doc._id, status: 'offen', expiresAt: { $lte: new Date() } }, { $set: { status: 'zurueckgezogen', closedAt: new Date() } }, { session });

      const [trade] = await Trade.create(
        [
          {
            kind: to ? 'privat' : 'markt',
            seller: user._id,
            sellerName: user.username,
            to: to ? to._id : null,
            toName: to ? to.username : null,
            card: cardId,
            cardDoc: doc._id,
            price,
            expiresAt: new Date(Date.now() + hours * 3600000),
          },
        ],
        { session }
      );
      return trade;
    });
  } catch (err) {
    if (err.code === 11000) throw new UserError('Dieses Exemplar ist schon im Handel.');
    throw err;
  }
}

/** Kaufen/Annehmen: Käufer zahlt den Preis, Verkäufer bekommt Preis − Steuer, die Karte wechselt den Besitzer */
async function buy({ user, tradeId }) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  return inTransaction(async (session) => {
    const trade = await Trade.findOne({ _id: tradeId, ...openFilter() }).session(session);
    if (!trade) throw new UserError('Dieses Angebot gibt es nicht mehr.');
    if (trade.seller.equals(user._id)) throw new UserError('Du kannst dein eigenes Angebot nicht kaufen.');
    if (trade.kind === 'privat' && !trade.to.equals(user._id)) throw new UserError('Dieses Angebot ist nicht für dich.');

    const tax = taxFor(trade.price);
    const buyer = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: trade.price } }, { $inc: { balance: -trade.price } }, { new: true, session });
    if (!buyer) throw new UserError('Dein Guthaben reicht dafür nicht aus.');

    const moved = await TcgCard.updateOne({ _id: trade.cardDoc, user: trade.seller }, { $set: { user: user._id } }, { session });
    if (moved.modifiedCount !== 1) throw new UserError('Die Karte ist nicht mehr verfügbar.');
    await User.updateOne({ _id: trade.seller }, { $inc: { balance: trade.price - tax } }, { session });

    const title = catalog.cardById[trade.card] ? catalog.cardById[trade.card].name : trade.card;
    await Ledger.create(
      [
        { user: user._id, type: 'handel_kauf', amount: -trade.price, betTitle: title },
        { user: trade.seller, type: 'handel_verkauf', amount: trade.price - tax, betTitle: title },
      ],
      { session, ordered: true }
    );
    Object.assign(trade, { status: 'verkauft', buyer: user._id, buyerName: user.username, taxPercent: settings.taxPercent, tax, closedAt: new Date() });
    await trade.save({ session });
    return { trade, tax, balance: buyer.balance };
  });
}

/** Verkäufer zieht zurück bzw. Empfänger lehnt ab – die Karte wird wieder frei */
async function close({ user, tradeId, action }) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  const who = action === 'ablehnen' ? { to: user._id } : { seller: user._id };
  const status = action === 'ablehnen' ? 'abgelehnt' : 'zurueckgezogen';
  const res = await Trade.updateOne({ _id: tradeId, status: 'offen', ...who }, { $set: { status, closedAt: new Date() } });
  if (res.modifiedCount !== 1) throw new UserError('Dieses Angebot gibt es nicht mehr.');
}

module.exports = { PRIVATE_HOURS, MARKET_DAYS, settings, loadSettings, saveSettings, taxFor, openFilter, incomingCount, marketNewFilter, marketNewCount, create, buy, close };

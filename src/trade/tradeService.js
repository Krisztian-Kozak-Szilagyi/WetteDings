const mongoose = require('mongoose');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgCard } = require('../models/Tcg');
const { Trade, TradeSettings, openFilter } = require('../models/Trade');
const { inTransaction } = require('../services/betService');
const { UserError } = require('../lib/util');
const catalog = require('../tcg/catalog');
const { lockedDocs, isLocked, claim } = require('../tcg/locks');
const { collection } = require('../tcg/collection');

const PRIVATE_HOURS = 48; // private Angebote und Tauschangebote laufen nach 48 Stunden ab
const MARKET_DAYS = 7; // Markt-Angebote nach 7 Tagen
const MAX_PRICE = 100000000; // 1 Mio. €
const MAX_OPEN = 20; // offene Angebote pro Person
const KINDS = ['markt', 'privat', 'tausch'];

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

/** Steuer in Cent (abgerundet), die dem Empfänger des Geldes abgezogen wird */
const taxFor = (price, percent = settings.taxPercent) => Math.floor((price * Math.min(100, Math.max(0, percent))) / 100);

const cardName = (id) => (catalog.cardById[id] ? catalog.cardById[id].name : id);

// ---------- Reine Regeln (ohne Datenbank, getestet) ----------
/**
 * Prüft ein neues Angebot. Verkauf: Preis ab 1 Cent. Tausch: andere Wunschkarte, Aufpreis ab 0 –
 * ist er größer als 0, muss feststehen, wer ihn zahlt. Gibt das bereinigte extraFrom zurück.
 */
function validateOffer({ kind, price, cardId, wantCardId, extraFrom }) {
  if (!KINDS.includes(kind)) throw new UserError('Unbekannte Angebotsart.');
  if (!catalog.cardById[cardId]) throw new UserError('Bitte wähle eine Karte aus.');
  if (kind !== 'tausch') {
    if (!Number.isInteger(price) || price < 1 || price > MAX_PRICE) throw new UserError('Bitte gib einen gültigen Preis an.');
    return { extraFrom: null };
  }
  if (!catalog.cardById[wantCardId]) throw new UserError('Bitte wähle die Karte aus, die du haben möchtest.');
  if (wantCardId === cardId) throw new UserError('Ein Tausch gegen dieselbe Karte ergibt keinen Sinn.');
  if (!Number.isInteger(price) || price < 0 || price > MAX_PRICE) throw new UserError('Bitte gib einen gültigen Aufpreis an.');
  if (price === 0) return { extraFrom: null };
  if (extraFrom !== 'seller' && extraFrom !== 'to') throw new UserError('Bitte wähle aus, wer den Aufpreis zahlt.');
  return { extraFrom };
}

/**
 * Geldfluss beim Abschluss: { payer, payee, amount, tax } – oder null bei einem Tausch ohne Aufpreis.
 * Verkauf: Käufer zahlt an den Verkäufer. Tausch: je nach extraFrom zahlt der Anbieter oder der Empfänger.
 * Die Steuer fällt nur auf das Geld an und wird dem abgezogen, der es bekommt.
 */
function settlement(trade, { buyer, taxPercent = settings.taxPercent } = {}) {
  if (!trade.price) return null;
  let payer = buyer;
  let payee = trade.seller;
  if (trade.kind === 'tausch') {
    [payer, payee] = trade.extraFrom === 'seller' ? [trade.seller, trade.to] : [trade.to, trade.seller];
  }
  return { payer, payee, amount: trade.price, tax: taxFor(trade.price, taxPercent) };
}

// ---------- Abfragen ----------
/** Offene Angebote an einen Nutzer – privat und Tausch (für das Abzeichen im Menü) */
const incomingFilter = (userId) => ({ ...openFilter(), to: userId });
const incomingCount = (userId) => Trade.countDocuments(incomingFilter(userId));

/** Offene Markt-Angebote anderer, die seit dem letzten Besuch der Handelsseite eingestellt wurden */
const marketNewFilter = (user) => ({
  ...openFilter(),
  kind: 'markt',
  seller: { $ne: user._id },
  createdAt: { $gt: user.marketSeenAt || user.createdAt },
});
const marketNewCount = (user) => Trade.countDocuments(marketNewFilter(user));

/** Alles für die Handelsseite: Angebote, eigene Sammlung, Verlauf, Mitglieder */
async function overview(user) {
  const me = user._id;
  const open = openFilter();
  const [incoming, market, mine, history, coll, users] = await Promise.all([
    Trade.find({ ...open, to: me }).sort({ createdAt: -1 }).lean(),
    Trade.find({ ...open, kind: 'markt', seller: { $ne: me } }).sort({ createdAt: -1 }).limit(200).lean(),
    Trade.find({ ...open, seller: me }).sort({ createdAt: -1 }).lean(),
    Trade.find({ status: 'verkauft', $or: [{ seller: me }, { buyer: me }] }).sort({ closedAt: -1 }).limit(10).lean(),
    collection(user),
    User.find({ _id: { $ne: me }, deletedAt: null }).select('username').sort({ usernameLower: 1 }).lean(),
  ]);
  return { incoming, market, mine, history, coll, users };
}

// ---------- Aktionen ----------
/** Ältestes freies Exemplar einer Karte (nicht auf einer Quest, nicht im Handel) – oder null */
async function freeCopy(userId, cardId, session) {
  const locked = await lockedDocs(userId, session);
  const docs = await TcgCard.find({ user: userId, card: cardId }).sort({ createdAt: 1 }).select('_id').session(session).lean();
  return { doc: docs.find((d) => !isLocked(locked, d)) || null, owned: docs.length };
}

/**
 * Angebot erstellen.
 * markt: für alle, privat: an toName gegen Geld, tausch: an toName gegen dessen Karte wantCardId (+ optional Aufpreis)
 */
async function create({ user, kind, cardId, price, toName, wantCardId = null, extraFrom = null }) {
  const valid = validateOffer({ kind, price, cardId, wantCardId, extraFrom });

  let to = null;
  if (kind !== 'markt') {
    if (!toName) throw new UserError('Bitte gib an, wem du das Angebot machen willst.');
    to = await User.findOne({ usernameLower: toName.trim().toLowerCase(), deletedAt: null }).select('_id username').lean();
    if (!to) throw new UserError('Diesen Benutzer gibt es nicht.');
    if (to._id.equals(user._id)) throw new UserError('Du kannst dir nicht selbst ein Angebot machen.');
  }
  if (kind === 'tausch' && !(await TcgCard.exists({ user: to._id, card: wantCardId }))) {
    throw new UserError(`${to.username} besitzt ${cardName(wantCardId)} nicht.`);
  }
  if ((await Trade.countDocuments({ ...openFilter(), seller: user._id })) >= MAX_OPEN) {
    throw new UserError(`Du hast schon ${MAX_OPEN} offene Angebote.`);
  }

  const hours = kind === 'markt' ? MARKET_DAYS * 24 : PRIVATE_HOURS;
  try {
    // Sperrprüfung und Angebot in einer Transaktion, damit die Karte nicht gleichzeitig verkauft oder auf eine Quest geschickt wird
    return await inTransaction(async (session) => {
      const { doc, owned } = await freeCopy(user._id, cardId, session);
      if (!doc) throw new UserError(owned ? 'Alle Exemplare dieser Karte sind gerade gesperrt (Quest oder Handel).' : 'Diese Karte besitzt du nicht.');
      await claim([doc], user._id, session);

      // abgelaufene Angebote für dieses Exemplar schließen, damit der eindeutige Index nicht blockiert
      await Trade.updateMany({ cardDoc: doc._id, status: 'offen', expiresAt: { $lte: new Date() } }, { $set: { status: 'zurueckgezogen', closedAt: new Date() } }, { session });

      const [trade] = await Trade.create(
        [
          {
            kind,
            seller: user._id,
            sellerName: user.username,
            to: to ? to._id : null,
            toName: to ? to.username : null,
            card: cardId,
            cardDoc: doc._id,
            wantCard: kind === 'tausch' ? wantCardId : null,
            extraFrom: valid.extraFrom,
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

/** Geld gemäß settlement bewegen und verbuchen; payerMsg ist die Meldung, wenn der Zahler zu wenig hat */
async function transfer(money, { title, payerType, payeeType, payerMsg }, session) {
  const payer = await User.findOneAndUpdate({ _id: money.payer, balance: { $gte: money.amount } }, { $inc: { balance: -money.amount } }, { new: true, session });
  if (!payer) throw new UserError(payerMsg);
  await User.updateOne({ _id: money.payee }, { $inc: { balance: money.amount - money.tax } }, { session });
  await Ledger.create(
    [
      { user: money.payer, type: payerType, amount: -money.amount, betTitle: title },
      { user: money.payee, type: payeeType, amount: money.amount - money.tax, betTitle: title },
    ],
    { session, ordered: true }
  );
}

/** Kaufen/Annehmen (Markt und privat): Käufer zahlt den Preis, Verkäufer bekommt Preis − Steuer, die Karte wechselt den Besitzer */
async function buy({ user, tradeId }) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  return inTransaction(async (session) => {
    const trade = await Trade.findOne({ _id: tradeId, ...openFilter() }).session(session);
    if (!trade) throw new UserError('Dieses Angebot gibt es nicht mehr.');
    if (trade.kind === 'tausch') throw new UserError('Ein Tauschangebot kann man nicht kaufen.');
    if (trade.seller.equals(user._id)) throw new UserError('Du kannst dein eigenes Angebot nicht kaufen.');
    if (trade.kind === 'privat' && !trade.to.equals(user._id)) throw new UserError('Dieses Angebot ist nicht für dich.');

    const money = settlement(trade, { buyer: user._id });
    await transfer(money, { title: cardName(trade.card), payerType: 'handel_kauf', payeeType: 'handel_verkauf', payerMsg: 'Dein Guthaben reicht dafür nicht aus.' }, session);

    const moved = await TcgCard.updateOne({ _id: trade.cardDoc, user: trade.seller }, { $set: { user: user._id } }, { session });
    if (moved.modifiedCount !== 1) throw new UserError('Die Karte ist nicht mehr verfügbar.');

    Object.assign(trade, { status: 'verkauft', buyer: user._id, buyerName: user.username, taxPercent: settings.taxPercent, tax: money.tax, closedAt: new Date() });
    await trade.save({ session });
    return { trade, tax: money.tax };
  });
}

/** Tausch annehmen: beide Karten wechseln den Besitzer, ein Aufpreis wird wie ein Verkauf (mit Steuer) gebucht */
async function acceptSwap({ user, tradeId }) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  return inTransaction(async (session) => {
    const trade = await Trade.findOne({ _id: tradeId, kind: 'tausch', to: user._id, ...openFilter() }).session(session);
    if (!trade) throw new UserError('Dieses Angebot gibt es nicht mehr.');

    // Die Wunschkarte wird erst jetzt gesperrt: freies Exemplar beim Empfänger suchen
    const { doc } = await freeCopy(user._id, trade.wantCard, session);
    if (!doc) throw new UserError(`Du hast gerade kein freies Exemplar von ${cardName(trade.wantCard)} (Quest oder Handel).`);
    await claim([doc], user._id, session);

    const money = settlement(trade);
    if (money) {
      const iPay = money.payer.equals(user._id);
      await transfer(
        money,
        {
          title: `${cardName(trade.card)} gegen ${cardName(trade.wantCard)}`,
          payerType: 'handel_tausch_zahlung',
          payeeType: 'handel_tausch_erhalt',
          payerMsg: iPay ? 'Dein Guthaben reicht für den Aufpreis nicht aus.' : `${trade.sellerName} hat nicht mehr genug Guthaben für den Aufpreis.`,
        },
        session
      );
    }

    const given = await TcgCard.updateOne({ _id: trade.cardDoc, user: trade.seller }, { $set: { user: user._id } }, { session });
    const taken = await TcgCard.updateOne({ _id: doc._id, user: user._id }, { $set: { user: trade.seller } }, { session });
    if (given.modifiedCount !== 1 || taken.modifiedCount !== 1) throw new UserError('Eine der Karten ist nicht mehr verfügbar.');

    Object.assign(trade, {
      status: 'verkauft',
      buyer: user._id,
      buyerName: user.username,
      wantCardDoc: doc._id,
      taxPercent: settings.taxPercent,
      tax: money ? money.tax : 0,
      closedAt: new Date(),
    });
    await trade.save({ session });
    return { trade, money };
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

module.exports = {
  PRIVATE_HOURS,
  MARKET_DAYS,
  MAX_PRICE,
  settings,
  loadSettings,
  saveSettings,
  taxFor,
  validateOffer,
  settlement,
  openFilter,
  incomingFilter,
  incomingCount,
  marketNewFilter,
  marketNewCount,
  overview,
  create,
  buy,
  acceptSwap,
  close,
};

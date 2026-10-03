const mongoose = require('mongoose');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgCard } = require('../models/Tcg');
const { Trade, TradeSettings, openFilter } = require('../models/Trade');
const { inTransaction } = require('../services/betService');
const { UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');
const catalog = require('../tcg/catalog');
const { lockedDocs, isLocked, claim } = require('../tcg/locks');
const { collection } = require('../tcg/collection');
const { markSeen } = require('../tcg/tcgService');
const { logSettingsChange } = require('../stats/settingsLog');
const { notify } = require('../services/notifyService');

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
  const before = { ...settings };
  settings.taxPercent = taxPercent;
  await logSettingsChange({ area: 'handel', before, after: settings, by: admin });
}

/** Steuer in Cent (abgerundet), die dem Empfänger des Geldes abgezogen wird */
const taxFor = (price, percent = settings.taxPercent) => Math.floor((price * Math.min(100, Math.max(0, percent))) / 100);

const cardName = (id) => (catalog.cardById[id] ? catalog.cardById[id].name : id);
const swapHref = (trade) => `/handel/verhandlung/${trade._id}`;

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

// ---------- Verhandlung beim Tausch (reine Regeln) ----------
const MESSAGE_MAX = 500; // Zeichen pro Nachricht
const MAX_MESSAGES = 200; // ältere Nachrichten fallen weg
const MESSAGES_PER_MINUTE = 8;

/** Rolle eines Nutzers in einem Angebot: 'seller' (Anbieter), 'to' (Empfänger) oder null */
const roleOf = (trade, userId) => (String(trade.seller) === String(userId) ? 'seller' : trade.to && String(trade.to) === String(userId) ? 'to' : null);
const otherRole = (role) => (role === 'seller' ? 'to' : 'seller');

/** Darf diese Rolle annehmen? Beim Tausch nur, wer die aktuellen Bedingungen nicht selbst gesetzt hat. */
const canAccept = (trade, role) => (trade.kind === 'tausch' ? role !== null && role !== (trade.lastChangeBy || 'seller') : role === 'to');

/** Ungelesene Aktivität (Nachricht oder Gegenvorschlag) für diese Rolle? */
const isUnread = (trade, role) => {
  const seen = role === 'seller' ? trade.sellerSeenAt : trade.toSeenAt;
  return !!trade.activityAt && (!seen || new Date(trade.activityAt) > new Date(seen));
};

/** Nachricht bereinigen und prüfen: nicht leer, höchstens MESSAGE_MAX Zeichen, keine Leerzeilen-Wüsten */
function cleanMessage(input) {
  const text = String(input || '').trim().replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  if (!text) throw new UserError('Die Nachricht ist leer.');
  if (text.length > MESSAGE_MAX) throw new UserError(`Eine Nachricht darf höchstens ${MESSAGE_MAX} Zeichen lang sein.`);
  return text;
}

/** Bedingungen als Satz, z. B. "anna legt 5,00 € drauf" oder "ohne Aufpreis" */
function termsText(trade, { price = trade.price, extraFrom = trade.extraFrom } = {}) {
  if (!price) return 'ohne Aufpreis';
  return `${extraFrom === 'seller' ? trade.sellerName : trade.toName} legt ${euro(price)} drauf`;
}

// ---------- Abfragen ----------
/**
 * Angebote, um die ich mich kümmern sollte (für das Abzeichen im Menü):
 * private Angebote an mich und Tauschangebote, bei denen ich am Zug bin oder etwas Neues steht.
 */
const incomingFilter = (userId) => ({
  ...openFilter(),
  $or: [
    { to: userId, kind: 'privat' },
    { to: userId, kind: 'tausch', $or: [{ lastChangeBy: { $ne: 'to' } }, { $expr: { $gt: ['$activityAt', '$toSeenAt'] } }] },
    { seller: userId, kind: 'tausch', $or: [{ lastChangeBy: 'to' }, { $expr: { $gt: ['$activityAt', '$sellerSeenAt'] } }] },
  ],
});
const incomingCount = (userId) => Trade.countDocuments(incomingFilter(userId));

/**
 * Abgeschlossene Geschäfte, über die ein Mitglied noch nicht Bescheid weiß: Jemand anderes hat seine
 * Karte gekauft oder seinen Tausch-Vorschlag angenommen (closedBy ist die handelnde Seite).
 */
const newDealsFilter = (user) => ({
  status: 'verkauft',
  $or: [{ seller: user._id }, { buyer: user._id }],
  closedBy: { $nin: [null, user._id] },
  closedAt: { $gt: user.dealsSeenAt || user.createdAt },
});
const newDealsCount = (user) => Trade.countDocuments(newDealsFilter(user));

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
    Trade.find({ ...open, to: me }).select('-messages').sort({ createdAt: -1 }).lean(),
    Trade.find({ ...open, kind: 'markt', seller: { $ne: me } }).sort({ createdAt: -1 }).limit(200).lean(),
    Trade.find({ ...open, seller: me }).select('-messages').sort({ createdAt: -1 }).lean(),
    Trade.find({ status: 'verkauft', $or: [{ seller: me }, { buyer: me }] }).select('-messages').sort({ closedAt: -1 }).limit(15).lean(),
    collection(user),
    User.find({ _id: { $ne: me }, deletedAt: null }).select('username').sort({ usernameLower: 1 }).lean(),
  ]);
  // neu für dieses Mitglied: von der anderen Seite abgeschlossen, seit dem letzten Besuch
  const seen = user.dealsSeenAt || user.createdAt;
  const isNewDeal = (t) => !!t.closedBy && String(t.closedBy) !== String(me) && t.closedAt > seen;
  const deals = history.map((t) => ({ ...t, isNew: isNewDeal(t) }));
  return { incoming, market, mine, history: deals, newDeals: deals.filter((t) => t.isNew), coll, users };
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
async function create({ user, kind, cardId, price, toName, wantCardId = null, extraFrom = null, message = '' }) {
  const valid = validateOffer({ kind, price, cardId, wantCardId, extraFrom });
  // Beim Tausch kann gleich eine erste Nachricht mitgeschickt werden
  const firstMessage = kind === 'tausch' && String(message || '').trim() ? cleanMessage(message) : null;

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
    const created = await inTransaction(async (session) => {
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
            ...(kind === 'tausch' && {
              lastChangeBy: 'seller',
              activityAt: new Date(),
              sellerSeenAt: new Date(),
              messages: firstMessage ? [{ from: 'seller', text: firstMessage }] : [],
            }),
          },
        ],
        { session }
      );
      return trade;
    });
    if (kind === 'privat') {
      await notify(to._id, { area: 'Handel', href: '/handel', text: `${user.username} bietet dir „${cardName(cardId)}“ für ${euro(price)} an.` });
    } else if (kind === 'tausch') {
      await notify(to._id, { area: 'Handel', href: swapHref(created), text: `${user.username} möchte „${cardName(cardId)}“ gegen deine „${cardName(wantCardId)}“ tauschen (${termsText(created)}).` });
    }
    return created;
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
  const result = await inTransaction(async (session) => {
    const trade = await Trade.findOne({ _id: tradeId, ...openFilter() }).session(session);
    if (!trade) throw new UserError('Dieses Angebot gibt es nicht mehr.');
    if (trade.kind === 'tausch') throw new UserError('Ein Tauschangebot kann man nicht kaufen.');
    if (trade.seller.equals(user._id)) throw new UserError('Du kannst dein eigenes Angebot nicht kaufen.');
    if (trade.kind === 'privat' && !trade.to.equals(user._id)) throw new UserError('Dieses Angebot ist nicht für dich.');

    const money = settlement(trade, { buyer: user._id });
    await transfer(money, { title: cardName(trade.card), payerType: 'handel_kauf', payeeType: 'handel_verkauf', payerMsg: 'Dein Guthaben reicht dafür nicht aus.' }, session);

    const moved = await TcgCard.updateOne({ _id: trade.cardDoc, user: trade.seller }, { $set: { user: user._id } }, { session });
    if (moved.modifiedCount !== 1) throw new UserError('Die Karte ist nicht mehr verfügbar.');
    await markSeen(user._id, [trade.card], session);

    Object.assign(trade, { status: 'verkauft', buyer: user._id, buyerName: user.username, closedBy: user._id, taxPercent: settings.taxPercent, tax: money.tax, closedAt: new Date() });
    await trade.save({ session });
    return { trade, tax: money.tax };
  });
  const { trade } = result;
  await notify(trade.seller, { area: 'Handel', href: '/handel', text: `${user.username} hat deine Karte „${cardName(trade.card)}“ für ${euro(trade.price)} gekauft.` });
  return result;
}

/**
 * Tausch annehmen: beide Karten wechseln den Besitzer, ein Aufpreis wird wie ein Verkauf (mit Steuer) gebucht.
 * Annehmen darf, wer die aktuellen Bedingungen nicht selbst gesetzt hat – also auch der Anbieter nach einem
 * Gegenvorschlag. version = Stand der Bedingungen, den der Annehmende gesehen hat.
 */
async function acceptSwap({ user, tradeId, version }) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  const result = await inTransaction(async (session) => {
    const trade = await Trade.findOne({ _id: tradeId, kind: 'tausch', ...openFilter() }).session(session);
    const role = trade && roleOf(trade, user._id);
    if (!role) throw new UserError('Dieses Angebot gibt es nicht mehr.');
    if (!canAccept(trade, role)) throw new UserError('Das ist dein eigener Vorschlag – jetzt ist die andere Seite am Zug.');
    if (Number.isInteger(version) && version !== trade.termsVersion) {
      throw new UserError('Die Bedingungen wurden gerade geändert. Bitte schau sie dir noch einmal an.');
    }

    // Die Wunschkarte wird erst jetzt gesperrt: freies Exemplar beim Empfänger suchen
    const { doc } = await freeCopy(trade.to, trade.wantCard, session);
    if (!doc) {
      throw new UserError(role === 'to'
        ? `Du hast gerade kein freies Exemplar von ${cardName(trade.wantCard)} (Quest oder Handel).`
        : `${trade.toName} hat gerade kein freies Exemplar von ${cardName(trade.wantCard)} (Quest oder Handel).`);
    }
    await claim([doc], trade.to, session);

    const money = settlement(trade);
    if (money) {
      const iPay = money.payer.equals(user._id);
      const other = role === 'to' ? trade.sellerName : trade.toName;
      await transfer(
        money,
        {
          title: `${cardName(trade.card)} gegen ${cardName(trade.wantCard)}`,
          payerType: 'handel_tausch_zahlung',
          payeeType: 'handel_tausch_erhalt',
          payerMsg: iPay ? 'Dein Guthaben reicht für den Aufpreis nicht aus.' : `${other} hat nicht mehr genug Guthaben für den Aufpreis.`,
        },
        session
      );
    }

    const given = await TcgCard.updateOne({ _id: trade.cardDoc, user: trade.seller }, { $set: { user: trade.to } }, { session });
    const taken = await TcgCard.updateOne({ _id: doc._id, user: trade.to }, { $set: { user: trade.seller } }, { session });
    if (given.modifiedCount !== 1 || taken.modifiedCount !== 1) throw new UserError('Eine der Karten ist nicht mehr verfügbar.');
    await markSeen(trade.to, [trade.card], session);
    await markSeen(trade.seller, [trade.wantCard], session);

    Object.assign(trade, {
      status: 'verkauft',
      buyer: trade.to, // beim Tausch immer der Empfänger, egal wer zuletzt angenommen hat
      buyerName: trade.toName,
      closedBy: user._id, // wer angenommen hat
      wantCardDoc: doc._id,
      taxPercent: settings.taxPercent,
      tax: money ? money.tax : 0,
      closedAt: new Date(),
    });
    await trade.save({ session });
    return { trade, money, role };
  });
  const { trade, role } = result;
  // die andere Seite: Was bekommt sie?
  const [other, gets, gives] = role === 'to' ? [trade.seller, trade.wantCard, trade.card] : [trade.to, trade.card, trade.wantCard];
  await notify(other, { area: 'Handel', href: swapHref(trade), text: `${user.username} hat den Tausch angenommen: Du bekommst „${cardName(gets)}“ für „${cardName(gives)}“.` });
  return result;
}

// ---------- Verhandlung beim Tausch ----------
const seenField = (role) => (role === 'seller' ? 'sellerSeenAt' : 'toSeenAt');

/** Verhandlung öffnen (nur die beiden Beteiligten); markiert sie als gelesen */
async function negotiation({ user, tradeId }) {
  if (!mongoose.isValidObjectId(tradeId)) return null;
  const trade = await Trade.findOne({ _id: tradeId, kind: 'tausch' }).lean();
  const role = trade && roleOf(trade, user._id);
  if (!role) return null;
  await Trade.updateOne({ _id: trade._id }, { $set: { [seenField(role)]: new Date() } });
  return { trade, role };
}

/** Offenes Tauschangebot laden, an dem der Nutzer beteiligt ist */
async function openSwapFor(user, tradeId) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  const trade = await Trade.findOne({ _id: tradeId, kind: 'tausch', ...openFilter() }).select('-messages.text').lean();
  const role = trade && roleOf(trade, user._id);
  if (!role) throw new UserError('Dieses Angebot ist nicht mehr offen.');
  return { trade, role };
}

/** Nachricht in der Verhandlung schreiben */
async function sendMessage({ user, tradeId, text }) {
  const clean = cleanMessage(text);
  const { trade, role } = await openSwapFor(user, tradeId);
  const since = Date.now() - 60000;
  if ((trade.messages || []).filter((m) => m.from === role && new Date(m.createdAt) > since).length >= MESSAGES_PER_MINUTE) {
    throw new UserError('Du schreibst gerade sehr schnell – bitte warte einen Moment.');
  }
  const now = new Date();
  const res = await Trade.updateOne(
    { _id: trade._id, ...openFilter() },
    { $push: { messages: { $each: [{ from: role, text: clean }], $slice: -MAX_MESSAGES } }, $set: { activityAt: now, [seenField(role)]: now } }
  );
  if (res.modifiedCount !== 1) throw new UserError('Dieses Angebot ist nicht mehr offen.');
  const card = cardName(trade.card);
  await notify(role === 'seller' ? trade.to : trade.seller, {
    area: 'Handel',
    href: swapHref(trade),
    key: `handel:${trade._id}:nachricht`,
    text: `${user.username} hat dir in der Verhandlung um „${card}“ geschrieben.`,
    many: (n) => `${n} neue Nachrichten in der Verhandlung um „${card}“.`,
  });
}

/**
 * Gegenvorschlag: Aufpreis und wer ihn zahlt ändern. Danach ist die andere Seite am Zug, das Angebot
 * läuft wieder volle PRIVATE_HOURS. version = Stand, den der Ändernde gesehen hat (sonst Konflikt).
 */
async function changeTerms({ user, tradeId, price, extraFrom, version }) {
  const { trade, role } = await openSwapFor(user, tradeId);
  const valid = validateOffer({ kind: 'tausch', price, cardId: trade.card, wantCardId: trade.wantCard, extraFrom });
  if (price === trade.price && valid.extraFrom === (trade.price ? trade.extraFrom : null)) {
    throw new UserError('Das sind schon die aktuellen Bedingungen.');
  }
  const now = new Date();
  const actor = role === 'seller' ? trade.sellerName : trade.toName;
  const seen = Number.isInteger(version) ? version : trade.termsVersion || 0;
  const res = await Trade.updateOne(
    // Ältere Angebote haben noch kein termsVersion-Feld – das zählt als Stand 0
    { _id: trade._id, ...openFilter(), termsVersion: { $in: seen === 0 ? [0, null] : [seen] } },
    {
      $set: {
        price,
        extraFrom: valid.extraFrom,
        lastChangeBy: role,
        activityAt: now,
        [seenField(role)]: now,
        expiresAt: new Date(now.getTime() + PRIVATE_HOURS * 3600000),
      },
      $inc: { termsVersion: 1 },
      $push: { messages: { $each: [{ from: 'system', text: `${actor} schlägt vor: ${termsText(trade, { price, extraFrom: valid.extraFrom })}.` }], $slice: -MAX_MESSAGES } },
    }
  );
  if (res.modifiedCount !== 1) throw new UserError('Die Bedingungen wurden gerade geändert. Bitte schau sie dir noch einmal an.');
  await notify(role === 'seller' ? trade.to : trade.seller, {
    area: 'Handel',
    href: swapHref(trade),
    text: `${actor} macht einen Gegenvorschlag zum Tausch um „${cardName(trade.card)}“: ${termsText(trade, { price, extraFrom: valid.extraFrom })}.`,
  });
}

/** Verkäufer zieht zurück bzw. Empfänger lehnt ab – die Karte wird wieder frei */
async function close({ user, tradeId, action }) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  const who = action === 'ablehnen' ? { to: user._id } : { seller: user._id };
  const status = action === 'ablehnen' ? 'abgelehnt' : 'zurueckgezogen';
  const trade = await Trade.findOneAndUpdate({ _id: tradeId, status: 'offen', ...who }, { $set: { status, closedAt: new Date() } }).select('kind seller to card expiresAt').lean();
  if (!trade) throw new UserError('Dieses Angebot gibt es nicht mehr.');
  if (action === 'ablehnen') {
    await notify(trade.seller, { area: 'Handel', href: '/handel', text: `${user.username} hat dein Angebot „${cardName(trade.card)}“ abgelehnt.` });
  } else if (trade.to && trade.expiresAt > new Date()) {
    await notify(trade.to, { area: 'Handel', href: '/handel', text: `${user.username} hat das Angebot „${cardName(trade.card)}“ zurückgezogen.` });
  }
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
  MESSAGE_MAX,
  roleOf,
  otherRole,
  canAccept,
  isUnread,
  cleanMessage,
  termsText,
  incomingFilter,
  incomingCount,
  newDealsFilter,
  newDealsCount,
  marketNewFilter,
  marketNewCount,
  overview,
  create,
  buy,
  acceptSwap,
  negotiation,
  sendMessage,
  changeTerms,
  close,
};

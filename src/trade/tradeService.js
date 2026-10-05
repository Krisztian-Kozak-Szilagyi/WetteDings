const mongoose = require('mongoose');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgCard } = require('../models/Tcg');
const { Item } = require('../models/Item');
const { itemByCardId, freeItems, claimItems, logItems } = require('../items/itemService');
const { Trade, TradeTalk, openFilter } = require('../models/Trade');
const { inTransaction } = require('../services/betService');
const { UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');
const catalog = require('../tcg/catalog');
const { lockedDocs, isLocked, claim } = require('../tcg/locks');
const { collection } = require('../tcg/collection');
const { markSeen } = require('../tcg/tcgService');
const taxService = require('../services/taxService');
const { notify } = require('../services/notifyService');

const PRIVATE_HOURS = 48; // private Angebote und Tauschangebote laufen nach 48 Stunden ab
const MARKET_DAYS = 7; // Markt-Angebote nach 7 Tagen
const MAX_PRICE = 100000000; // 1 Mio. €
const MAX_OPEN = 20; // offene Angebote pro Person
const MAX_TALKS = 30; // offene Gespräche über Markt-Angebote pro Interessent
const MAX_SWAP_CARDS = 5; // Karten pro Seite eines Tauschs (#76)
const KINDS = ['markt', 'privat', 'tausch'];

// ---------- Steuer (Sätze je Angebotsart im Admin-Panel, siehe services/taxService) ----------
/** Steuer in Cent (abgerundet), die dem Empfänger des Geldes abgezogen wird */
const taxFor = (price, percent = 0) => taxService.taxFor(price, percent);
/** Steuer auf einen Betrag nach dem aktuellen Satz der Angebotsart (markt, privat, tausch) */
const taxOf = (price, kind) => taxFor(price, taxService.rate(kind));
/** Aktuelle Sätze der drei Angebotsarten, z. B. für die Anzeige */
const taxRates = () => ({ markt: taxService.rate('markt'), privat: taxService.rate('privat'), tausch: taxService.rate('tausch') });

const cardName = (id) => {
  const item = itemByCardId(id);
  return item ? item.label : catalog.cardById[id] ? catalog.cardById[id].name : id;
};
const swapHref = (trade) => `/handel/verhandlung/${trade._id}`;
const talkHref = (talk) => `/handel/gespraech/${talk._id}`;

// ---------- Reine Regeln (ohne Datenbank, getestet) ----------
/**
 * Prüft ein neues Angebot. Verkauf: Preis ab 1 Cent. Tausch: andere Wunschkarte, Aufpreis ab 0 –
 * ist er größer als 0, muss feststehen, wer ihn zahlt. Gibt das bereinigte extraFrom zurück.
 */
function validateOffer({ kind, price, cardId, wantCardId, extraFrom, give, take }) {
  if (!KINDS.includes(kind)) throw new UserError('Unbekannte Angebotsart.');
  if (kind === 'tausch') {
    // ohne give/take: ein Tausch 1 gegen 1 (cardId gegen wantCardId)
    validateSwap(give || [{ card: cardId }], take || (wantCardId ? [{ card: wantCardId }] : []));
  } else if (!catalog.cardById[cardId] && !itemByCardId(cardId)) {
    throw new UserError('Bitte wähle eine Karte aus.');
  }
  if (kind !== 'tausch') {
    if (!Number.isInteger(price) || price < 1 || price > MAX_PRICE) throw new UserError('Bitte gib einen gültigen Preis an.');
    return { extraFrom: null };
  }
  if (!Number.isInteger(price) || price < 0 || price > MAX_PRICE) throw new UserError('Bitte gib einen gültigen Aufpreis an.');
  if (price === 0) return { extraFrom: null };
  if (extraFrom !== 'seller' && extraFrom !== 'to') throw new UserError('Bitte wähle aus, wer den Aufpreis zahlt.');
  return { extraFrom };
}

/**
 * Karten eines Tauschs prüfen (#76): je Seite 1 bis MAX_SWAP_CARDS Karten aus dem Katalog (keine Gegenstände),
 * ein foliertes Exemplar höchstens einmal, und beide Seiten nicht genau gleich.
 */
function validateSwap(give, take) {
  const isItem = (l) => !!itemByCardId(l && l.card);
  if ([...give, ...take].some(isItem)) throw new UserError('Gegenstände kann man verkaufen, aber nicht tauschen.');
  if (!give.length || give.some((l) => !catalog.cardById[l.card])) throw new UserError('Bitte wähle eine Karte aus.');
  if (!take.length || take.some((l) => !catalog.cardById[l.card])) throw new UserError('Bitte wähle die Karte aus, die du haben möchtest.');
  if (give.length > MAX_SWAP_CARDS || take.length > MAX_SWAP_CARDS) throw new UserError(`Höchstens ${MAX_SWAP_CARDS} Karten pro Seite.`);
  for (const side of [give, take]) {
    const copies = side.filter((l) => l.copy).map((l) => String(l.copy));
    if (new Set(copies).size !== copies.length) throw new UserError('Ein foliertes Exemplar kann nur einmal im Tausch stehen.');
  }
  const key = (side) => side.map((l) => l.card + (l.copy ? ':' + l.copy : '')).sort().join('|');
  if (key(give) === key(take)) throw new UserError('Ein Tausch gegen dieselbe Karte ergibt keinen Sinn.');
}

/**
 * Beide Seiten eines Tauschs: { give: Karten des Anbieters, take: Karten des Empfängers } – neue Angebote mit
 * give/take, alte mit je einer Karte (card/cardDoc bzw. wantCard/wantCopy). Bei alten steht doc = gesperrtes Exemplar.
 */
function swapSides(t) {
  if (t.give && t.give.length) return { give: t.give, take: t.take || [] };
  return {
    give: [{ card: t.card, copy: t.foiledAt ? t.cardDoc : null, doc: t.cardDoc, foiledAt: t.foiledAt || null, grade: t.grade || null }],
    take: t.wantCard ? [{ card: t.wantCard, copy: t.wantCopy || null, foiledAt: t.wantFoiledAt || null, grade: t.wantGrade || null }] : [],
  };
}

/** Karten einer Seite als Text, z. B. "Krisz, 2× Pascal, Ivan (foliert)" */
function sideText(lines) {
  const parts = [];
  const counts = new Map();
  for (const l of lines) {
    if (l.copy) parts.push(`${cardName(l.card)} (foliert)`);
    else counts.set(l.card, (counts.get(l.card) || 0) + 1);
  }
  return [...[...counts].map(([card, n]) => (n > 1 ? `${n}× ${cardName(card)}` : cardName(card))), ...parts].join(', ');
}

/** Tausch als Satz aus Sicht des Anbieters: "A, B gegen C" */
const swapText = (t) => {
  const { give, take } = swapSides(t);
  return `${sideText(give)} gegen ${sideText(take)}`;
};

/**
 * Geldfluss beim Abschluss: { payer, payee, amount, tax } – oder null bei einem Tausch ohne Aufpreis.
 * Verkauf: Käufer zahlt an den Verkäufer. Tausch: je nach extraFrom zahlt der Anbieter oder der Empfänger.
 * Die Steuer fällt nur auf das Geld an und wird dem abgezogen, der es bekommt.
 */
function settlement(trade, { buyer, taxPercent = taxService.rate(trade.kind) } = {}) {
  if (!trade.price) return null;
  let payer = buyer;
  let payee = trade.seller;
  if (trade.kind === 'tausch') {
    [payer, payee] = trade.extraFrom === 'seller' ? [trade.seller, trade.to] : [trade.to, trade.seller];
  }
  return { payer, payee, amount: trade.price, tax: taxFor(trade.price, taxPercent) };
}

// ---------- Verhandlung (reine Regeln) ----------
// Verhandelt wird beim Tausch, beim privaten Verkauf und in Gesprächen über Markt-Angebote (talk: true, #82).
const MESSAGE_MAX = 500; // Zeichen pro Nachricht
const MAX_MESSAGES = 200; // ältere Nachrichten fallen weg
const MESSAGES_PER_MINUTE = 8;

/** Rolle eines Nutzers in einem Angebot: 'seller' (Anbieter), 'to' (Empfänger) oder null */
const roleOf = (trade, userId) => (String(trade.seller) === String(userId) ? 'seller' : trade.to && String(trade.to) === String(userId) ? 'to' : null);
const otherRole = (role) => (role === 'seller' ? 'to' : 'seller');

/** Wird über dieses Angebot (oder Gespräch) verhandelt? */
const negotiable = (trade) => trade.kind === 'tausch' || trade.kind === 'privat' || !!trade.talk;
/** Darf diese Rolle annehmen? In einer Verhandlung nur, wer die aktuellen Bedingungen nicht selbst gesetzt hat. */
const canAccept = (trade, role) => (negotiable(trade) ? !!role && role !== (trade.lastChangeBy || 'seller') : role === 'to');

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

/** Bedingungen als Satz, z. B. "anna legt 5,00 € drauf" oder "ohne Aufpreis"; beim Verkauf nur der Preis */
function termsText(trade, { price = trade.price, extraFrom = trade.extraFrom } = {}) {
  if (trade.kind && trade.kind !== 'tausch') return euro(price);
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
    { to: userId, kind: { $in: ['privat', 'tausch'] }, $or: [{ lastChangeBy: { $ne: 'to' } }, { $expr: { $gt: ['$activityAt', '$toSeenAt'] } }] },
    { seller: userId, kind: { $in: ['privat', 'tausch'] }, $or: [{ lastChangeBy: 'to' }, { $expr: { $gt: ['$activityAt', '$sellerSeenAt'] } }] },
  ],
});
/**
 * Gespräche über Markt-Angebote, um die ich mich kümmern sollte: als Anbieter, wenn der Interessent etwas
 * vorgeschlagen oder geschrieben hat; als Interessent, wenn der Anbieter einen Gegenvorschlag gemacht oder geschrieben hat.
 */
const talkAttentionFilter = (userId) => ({
  status: 'offen',
  expiresAt: { $gt: new Date() },
  $or: [
    { seller: userId, $or: [{ lastChangeBy: 'to' }, { $expr: { $gt: ['$activityAt', '$sellerSeenAt'] } }] },
    { to: userId, $or: [{ lastChangeBy: 'seller', termsVersion: { $gt: 0 } }, { $expr: { $gt: ['$activityAt', '$toSeenAt'] } }] },
  ],
});
const incomingCount = async (userId) => {
  const [offers, talks] = await Promise.all([Trade.countDocuments(incomingFilter(userId)), TradeTalk.countDocuments(talkAttentionFilter(userId))]);
  return offers + talks;
};

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
  const talkOpen = { status: 'offen', expiresAt: { $gt: new Date() } };
  const [incoming, market, mine, history, coll, users, myTalks, talksOnMine] = await Promise.all([
    Trade.find({ ...open, to: me }).select('-messages').sort({ createdAt: -1 }).lean(),
    Trade.find({ ...open, kind: 'markt', seller: { $ne: me } }).sort({ createdAt: -1 }).limit(200).lean(),
    Trade.find({ ...open, seller: me }).select('-messages').sort({ createdAt: -1 }).lean(),
    Trade.find({ status: 'verkauft', $or: [{ seller: me }, { buyer: me }] }).select('-messages').sort({ closedAt: -1 }).limit(15).lean(),
    collection(user),
    User.find({ _id: { $ne: me }, deletedAt: null }).select('username').sort({ usernameLower: 1 }).lean(),
    TradeTalk.find({ ...talkOpen, to: me }).select('-messages').lean(), // meine Gespräche als Interessent
    TradeTalk.find({ ...talkOpen, seller: me }).select('-messages').sort({ activityAt: -1 }).lean(), // Gespräche über meine Markt-Angebote
  ]);
  // neu für dieses Mitglied: von der anderen Seite abgeschlossen, seit dem letzten Besuch
  const seen = user.dealsSeenAt || user.createdAt;
  const isNewDeal = (t) => !!t.closedBy && String(t.closedBy) !== String(me) && t.closedAt > seen;
  const deals = history.map((t) => ({ ...t, isNew: isNewDeal(t) }));
  // Gespräche je Angebot: mein eigenes (Interessent) und alle über meine Angebote (Anbieter)
  const myTalkByTrade = Object.fromEntries(myTalks.map((t) => [String(t.trade), { ...t, talk: true, kind: 'markt' }]));
  const talksByTrade = {};
  for (const t of talksOnMine) (talksByTrade[String(t.trade)] = talksByTrade[String(t.trade)] || []).push({ ...t, talk: true, kind: 'markt' });
  return { incoming, market, mine, history: deals, newDeals: deals.filter((t) => t.isNew), coll, users, myTalkByTrade, talksByTrade };
}

// ---------- Aktionen ----------
/** Ältestes freies Exemplar einer Karte (nicht auf einer Quest, nicht im Handel) – oder null */
async function freeCopy(userId, cardId, session) {
  const locked = await lockedDocs(userId, session);
  const docs = await TcgCard.find({ user: userId, card: cardId }).sort({ createdAt: 1 }).select('_id').session(session).lean();
  return { doc: docs.find((d) => !isLocked(locked, d)) || null, owned: docs.length };
}

/**
 * Exemplare für eine Tausch-Seite beim Annehmen auswählen (in der Transaktion): bestimmte folierte Exemplare
 * (copy) bzw. bei alten Angeboten das gesperrte (doc), sonst die ältesten freien, unfolierten. Wirft eine Meldung
 * aus Sicht des Annehmenden (mine = es sind seine eigenen Karten). Gibt die Exemplar-IDs zurück.
 */
async function pickSwapCopies({ owner, ownerName, lines, mine, legacyDoc, session }) {
  const locked = await lockedDocs(owner, session);
  const chosen = [];
  const taken = new Set();
  const fail = (text) => {
    throw new UserError(mine ? `Du hast ${text}` : `${ownerName} hat ${text}`);
  };
  for (const l of lines.filter((x) => x.copy || x.doc)) {
    const id = String(l.copy || l.doc);
    const own = await TcgCard.findOne({ _id: id, user: owner }).select('_id foiledAt').session(session).lean();
    const reason = locked.reasons.get(id);
    // altes Angebot: das Exemplar ist durch genau dieses Angebot gesperrt – das ist in Ordnung
    const ok = own && (legacyDoc && id === String(legacyDoc) ? reason === 'handel' : !!own.foiledAt && reason === 'folie');
    if (!ok) fail(`${cardName(l.card)} (foliert) gerade nicht frei (im Handel, Duell) oder nicht mehr foliert.`);
    chosen.push(own._id);
    taken.add(id);
  }
  const need = {};
  for (const l of lines.filter((x) => !x.copy && !x.doc)) need[l.card] = (need[l.card] || 0) + 1;
  for (const [card, n] of Object.entries(need)) {
    const docs = await TcgCard.find({ user: owner, card, foiledAt: null }).sort({ createdAt: 1 }).select('_id').session(session).lean();
    const free = docs.filter((d) => !isLocked(locked, d) && !taken.has(String(d._id))).slice(0, n);
    if (free.length < n) fail(`gerade ${n > 1 ? 'nicht ' + n + ' freie Exemplare' : 'kein freies Exemplar'} von ${cardName(card)} (Quest, Handel oder foliert).`);
    free.forEach((d) => chosen.push(d._id));
  }
  return chosen;
}

/** Ein bestimmtes foliertes Exemplar (aus dem Inventar), sofern es nicht schon im Handel ist */
async function foiledCopy(userId, cardId, copyId, session) {
  if (!mongoose.isValidObjectId(copyId)) throw new UserError('Diese folierte Karte gibt es nicht.');
  const doc = await TcgCard.findOne({ _id: copyId, user: userId, card: cardId, foiledAt: { $ne: null } }).select('_id foiledAt condition.grade').session(session).lean();
  if (!doc) throw new UserError('Diese folierte Karte besitzt du nicht (mehr).');
  if ((await lockedDocs(userId, session)).reasons.get(String(doc._id)) !== 'folie') throw new UserError('Diese Karte ist schon im Handel.');
  return { doc, owned: 1 };
}

/**
 * Angebot erstellen.
 * markt: für alle, privat: an toName gegen Geld, tausch: an toName gegen dessen Karte wantCardId (+ optional Aufpreis).
 * copyId: ein bestimmtes foliertes Exemplar anbieten (sonst das älteste freie, unfolierte; cardId ergibt sich dann daraus).
 * wantCopy: beim Tausch ein bestimmtes foliertes Exemplar des Empfängers haben wollen (wantCardId ergibt sich daraus).
 * Gegenstände: cardId = "item:<Art>" (itemService.itemCardId) – angeboten wird das älteste freie Stück.
 */
/**
 * Rohe Auswahl einer Tausch-Seite in Karten-Zeilen umwandeln: [{ card }] oder [{ copy }] (foliertes Exemplar des
 * Besitzers). Prüft, dass der Besitzer die Karten hat (frei sein müssen sie erst beim Annehmen).
 */
async function resolveSwapLines(raw, owner, ownerName, mine) {
  const lines = [];
  for (const r of raw) {
    if (r.copy) {
      if (!mongoose.isValidObjectId(r.copy)) throw new UserError('Diese folierte Karte gibt es nicht.');
      const doc = await TcgCard.findOne({ _id: r.copy, user: owner._id, foiledAt: { $ne: null } }).select('card foiledAt condition.grade').lean();
      if (!doc) throw new UserError(mine ? 'Diese folierte Karte besitzt du nicht (mehr).' : `${ownerName} besitzt diese folierte Karte nicht (mehr).`);
      lines.push({ card: doc.card, copy: doc._id, foiledAt: doc.foiledAt, grade: doc.condition ? doc.condition.grade : null });
    } else {
      lines.push({ card: r.card, copy: null, foiledAt: null, grade: null });
    }
  }
  // genug unfolierte Exemplare? (welche frei sind, zählt erst beim Annehmen)
  const need = {};
  for (const l of lines) if (!l.copy && catalog.cardById[l.card]) need[l.card] = (need[l.card] || 0) + 1;
  const ids = Object.keys(need);
  if (ids.length) {
    const have = await TcgCard.aggregate([{ $match: { user: owner._id, card: { $in: ids }, foiledAt: null } }, { $group: { _id: '$card', n: { $sum: 1 } } }]);
    const n = Object.fromEntries(have.map((h) => [h._id, h.n]));
    const short = ids.find((id) => (n[id] || 0) < need[id]);
    if (short) {
      const times = need[short] > 1 ? ` ${need[short]}-mal` : '';
      throw new UserError(mine ? `Du besitzt ${cardName(short)} nicht${times}.` : `${ownerName} besitzt ${cardName(short)} nicht${times}.`);
    }
  }
  return lines;
}

/** Spiegel-Felder der ersten Karte je Seite (Listen, Protokolle, ältere Auswertungen) */
const swapMirror = (give, take) => ({
  card: give[0].card,
  foiledAt: give[0].foiledAt || null,
  grade: give[0].grade || null,
  wantCard: take[0].card,
  wantCopy: take[0].copy || null,
  wantFoiledAt: take[0].foiledAt || null,
  wantGrade: take[0].grade || null,
});

/**
 * Tauschangebot (#76): give/take = rohe Auswahl je Seite ([{ card }] / [{ copy }]). Nichts wird gesperrt –
 * beide Seiten werden beim Annehmen geprüft. Optional eine erste Nachricht.
 */
async function createSwap({ user, toName, give: rawGive, take: rawTake, price, extraFrom, message = '' }) {
  if (!toName) throw new UserError('Bitte gib an, wem du das Angebot machen willst.');
  const to = await User.findOne({ usernameLower: toName.trim().toLowerCase(), deletedAt: null }).select('_id username').lean();
  if (!to) throw new UserError('Diesen Benutzer gibt es nicht.');
  if (to._id.equals(user._id)) throw new UserError('Du kannst dir nicht selbst ein Angebot machen.');
  // vor den Datenbank-Abfragen: Anzahl begrenzen (die Karten selbst prüft validateOffer danach)
  if (rawGive.length > MAX_SWAP_CARDS || rawTake.length > MAX_SWAP_CARDS) throw new UserError(`Höchstens ${MAX_SWAP_CARDS} Karten pro Seite.`);
  const give = await resolveSwapLines(rawGive, user, user.username, true);
  const take = await resolveSwapLines(rawTake, to, to.username, false);
  const valid = validateOffer({ kind: 'tausch', price, extraFrom, give, take });
  const firstMessage = String(message || '').trim() ? cleanMessage(message) : null;
  if ((await Trade.countDocuments({ ...openFilter(), seller: user._id })) >= MAX_OPEN) {
    throw new UserError(`Du hast schon ${MAX_OPEN} offene Angebote.`);
  }
  const _id = new mongoose.Types.ObjectId();
  const now = new Date();
  const created = await Trade.create({
    _id,
    kind: 'tausch',
    seller: user._id,
    sellerName: user.username,
    to: to._id,
    toName: to.username,
    cardDoc: _id, // Platzhalter: beim Tausch ist vorher nichts gesperrt
    give,
    take,
    ...swapMirror(give, take),
    extraFrom: valid.extraFrom,
    price,
    expiresAt: new Date(now.getTime() + PRIVATE_HOURS * 3600000),
    lastChangeBy: 'seller',
    activityAt: now,
    sellerSeenAt: now,
    messages: firstMessage ? [{ from: 'seller', text: firstMessage }] : [],
  });
  await notify(to._id, { area: 'Handel', href: swapHref(created), text: `${user.username} möchte ${sideText(give)} gegen deine ${sideText(take)} tauschen (${termsText(created)}).` });
  return created;
}

async function create({ user, kind, cardId, price, toName, wantCardId = null, extraFrom = null, message = '', copyId = null, wantCopy = null }) {
  // Tausch 1 gegen 1 (z. B. aus einer fremden Sammlung): wie ein Tausch mit je einer Karte
  if (kind === 'tausch') {
    return createSwap({ user, toName, price, extraFrom, message, give: [copyId ? { copy: copyId } : { card: cardId }], take: [wantCopy ? { copy: wantCopy } : { card: wantCardId }] });
  }
  if (copyId) {
    if (!mongoose.isValidObjectId(copyId)) throw new UserError('Diese folierte Karte gibt es nicht.');
    const own = await TcgCard.findOne({ _id: copyId, user: user._id }).select('card').lean();
    if (!own) throw new UserError('Diese folierte Karte besitzt du nicht (mehr).');
    cardId = own.card;
  }
  validateOffer({ kind, price, cardId });

  let to = null;
  if (kind !== 'markt') {
    if (!toName) throw new UserError('Bitte gib an, wem du das Angebot machen willst.');
    to = await User.findOne({ usernameLower: toName.trim().toLowerCase(), deletedAt: null }).select('_id username').lean();
    if (!to) throw new UserError('Diesen Benutzer gibt es nicht.');
    if (to._id.equals(user._id)) throw new UserError('Du kannst dir nicht selbst ein Angebot machen.');
  }
  if ((await Trade.countDocuments({ ...openFilter(), seller: user._id })) >= MAX_OPEN) {
    throw new UserError(`Du hast schon ${MAX_OPEN} offene Angebote.`);
  }

  const hours = kind === 'markt' ? MARKET_DAYS * 24 : PRIVATE_HOURS;
  try {
    // Sperrprüfung und Angebot in einer Transaktion, damit die Karte nicht gleichzeitig verkauft oder auf eine Quest geschickt wird
    const created = await inTransaction(async (session) => {
      const item = itemByCardId(cardId);
      const { doc, owned } = item
        ? { doc: (await freeItems(user._id, item.key, session))[0] || null, owned: 0 }
        : copyId
          ? await foiledCopy(user._id, cardId, copyId, session)
          : await freeCopy(user._id, cardId, session);
      if (!doc) {
        if (item) throw new UserError(`Du hast keine freie ${item.label} (oder sie steht schon im Handel).`);
        throw new UserError(owned ? 'Alle Exemplare dieser Karte sind gerade gesperrt (Quest, Handel oder foliert).' : 'Diese Karte besitzt du nicht.');
      }
      if (item) await claimItems([doc], user._id, session);
      else await claim([doc], user._id, session);

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
            foiledAt: doc.foiledAt || null,
            grade: doc.foiledAt && doc.condition ? doc.condition.grade : null, // Note nur bei folierten Exemplaren
            price,
            expiresAt: new Date(Date.now() + hours * 3600000),
          },
        ],
        { session }
      );
      return trade;
    });
    if (kind === 'privat') {
      await notify(to._id, { area: 'Handel', href: '/handel', text: `${user.username} bietet dir „${cardName(cardId)}“ für ${euro(price)} an.` });
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

/**
 * Verkauf abschließen (in einer Transaktion): Käufer zahlt price, Verkäufer bekommt price − Steuer, Karte bzw.
 * Gegenstand wechselt den Besitzer. Alle Gespräche über das Angebot enden. payerMsg = Meldung bei zu wenig Guthaben.
 */
async function completeSale(trade, { buyerId, buyerName, price, closedBy, payerMsg }, session) {
  const money = settlement({ ...trade.toObject(), price }, { buyer: buyerId });
  await transfer(money, { title: cardName(trade.card), payerType: 'handel_kauf', payeeType: 'handel_verkauf', payerMsg }, session);

  const item = itemByCardId(trade.card);
  const Model = item ? Item : TcgCard;
  const moved = await Model.updateOne({ _id: trade.cardDoc, user: trade.seller }, { $set: { user: buyerId } }, { session });
  if (moved.modifiedCount !== 1) throw new UserError(item ? 'Der Gegenstand ist nicht mehr verfügbar.' : 'Die Karte ist nicht mehr verfügbar.');
  if (!item) await markSeen(buyerId, [trade.card], session);
  else {
    const meta = { trade: trade._id };
    await logItems([{ user: trade.seller, type: item.key, delta: -1, source: 'handel', meta }, { user: buyerId, type: item.key, delta: 1, source: 'handel', meta }], session);
  }

  // price = tatsächlich bezahlter Preis (nach einer Verhandlung kann er vom Angebot abweichen)
  Object.assign(trade, { status: 'verkauft', price, buyer: buyerId, buyerName, closedBy, taxPercent: taxService.rate(trade.kind), tax: money.tax, closedAt: new Date() });
  await trade.save({ session });
  // offene Gespräche über das Angebot enden – ihre Interessenten werden nach der Transaktion benachrichtigt
  const talks = await TradeTalk.find({ trade: trade._id, status: 'offen' }).select('to').session(session).lean();
  if (talks.length) await TradeTalk.updateMany({ trade: trade._id, status: 'offen' }, { $set: { status: 'beendet' } }, { session });
  return { ...money, talkUsers: talks.map((t) => t.to) };
}

/** Interessenten benachrichtigen, deren Gespräch endet, weil die Karte weg ist (außer except) */
async function notifyTalksEnded(users, except, card, text = `„${cardName(card)}“ ist nicht mehr zu haben – die Verhandlung ist beendet.`) {
  const ids = users.filter((u) => !except || String(u) !== String(except));
  if (ids.length) await notify(ids, { area: 'Handel', href: '/handel', text });
}

/**
 * Kaufen/Annehmen beim Verkauf. Markt: jeder außer dem Anbieter, zum Marktpreis. Privat: wer die aktuellen
 * Bedingungen nicht selbst gesetzt hat – der Empfänger kauft, der Anbieter nimmt einen Gegenvorschlag an (#82).
 * version = Stand der Bedingungen, den der Annehmende gesehen hat.
 */
async function buy({ user, tradeId, version }) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  const result = await inTransaction(async (session) => {
    const trade = await Trade.findOne({ _id: tradeId, ...openFilter() }).session(session);
    if (!trade) throw new UserError('Dieses Angebot gibt es nicht mehr.');
    if (trade.kind === 'tausch') throw new UserError('Ein Tauschangebot kann man nicht kaufen.');
    let role = 'to';
    if (trade.kind === 'privat') {
      role = roleOf(trade, user._id);
      if (!role) throw new UserError('Dieses Angebot ist nicht für dich.');
      if (!canAccept(trade, role)) throw new UserError('Das ist dein eigener Vorschlag – jetzt ist die andere Seite am Zug.');
      if (Number.isInteger(version) && version !== (trade.termsVersion || 0)) throw new UserError('Der Preis wurde gerade geändert. Bitte schau ihn dir noch einmal an.');
    } else if (trade.seller.equals(user._id)) {
      throw new UserError('Du kannst dein eigenes Angebot nicht kaufen.');
    }
    const [buyerId, buyerName] = trade.kind === 'privat' ? [trade.to, trade.toName] : [user._id, user.username];
    const money = await completeSale(trade, {
      buyerId,
      buyerName,
      price: trade.price,
      closedBy: user._id,
      payerMsg: role === 'seller' ? `${trade.toName} hat nicht mehr genug Guthaben.` : 'Dein Guthaben reicht dafür nicht aus.',
    }, session);
    return { trade, tax: money.tax, role, talkUsers: money.talkUsers };
  });
  const { trade, role } = result;
  if (role === 'seller') {
    await notify(trade.to, { area: 'Handel', href: '/handel', text: `${user.username} hat deinen Preis angenommen: „${cardName(trade.card)}“ gehört jetzt dir (${euro(trade.price)}).` });
  } else {
    await notify(trade.seller, { area: 'Handel', href: '/handel', text: `${user.username} hat ${itemByCardId(trade.card) ? 'deine' : 'deine Karte'} „${cardName(trade.card)}“ für ${euro(trade.price)} gekauft.` });
  }
  await notifyTalksEnded(result.talkUsers, user._id, trade.card);
  return result;
}

/**
 * Tausch annehmen: alle Karten beider Seiten wechseln den Besitzer, ein Aufpreis wird wie ein Verkauf (mit Steuer)
 * gebucht. Annehmen darf, wer die aktuellen Bedingungen nicht selbst gesetzt hat – also auch der Anbieter nach einem
 * Gegenvorschlag. version = Stand der Bedingungen, den der Annehmende gesehen hat. Die Karten werden erst jetzt
 * geprüft und gesperrt (#76).
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
    const { give, take } = swapSides(trade.toObject());
    const legacyDoc = trade.give && trade.give.length ? null : trade.cardDoc;
    const giveDocs = await pickSwapCopies({ owner: trade.seller, ownerName: trade.sellerName, lines: give, mine: role === 'seller', legacyDoc, session });
    const takeDocs = await pickSwapCopies({ owner: trade.to, ownerName: trade.toName, lines: take, mine: role === 'to', session });
    await claim(giveDocs, trade.seller, session);
    await claim(takeDocs, trade.to, session);

    const money = settlement(trade);
    if (money) {
      const iPay = money.payer.equals(user._id);
      const other = role === 'to' ? trade.sellerName : trade.toName;
      await transfer(
        money,
        {
          title: `${sideText(give)} gegen ${sideText(take)}`,
          payerType: 'handel_tausch_zahlung',
          payeeType: 'handel_tausch_erhalt',
          payerMsg: iPay ? 'Dein Guthaben reicht für den Aufpreis nicht aus.' : `${other} hat nicht mehr genug Guthaben für den Aufpreis.`,
        },
        session
      );
    }

    const given = await TcgCard.updateMany({ _id: { $in: giveDocs }, user: trade.seller }, { $set: { user: trade.to } }, { session });
    const taken = await TcgCard.updateMany({ _id: { $in: takeDocs }, user: trade.to }, { $set: { user: trade.seller } }, { session });
    if (given.modifiedCount !== giveDocs.length || taken.modifiedCount !== takeDocs.length) throw new UserError('Eine der Karten ist nicht mehr verfügbar.');
    await markSeen(trade.to, give.map((l) => l.card), session);
    await markSeen(trade.seller, take.map((l) => l.card), session);

    Object.assign(trade, {
      status: 'verkauft',
      buyer: trade.to, // beim Tausch immer der Empfänger, egal wer zuletzt angenommen hat
      buyerName: trade.toName,
      closedBy: user._id, // wer angenommen hat
      wantCardDoc: takeDocs[0],
      giveDocs,
      takeDocs,
      taxPercent: taxService.rate('tausch'),
      tax: money ? money.tax : 0,
      closedAt: new Date(),
    });
    await trade.save({ session });
    return { trade, money, role, give, take };
  });
  const { trade, role, give, take } = result;
  // die andere Seite: Was bekommt sie?
  const [other, gets, gives] = role === 'to' ? [trade.seller, take, give] : [trade.to, give, take];
  await notify(other, { area: 'Handel', href: swapHref(trade), text: `${user.username} hat den Tausch angenommen: Du bekommst ${sideText(gets)} für ${sideText(gives)}.` });
  return result;
}

// ---------- Verhandlung: Tausch und privater Verkauf ----------
const seenField = (role) => (role === 'seller' ? 'sellerSeenAt' : 'toSeenAt');
const NEGOTIABLE_KINDS = ['tausch', 'privat'];

/** Verhandlung öffnen (nur die beiden Beteiligten); markiert sie als gelesen */
async function negotiation({ user, tradeId }) {
  if (!mongoose.isValidObjectId(tradeId)) return null;
  const trade = await Trade.findOne({ _id: tradeId, kind: { $in: NEGOTIABLE_KINDS } }).lean();
  const role = trade && roleOf(trade, user._id);
  if (!role) return null;
  await Trade.updateOne({ _id: trade._id }, { $set: { [seenField(role)]: new Date() } });
  return { trade, role };
}

/** Offenes Tausch- oder Privatangebot laden, an dem der Nutzer beteiligt ist */
async function openSwapFor(user, tradeId) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  const trade = await Trade.findOne({ _id: tradeId, kind: { $in: NEGOTIABLE_KINDS }, ...openFilter() }).select('-messages.text').lean();
  const role = trade && roleOf(trade, user._id);
  if (!role) throw new UserError('Dieses Angebot ist nicht mehr offen.');
  return { trade, role };
}

/** Nachricht speichern (Trade oder TradeTalk) und die andere Seite benachrichtigen */
async function postMessage({ Model, doc, filter, role, user, text, href }) {
  const clean = cleanMessage(text);
  const since = Date.now() - 60000;
  if ((doc.messages || []).filter((m) => m.from === role && new Date(m.createdAt) > since).length >= MESSAGES_PER_MINUTE) {
    throw new UserError('Du schreibst gerade sehr schnell – bitte warte einen Moment.');
  }
  const now = new Date();
  const res = await Model.updateOne(
    { _id: doc._id, ...filter },
    { $push: { messages: { $each: [{ from: role, text: clean }], $slice: -MAX_MESSAGES } }, $set: { activityAt: now, [seenField(role)]: now } }
  );
  if (res.modifiedCount !== 1) throw new UserError('Dieses Angebot ist nicht mehr offen.');
  const card = cardName(doc.card);
  await notify(role === 'seller' ? doc.to : doc.seller, {
    area: 'Handel',
    href,
    key: `handel:${doc._id}:nachricht`,
    text: `${user.username} hat dir in der Verhandlung um „${card}“ geschrieben.`,
    many: (n) => `${n} neue Nachrichten in der Verhandlung um „${card}“.`,
  });
}

/** Nachricht in der Verhandlung schreiben (Tausch oder privat) */
async function sendMessage({ user, tradeId, text }) {
  cleanMessage(text);
  const { trade, role } = await openSwapFor(user, tradeId);
  await postMessage({ Model: Trade, doc: trade, filter: openFilter(), role, user, text, href: swapHref(trade) });
}

/**
 * Gegenvorschlag: beim Tausch Aufpreis und wer ihn zahlt, beim privaten Verkauf der Preis. Danach ist die andere
 * Seite am Zug, das Angebot läuft wieder volle PRIVATE_HOURS. version = Stand, den der Ändernde gesehen hat.
 */
async function changeTerms({ user, tradeId, price, extraFrom, version, give: rawGive = null, take: rawTake = null }) {
  const { trade, role } = await openSwapFor(user, tradeId);
  // Tausch: auf Wunsch auch andere Karten (#76) – give = Karten des Anbieters, take = des Empfängers
  let cards = null;
  if (trade.kind === 'tausch' && rawGive && rawTake) {
    if (rawGive.length > MAX_SWAP_CARDS || rawTake.length > MAX_SWAP_CARDS) throw new UserError(`Höchstens ${MAX_SWAP_CARDS} Karten pro Seite.`);
    const seller = { _id: trade.seller };
    const to = { _id: trade.to };
    cards = {
      give: await resolveSwapLines(rawGive, seller, trade.sellerName, role === 'seller'),
      take: await resolveSwapLines(rawTake, to, trade.toName, role === 'to'),
    };
  }
  const current = swapSides(trade);
  const valid = trade.kind === 'tausch'
    ? validateOffer({ kind: 'tausch', price, extraFrom, give: cards ? cards.give : current.give, take: cards ? cards.take : current.take })
    : validateOffer({ kind: trade.kind, price, cardId: trade.card, extraFrom });
  const sameCards = !cards || swapText({ ...cards, card: null }) === swapText(trade);
  if (sameCards && price === trade.price && valid.extraFrom === (trade.price ? trade.extraFrom : null)) {
    throw new UserError('Das sind schon die aktuellen Bedingungen.');
  }
  const now = new Date();
  const actor = role === 'seller' ? trade.sellerName : trade.toName;
  const terms = termsText(trade, { price, extraFrom: valid.extraFrom });
  // mit neuen Karten aus Sicht des Anbieters: "A, B gegen C, ohne Aufpreis"
  const proposal = cards && !sameCards ? `${sideText(cards.give)} gegen ${sideText(cards.take)}, ${terms}` : terms;
  const seen = Number.isInteger(version) ? version : trade.termsVersion || 0;
  const res = await Trade.updateOne(
    // Ältere Angebote haben noch kein termsVersion-Feld – das zählt als Stand 0
    { _id: trade._id, ...openFilter(), termsVersion: { $in: seen === 0 ? [0, null] : [seen] } },
    {
      $set: {
        price,
        extraFrom: valid.extraFrom,
        // neue Karten: give/take und Spiegel-Felder; ein altes Angebot gibt dabei sein gesperrtes Exemplar frei
        ...(cards && !sameCards && { give: cards.give, take: cards.take, ...swapMirror(cards.give, cards.take), cardDoc: trade._id }),
        lastChangeBy: role,
        activityAt: now,
        [seenField(role)]: now,
        expiresAt: new Date(now.getTime() + PRIVATE_HOURS * 3600000),
      },
      $inc: { termsVersion: 1 },
      $push: { messages: { $each: [{ from: 'system', text: `${actor} schlägt vor: ${proposal}.` }], $slice: -MAX_MESSAGES } },
    }
  );
  if (res.modifiedCount !== 1) throw new UserError('Die Bedingungen wurden gerade geändert. Bitte schau sie dir noch einmal an.');
  await notify(role === 'seller' ? trade.to : trade.seller, {
    area: 'Handel',
    href: swapHref(trade),
    text: `${actor} macht einen Gegenvorschlag ${trade.kind === 'tausch' ? 'zum Tausch' : 'zum Verkauf'} um „${cardName(trade.card)}“: ${proposal}.`,
  });
}

// ---------- Gespräche über Markt-Angebote (#82) ----------
/** Gespräch für die Ansicht: wie ein Angebot (talk: true) */
const talkView = (talk, trade) => ({ ...talk, talk: true, kind: 'markt', foiledAt: trade ? trade.foiledAt : null, grade: trade ? trade.grade : null, listPrice: trade ? trade.price : null });

/** Gespräch über ein Markt-Angebot beginnen (oder das bestehende öffnen). Gibt das Gespräch zurück. */
async function startTalk({ user, tradeId }) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  const trade = await Trade.findOne({ _id: tradeId, kind: 'markt', ...openFilter() }).select('seller sellerName card price expiresAt').lean();
  if (!trade) throw new UserError('Dieses Angebot gibt es nicht mehr.');
  if (trade.seller.equals(user._id)) throw new UserError('Über dein eigenes Angebot kannst du nicht verhandeln.');
  const existing = await TradeTalk.findOne({ trade: trade._id, to: user._id }).select('_id status').lean();
  if (existing) {
    if (existing.status !== 'offen') throw new UserError('Diese Verhandlung ist beendet.');
    return existing;
  }
  if ((await TradeTalk.countDocuments({ to: user._id, status: 'offen', expiresAt: { $gt: new Date() } })) >= MAX_TALKS) {
    throw new UserError(`Du verhandelst schon über ${MAX_TALKS} Angebote.`);
  }
  const now = new Date();
  try {
    const [talk] = await TradeTalk.create([
      {
        trade: trade._id,
        seller: trade.seller,
        sellerName: trade.sellerName,
        to: user._id,
        toName: user.username,
        card: trade.card,
        price: trade.price,
        lastChangeBy: 'seller', // am Anfang gilt der Marktpreis des Anbieters
        toSeenAt: now, // activityAt erst bei der ersten Nachricht oder dem ersten Vorschlag – vorher kein Abzeichen
        expiresAt: trade.expiresAt,
      },
    ]);
    return talk;
  } catch (err) {
    if (err.code === 11000) return TradeTalk.findOne({ trade: trade._id, to: user._id }).select('_id status').lean();
    throw err;
  }
}

/** Gespräch öffnen (nur die beiden Beteiligten); markiert es als gelesen. { talk (Ansicht), role, isOpen } oder null */
async function talkFor({ user, talkId }) {
  if (!mongoose.isValidObjectId(talkId)) return null;
  const talk = await TradeTalk.findById(talkId).lean();
  const role = talk && roleOf(talk, user._id);
  if (!role) return null;
  const trade = await Trade.findById(talk.trade).select('status expiresAt foiledAt grade price').lean();
  await TradeTalk.updateOne({ _id: talk._id }, { $set: { [seenField(role)]: new Date() } });
  const isOpen = talk.status === 'offen' && !!trade && trade.status === 'offen' && new Date(trade.expiresAt) > new Date();
  return { talk: talkView(talk, trade), role, isOpen };
}

const talkOpenFilter = () => ({ status: 'offen', expiresAt: { $gt: new Date() } });

/** Offenes Gespräch laden, an dem der Nutzer beteiligt ist */
async function openTalkFor(user, talkId) {
  if (!mongoose.isValidObjectId(talkId)) throw new UserError('Verhandlung nicht gefunden.');
  const talk = await TradeTalk.findOne({ _id: talkId, ...talkOpenFilter() }).select('-messages.text').lean();
  const role = talk && roleOf(talk, user._id);
  if (!role) throw new UserError('Diese Verhandlung ist beendet.');
  return { talk, role };
}

/** Nachricht im Gespräch */
async function sendTalkMessage({ user, talkId, text }) {
  cleanMessage(text);
  const { talk, role } = await openTalkFor(user, talkId);
  await postMessage({ Model: TradeTalk, doc: talk, filter: talkOpenFilter(), role, user, text, href: talkHref(talk) });
}

/** Preisvorschlag im Gespräch – gilt nur zwischen diesen beiden */
async function changeTalkTerms({ user, talkId, price, version }) {
  const { talk, role } = await openTalkFor(user, talkId);
  validateOffer({ kind: 'markt', price, cardId: talk.card });
  if (price === talk.price) throw new UserError('Das ist schon der aktuelle Preis.');
  const now = new Date();
  const actor = role === 'seller' ? talk.sellerName : talk.toName;
  const seen = Number.isInteger(version) ? version : talk.termsVersion || 0;
  const res = await TradeTalk.updateOne(
    { _id: talk._id, ...talkOpenFilter(), termsVersion: seen },
    {
      $set: { price, lastChangeBy: role, activityAt: now, [seenField(role)]: now },
      $inc: { termsVersion: 1 },
      $push: { messages: { $each: [{ from: 'system', text: `${actor} schlägt ${euro(price)} vor.` }], $slice: -MAX_MESSAGES } },
    }
  );
  if (res.modifiedCount !== 1) throw new UserError('Der Preis wurde gerade geändert. Bitte schau ihn dir noch einmal an.');
  await notify(role === 'seller' ? talk.to : talk.seller, {
    area: 'Handel',
    href: talkHref(talk),
    text: `${actor} schlägt für „${cardName(talk.card)}“ ${euro(price)} vor.`,
  });
}

/** Vorschlag im Gespräch annehmen: der Interessent kauft zum ausgehandelten Preis */
async function acceptTalk({ user, talkId, version }) {
  if (!mongoose.isValidObjectId(talkId)) throw new UserError('Verhandlung nicht gefunden.');
  const result = await inTransaction(async (session) => {
    const talk = await TradeTalk.findOne({ _id: talkId, ...talkOpenFilter() }).session(session);
    const role = talk && roleOf(talk, user._id);
    if (!role) throw new UserError('Diese Verhandlung ist beendet.');
    if (!canAccept({ talk: true, lastChangeBy: talk.lastChangeBy }, role)) throw new UserError('Das ist dein eigener Vorschlag – jetzt ist die andere Seite am Zug.');
    if (Number.isInteger(version) && version !== talk.termsVersion) throw new UserError('Der Preis wurde gerade geändert. Bitte schau ihn dir noch einmal an.');
    const trade = await Trade.findOne({ _id: talk.trade, kind: 'markt', ...openFilter() }).session(session);
    if (!trade) throw new UserError('Dieses Angebot gibt es nicht mehr.');
    const money = await completeSale(trade, {
      buyerId: talk.to,
      buyerName: talk.toName,
      price: talk.price,
      closedBy: user._id,
      payerMsg: role === 'seller' ? `${talk.toName} hat nicht mehr genug Guthaben.` : 'Dein Guthaben reicht dafür nicht aus.',
    }, session);
    await TradeTalk.updateOne({ _id: talk._id }, { $set: { status: 'verkauft' } }, { session });
    return { trade, talk, role, talkUsers: money.talkUsers };
  });
  const { trade, talk, role } = result;
  const text = role === 'seller'
    ? `${user.username} hat deinen Preis angenommen: „${cardName(trade.card)}“ gehört jetzt dir (${euro(talk.price)}).`
    : `${user.username} hat „${cardName(trade.card)}“ für ${euro(talk.price)} gekauft (ausgehandelter Preis).`;
  await notify(role === 'seller' ? talk.to : talk.seller, { area: 'Handel', href: '/handel', text });
  await notifyTalksEnded(result.talkUsers, talk.to, trade.card);
  return result;
}

/** Gespräch beenden (eine Seite) – das Markt-Angebot selbst bleibt */
async function endTalk({ user, talkId }) {
  const { talk, role } = await openTalkFor(user, talkId);
  const res = await TradeTalk.updateOne({ _id: talk._id, status: 'offen' }, { $set: { status: 'beendet' } });
  if (res.modifiedCount !== 1) throw new UserError('Diese Verhandlung ist beendet.');
  await notify(role === 'seller' ? talk.to : talk.seller, {
    area: 'Handel',
    href: '/handel',
    text: `${user.username} hat die Verhandlung um „${cardName(talk.card)}“ beendet.`,
  });
}

/** Verkäufer zieht zurück bzw. Empfänger lehnt ab – die Karte wird wieder frei */
async function close({ user, tradeId, action }) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  const who = action === 'ablehnen' ? { to: user._id } : { seller: user._id };
  const status = action === 'ablehnen' ? 'abgelehnt' : 'zurueckgezogen';
  const trade = await Trade.findOneAndUpdate({ _id: tradeId, status: 'offen', ...who }, { $set: { status, closedAt: new Date() } }).select('kind seller to card expiresAt').lean();
  if (!trade) throw new UserError('Dieses Angebot gibt es nicht mehr.');
  if (trade.kind === 'markt') {
    const talks = await TradeTalk.find({ trade: trade._id, status: 'offen' }).select('to').lean();
    await TradeTalk.updateMany({ trade: trade._id, status: 'offen' }, { $set: { status: 'beendet' } });
    if (trade.expiresAt > new Date()) {
      await notifyTalksEnded(talks.map((t) => t.to), null, trade.card, `${user.username} hat „${cardName(trade.card)}“ vom Markt genommen – die Verhandlung ist beendet.`);
    }
  }
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
  taxFor,
  taxOf,
  taxRates,
  validateOffer,
  validateSwap,
  swapSides,
  sideText,
  swapText,
  MAX_SWAP_CARDS,
  createSwap,
  settlement,
  openFilter,
  MESSAGE_MAX,
  roleOf,
  otherRole,
  canAccept,
  negotiable,
  isUnread,
  cleanMessage,
  termsText,
  incomingFilter,
  incomingCount,
  talkAttentionFilter,
  MAX_TALKS,
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
  startTalk,
  talkFor,
  sendTalkMessage,
  changeTalkTerms,
  acceptTalk,
  endTalk,
  close,
};

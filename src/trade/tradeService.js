const mongoose = require('mongoose');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgCard } = require('../models/Tcg');
const { Item } = require('../models/Item');
const { itemByCardId, freeItems, claimItems, logItems } = require('../items/itemService');
const { Trade, openFilter } = require('../models/Trade');
const { inTransaction } = require('../services/betService');
const { UserError, str, parseEuro } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');
const catalog = require('../tcg/catalog');
const { lockedDocs, isLocked, claim } = require('../tcg/locks');
const { markSeen } = require('../tcg/tcgService');
const taxService = require('../services/taxService');
const { notify } = require('../services/notifyService');
const lines = require('./lines');

const { cardName, otherRole, kindOf, lockDocsOf, termsText, lineLabel } = lines;

const PRIVATE_HOURS = 48; // Angebote an ein Mitglied und Gegenangebote laufen nach 48 Stunden ab
const MARKET_DAYS = 7; // Markt-Angebote nach 7 Tagen
const MAX_PRICE = 100000000; // 1 Mio. €
const MAX_OPEN = 20; // offene Angebote pro Person
const MAX_LINES = 10; // Karten bzw. Gegenstände je Seite

// ---------- Steuer (Sätze je Angebotsart im Admin-Panel, siehe services/taxService) ----------
/** Steuer in Cent (abgerundet), die dem Empfänger des Geldes abgezogen wird */
const taxFor = (price, percent = 0) => taxService.taxFor(price, percent);
/** Steuer auf einen Betrag nach dem aktuellen Satz der Angebotsart (markt, privat, tausch) */
const taxOf = (price, kind) => taxFor(price, taxService.rate(kind));
/** Aktuelle Sätze der drei Angebotsarten, z. B. für die Anzeige */
const taxRates = () => ({ markt: taxService.rate('markt'), privat: taxService.rate('privat'), tausch: taxService.rate('tausch') });

const offerHref = (trade) => `/handel/angebot/${trade._id}`;
const isCard = (id) => !!catalog.cardById[id] || !!itemByCardId(id);

// ---------- Reine Regeln (ohne Datenbank, getestet) ----------
/**
 * Prüft die Bedingungen eines Angebots: give/want = Positionen ({ card, copy?, doc? }), Geld price von extraFrom.
 * Wer keine Karte gibt, muss zahlen – verschenkt wird nichts. Markt-Angebot (listing): Wunschkarten nur als
 * Karten, kein bestimmtes Exemplar – jeder, der sie hat, kann tauschen. Gibt das bereinigte extraFrom zurück (null ohne Geld).
 */
function validateOffer({ give = [], want = [], price, extraFrom = null, listing = false }) {
  for (const l of [...give, ...want]) if (!isCard(l.card)) throw new UserError('Diese Karte gibt es nicht.');
  if (!give.length && !want.length) throw new UserError('Bitte wähle mindestens eine Karte aus.');
  if (give.length > MAX_LINES || want.length > MAX_LINES) throw new UserError(`Höchstens ${MAX_LINES} Karten je Seite.`);
  const copies = [...give, ...want].map((l) => l.copy || l.doc).filter(Boolean).map(String);
  if (new Set(copies).size !== copies.length) throw new UserError('Ein Exemplar kann nur einmal im Angebot stehen.');
  if (!Number.isInteger(price) || price < 0 || price > MAX_PRICE) throw new UserError('Bitte gib einen gültigen Betrag an.');
  if (listing && want.some((l) => l.copy)) throw new UserError('Auf dem Markt kannst du dir nur Karten wünschen, kein bestimmtes foliertes Exemplar.');
  if (listing && !want.length && price < 1) throw new UserError('Bitte gib einen Preis an.');
  if (!price) {
    if (!give.length || !want.length) throw new UserError('Wer keine Karte gibt, muss etwas zahlen – bitte gib einen Betrag an.');
    return { extraFrom: null };
  }
  if (extraFrom !== 'seller' && extraFrom !== 'to') throw new UserError('Bitte wähle aus, wer das Geld zahlt.');
  if ((!give.length && extraFrom !== 'seller') || (!want.length && extraFrom !== 'to')) {
    throw new UserError('Wer keine Karte gibt, muss das Geld zahlen.');
  }
  return { extraFrom };
}

/**
 * Geldfluss beim Abschluss: { payer, payee, amount, tax } – oder null ohne Geld.
 * Es zahlt extraFrom (ohne Angabe der Empfänger bzw. bei einem Markt-Angebot der Käufer buyer).
 * Die Steuer fällt nur auf das Geld an und wird dem abgezogen, der es bekommt.
 */
function settlement(trade, { buyer, taxPercent = taxService.rate(trade.kind) } = {}) {
  if (!trade.price) return null;
  const by = { seller: trade.seller, to: trade.to || buyer };
  const from = trade.extraFrom || 'to';
  return { payer: by[from], payee: by[otherRole(from)], amount: trade.price, tax: taxFor(trade.price, taxPercent) };
}

/**
 * Formular des Handelsfensters lesen (auch die Vorauswahl per GET):
 * gib:<Karte> / will:<Karte> = Anzahl, gib / will = "f:<Exemplar>" (foliert) oder "<Karte>" (je ein Stück),
 * geld_gib / geld_will = Betrag, den ich zahle bzw. haben möchte.
 * Gibt { gives, gets, price, iPay } aus meiner Sicht zurück; Positionen ohne Sperre ({ card } bzw. { copy }).
 */
function parseOfferForm(body = {}) {
  const side = (prefix) => {
    const out = [];
    const counts = {};
    for (const [key, value] of Object.entries(body)) {
      if (!key.startsWith(prefix + ':')) continue;
      const n = parseInt(str(Array.isArray(value) ? value[value.length - 1] : value), 10);
      if (n > 0) counts[key.slice(prefix.length + 1)] = Math.min(n, MAX_LINES + 1);
    }
    const raw = body[prefix];
    for (const v of (Array.isArray(raw) ? raw : raw ? [raw] : []).map(str)) {
      if (v.startsWith('f:')) out.push({ copy: v.slice(2) });
      else if (v) counts[v] = Math.min((counts[v] || 0) + 1, MAX_LINES + 1);
    }
    for (const [card, n] of Object.entries(counts)) for (let i = 0; i < n; i++) out.push({ card });
    return out;
  };
  const pay = str(body.geld_gib).trim() ? parseEuro(str(body.geld_gib)) : 0;
  const receive = str(body.geld_will).trim() ? parseEuro(str(body.geld_will)) : 0;
  if (pay === null || receive === null) throw new UserError('Bitte gib einen gültigen Betrag an.');
  if (pay > 0 && receive > 0) throw new UserError('Geld kann nur in eine Richtung fließen – entweder du zahlst oder du bekommst etwas.');
  return { gives: side('gib'), gets: side('will'), price: pay || receive, iPay: pay > 0 };
}

// ---------- Verhandlung (reine Regeln) ----------
const MESSAGE_MAX = 500; // Zeichen pro Nachricht
const MAX_MESSAGES = 200; // ältere Nachrichten fallen weg
const MESSAGES_PER_MINUTE = 8;

/** Rolle eines Nutzers in einem Angebot: 'seller' (Anbieter), 'to' (Empfänger) oder null */
const roleOf = (trade, userId) => (String(trade.seller) === String(userId) ? 'seller' : trade.to && String(trade.to) === String(userId) ? 'to' : null);

/** Darf diese Rolle annehmen? Nur, wer die aktuellen Bedingungen nicht selbst gesetzt hat. */
const canAccept = (trade, role) => role !== null && !!trade.to && role !== (trade.lastChangeBy || 'seller');

/** Hat diese Rolle das Angebot angelegt? Beim Gegenangebot auf dem Markt ist das der Interessent. */
const isCreator = (trade, role) => role === (trade.listing ? 'to' : 'seller');

/** Ungelesene Aktivität (Nachricht oder Gegenangebot) für diese Rolle? */
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

/** Sind zwei Positionslisten gleich (Reihenfolge egal)? */
const sameLines = (a, b) => {
  const key = (l) => `${l.card}|${l.copy || ''}|${l.doc || ''}`;
  const ka = (a || []).map(key).sort();
  const kb = (b || []).map(key).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
};

/**
 * Neue Positionen einer Seite mit den bisherigen abgleichen: Gleiche Karte (und gleiches verlangtes Exemplar)
 * behält ihr schon gesperrtes Exemplar. Jede alte Position wird höchstens einmal übernommen.
 */
function carryLines(next, prev) {
  const pool = [...(prev || [])];
  return next.map((l) => {
    const i = pool.findIndex((p) => p.card === l.card && String(p.copy || '') === String(l.copy || '') && (!l.doc || String(p.doc) === String(l.doc)));
    if (i === -1) return { card: l.card, copy: l.copy || null, doc: l.doc || null, foiledAt: l.foiledAt || null, grade: l.grade == null ? null : l.grade };
    const [p] = pool.splice(i, 1);
    return { card: p.card, copy: p.copy || null, doc: p.doc || null, foiledAt: p.foiledAt || null, grade: p.grade == null ? null : p.grade };
  });
}

// ---------- Abfragen ----------
/**
 * Angebote, um die ich mich kümmern sollte (Abzeichen im Menü): Ich bin beteiligt und am Zug
 * oder es gibt etwas Neues. Markt-Angebote selbst zählen nicht (dort verhandelt man im Gegenangebot).
 */
const incomingFilter = (userId) => ({
  ...openFilter(),
  $or: [
    { to: userId, $or: [{ lastChangeBy: { $ne: 'to' } }, { $expr: { $gt: ['$activityAt', '$toSeenAt'] } }] },
    { seller: userId, to: { $ne: null }, $or: [{ lastChangeBy: 'to' }, { $expr: { $gt: ['$activityAt', '$sellerSeenAt'] } }] },
  ],
});
const incomingCount = (userId) => Trade.countDocuments(incomingFilter(userId));

/**
 * Abgeschlossene Geschäfte, über die ein Mitglied noch nicht Bescheid weiß: Jemand anderes hat seine
 * Karte gekauft oder sein Angebot angenommen (closedBy ist die handelnde Seite).
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
  to: null, // auch Tausch-Angebote und Gesuche auf dem Markt
  listing: null,
  seller: { $ne: user._id },
  createdAt: { $gt: user.marketSeenAt || user.createdAt },
});
const marketNewCount = (user) => Trade.countDocuments(marketNewFilter(user));

/**
 * Alles für die Handelsseite:
 * market – Markt-Angebote anderer (mit myOffer = mein laufendes Gegenangebot darauf),
 * incoming – an mich bzw. Gegenangebote auf meine Markt-Angebote, mine – von mir angelegt,
 * history – abgeschlossene Geschäfte, users – Mitglieder für die Auswahl.
 */
async function overview(user) {
  const me = user._id;
  const open = openFilter();
  const noMessages = '-messages';
  const [market, incoming, mine, history, users] = await Promise.all([
    Trade.find({ ...open, to: null, seller: { $ne: me } }).select(noMessages).sort({ createdAt: -1 }).limit(300).lean(),
    Trade.find({ ...open, $or: [{ to: me, listing: null }, { seller: me, listing: { $ne: null } }] }).select(noMessages).sort({ activityAt: -1, createdAt: -1 }).lean(),
    Trade.find({ ...open, $or: [{ seller: me, listing: null }, { to: me, listing: { $ne: null } }] }).select(noMessages).sort({ createdAt: -1 }).lean(),
    Trade.find({ status: 'verkauft', $or: [{ seller: me }, { buyer: me }] }).select(noMessages).sort({ closedAt: -1 }).limit(30).lean(),
    User.find({ _id: { $ne: me }, deletedAt: null }).select('username').sort({ usernameLower: 1 }).lean(),
  ]);
  // Gegenangebote je eigenem Markt-Angebot und mein Gegenangebot je fremdem
  const myListingIds = mine.filter((t) => !t.to).map((t) => t._id);
  const counters = myListingIds.length ? await Trade.aggregate([{ $match: { ...open, listing: { $in: myListingIds } } }, { $group: { _id: '$listing', n: { $sum: 1 } } }]) : [];
  const counterCount = new Map(counters.map((c) => [String(c._id), c.n]));
  const myOffers = new Map(mine.filter((t) => t.listing).map((t) => [String(t.listing), t._id]));
  const seen = user.dealsSeenAt || user.createdAt;
  const isNewDeal = (t) => !!t.closedBy && String(t.closedBy) !== String(me) && t.closedAt > seen;
  const deals = history.map((t) => ({ ...t, isNew: isNewDeal(t) }));
  return {
    market: market.map((t) => ({ ...t, myOffer: myOffers.get(String(t._id)) || null })),
    incoming,
    mine: mine.map((t) => ({ ...t, counters: counterCount.get(String(t._id)) || 0 })),
    history: deals,
    newDeals: deals.filter((t) => t.isNew),
    users,
  };
}

// ---------- Exemplare belegen, sperren, verschieben ----------
/**
 * Positionen eines Besitzers mit Exemplaren belegen: Positionen mit doc bleiben, sonst das älteste freie
 * Exemplar (nicht gesperrt, nicht foliert), bei copy genau dieses folierte Exemplar, bei Gegenständen ein freies Stück.
 * Mehrere Positionen derselben Karte bekommen verschiedene Exemplare. who = Name für die Meldung (null = "du").
 */
async function resolveLines(ownerId, list, session, who = null) {
  if (list.every((l) => l.doc)) return list;
  const lack = (text) => new UserError(who ? `${who} hat ${text}` : `Du hast ${text}`);
  const cardIdsNeeded = [...new Set(list.filter((l) => !l.doc && !itemByCardId(l.card)).map((l) => l.card))];
  const copyIds = list.filter((l) => !l.doc && l.copy).map((l) => l.copy);
  const [locked, docs, copies] = await Promise.all([
    lockedDocs(ownerId, session),
    TcgCard.find({ user: ownerId, card: { $in: cardIdsNeeded }, foiledAt: null }).sort({ createdAt: 1 }).select('_id card condition.grade').session(session).lean(),
    copyIds.length ? TcgCard.find({ _id: { $in: copyIds }, user: ownerId, foiledAt: { $ne: null } }).select('_id card foiledAt condition.grade').session(session).lean() : [],
  ]);
  const used = new Set(list.filter((l) => l.doc).map((l) => String(l.doc)));
  const itemPool = {};
  const out = [];
  for (const l of list) {
    if (l.doc) {
      out.push(l);
      continue;
    }
    const item = itemByCardId(l.card);
    let doc = null;
    if (item) {
      itemPool[item.key] = itemPool[item.key] || (await freeItems(ownerId, item.key, session));
      doc = itemPool[item.key].find((d) => !used.has(String(d._id)));
      if (!doc) throw lack(`keine freie ${item.label} mehr (oder sie steht schon im Handel).`);
    } else if (l.copy) {
      doc = copies.find((d) => String(d._id) === String(l.copy) && d.card === l.card);
      if (!doc) throw lack(`die folierte ${cardName(l.card)} nicht mehr.`);
      if (locked.reasons.get(String(doc._id)) !== 'folie') throw lack(`die folierte ${cardName(l.card)} gerade nicht frei (Handel, Quest oder Duell).`);
    } else {
      doc = docs.find((d) => d.card === l.card && !used.has(String(d._id)) && !isLocked(locked, d));
      if (!doc) throw lack(`nicht genug freie Exemplare von ${cardName(l.card)} (Quest, Handel oder foliert).`);
    }
    used.add(String(doc._id));
    out.push({ card: l.card, copy: l.copy || null, doc: doc._id, foiledAt: doc.foiledAt || null, grade: doc.foiledAt && doc.condition ? doc.condition.grade : null });
  }
  return out;
}

/** Exemplare per Schreibzugriff beanspruchen – ein gleichzeitiger Verkauf, Handel oder Quest-Start kollidiert (tcg/locks.claim) */
async function claimLines(list, ownerId, session) {
  const cards = list.filter((l) => !itemByCardId(l.card)).map((l) => l.doc);
  const goods = list.filter((l) => itemByCardId(l.card)).map((l) => ({ _id: l.doc }));
  if (cards.length) await claim(cards, ownerId, session);
  if (goods.length) await claimItems(goods, ownerId, session);
}

/**
 * Exemplare einer Seite an den neuen Besitzer geben; fehlt eines, scheitert der ganze Abschluss.
 * Gegenstände landen im Gegenstands-Protokoll (Quelle "handel", meta = { trade }).
 */
async function moveLines(list, from, to, session, meta = null) {
  for (const [Model, ids] of [
    [TcgCard, list.filter((l) => !itemByCardId(l.card)).map((l) => l.doc)],
    [Item, list.filter((l) => itemByCardId(l.card)).map((l) => l.doc)],
  ]) {
    if (!ids.length) continue;
    const res = await Model.updateMany({ _id: { $in: ids }, user: from }, { $set: { user: to } }, { session });
    if (res.modifiedCount !== ids.length) throw new UserError('Eine der Karten ist nicht mehr verfügbar.');
  }
  const cards = list.filter((l) => !itemByCardId(l.card)).map((l) => l.card);
  if (cards.length) await markSeen(to, cards, session);
  const moved = list.map((l) => itemByCardId(l.card)).filter(Boolean);
  if (moved.length) {
    await logItems(moved.flatMap((t) => [
      { user: from, type: t.key, delta: -1, source: 'handel', meta },
      { user: to, type: t.key, delta: 1, source: 'handel', meta },
    ]), session);
  }
}

/**
 * Positionen aus dem Formular ({ card } bzw. { copy }) prüfen und vervollständigen: Bei folierten Exemplaren
 * ergibt sich die Karte aus dem Exemplar des Besitzers. Bei fremden Positionen (who gesetzt) muss der Besitzer
 * die Karten in genug Stück besitzen – gesperrt dürfen sie sein, geprüft wird beim Annehmen.
 */
async function prepareLines(list, ownerId, who = null) {
  const copyIds = list.filter((l) => l.copy).map((l) => l.copy);
  if (copyIds.some((id) => !mongoose.isValidObjectId(id))) throw new UserError('Diese folierte Karte gibt es nicht.');
  const copies = copyIds.length ? await TcgCard.find({ _id: { $in: copyIds }, user: ownerId, foiledAt: { $ne: null } }).select('card foiledAt condition.grade').lean() : [];
  const out = list.map((l) => {
    if (!l.copy) return { card: l.card, copy: null, doc: null, foiledAt: null, grade: null };
    const d = copies.find((c) => String(c._id) === String(l.copy));
    if (!d) throw new UserError(who ? `${who} besitzt diese folierte Karte nicht (mehr).` : 'Diese folierte Karte besitzt du nicht (mehr).');
    return { card: d.card, copy: d._id, doc: null, foiledAt: d.foiledAt, grade: d.condition ? d.condition.grade : null };
  });
  if (who) {
    const need = {};
    for (const l of out) if (!l.copy) need[l.card] = (need[l.card] || 0) + 1;
    for (const [card, n] of Object.entries(need)) {
      const item = itemByCardId(card);
      const have = item ? await Item.countDocuments({ user: ownerId, type: item.key }) : await TcgCard.countDocuments({ user: ownerId, card, foiledAt: null });
      if (have < n) throw new UserError(`${who} besitzt ${n > 1 ? n + '× ' : ''}${cardName(card)} nicht${have ? ` (nur ${have})` : ''}.`);
    }
  }
  return out;
}

/** Mitglied per Name finden (nicht gelöscht, nicht ich selbst) */
async function memberByName(name, user) {
  const to = await User.findOne({ usernameLower: String(name).trim().toLowerCase(), deletedAt: null }).select('_id username').lean();
  if (!to) throw new UserError('Diesen Benutzer gibt es nicht.');
  if (to._id.equals(user._id)) throw new UserError('Du kannst dir nicht selbst ein Angebot machen.');
  return to;
}

/** Offenes Markt-Angebot laden */
async function openListing(listingId, session = null) {
  if (!mongoose.isValidObjectId(listingId)) return null;
  return Trade.findOne({ _id: listingId, to: null, ...openFilter() }).session(session);
}

/** Abgelaufene Angebote mit diesen Exemplaren schließen, damit der eindeutige Index nicht blockiert */
async function closeExpiredLocks(ids, session) {
  if (!ids.length) return;
  await Trade.updateMany({ lockDocs: { $in: ids }, status: 'offen', expiresAt: { $lte: new Date() } }, { $set: { status: 'zurueckgezogen', closedAt: new Date() } }, { session });
}

/** Alle offenen Gegenangebote auf ein Markt-Angebot schließen (außer except), mit Hinweis im Chat */
async function closeCounters(listing, text, session, except = null) {
  const filter = { listing: listing._id, status: 'offen', ...(except ? { _id: { $ne: except } } : {}) };
  const others = await Trade.find(filter).select('to').session(session).lean();
  if (others.length) {
    await Trade.updateMany(filter, { $set: { status: 'abgelehnt', closedAt: new Date(), activityAt: new Date() }, $push: { messages: { from: 'system', text } } }, { session });
  }
  return others;
}

// ---------- Aktionen ----------
/**
 * Angebot erstellen – alles aus meiner Sicht: gives = was ich gebe, gets = was ich haben möchte
 * (Positionen aus parseOfferForm), price fließt von mir (iPay) oder zu mir.
 * Ohne toName und listingId: Markt-Angebot. Mit listingId: Gegenangebot auf dieses Markt-Angebot.
 * Eigene Karten werden sofort gesperrt; was ich von der anderen Seite will, wird erst beim Annehmen geprüft.
 */
async function create({ user, toName = null, listingId = null, gives = [], gets = [], price = 0, iPay = false, message = '' }) {
  const firstMessage = String(message || '').trim() ? cleanMessage(message) : null;
  let listing = null;
  let to = null;
  let role = 'seller'; // meine Rolle im neuen Angebot
  if (listingId) {
    listing = await openListing(listingId);
    if (!listing) throw new UserError('Dieses Markt-Angebot gibt es nicht mehr.');
    if (listing.seller.equals(user._id)) throw new UserError('Das ist dein eigenes Markt-Angebot.');
    if (await Trade.exists({ ...openFilter(), listing: listing._id, to: user._id })) throw new UserError('Du verhandelst schon über dieses Angebot.');
    role = 'to';
  } else if (toName) {
    to = await memberByName(toName, user);
  }
  const other = listing ? { _id: listing.seller, username: listing.sellerName } : to;
  const mine = await prepareLines(gives, user._id);
  // Beim Gegenangebot auf dem Markt stehen die Karten des Verkäufers fest
  // Markt-Angebot: Wunschkarten aus allen Karten, belegt beim Tauschen von dem, der annimmt
  const wished = () => gets.map((l) => ({ card: l.card, copy: l.copy || null, doc: null, foiledAt: null, grade: null }));
  const theirs = listing ? listing.give.map((l) => l.toObject()) : other ? await prepareLines(gets, other._id, other.username) : wished();
  const [give, want] = role === 'seller' ? [mine, theirs] : [theirs, mine];
  const extraFrom = price > 0 ? (iPay ? role : otherRole(role)) : null;
  const valid = validateOffer({ give, want, price, extraFrom, listing: !other });
  if ((await Trade.countDocuments({ ...openFilter(), $or: [{ seller: user._id, listing: null }, { to: user._id, listing: { $ne: null } }] })) >= MAX_OPEN) {
    throw new UserError(`Du hast schon ${MAX_OPEN} offene Angebote.`);
  }

  const now = Date.now();
  const expiresAt = !other
    ? new Date(now + MARKET_DAYS * 24 * 3600000)
    : new Date(Math.min(now + PRIVATE_HOURS * 3600000, listing ? listing.expiresAt.getTime() : Infinity));
  try {
    // Sperrprüfung und Angebot in einer Transaktion, damit die Karten nicht gleichzeitig verkauft oder auf eine Quest geschickt werden
    const created = await inTransaction(async (session) => {
      const locked = await resolveLines(user._id, mine, session);
      await claimLines(locked, user._id, session);
      const [g, w] = role === 'seller' ? [locked, theirs] : [theirs, locked];
      const lockDocs = lockDocsOf({ give: g, want: w, listing });
      await closeExpiredLocks(lockDocs, session);
      const [trade] = await Trade.create(
        [
          {
            kind: kindOf({ give: g, want: w, to: other && other._id, listing }),
            seller: role === 'seller' ? user._id : listing.seller,
            sellerName: role === 'seller' ? user.username : listing.sellerName,
            to: role === 'seller' ? (to ? to._id : null) : user._id,
            toName: role === 'seller' ? (to ? to.username : null) : user.username,
            listing: listing ? listing._id : null,
            give: g,
            want: w,
            extraFrom: valid.extraFrom,
            price,
            lockDocs: lockDocs.length ? lockDocs : undefined,
            expiresAt,
            lastChangeBy: role,
            ...(other && {
              activityAt: new Date(),
              [role === 'seller' ? 'sellerSeenAt' : 'toSeenAt']: new Date(),
              messages: firstMessage ? [{ from: role, text: firstMessage }] : [],
            }),
          },
        ],
        { session }
      );
      return trade;
    });
    if (listing) {
      await notify(listing.seller, { area: 'Handel', href: offerHref(created), text: `${user.username} macht ein Gegenangebot zu deinem Markt-Angebot „${lineLabel(listing.give) || lineLabel(listing.want)}“.` });
    } else if (to) {
      await notify(to._id, { area: 'Handel', href: offerHref(created), text: `${user.username} macht dir ein Angebot: ${termsText(created)}.` });
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

/** Buchungsarten: Karten gegen Geld wie bisher als Kauf/Verkauf, sonst als Zahlung im Tausch */
const ledgerTypes = (trade) => (trade.kind === 'tausch' ? { payerType: 'handel_tausch_zahlung', payeeType: 'handel_tausch_erhalt' } : { payerType: 'handel_kauf', payeeType: 'handel_verkauf' });
const dealTitle = (trade) => [lineLabel(trade.give), lineLabel(trade.want)].filter(Boolean).join(' gegen ');

/**
 * Markt-Angebot sofort annehmen – kaufen (Karten gegen Geld), tauschen (Karten gegen die Wunschkarten) oder abgeben
 * (Gesuch: Wunschkarten gegen Geld). Wer annimmt, wird zum Empfänger: seine Wunschkarten werden jetzt belegt,
 * Geld fließt mit Steuer, alle Karten wechseln in einer Transaktion den Besitzer.
 */
async function buy({ user, tradeId }) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  const result = await inTransaction(async (session) => {
    const trade = await openListing(tradeId, session);
    if (!trade) throw new UserError('Dieses Angebot gibt es nicht mehr.');
    if (trade.seller.equals(user._id)) throw new UserError('Das ist dein eigenes Angebot.');

    const want = await resolveLines(user._id, trade.want.map((l) => l.toObject()), session);
    await claimLines(want, user._id, session);
    const money = settlement(trade, { buyer: user._id });
    if (money) {
      const iPay = money.payer.equals(user._id);
      await transfer(money, { title: dealTitle(trade), ...ledgerTypes(trade), payerMsg: iPay ? 'Dein Guthaben reicht dafür nicht aus.' : `${trade.sellerName} hat nicht mehr genug Guthaben.` }, session);
    }
    await moveLines(trade.give, trade.seller, user._id, session, { trade: trade._id });
    await moveLines(want, user._id, trade.seller, session, { trade: trade._id });

    Object.assign(trade, {
      want,
      to: user._id, // wer angenommen hat, ist jetzt die Gegenseite
      toName: user.username,
      status: 'verkauft',
      buyer: user._id,
      buyerName: user.username,
      closedBy: user._id,
      taxPercent: taxService.rate(trade.kind),
      tax: money ? money.tax : 0,
      closedAt: new Date(),
    });
    await trade.save({ session });
    const closed = await closeCounters(trade, `${user.username} hat das Markt-Angebot angenommen – dieses Gegenangebot ist damit erledigt.`, session);
    return { trade, tax: money ? money.tax : 0, closed };
  });
  const { trade, closed } = result;
  const what = !trade.want.length ? `„${lineLabel(trade.give)}“ für ${euro(trade.price)} gekauft` : !trade.give.length ? `dir „${lineLabel(trade.want)}“ für ${euro(trade.price)} gegeben` : `dein Tauschangebot angenommen: ${termsText(trade)}`;
  await notify(trade.seller, { area: 'Handel', href: '/handel?reiter=verlauf', text: `${user.username} hat ${what}.` });
  const label = lineLabel(trade.give) || lineLabel(trade.want);
  for (const c of closed) {
    if (!c.to.equals(user._id)) await notify(c.to, { area: 'Handel', href: offerHref(c), text: `„${label}“ ging an jemand anderen – dein Gegenangebot ist erledigt.` });
  }
  return result;
}

/**
 * Angebot annehmen (alle Arten außer dem Markt-Angebot selbst): Beide Seiten geben ihre Positionen, Geld
 * wird mit Steuer gebucht. Annehmen darf, wer die aktuellen Bedingungen nicht selbst gesetzt hat.
 * Was noch nicht gesperrt ist (die Wünsche an die jeweils andere Seite), wird erst jetzt belegt.
 * version = Stand der Bedingungen, den der Annehmende gesehen hat.
 */
async function accept({ user, tradeId, version }) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  const result = await inTransaction(async (session) => {
    const trade = await Trade.findOne({ _id: tradeId, to: { $ne: null }, ...openFilter() }).session(session);
    const role = trade && roleOf(trade, user._id);
    if (!role) throw new UserError('Dieses Angebot gibt es nicht mehr.');
    if (!canAccept(trade, role)) throw new UserError('Das ist dein eigener Vorschlag – jetzt ist die andere Seite am Zug.');
    if (Number.isInteger(version) && version !== (trade.termsVersion || 0)) {
      throw new UserError('Die Bedingungen wurden gerade geändert. Bitte schau sie dir noch einmal an.');
    }
    const listing = trade.listing ? await openListing(trade.listing, session) : null;
    if (trade.listing && !listing) throw new UserError('Das Markt-Angebot gibt es nicht mehr.');

    const give = await resolveLines(trade.seller, trade.give.map((l) => l.toObject()), session, role === 'seller' ? null : trade.sellerName);
    const want = await resolveLines(trade.to, trade.want.map((l) => l.toObject()), session, role === 'to' ? null : trade.toName);
    await claimLines(give, trade.seller, session);
    await claimLines(want, trade.to, session);

    const money = settlement(trade);
    if (money) {
      const iPay = money.payer.equals(user._id);
      const other = role === 'to' ? trade.sellerName : trade.toName;
      await transfer(money, { title: dealTitle(trade), ...ledgerTypes(trade), payerMsg: iPay ? 'Dein Guthaben reicht dafür nicht aus.' : `${other} hat nicht mehr genug Guthaben.` }, session);
    }
    await moveLines(give, trade.seller, trade.to, session, { trade: trade._id });
    await moveLines(want, trade.to, trade.seller, session, { trade: trade._id });

    Object.assign(trade, {
      give,
      want,
      status: 'verkauft',
      buyer: trade.to, // immer der Empfänger, egal wer zuletzt angenommen hat
      buyerName: trade.toName,
      closedBy: user._id, // wer angenommen hat
      taxPercent: taxService.rate(trade.kind),
      tax: money ? money.tax : 0,
      closedAt: new Date(),
    });
    await trade.save({ session });
    let closed = [];
    if (listing) {
      Object.assign(listing, { status: 'zurueckgezogen', closedVia: trade._id, closedAt: new Date() });
      await listing.save({ session });
      closed = await closeCounters(listing, 'Der Verkäufer hat ein anderes Gegenangebot angenommen.', session, trade._id);
    }
    return { trade, money, role, closed };
  });
  const { trade, role, closed } = result;
  const other = role === 'to' ? trade.seller : trade.to;
  await notify(other, { area: 'Handel', href: offerHref(trade), text: `${user.username} hat dein Angebot angenommen: ${termsText(trade)}.` });
  for (const c of closed) await notify(c.to, { area: 'Handel', href: offerHref(c), text: `„${lineLabel(trade.give)}“ ging an jemand anderen – dein Gegenangebot ist erledigt.` });
  return result;
}

// ---------- Verhandlung ----------
const seenField = (role) => (role === 'seller' ? 'sellerSeenAt' : 'toSeenAt');

/** Verhandlung bzw. Markt-Angebot öffnen (nur Beteiligte); markiert sie als gelesen. Beim eigenen Markt-Angebot mit den Gegenangeboten. */
async function negotiation({ user, tradeId }) {
  if (!mongoose.isValidObjectId(tradeId)) return null;
  const trade = await Trade.findOne({ _id: tradeId }).lean();
  const role = trade && roleOf(trade, user._id);
  if (!role) return null;
  if (trade.to) await Trade.updateOne({ _id: trade._id }, { $set: { [seenField(role)]: new Date() } });
  const counters = !trade.to ? await Trade.find({ listing: trade._id }).select('-messages').sort({ status: 1, activityAt: -1 }).lean() : [];
  const listing = trade.listing ? await Trade.findOne({ _id: trade.listing }).select('-messages').lean() : null;
  return { trade, role, counters, listing };
}

/** Offenes Angebot mit Empfänger laden, an dem der Nutzer beteiligt ist */
async function openOfferFor(user, tradeId, session = null) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  const trade = await Trade.findOne({ _id: tradeId, to: { $ne: null }, ...openFilter() }).select('-messages.text').session(session).lean();
  const role = trade && roleOf(trade, user._id);
  if (!role) throw new UserError('Dieses Angebot ist nicht mehr offen.');
  return { trade, role };
}

/** Nachricht in der Verhandlung schreiben */
async function sendMessage({ user, tradeId, text }) {
  const clean = cleanMessage(text);
  const { trade, role } = await openOfferFor(user, tradeId);
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
  const card = lineLabel(trade.give) || lineLabel(trade.want);
  await notify(role === 'seller' ? trade.to : trade.seller, {
    area: 'Handel',
    href: offerHref(trade),
    key: `handel:${trade._id}:nachricht`,
    text: `${user.username} hat dir in der Verhandlung um „${card}“ geschrieben.`,
    many: (n) => `${n} neue Nachrichten in der Verhandlung um „${card}“.`,
  });
}

/**
 * Gegenangebot: alle Bedingungen neu setzen – aus meiner Sicht gives/gets (wie bei create), Geld price von mir
 * (iPay) oder an mich. Meine neuen Karten werden gesperrt, schon gesperrte, unveränderte Positionen beider Seiten
 * bleiben es, entfernte werden frei. Beim Gegenangebot auf dem Markt stehen die Karten des Verkäufers fest.
 * Danach ist die andere Seite am Zug, das Angebot läuft wieder PRIVATE_HOURS. version = gesehener Stand.
 */
async function counter({ user, tradeId, gives = [], gets = [], price = 0, iPay = false, version }) {
  const { trade, role } = await openOfferFor(user, tradeId);
  const seen = Number.isInteger(version) ? version : trade.termsVersion || 0;
  if (seen !== (trade.termsVersion || 0)) throw new UserError('Die Bedingungen wurden gerade geändert. Bitte schau sie dir noch einmal an.');
  const other = role === 'seller' ? { _id: trade.to, username: trade.toName } : { _id: trade.seller, username: trade.sellerName };
  const myOld = role === 'seller' ? trade.give : trade.want;
  const theirOld = role === 'seller' ? trade.want : trade.give;
  // Beim Gegenangebot auf dem Markt: die Karten des Verkäufers (give) bleiben, wie sie sind
  const fixedGive = !!trade.listing;
  const mine = fixedGive && role === 'seller' ? myOld : carryLines(await prepareLines(gives, user._id), myOld);
  const theirs = fixedGive && role === 'to' ? theirOld : carryLines(await prepareLines(gets, other._id, other.username), theirOld);
  const extraFrom = price > 0 ? (iPay ? role : otherRole(role)) : null;
  const [g0, w0] = role === 'seller' ? [mine, theirs] : [theirs, mine];
  const valid = validateOffer({ give: g0, want: w0, price, extraFrom });
  if (sameLines(g0, trade.give) && sameLines(w0, trade.want) && price === trade.price && valid.extraFrom === (trade.price ? trade.extraFrom || 'to' : null)) {
    throw new UserError('Das sind schon die aktuellen Bedingungen.');
  }
  const actor = role === 'seller' ? trade.sellerName : trade.toName;
  let next;
  try {
    next = await inTransaction(async (session) => {
      // Meine Seite: neue Positionen belegen und sperren; die der anderen Seite bleiben, wie sie sind (unveränderte behalten ihre Sperre)
      const lockedMine = await resolveLines(user._id, mine, session);
      await claimLines(lockedMine.filter((l) => !myOld.some((o) => o.doc && String(o.doc) === String(l.doc))), user._id, session);
      const [give, want] = role === 'seller' ? [lockedMine, theirs] : [theirs, lockedMine];
      const lockDocs = lockDocsOf({ give, want, listing: trade.listing });
      await closeExpiredLocks(lockDocs, session);
      const now = new Date();
      const t = { ...trade, give, want, price, extraFrom: valid.extraFrom };
      const res = await Trade.updateOne(
        // Ältere Angebote haben noch kein termsVersion-Feld – das zählt als Stand 0
        { _id: trade._id, ...openFilter(), termsVersion: { $in: seen === 0 ? [0, null] : [seen] } },
        {
          $set: {
            give,
            want,
            price,
            extraFrom: valid.extraFrom,
            kind: kindOf({ give, want, to: trade.to, listing: trade.listing }),
            lastChangeBy: role,
            activityAt: now,
            [seenField(role)]: now,
            expiresAt: new Date(now.getTime() + PRIVATE_HOURS * 3600000),
            ...(lockDocs.length && { lockDocs }),
          },
          ...(!lockDocs.length && { $unset: { lockDocs: 1 } }),
          $inc: { termsVersion: 1 },
          $push: { messages: { $each: [{ from: 'system', text: `${actor} schlägt vor: ${termsText(t)}.` }], $slice: -MAX_MESSAGES } },
        },
        { session }
      );
      if (res.modifiedCount !== 1) throw new UserError('Die Bedingungen wurden gerade geändert. Bitte schau sie dir noch einmal an.');
      return t;
    });
  } catch (err) {
    if (err.code === 11000) throw new UserError('Eines deiner Exemplare ist schon in einem anderen Angebot.');
    throw err;
  }
  await notify(other._id, { area: 'Handel', href: offerHref(trade), text: `${actor} macht ein Gegenangebot: ${termsText(next)}.` });
  return next;
}

/**
 * Angebot beenden: Wer es angelegt hat, zieht zurück, die andere Seite lehnt ab – die Karten werden wieder frei.
 * Ein zurückgezogenes Markt-Angebot schließt auch alle Gegenangebote darauf.
 */
async function close({ user, tradeId }) {
  if (!mongoose.isValidObjectId(tradeId)) throw new UserError('Angebot nicht gefunden.');
  const found = await Trade.findOne({ _id: tradeId, status: 'offen' }).select('seller to listing give want expiresAt sellerName toName').lean();
  const role = found && roleOf(found, user._id);
  if (!role) throw new UserError('Dieses Angebot gibt es nicht mehr.');
  const status = isCreator(found, role) ? 'zurueckgezogen' : 'abgelehnt';
  const { trade, closed } = await inTransaction(async (session) => {
    const t = await Trade.findOneAndUpdate({ _id: found._id, status: 'offen' }, { $set: { status, closedAt: new Date() } }, { session }).lean();
    if (!t) throw new UserError('Dieses Angebot gibt es nicht mehr.');
    const c = !t.to ? await closeCounters(t, `${t.sellerName} hat das Markt-Angebot zurückgezogen.`, session) : [];
    return { trade: t, closed: c };
  });
  const label = lineLabel(trade.give) || lineLabel(trade.want);
  if (trade.to && trade.expiresAt > new Date()) {
    const other = role === 'seller' ? trade.to : trade.seller;
    const text = status === 'abgelehnt' ? `${user.username} hat dein Angebot „${label}“ abgelehnt.` : `${user.username} hat das Angebot „${label}“ zurückgezogen.`;
    await notify(other, { area: 'Handel', href: offerHref(trade), text });
  }
  for (const c of closed) await notify(c.to, { area: 'Handel', href: offerHref(c), text: `${trade.sellerName} hat „${label}“ vom Markt genommen – dein Gegenangebot ist erledigt.` });
  return { trade, status };
}

module.exports = {
  PRIVATE_HOURS,
  MARKET_DAYS,
  MAX_PRICE,
  MAX_LINES,
  MESSAGE_MAX,
  taxFor,
  taxOf,
  taxRates,
  validateOffer,
  settlement,
  parseOfferForm,
  carryLines,
  sameLines,
  openFilter,
  roleOf,
  otherRole,
  canAccept,
  isCreator,
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
  accept,
  negotiation,
  sendMessage,
  counter,
  close,
};

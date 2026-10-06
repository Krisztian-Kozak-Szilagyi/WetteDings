const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const { Trade, openFilter } = require('../models/Trade');
const { requireLogin } = require('../middleware');
const catalog = require('../tcg/catalog');
const { collection } = require('../tcg/collection');
const trade = require('../trade/tradeService');
const lines = require('../trade/lines');
const blackMarket = require('../tcg/blackMarket');
const foil = require('../items/foil');
const items = require('../items/itemService');
const { str, UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');

const router = express.Router();
router.use('/handel', requireLogin);

const TABS = ['markt', 'an-mich', 'meine', 'verlauf'];

/** Karte – oder Gegenstand ("item:folie") – für die Anzeige */
const cardInfo = (id) => {
  const item = items.itemByCardId(id);
  return item ? items.itemCard(item) : catalog.cardById[id] || { id, name: id, rarity: 'crumpled', image: '' };
};
/** Seltenheiten samt der Pseudo-Seltenheit "Gegenstand" */
const tradeRarities = () => ({ ...catalog.rarityByKey, item: items.ITEM_RARITY });
/** Kartenwert einer Position: Bankwert, bei folierten Karten mit Wertsteigerung */
const lineValue = (l) => {
  const c = cardInfo(l.card);
  if (c.isItem) return c.sell;
  const r = catalog.rarityByKey[c.rarity];
  return foil.cardValue(r ? r.sell : 0, l.foiledAt);
};
const linesValue = (list) => (list || []).reduce((s, l) => s + lineValue(l), 0);
/** Art des Angebots als Wort */
const offerLabel = (t) => (!t.to ? 'Markt' : t.listing ? 'Gegenangebot' : t.give.length && t.want.length ? 'Tausch' : t.give.length ? 'Verkauf' : 'Kaufanfrage');

/** Helfer für alle Handels-Ansichten */
const viewHelpers = () => ({
  cardInfo,
  rarityByKey: tradeRarities(),
  lineValue,
  linesValue,
  offerLabel,
  perspective: lines.perspective,
  lineLabel: lines.lineLabel,
  countText: lines.countText,
  roleOf: trade.roleOf,
  canAccept: trade.canAccept,
  isCreator: trade.isCreator,
  isUnread: trade.isUnread,
  taxFor: trade.taxOf,
  taxRates: trade.taxRates(),
  foil,
  privateHours: trade.PRIVATE_HOURS,
  marketDays: trade.MARKET_DAYS,
  maxLines: trade.MAX_LINES,
});

/** Adresse des Handelsfensters mit Vorauswahl (gives/gets aus meiner Sicht, wie parseOfferForm sie liefert) */
function builderUrl({ an = '', markt = '', gives = [], gets = [], price = 0, iPay = true } = {}) {
  const q = new URLSearchParams();
  if (an) q.set('an', an);
  if (markt) q.set('markt', String(markt));
  const add = (key, list) => list.forEach((l) => q.append(key, l.copy ? 'f:' + l.copy : l.card));
  add('gib', gives);
  add('will', gets);
  if (price > 0) q.set(iPay ? 'geld_gib' : 'geld_will', (price / 100).toFixed(2).replace('.', ','));
  const s = q.toString();
  return '/handel/neu' + (s ? '?' + s : '');
}

/** Positionen als Formular-Vorauswahl: { counts: { karte: n }, copies: Set(Exemplar) } */
function presetOf(list) {
  const counts = {};
  const copies = new Set();
  for (const l of list) {
    if (l.copy) copies.add(String(l.copy));
    else counts[l.card] = (counts[l.card] || 0) + 1;
  }
  return { counts, copies };
}

/**
 * Was ein Mitglied in einem Angebot geben kann: freie Karten (unfoliert) je Karte, folierte Exemplare und Gegenstände.
 * own = eigene Sammlung (nur freie; Exemplare, die dieses Angebot selbst sperrt, zählen wieder als frei),
 * sonst fremde Sammlung (alles, was sie besitzt – gesperrt darf es sein, geprüft wird beim Annehmen).
 */
async function pickable(member, { own, keep = [] } = {}) {
  const [coll, inv] = await Promise.all([collection(member), items.itemInventory(member._id)]);
  // Exemplare, die dieses Angebot schon sperrt (nur zugesagte Positionen mit doc)
  const keepCards = {};
  const keepItems = {};
  const keepCopies = new Set();
  for (const l of keep.filter((x) => x.doc)) {
    if (l.foiledAt) keepCopies.add(String(l.doc));
    else if (items.itemByCardId(l.card)) keepItems[l.card] = (keepItems[l.card] || 0) + 1;
    else keepCards[l.card] = (keepCards[l.card] || 0) + 1;
  }
  const cards = catalog.CARDS.map((c) => {
    const plain = (coll.counts[c.id] || 0) - (coll.foiledByCard[c.id] || 0);
    const max = own ? Math.max(0, (coll.free[c.id] || 0) + (keepCards[c.id] || 0)) : Math.max(0, plain);
    return { card: c, max, owned: plain };
  }).filter((x) => x.max > 0);
  const foiled = Object.entries(coll.foiledCopies)
    .flatMap(([id, list]) => list.map((f) => ({ ...f, card: catalog.cardById[id], lock: keepCopies.has(f.id) ? null : f.lock })))
    .filter((f) => f.card && (!own || !f.lock));
  const goods = inv
    .filter((it) => it.tradable) // nur Gegenstände, die sich handeln lassen (src/items/types.js)
    .map((it) => {
      const id = items.itemCardId(it.key);
      return { card: items.itemCard(it), max: own ? it.count - it.inTrade + (keepItems[id] || 0) : it.count };
    })
    .filter((x) => x.max > 0);
  return { cards, foiled, goods, counts: coll.counts };
}

/**
 * Wunschkarten für ein Markt-Angebot: alle sichtbaren Karten und Gegenstände (je bis zu MAX_LINES Stück).
 * counts = eigene Sammlung (Anzeige "du hast …").
 */
function wishPool(counts) {
  const visible = new Set(catalog.visibleRarities().map((r) => r.key));
  return {
    cards: catalog.CARDS.filter((c) => visible.has(c.rarity)).map((c) => ({ card: c, max: trade.MAX_LINES, owned: counts[c.id] || 0 })),
    foiled: [],
    goods: items.ITEM_TYPES.filter((t) => t.tradable).map((t) => ({ card: items.itemCard(t), max: trade.MAX_LINES })),
    counts,
  };
}

// ---------- Handelsseite ----------
router.get('/handel', async (req, res) => {
  const [data, market, coll] = await Promise.all([
    trade.overview(req.user),
    blackMarket.today(), // Black Market (16:30–19:00): vier Karten, jede nur einmal
    collection(req.user),
    // Besuch merken: der Markt gilt ab jetzt als gesehen
    User.updateOne({ _id: req.user._id }, { $set: { marketSeenAt: new Date(), dealsSeenAt: new Date() } }),
  ]);
  res.locals.tradeMarketNew = 0;
  // die gerade gezeigten neuen Geschäfte zählen im Abzeichen nicht mehr mit
  res.locals.tradeIncoming = Math.max(0, (res.locals.tradeIncoming || 0) - data.newDeals.length);
  const asked = str(req.query.reiter);
  res.render('handel', {
    title: 'Handel',
    ...data,
    ...viewHelpers(),
    coll,
    tab: TABS.includes(asked) ? asked : 'markt',
    rarities: catalog.visibleRarities(),
    blackMarket: { ...market, openTime: blackMarket.OPEN, closeTime: blackMarket.CLOSE, percent: blackMarket.PRICE_PERCENT },
  });
});

// Black Market: eine der vier Karten kaufen
router.post('/handel/black-market', async (req, res) => {
  try {
    const r = await blackMarket.buy({ user: req.user, index: str(req.body.index) });
    req.flash('success', `Gekauft: ${r.card.name} (${catalog.rarityByKey[r.card.rarity].label}) für ${euro(r.price)}. Die Karte liegt in deinem Album.`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/handel#blackmarket');
});

// ---------- Handelsfenster ----------
/**
 * Handelsfenster rendern. mode: 'neu' (Markt oder Mitglied), 'markt' (Gegenangebot auf ein Markt-Angebot),
 * 'gegen' (Gegenangebot in einer laufenden Verhandlung). fixedGets: Karten der anderen Seite, die feststehen.
 */
async function renderBuilder(req, res, { mode, partner = null, listing = null, offer = null, preset, keep = [], fixedGets = null, fixedGives = null, reference = null }) {
  const [mine, partnerPool, users] = await Promise.all([
    pickable(req.user, { own: true, keep }),
    partner && !fixedGets ? pickable(partner, { own: false }) : null,
    mode === 'neu' ? User.find({ _id: { $ne: req.user._id }, deletedAt: null }).select('username').sort({ usernameLower: 1 }).lean() : [],
  ]);
  // Eigenes Markt-Angebot: Wunschkarten aus allen Karten
  const theirs = partnerPool || (mode === 'neu' && !partner ? wishPool(mine.counts) : null);
  res.render('handel-neu', {
    title: mode === 'neu' ? 'Neuer Handel' : 'Gegenangebot',
    ...viewHelpers(),
    mode,
    partner,
    listing,
    offer,
    mine,
    theirs,
    users,
    fixedGets,
    fixedGives,
    // Bezug fürs Geld beim Gegenangebot: was verlangt wird bzw. bisher stand ({ pay, receive, label })
    reference,
    give: presetOf(preset.gives),
    get: presetOf(preset.gets),
    pay: preset.iPay ? preset.price : 0,
    receive: preset.iPay ? 0 : preset.price,
    rarities: catalog.visibleRarities(),
    cards: catalog.CARDS,
    balance: req.user.balance,
  });
}

/** Vorauswahl aus der Adresse lesen (ungültige Beträge ignorieren) */
function presetFrom(query) {
  try {
    return trade.parseOfferForm(query);
  } catch {
    return { ...trade.parseOfferForm({ ...query, geld_gib: '', geld_will: '' }) };
  }
}

router.get('/handel/neu', async (req, res) => {
  const preset = presetFrom(req.query);
  const listingId = str(req.query.markt);
  if (listingId) {
    const listing = mongoose.isValidObjectId(listingId) ? await Trade.findOne({ _id: listingId, to: null, ...openFilter() }).lean() : null;
    if (!listing || listing.seller.equals(req.user._id)) {
      req.flash('error', listing ? 'Das ist dein eigenes Markt-Angebot.' : 'Dieses Markt-Angebot gibt es nicht mehr.');
      return res.redirect('/handel');
    }
    const mineOpen = await Trade.findOne({ ...openFilter(), listing: listing._id, to: req.user._id }).select('_id').lean();
    if (mineOpen) return res.redirect(`/handel/angebot/${mineOpen._id}`);
    // Ohne eigene Vorauswahl: vorbelegt mit den Wunschkarten und dem Preis des Markt-Angebots – zum Anpassen
    const fresh = !preset.gives.length && !preset.price;
    const listingPayer = listing.price ? listing.extraFrom || 'to' : null;
    const start = fresh ? { gives: listing.want.map((l) => ({ card: l.card })), gets: [], price: listing.price, iPay: listingPayer === 'to' } : { ...preset, gets: [] };
    const ask = lines.perspective(listing, 'to'); // aus Sicht des Interessenten
    return renderBuilder(req, res, { mode: 'markt', partner: { _id: listing.seller, username: listing.sellerName }, listing, preset: start, fixedGets: listing.give, reference: { pay: ask.pay, receive: ask.receive, label: 'verlangt' } });
  }
  const name = str(req.query.an).trim();
  let partner = null;
  if (name) {
    partner = await User.findOne({ usernameLower: name.toLowerCase(), deletedAt: null }).select('username').lean();
    if (!partner || partner._id.equals(req.user._id)) {
      req.flash('error', partner ? 'Du kannst dir nicht selbst ein Angebot machen.' : `Ein Mitglied „${name}“ gibt es nicht.`);
      return res.redirect(builderUrl({ gives: preset.gives }));
    }
  }
  // Markt: Wunschkarten nur als Karten, kein bestimmtes Exemplar
  return renderBuilder(req, res, { mode: 'neu', partner, preset: partner ? preset : { ...preset, gets: preset.gets.filter((l) => !l.copy) } });
});

// Alte Tausch-Adresse (Profil, Inventar, alte Links): ins Handelsfenster
router.get('/handel/tausch', (req, res) => {
  const q = new URLSearchParams();
  if (str(req.query.an)) q.set('an', str(req.query.an));
  if (str(req.query.karte)) q.append('gib', str(req.query.karte));
  if (str(req.query.will)) q.append('will', str(req.query.will));
  res.redirect('/handel/neu' + (q.toString() ? '?' + q : ''));
});

/** Aktion ausführen, Meldung setzen (keine bei leerem Ergebnis); Erfolg führt nach next(Ergebnis), ein Fehler nach back */
async function handle(req, res, fn, back = '/handel', next = '/handel') {
  try {
    const result = await fn();
    const message = typeof result === 'string' ? result : result && result.message;
    if (message) req.flash('success', message);
    return res.redirect(typeof next === 'function' ? next(result) : next);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
    return res.redirect(typeof back === 'function' ? back() : back);
  }
}

router.post('/handel/angebot', (req, res) => {
  const toName = str(req.body.to).trim();
  const listingId = str(req.body.markt);
  let form = { gives: [], gets: [], price: 0, iPay: true };
  return handle(
    req,
    res,
    async () => {
      form = trade.parseOfferForm(req.body);
      const t = await trade.create({ user: req.user, toName: toName || null, listingId: listingId || null, ...form, message: str(req.body.nachricht) });
      const message = !t.to
        ? `Dein Angebot steht jetzt auf dem Markt: ${lines.termsText(t).replace(/^[^ ]+ gibt /, 'du gibst ')}.`
        : t.listing
          ? `Gegenangebot an ${t.sellerName} gesendet.`
          : `Angebot an ${t.toName} gesendet.`;
      return { message, trade: t };
    },
    () => builderUrl({ an: toName, markt: listingId, ...form }),
    (r) => (r.trade.to ? `/handel/angebot/${r.trade._id}` : '/handel?reiter=meine')
  );
});

// ---------- Ein Angebot: Verhandlung, Gegenangebot, Abschluss ----------
const offerUrl = (id) => `/handel/angebot/${id}`;
const messageView = (m) => ({ from: m.from, text: m.text, at: m.createdAt });
const version = (req) => (/^\d+$/.test(str(req.body.version)) ? Number(req.body.version) : undefined);

// Alte Verhandlungs-Adresse (gespeicherte Benachrichtigungen)
router.get('/handel/verhandlung/:id', (req, res) => res.redirect(offerUrl(req.params.id)));

router.get('/handel/angebot/:id', async (req, res) => {
  const n = await trade.negotiation({ user: req.user, tradeId: req.params.id });
  if (!n) return res.status(404).render('error', { title: 'Angebot', status: 404, message: 'Dieses Angebot gibt es nicht oder du bist nicht beteiligt.' });
  const t = n.trade;
  const isOpen = t.status === 'offen' && new Date(t.expiresAt) > new Date();
  const coll = await collection(req.user);
  res.render('handel-angebot', {
    title: t.to ? 'Verhandlung' : 'Markt-Angebot',
    ...viewHelpers(),
    t,
    role: n.role,
    counters: n.counters,
    listing: n.listing,
    isOpen,
    mayAccept: isOpen && trade.canAccept(t, n.role),
    coll,
    balance: req.user.balance,
    termsText: lines.termsText,
    messageMax: trade.MESSAGE_MAX,
  });
});

// Live-Aktualisierung: neue Nachrichten seit "seit" und der aktuelle Stand der Bedingungen
router.get('/handel/angebot/:id/stand', async (req, res) => {
  const n = await trade.negotiation({ user: req.user, tradeId: req.params.id });
  if (!n) return res.status(404).json({ error: 'nicht gefunden' });
  const since = new Date(str(req.query.seit));
  const fresh = (n.trade.messages || []).filter((m) => Number.isNaN(since.getTime()) || new Date(m.createdAt) > since);
  res.json({ version: n.trade.termsVersion || 0, status: n.trade.status, messages: fresh.map(messageView) });
});

router.post('/handel/angebot/:id/nachricht', (req, res) => {
  const url = offerUrl(req.params.id) + '#chat';
  return handle(req, res, async () => {
    await trade.sendMessage({ user: req.user, tradeId: req.params.id, text: str(req.body.text) });
    return null;
  }, url, url);
});

// Gegenangebot: Handelsfenster mit den aktuellen Bedingungen aus meiner Sicht (oder dem zuletzt versuchten Stand)
router.get('/handel/angebot/:id/gegenangebot', async (req, res) => {
  const n = await trade.negotiation({ user: req.user, tradeId: req.params.id });
  const t = n && n.trade;
  if (!t || !t.to || t.status !== 'offen' || new Date(t.expiresAt) <= new Date()) {
    req.flash('error', 'Dieses Angebot ist nicht mehr offen.');
    return res.redirect(t ? offerUrl(t._id) : '/handel');
  }
  const role = n.role;
  const p = lines.perspective(t, role);
  const fromQuery = Object.keys(req.query).some((k) => k.startsWith('gib') || k.startsWith('will') || k.startsWith('geld'));
  const preset = fromQuery ? presetFrom(req.query) : { gives: p.gives, gets: p.gets, price: t.price, iPay: p.pay > 0 };
  const partner = role === 'seller' ? { _id: t.to, username: t.toName } : { _id: t.seller, username: t.sellerName };
  // Beim Gegenangebot auf dem Markt stehen die Karten des Verkäufers fest
  const fixed = t.listing ? t.give : null;
  return renderBuilder(req, res, {
    reference: { pay: p.pay, receive: p.receive, label: 'bisher' },
    mode: 'gegen',
    partner,
    offer: t,
    preset,
    keep: p.gives,
    fixedGets: fixed && role === 'to' ? fixed : null,
    fixedGives: fixed && role === 'seller' ? fixed : null,
  });
});

router.post('/handel/angebot/:id/gegenangebot', (req, res) => {
  let form = { gives: [], gets: [], price: 0, iPay: true };
  const back = () => {
    const url = builderUrl(form);
    return offerUrl(req.params.id) + '/gegenangebot' + (url.includes('?') ? url.slice(url.indexOf('?')) : '');
  };
  return handle(req, res, async () => {
    form = trade.parseOfferForm(req.body);
    await trade.counter({ user: req.user, tradeId: req.params.id, ...form, version: version(req) });
    return 'Gegenangebot gesendet – jetzt ist die andere Seite am Zug.';
  }, back, offerUrl(req.params.id));
});

router.post('/handel/angebot/:id/kaufen', (req, res) =>
  handle(req, res, async () => {
    const r = await trade.buy({ user: req.user, tradeId: req.params.id });
    const p = lines.perspective(r.trade, 'to');
    return `Abgeschlossen: Du bekommst ${lines.sideText(p.gets, p.receive)} und gibst ${lines.sideText(p.gives, p.pay)}.`;
  }, '/handel', '/handel?reiter=verlauf')
);

router.post('/handel/angebot/:id/annehmen', (req, res) => {
  const back = str(req.body.zurueck) === 'liste' ? '/handel?reiter=an-mich' : offerUrl(req.params.id);
  return handle(req, res, async () => {
    const r = await trade.accept({ user: req.user, tradeId: req.params.id, version: version(req) });
    const p = lines.perspective(r.trade, r.role);
    return `Abgeschlossen: Du bekommst ${lines.sideText(p.gets, p.receive)} und gibst ${lines.sideText(p.gives, p.pay)}.`;
  }, back, offerUrl(req.params.id));
});

router.post('/handel/angebot/:id/beenden', (req, res) => {
  const back = str(req.body.zurueck) === 'liste' ? '/handel?reiter=' + (str(req.body.reiter) || 'meine') : offerUrl(req.params.id);
  return handle(req, res, async () => {
    const r = await trade.close({ user: req.user, tradeId: req.params.id });
    return r.status === 'abgelehnt' ? 'Angebot abgelehnt.' : 'Angebot zurückgezogen – deine Karten sind wieder frei.';
  }, back, back);
});

module.exports = router;
module.exports.builderUrl = builderUrl;

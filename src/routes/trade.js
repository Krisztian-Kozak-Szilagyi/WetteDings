const express = require('express');
const User = require('../models/User');
const { requireLogin } = require('../middleware');
const catalog = require('../tcg/catalog');
const { collection } = require('../tcg/collection');
const trade = require('../trade/tradeService');
const blackMarket = require('../tcg/blackMarket');
const foil = require('../items/foil');
const items = require('../items/itemService');
const { str, parseEuro, UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');

const router = express.Router();
router.use('/handel', requireLogin);

/** Karte – oder Gegenstand ("item:folie") – für die Anzeige */
const cardInfo = (id) => {
  const item = items.itemByCardId(id);
  return item ? items.itemCard(item) : catalog.cardById[id] || { id, name: id, rarity: 'crumpled', image: '' };
};
/** Seltenheiten samt der Pseudo-Seltenheit "Gegenstand" */
const tradeRarities = () => ({ ...catalog.rarityByKey, item: items.ITEM_RARITY });
/** Zurück in den Handel-Dialog derselben Karte, Reiter "Tauschen" (Partner vorausgefüllt) */
const swapDialogUrl = (cardId, name) => '/handel?' + new URLSearchParams({ karte: cardId, reiter: 'tausch', an: name || '' }) + '#sammlung';

router.get('/handel', async (req, res) => {
  const [data, market] = await Promise.all([
    trade.overview(req.user),
    blackMarket.today(), // Black Market (16:30–19:00): vier Karten, jede nur einmal
    // Besuch merken: der Markt gilt ab jetzt als gesehen
    User.updateOne({ _id: req.user._id }, { $set: { marketSeenAt: new Date(), dealsSeenAt: new Date() } }),
  ]);
  res.locals.tradeMarketNew = 0;
  // die gerade gezeigten neuen Geschäfte zählen im Abzeichen nicht mehr mit
  res.locals.tradeIncoming = Math.max(0, (res.locals.tradeIncoming || 0) - data.newDeals.length);

  res.render('handel', {
    title: 'Handel',
    ...data,
    cards: catalog.CARDS,
    rarities: catalog.visibleRarities(),
    cardInfo,
    rarityByKey: tradeRarities(),
    taxRates: trade.taxRates(),
    taxFor: trade.taxOf,
    canAccept: trade.canAccept,
    isUnread: trade.isUnread,
    termsText: trade.termsText,
    swapSides: trade.swapSides,
    sideText: trade.sideText,
    foil,
    privateHours: trade.PRIVATE_HOURS,
    marketDays: trade.MARKET_DAYS,
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

// ---------- Tausch zusammenstellen (#76: je Seite 1–5 Karten) ----------
// Auswahl einer Seite als Liste: Karten-ID je Exemplar (doppelt = zweimal), "f:<Exemplar>" = bestimmtes foliertes
const listOf = (v) => [].concat(v || []).map(String).slice(0, 50);
/** Auswahl aus dem Formular: Checkbox je Karte (name) mit Anzahl (name-anzahl-<id>) und folierte Exemplare */
function pickedList(body, name) {
  const out = [];
  for (const v of listOf(body[name])) {
    if (v.startsWith('f:')) {
      out.push(v);
      continue;
    }
    if (!catalog.cardById[v]) continue;
    const n = Number.parseInt(str(body[`${name}-anzahl-${v}`]), 10);
    const times = Number.isInteger(n) && n > 1 ? Math.min(n, trade.MAX_SWAP_CARDS) : 1;
    for (let i = 0; i < times; i++) out.push(v);
  }
  return out;
}
const toRawLines = (list) => list.map((v) => (v.startsWith('f:') ? { copy: v.slice(2) } : { card: v }));
const toPicks = (lines) => lines.map((l) => (l.copy ? 'f:' + l.copy : l.card));
/** { cardId: Anzahl } und Set der folierten Exemplare "f:<id>" für die Vorauswahl */
const pickState = (list) => {
  const counts = {};
  const foils = new Set();
  for (const v of list) {
    if (v.startsWith('f:')) foils.add(v);
    else counts[v] = (counts[v] || 0) + 1;
  }
  return { counts, foils };
};
const swapPageUrl = (q) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) for (const x of [].concat(v)) if (x) p.append(k, x);
  return '/handel/tausch?' + p;
};
/** Wer zahlt: Formularwert "ich"/"partner" → Rolle im Angebot */
const payerRole = (value, myRole) => (value === 'partner' ? trade.otherRole(myRole) : value === 'ich' ? myRole : null);

/**
 * Tauschangebot zusammenstellen: links die eigenen Karten, rechts die Sammlung des Mitspielers.
 * Mit gegen=<Angebot>: Gegenvorschlag mit anderen Karten in einer laufenden Verhandlung.
 */
router.get('/handel/tausch', async (req, res) => {
  let name = str(req.query.an).trim();
  let myPicks = listOf(req.query.karte);
  let theirPicks = listOf(req.query.will);
  let pickPrice = str(req.query.preis);
  let pickFrom = str(req.query.zahlt);
  let counter = null;
  const counterId = str(req.query.gegen);
  if (counterId) {
    const n = await trade.negotiation({ user: req.user, tradeId: counterId });
    if (!n || n.trade.kind !== 'tausch' || n.trade.status !== 'offen' || new Date(n.trade.expiresAt) <= new Date()) {
      req.flash('error', 'Diese Verhandlung ist nicht mehr offen.');
      return res.redirect('/handel');
    }
    const t = n.trade;
    const sides = trade.swapSides(t);
    counter = { id: String(t._id), version: t.termsVersion || 0 };
    name = n.role === 'seller' ? t.toName : t.sellerName;
    // nach einem Fehler kommt die Auswahl aus der URL, sonst aus den aktuellen Bedingungen
    if (!req.query.karte && !req.query.will) {
      myPicks = toPicks(n.role === 'seller' ? sides.give : sides.take);
      theirPicks = toPicks(n.role === 'seller' ? sides.take : sides.give);
      pickPrice = t.price ? (t.price / 100).toFixed(2).replace('.', ',') : '';
      pickFrom = t.price ? ((t.extraFrom || 'to') === n.role ? 'ich' : 'partner') : '';
    }
  }
  const partner = name && (await User.findOne({ usernameLower: name.toLowerCase(), deletedAt: null }).select('username').lean());
  if (!partner || partner._id.equals(req.user._id)) {
    req.flash('error', name ? 'Mit diesem Mitglied kannst du nicht tauschen.' : 'Bitte wähle aus, mit wem du tauschen möchtest.');
    return res.redirect(myPicks[0] ? swapDialogUrl(myPicks[0], name) : '/handel');
  }
  const [mine, theirs, myFoiled, theirFoiled] = await Promise.all([collection(req.user), collection(partner), items.foiledCards(req.user._id), items.foiledCards(partner._id)]);
  const firstPick = myPicks[0] || '';
  res.render('handel-tausch', {
    title: 'Tausch',
    partner,
    mine,
    theirs,
    // folierte Karten werden einzeln gewählt (Wert "f:<Exemplar>"); eigene nur, wenn sie nicht schon im Handel stehen
    myFoiled: myFoiled.filter((f) => !f.lock),
    theirFoiled,
    cards: catalog.CARDS,
    rarities: catalog.visibleRarities(),
    rarityByKey: catalog.rarityByKey,
    pickCard: firstPick,
    mySel: pickState(myPicks),
    theirSel: pickState(theirPicks),
    counter,
    maxCards: trade.MAX_SWAP_CARDS,
    // Ein Schritt zurück: zur Verhandlung, aus dem Handel-Dialog dorthin, sonst (Profil) zum Profil
    backUrl: counter ? negotiationUrl(counter.id) : firstPick && !firstPick.startsWith('f:') ? swapDialogUrl(firstPick, partner.username) : `/profil/${encodeURIComponent(partner.username)}`,
    pickPrice,
    pickFrom,
    taxPercent: trade.taxRates().tausch,
    privateHours: trade.PRIVATE_HOURS,
  });
});

/** Aktion ausführen, Meldung setzen (keine bei leerem Ergebnis); Erfolg führt nach next, ein Fehler nach back */
async function handle(req, res, fn, back = '/handel', next = '/handel') {
  try {
    const message = await fn();
    if (message) req.flash('success', message);
    return res.redirect(next);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
    return res.redirect(back);
  }
}

// copy = ein foliertes Exemplar, item = ein Gegenstand aus dem Inventar anbieten (dann geht es auch dorthin zurück)
router.post('/handel/angebot', (req, res) => {
  const copyId = str(req.body.copy) || null;
  const itemKey = str(req.body.item);
  const back = itemKey ? '/inventar#gegenstaende' : '/handel';
  return handle(
    req,
    res,
    async () => {
      const toName = str(req.body.to).trim() || null;
      const cardId = itemKey ? items.itemCardId(itemKey) : str(req.body.card);
      const t = await trade.create({ user: req.user, kind: toName ? 'privat' : 'markt', cardId, price: parseEuro(str(req.body.price)), toName, copyId });
      const name = cardInfo(t.card).name;
      return t.kind === 'privat' ? `Angebot an ${t.toName} gesendet: ${name} für ${euro(t.price)}.` : `${name} steht jetzt für ${euro(t.price)} auf dem Markt.`;
    },
    back,
    back
  );
});

router.post('/handel/tausch', (req, res) => {
  const toName = str(req.body.to).trim();
  const mine = pickedList(req.body, 'card');
  const theirs = pickedList(req.body, 'want');
  const rawPrice = str(req.body.price).trim();
  const from = str(req.body.extra);
  // Bei einem Fehler zurück zur Auswahl, mit allem, was schon gewählt war
  const back = swapPageUrl({ an: toName, karte: mine, will: theirs, preis: rawPrice, zahlt: from });
  return handle(
    req,
    res,
    async () => {
      await trade.createSwap({
        user: req.user,
        toName,
        give: toRawLines(mine),
        take: toRawLines(theirs),
        price: rawPrice ? parseEuro(rawPrice) : 0,
        extraFrom: payerRole(from, 'seller'),
        message: str(req.body.message),
      });
      return null;
    },
    back
  );
});

// Gegenvorschlag mit anderen Karten (von der Tausch-Seite mit gegen=<Angebot>)
router.post('/handel/verhandlung/:id/karten', async (req, res) => {
  const id = req.params.id;
  const mine = pickedList(req.body, 'card');
  const theirs = pickedList(req.body, 'want');
  const rawPrice = str(req.body.price).trim();
  const from = str(req.body.extra);
  const back = swapPageUrl({ gegen: id, karte: mine, will: theirs, preis: rawPrice, zahlt: from });
  return handle(
    req,
    res,
    async () => {
      const n = await trade.negotiation({ user: req.user, tradeId: id });
      if (!n || n.trade.kind !== 'tausch') throw new UserError('Diese Verhandlung gibt es nicht.');
      const seller = n.role === 'seller';
      await trade.changeTerms({
        user: req.user,
        tradeId: id,
        price: rawPrice ? parseEuro(rawPrice) : 0,
        extraFrom: payerRole(from, n.role),
        version: versionOf(req),
        give: toRawLines(seller ? mine : theirs),
        take: toRawLines(seller ? theirs : mine),
      });
      return null;
    },
    back,
    negotiationUrl(id)
  );
});

// ---------- Verhandlung: Tausch, privater Verkauf und Gespräch über ein Markt-Angebot (#82) ----------
const negotiationUrl = (id) => `/handel/verhandlung/${id}`;
const talkUrl = (id) => `/handel/gespraech/${id}`;
const messageView = (m) => ({ from: m.from, text: m.text, at: m.createdAt });
const versionOf = (req) => (/^\d+$/.test(str(req.body.version)) ? Number(req.body.version) : undefined);
const notFound = (res) => res.status(404).render('error', { title: 'Verhandlung', status: 404, message: 'Diese Verhandlung gibt es nicht oder du bist nicht beteiligt.' });

/** Seite einer Verhandlung; base = URL-Anfang für Nachrichten/Vorschläge, acceptUrl/closeUrl = Formulare */
async function renderNegotiation(req, res, { t, role, isOpen, base, acceptUrl, closeUrl, closeLabel, closeConfirm }) {
  const coll = isOpen && t.kind === 'tausch' ? await collection(req.user) : null;
  const hasFree = (c, lines) => {
    const need = {};
    for (const l of lines) if (!l.copy && !l.doc) need[l.card] = (need[l.card] || 0) + 1;
    return Object.entries(need).every(([card, n]) => (c.free[card] || 0) >= n);
  };
  res.render('handel-verhandlung', {
    title: 'Verhandlung',
    t,
    role,
    isOpen,
    canAccept: isOpen && trade.canAccept(t, role),
    // Hat der Annehmende seine Karten gerade frei? (nur für den Hinweis; geprüft wird beim Annehmen)
    wantFree: !coll || hasFree(coll, trade.swapSides(t)[role === 'seller' ? 'give' : 'take']),
    base,
    acceptUrl,
    closeUrl,
    closeLabel,
    closeConfirm,
    cardInfo,
    rarityByKey: tradeRarities(),
    termsText: trade.termsText,
    sides: t.kind === 'tausch' ? trade.swapSides(t) : null,
    sideText: trade.sideText,
    taxFor: (price) => trade.taxOf(price, t.kind),
    taxPercent: trade.taxRates()[t.kind],
    privateHours: trade.PRIVATE_HOURS,
    messageMax: trade.MESSAGE_MAX,
  });
}

router.get('/handel/verhandlung/:id', async (req, res) => {
  const n = await trade.negotiation({ user: req.user, tradeId: req.params.id });
  if (!n) return notFound(res);
  const t = n.trade;
  const id = String(t._id);
  const reject = n.role === 'to';
  await renderNegotiation(req, res, {
    t,
    role: n.role,
    isOpen: t.status === 'offen' && new Date(t.expiresAt) > new Date(),
    base: negotiationUrl(id),
    acceptUrl: `/handel/${id}/${t.kind === 'tausch' ? 'tauschen' : 'kaufen'}`,
    closeUrl: `/handel/${id}/${reject ? 'ablehnen' : 'zurueckziehen'}`,
    closeLabel: reject ? 'Ablehnen' : 'Zurückziehen',
    closeConfirm: `${t.kind === 'tausch' ? 'Tauschangebot' : 'Angebot'} ${reject ? 'ablehnen' : 'zurückziehen'}?`,
  });
});

// Gespräch über ein Markt-Angebot beginnen (oder das bestehende öffnen)
router.post('/handel/:id/verhandeln', async (req, res) => {
  try {
    const talk = await trade.startTalk({ user: req.user, tradeId: req.params.id });
    return res.redirect(talkUrl(talk._id));
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
    return res.redirect('/handel#markt');
  }
});

router.get('/handel/gespraech/:id', async (req, res) => {
  const n = await trade.talkFor({ user: req.user, talkId: req.params.id });
  if (!n) return notFound(res);
  const id = String(n.talk._id);
  await renderNegotiation(req, res, {
    t: n.talk,
    role: n.role,
    isOpen: n.isOpen,
    base: talkUrl(id),
    acceptUrl: talkUrl(id) + '/annehmen',
    closeUrl: talkUrl(id) + '/beenden',
    closeLabel: 'Verhandlung beenden',
    closeConfirm: n.role === 'seller' ? 'Verhandlung beenden? Dein Angebot bleibt auf dem Markt.' : 'Verhandlung beenden? Kaufen kannst du weiter zum Marktpreis.',
  });
});

router.get('/handel/gespraech/:id/stand', async (req, res) => {
  const n = await trade.talkFor({ user: req.user, talkId: req.params.id });
  if (!n) return res.status(404).json({ error: 'nicht gefunden' });
  const since = new Date(str(req.query.seit));
  const fresh = (n.talk.messages || []).filter((m) => Number.isNaN(since.getTime()) || new Date(m.createdAt) > since);
  res.json({ version: n.talk.termsVersion || 0, status: n.isOpen ? 'offen' : 'beendet', messages: fresh.map(messageView) });
});

router.post('/handel/gespraech/:id/nachricht', (req, res) => {
  const url = talkUrl(req.params.id) + '#chat';
  return handle(req, res, async () => {
    await trade.sendTalkMessage({ user: req.user, talkId: req.params.id, text: str(req.body.text) });
    return null;
  }, url, url);
});

router.post('/handel/gespraech/:id/bedingungen', (req, res) => {
  const url = talkUrl(req.params.id);
  return handle(req, res, async () => {
    await trade.changeTalkTerms({ user: req.user, talkId: req.params.id, price: parseEuro(str(req.body.price)), version: versionOf(req) });
    return null;
  }, url, url);
});

router.post('/handel/gespraech/:id/annehmen', (req, res) =>
  handle(req, res, async () => {
    await trade.acceptTalk({ user: req.user, talkId: req.params.id, version: versionOf(req) });
    return null;
  }, talkUrl(req.params.id))
);

router.post('/handel/gespraech/:id/beenden', (req, res) =>
  handle(req, res, async () => {
    await trade.endTalk({ user: req.user, talkId: req.params.id });
    return null;
  }, talkUrl(req.params.id))
);

// Live-Aktualisierung: neue Nachrichten seit "seit" und der aktuelle Stand der Bedingungen
router.get('/handel/verhandlung/:id/stand', async (req, res) => {
  const n = await trade.negotiation({ user: req.user, tradeId: req.params.id });
  if (!n) return res.status(404).json({ error: 'nicht gefunden' });
  const since = new Date(str(req.query.seit));
  const fresh = (n.trade.messages || []).filter((m) => Number.isNaN(since.getTime()) || new Date(m.createdAt) > since);
  res.json({
    version: n.trade.termsVersion || 0,
    status: n.trade.status,
    messages: fresh.map(messageView),
  });
});

router.post('/handel/verhandlung/:id/nachricht', (req, res) => {
  const url = negotiationUrl(req.params.id) + '#chat';
  return handle(req, res, async () => {
    await trade.sendMessage({ user: req.user, tradeId: req.params.id, text: str(req.body.text) });
    return null;
  }, url, url);
});

router.post('/handel/verhandlung/:id/bedingungen', (req, res) => {
  const url = negotiationUrl(req.params.id);
  const raw = str(req.body.price).trim();
  return handle(req, res, async () => {
    await trade.changeTerms({
      user: req.user,
      tradeId: req.params.id,
      price: raw ? parseEuro(raw) : 0,
      extraFrom: str(req.body.extra) || null,
      version: versionOf(req),
    });
    return null;
  }, url, url);
});

router.post('/handel/:id/kaufen', (req, res) =>
  handle(req, res, async () => {
    await trade.buy({ user: req.user, tradeId: req.params.id, version: versionOf(req) });
    return null;
  }, str(req.body.zurueck) === 'verhandlung' ? negotiationUrl(req.params.id) : '/handel')
);

router.post('/handel/:id/tauschen', (req, res) =>
  handle(req, res, async () => {
    await trade.acceptSwap({ user: req.user, tradeId: req.params.id, version: versionOf(req) });
    return null;
  }, str(req.body.zurueck) === 'verhandlung' ? negotiationUrl(req.params.id) : '/handel')
);

router.post('/handel/:id/zurueckziehen', (req, res) =>
  handle(req, res, async () => {
    await trade.close({ user: req.user, tradeId: req.params.id, action: 'zurueckziehen' });
    return 'Angebot zurückgezogen – die Karte ist wieder frei.';
  })
);

router.post('/handel/:id/ablehnen', (req, res) =>
  handle(req, res, async () => {
    await trade.close({ user: req.user, tradeId: req.params.id, action: 'ablehnen' });
    return 'Angebot abgelehnt.';
  })
);

module.exports = router;

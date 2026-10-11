const express = require('express');
const mongoose = require('mongoose');
const { requireLogin } = require('../middleware');
const { GradingShop } = require('../models/Grading');
const { TcgCard } = require('../models/Tcg');
const grading = require('../grading/gradingService');
const orders = require('../grading/orderService');
const reputation = require('../grading/reputation');
const population = require('../tcg/population');
const catalog = require('../tcg/catalog');
const { centerShift, centeringCap, CENTERING, creaseLine } = require('../grading/condition');

// Zentrierungs-Bereiche fürs Benoten: { from, to, cap } in % der breiteren Seite, beide Grenzen eingeschlossen
const ratio = (v) => `${v}/${100 - v}`;
const centeringScale = CENTERING.map((c, i) => {
  const from = i === 0 ? 50 : CENTERING[i - 1].max + 1;
  return { from, to: c.max, fromLabel: ratio(from), toLabel: ratio(c.max), cap: c.cap };
});
const { str, UserError, parseEuro } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');

const router = express.Router();

// Zugang: für alle, wenn im Admin-Panel freigegeben – sonst nur Admins
function requireGrading(req, res, next) {
  if (grading.settings.open || req.user.isAdmin) return next();
  if (req.method !== 'GET') {
    req.flash('error', 'Der Grading-Shop ist derzeit nicht verfügbar.');
    return res.redirect('/grading');
  }
  res.render('error', { title: 'Grading', status: 'Grading', message: 'Der Grading-Shop ist derzeit nicht verfügbar. Schau später wieder vorbei!' });
}
router.use('/grading', requireLogin, requireGrading);

// Reiter des Shop-Hubs (#204): Übersicht als Start, die anderen verwalten den Shop
const HUB_TABS = [
  { key: 'uebersicht', label: 'Übersicht' },
  { key: 'auftraege', label: 'Aufträge' },
  { key: 'vitrine', label: 'Vitrine' },
  { key: 'preise', label: 'Preise' },
  { key: 'werkstatt', label: 'Werkstatt' },
];
const hubUrl = (tab) => (tab && tab !== 'uebersicht' ? `/grading?reiter=${tab}` : '/grading');

/** Daten für den Arbeitstisch (public/js/grading.js) – die echte Note bleibt auf dem Server */
function benchData(job, shop) {
  const card = catalog.cardById[job.card];
  const player = grading.isPlayerJob(job);
  return {
    steps: grading.stepsFor(job), // Bügeln nur bei Karten mit Knick, Spieler-Aufträge nach gebuchten Bausteinen (#204)
    card: card ? { name: card.name, image: card.image, rarity: card.rarity, rarityLabel: catalog.rarityByKey[card.rarity].label, bonus: player ? 0 : grading.rarityBonus(card.rarity), rank: catalog.rarityByKey[card.rarity].rank, season: card.season } : null,
    customer: job.customer,
    shop: shop ? { name: shop.name, code: shop.code } : null, // Kürzel fürs Slab-Etikett (#204)
    cert: String(parseInt(String(job._id).slice(-7), 16) % 100000000).padStart(8, '0'), // Zertifikatsnummer fürs Slab-Etikett
    spots: job.spots,
    defects: job.defects,
    // Zentrierung: sichtbarer Versatz (Rand ungleich breit) und für die Auflösung die Höchstnote
    center: centerShift(job.defects && job.defects.centering, job._id),
    centerCap: job.defects && job.defects.centering ? centeringCap(job.defects.centering) : 10,
    centerScale: centeringScale.map(({ from, to, cap }) => ({ from, to, cap })), // fürs Messwerkzeug: Bereich → Höchstnote
    minMs: job.spots.length * grading.MS_PER_SPOT,
    // Bügeln (#204): Lage des Knicks, schon gebügelt? und wohin der Tisch das Ergebnis schickt
    crease: job.defects && job.defects.crease ? creaseLine(job.cardDoc || job._id) : null,
    iron: job.iron || null,
    ironUrl: '/grading/buegeln',
    startedAt: new Date(job.createdAt).getTime(),
    // schon benotet (z. B. nach Neuladen): Note und Auflösung gleich anzeigen – bei Karten von Mitgliedern (#204)
    // bleibt die echte Note geheim, auf den Slab kommt die Note des Shops
    guess: job.guess,
    grade: job.guess !== null && !player ? job.grade : null,
    player,
    services: job.services || null,
  };
}

// Shop-Hub (#204): Kopf mit Stufe und Tageszählern, „Jetzt dran“ (eine Primäraktion), Reiter für die Verwaltung
router.get('/grading', async (req, res) => {
  await orders.expireDue();
  const state = await grading.getState(req.user._id);
  const active = !!state.shop && state.shop.active;
  const tab = HUB_TABS.some((t) => t.key === req.query.reiter) ? req.query.reiter : 'uebersicht';
  const players = active && orders.acceptsOrders(state.shop);
  const coded = !!state.shop && !!state.shop.code;
  // Spieler-Aufträge: Warteschlange, Verlauf, Kennzahlen und Vitrine des eigenen Shops
  const [queue, showcase, history, ironable] = await Promise.all([
    players ? orders.queueFor(req.user._id) : [],
    coded ? orders.showcaseChoices(req.user._id) : [],
    coded && tab === 'auftraege' ? orders.shopHistory(req.user._id) : [],
    active && state.info.level >= grading.IRON_LEVEL ? grading.ironableCards(req.user._id) : [],
  ]);
  const job = state.open;
  res.render('grading', {
    title: 'Grading-Shop',
    ...state,
    active,
    tab,
    tabs: HUB_TABS,
    hubUrl,
    levels: grading.LEVELS.map((l) => grading.levelInfo(l.level)),
    pay: grading.PAY,
    contractDays: grading.CONTRACT_DAYS,
    closedForOthers: !grading.settings.open,
    openJob: job ? { card: cardInfo(job.card), customer: job.customer, player: grading.isPlayerJob(job), services: job.services || null } : null,
    // Schaukarte: Glitch-Sigrist im Slab (so, wie der Grading-Shop Karten versiegelt)
    shopCode: (state.shop && state.shop.code) || null, // Schaukarte mit dem eigenen Kürzel (#204)
    heroCard: ((c) => (c ? { ...c, rarityLabel: catalog.rarityByKey[c.rarity].label } : null))(catalog.cardById['sigrist-3-glitch'] || catalog.cardsByRarity.holo[0] || catalog.CARDS[0]),
    doneCards: state.done.map((j) => ({ ...j, cardInfo: catalog.cardById[j.card] || null })),
    earnedToday: state.done.reduce((s, j) => s + (j.pay || 0), 0),
    players,
    orderLevel: orders.ORDER_LEVEL,
    queue: queue.map((o) => ({ ...o, cardInfo: cardInfo(o.card) })),
    history: history.map((o) => ({ ...o, cardInfo: cardInfo(o.card) })),
    shopPrices: orders.shopPrices(state.shop),
    servicePrice: grading.settings.servicePrice,
    services: grading.SERVICES,
    orderDays: grading.settings.orderDays,
    expressDays: grading.settings.expressDays,
    rating: state.shop ? reputation.ratingOf(state.shop) : null,
    showcase,
    showcaseMax: grading.settings.showcaseMax,
    rarityByKey: catalog.rarityByKey,
    // Eigene Karten mit Knick zum Bügeln (#204) – ab Stufe IRON_LEVEL
    ironLevel: grading.IRON_LEVEL,
    ironable: ironable.map((x) => ({ ...x, info: cardInfo(x.card) })).filter((x) => x.info),
  });
});

// Werkbank (#204): der Arbeitstisch für den offenen Auftrag – ohne offenen Auftrag zurück zum Hub
router.get('/grading/werkbank', async (req, res) => {
  const state = await grading.getState(req.user._id);
  if (!state.open || !state.shop || !state.shop.active) return res.redirect('/grading');
  res.render('grading-werkbank', {
    title: 'Werkbank',
    shop: state.shop,
    pay: grading.PAY,
    // Zentrierung → Höchstnote für die Regeln beim Benoten, als Bereiche mit beiden Grenzen (beide eingeschlossen):
    // 50/50–55/45 → 10, 56/44–60/40 → 9, … – so ist z. B. 59/41 eindeutig (→ 9)
    centeringScale,
    jobData: benchData(state.open, state.shop),
  });
});

/** Karte aus dem Katalog mit Seltenheits-Bezeichnung (null, wenn unbekannt) */
function cardInfo(id) {
  const c = catalog.cardById[id];
  return c ? { name: c.name, image: c.image, rarity: c.rarity, rarityLabel: catalog.rarityByKey[c.rarity].label, rank: catalog.rarityByKey[c.rarity].rank, season: c.season } : null;
}

// ---------- Eigene Karten bügeln (#204) ----------
router.post('/grading/eigene/:doc/start', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.doc)) throw new UserError('Diese Karte gibt es nicht.');
    await grading.startIroning({ user: req.user, doc: req.params.doc });
    res.redirect(`/grading/eigene/${req.params.doc}`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
    res.redirect('/grading');
  }
});

// Bügeltisch für die eigene Karte – nur, solange genau diese Karte gerade gebügelt wird
router.get('/grading/eigene/:doc', async (req, res) => {
  const shop = await GradingShop.findById(req.user._id).select('ironing active level').lean();
  const doc = shop && shop.ironing && String(shop.ironing.doc) === req.params.doc ? await TcgCard.findOne({ _id: shop.ironing.doc, user: req.user._id }).select('card').lean() : null;
  if (!doc) return res.redirect('/grading');
  res.render('grading-eigene', {
    title: 'Karte bügeln',
    // Für den Arbeitstisch nur, was man sieht: der Knick – keine Note, keine anderen Mängel (#73)
    jobData: {
      own: true,
      steps: ['iron'],
      card: cardInfo(doc.card),
      spots: [],
      defects: { crease: true },
      crease: creaseLine(doc._id),
      center: null,
      centerCap: 10,
      ironUrl: '/grading/eigene/fertig',
      backUrl: '/grading',
    },
  });
});

router.post('/grading/eigene/fertig', async (req, res) => {
  try {
    res.json(await grading.finishIroning({ user: req.user, smooth: Number(str(req.body.smooth)), burns: Number(str(req.body.burns)) }));
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

// Ziel nach einem Formular: der Reiter, aus dem es kam (Feld reiter), sonst die Übersicht
async function handle(req, res, fn, target = hubUrl(HUB_TABS.some((t) => t.key === req.body.reiter) ? req.body.reiter : null)) {
  try {
    const msg = await fn();
    if (msg) req.flash('success', msg);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect(target);
}

// ---------- Spieler-Aufträge (#204, Etappe B) ----------
// Karte bei einem Shop einreichen: Shop-Liste mit Rating und Vitrine, eigene Karten, eigene Aufträge
router.get('/grading/einreichen', async (req, res) => {
  await orders.expireDue();
  const [shops, cards, mine] = await Promise.all([orders.shopsForOrders(), orders.submittable(req.user._id), orders.myOrders(req.user._id)]);
  const pick = str(req.query.shop).toUpperCase();
  res.render('grading-einreichen', {
    title: 'Karte graden lassen',
    shops: shops.map((s) => ({ ...s, own: s.id === String(req.user._id) })),
    cards,
    orders: mine,
    pick,
    orderDays: grading.settings.orderDays,
    expressDays: grading.settings.expressDays,
    services: grading.SERVICES,
    rateDays: orders.RATE_DAYS,
    rarityByKey: catalog.rarityByKey,
  });
});

router.post('/grading/einreichen', (req, res) =>
  handle(
    req,
    res,
    async () => {
      const services = { iron: req.body.iron === '1', slab: req.body.slab === '1', express: req.body.express === '1' };
      const order = await orders.submit({ user: req.user, shopCode: str(req.body.shop), doc: str(req.body.doc), services });
      const days = order.services.express ? grading.settings.expressDays : grading.settings.orderDays;
      return `Eingereicht: „${(catalog.cardById[order.card] || {}).name || order.card}“ bei ${order.shopCode} für ${euro(order.price)}. Der Shop hat ${days} ${days === 1 ? 'Tag' : 'Tage'} Zeit.`;
    },
    '/grading/einreichen'
  )
);

router.post('/grading/auftrag/:id/storno', (req, res) =>
  handle(
    req,
    res,
    async () => {
      const o = await orders.cancel({ user: req.user, orderId: req.params.id });
      return `Storniert – ${euro(o.price)} sind zurück auf deinem Konto.`;
    },
    '/grading/einreichen'
  )
);

router.post('/grading/auftrag/:id/bewerten', (req, res) =>
  handle(
    req,
    res,
    async () => {
      await orders.rate({ user: req.user, orderId: req.params.id, stars: Number.parseInt(str(req.body.stars), 10) });
      return 'Danke für deine Bewertung!';
    },
    '/grading/einreichen'
  )
);

// Öffentliche Seite eines Shops: Kennzahlen und Vitrine
router.get('/grading/shop/:code', async (req, res) => {
  const shop = await orders.shopByCode(req.params.code);
  if (!shop) return res.status(404).render('error', { title: 'Grading-Shop', status: 404, message: 'Diesen Grading-Shop gibt es nicht.' });
  const pop = await population.all();
  res.render('grading-shop', { title: shop.name, shop, own: shop.id === String(req.user._id), services: grading.SERVICES, rarityByKey: catalog.rarityByKey, popText: (x) => population.popText(x.card.id, pop, x.slab.grade) });
});

// Eigener Shop: Festpreise je Baustein für Spieler-Aufträge und Vitrine
router.post('/grading/preis', (req, res) =>
  handle(req, res, async () => {
    const prices = {};
    for (const sv of grading.SERVICES) {
      const cents = parseEuro(str(req.body[sv.key]));
      if (cents === null) throw new UserError(`Bitte gib für „${sv.label}“ einen gültigen Preis an.`);
      prices[sv.key] = cents;
    }
    await orders.setPrices({ user: req.user, prices });
    return 'Neue Preise gespeichert – sie gelten für neue Aufträge.';
  })
);

router.post('/grading/vitrine', (req, res) =>
  handle(
    req,
    res,
    async () => {
      const raw = req.body.doc;
      await orders.setShowcase({ user: req.user, docs: (Array.isArray(raw) ? raw : raw ? [raw] : []).map(str) });
      return 'Vitrine gespeichert.';
    },
    hubUrl('vitrine')
  )
);

router.post('/grading/annehmen', (req, res) =>
  handle(req, res, async () => {
    if (req.body.confirm !== '1') throw new UserError('Bitte bestätige, dass du die Vertragsbedingungen gelesen hast.');
    await grading.hire({ user: req.user });
    return `Willkommen im Grading-Shop! Dein Vertrag läuft ${grading.CONTRACT_DAYS} Tage – so lange gibt es keinen Tagesbonus, dafür Lohn für jeden Auftrag.`;
  })
);

router.post('/grading/kuendigen', (req, res) =>
  handle(req, res, async () => {
    await grading.quit({ user: req.user });
    return 'Du hast gekündigt. Ab dem nächsten Tag bekommst du wieder den Tagesbonus.';
  })
);

router.post('/grading/name', (req, res) =>
  handle(req, res, async () => {
    const { name, code, requested } = await grading.setName({ user: req.user, name: str(req.body.name), code: str(req.body.code) });
    if (requested) return `Dein Shop heißt jetzt „${name}“. Das neue Kürzel ${requested} ist beantragt – ein Admin oder Dev gibt es frei. Bis dahin bleibt ${code}.`;
    return `Dein Shop heißt jetzt „${name}“ – Kürzel ${code}.`;
  })
);

router.post('/grading/ausbauen', (req, res) =>
  handle(req, res, async () => {
    const next = await grading.upgrade({ user: req.user });
    return `Ausgebaut: Stufe ${next.level} – „${next.name}“!`;
  })
);

// Auftrag annehmen und gleich an die Werkbank
router.post('/grading/auftrag', (req, res) =>
  handle(
    req,
    res,
    async () => {
      await grading.takeJob({ user: req.user });
      return null;
    },
    '/grading/werkbank'
  )
);

// Note festlegen (vom Arbeitstisch per fetch) – Antwort: echte Note für die Auflösung
router.post('/grading/benoten', async (req, res) => {
  try {
    res.json(await grading.setGuess({ user: req.user, guess: Number.parseInt(str(req.body.grade), 10) }));
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

// Knick bügeln (vom Arbeitstisch per fetch, #204) – Antwort: neue Obergrenze und Mängel für die Auflösung
router.post('/grading/buegeln', async (req, res) => {
  try {
    res.json(await grading.ironJob({ user: req.user, smooth: Number(str(req.body.smooth)), burns: Number(str(req.body.burns)) }));
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

// Die Werkbank schickt per fetch (Accept: JSON) und zeigt danach den Abschluss-Bildschirm (#204); ohne JS wie bisher
router.post('/grading/zuruecksenden', async (req, res, next) => {
  if (!(req.get('accept') || '').includes('application/json')) return next();
  try {
    const job = await grading.finishJob({ user: req.user, clean: Number(str(req.body.clean)), seal: Number(str(req.body.seal)) });
    const state = await grading.getState(req.user._id);
    const canNext = state.used < state.limit || (state.waiting > 0 && state.playerUsed < state.playerLimit);
    res.json({
      pay: job.pay,
      breakdown: job.breakdown,
      reputation: job.score ? job.score.reputation : 0,
      quality: job.score ? job.score.quality : null,
      player: !!job.order,
      services: job.order ? job.order.services || null : null,
      customer: job.customer,
      clean: job.clean,
      seal: job.seal,
      iron: job.iron ? job.iron.smooth : null,
      guess: job.guess,
      grade: job.order ? null : job.grade, // Karten von Mitgliedern: echte Note bleibt geheim
      shopCode: job.shopCode,
      foilFound: !!job.foilFound,
      canNext,
      left: { npc: Math.max(0, state.limit - state.used), players: state.waiting },
    });
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.status(400).json({ error: err.message });
  }
});
router.post('/grading/zuruecksenden', (req, res) =>
  handle(req, res, async () => {
    const clean = Number(str(req.body.clean));
    const seal = Number(str(req.body.seal));
    const job = await grading.finishJob({ user: req.user, clean, seal });
    if (job.order) return `Slab ${job.shopCode} · Note ${job.guess} geht zurück an ${job.customer} – du bekommst ${euro(job.pay)}.`;
    let msg = `Zurück an ${job.customer} – ${euro(job.pay)} Lohn.`;
    if (job.clean < 100) msg += ` Die Karte war erst zu ${job.clean} % sauber – das hat Lohn gekostet.`;
    return msg;
  })
);

module.exports = router;

// Shop-Demo: eigener Laden (2:1-isometrisch, Platzhalter aus src/shop/items.json) mit Figur, PC (Bestellen, Preise,
// Lizenzen), Kartons, Regalen, Kunden und Kunden-Aufträgen. Vorerst nur für Admins.
// EJS ist nur der Rahmen, gezeichnet wird mit Phaser in public/js/shop-demo.js; Regeln in src/shop/layout.js
// (dieselbe Datei läuft im Browser als /js/shop-layout.js). Kanacoin = Demo-Geld, getrennt vom Kontostand.
// Aufträge: Karte und Zustand würfelt der Server (wie im Grading-Shop der Seite); gearbeitet wird am Arbeitstisch
// der Seite (/shop-demo/werkbank, public/js/grading.js im Demo-Modus), der Laden zeigt ihn in einem Fenster.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { requireAdmin } = require('../middleware');
const ShopDemo = require('../models/ShopDemo');
const layout = require('../shop/layout');
const { CATALOG, GROUPS, GOODS, LICENSES, SERVICES, SERVICE_PACKS, UNIT_PRICE } = require('../shop/catalog');
const grading = require('../grading/gradingService');
const { centerShift, centeringCap, CENTERING_SCALE, creaseLine, applyIron, ironCap, gradeFor } = require('../grading/condition');
const tcg = require('../tcg/catalog');
const { str } = require('../lib/util');

const router = express.Router();
const catalog = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
const goods = Object.fromEntries(GOODS.map((g) => [g.id, g]));
const more = { licenses: Object.fromEntries(LICENSES.map((l) => [l.id, l])), services: Object.fromEntries(SERVICES.map((x) => [x.id, x])) };
const ACTIONS = [
  'openDay', 'checkout', 'leave', 'closeDay', 'orderWare', 'orderMoebel', 'pick', 'drop', 'stock', 'unstock', 'build', 'move',
  'remove', 'setPrice', 'buyUnit', 'setCoins', 'reset', 'buyTool', 'dirt', 'mop', 'buyLicense', 'setServicePrice', 'takeJob', 'foil', 'serviceCheckout', 'jobCancel',
];
// Welcher Arbeitstisch welche Schritte des Grading-Tisches übernimmt
const BENCH_STEPS = { card_cleaning_table: ['clean', 'iron'], card_grading_table: ['grade', 'slab'] };

function plain(doc) {
  if (!doc) return layout.ensureCounter(layout.fresh(), catalog);
  const { coins, units, nextUid, nextBid, carry, prices, day, open, today, reports, licenses, servicePrices, jobs, nextJid, dirt, nextDid, tools, market, marketMoves, marketDay } = doc;
  const reviews = (doc.reviews || []).map(({ day: d, stars, text }) => ({ day: d, stars, text }));
  const items = (doc.items || []).map(({ uid, id, x, y, rot, wall, stock }) => {
    const it = { uid, id, x, y, rot };
    if (wall) it.wall = wall;
    if (stock && Object.keys(stock).length) it.stock = stock;
    return it;
  });
  const boxes = (doc.boxes || []).map(({ bid, kind, id, qty, x, y }) => ({ bid, kind, id, qty, x, y }));
  return layout.ensureCounter(
    layout.normalize({ coins, units, nextUid, nextBid, carry, prices, items, boxes, day, open, today: today || undefined, reviews, reports, licenses, servicePrices, jobs, nextJid, dirt, nextDid, tools, market, marketMoves, marketDay }),
    catalog
  );
}

const load = async (userId) => plain(await ShopDemo.findById(userId).lean());
const save = (userId, state) => ShopDemo.replaceOne({ _id: userId }, state, { upsert: true });

/** Karte aus dem TCG-Katalog für den Arbeitstisch */
function cardInfo(id) {
  const c = tcg.cardById[id];
  return c ? { name: c.name, image: c.image, rarity: c.rarity, rarityLabel: tcg.rarityByKey[c.rarity].label, rank: tcg.rarityByKey[c.rarity].rank, season: c.season, bonus: 0 } : null;
}

/** Neuer Auftrag: Karte, Mängel, Flecken wie bei einem Kunden des Grading-Shops; Bügeln kommt zum Reinigen dazu, wenn die Karte einen Knick hat */
function rollJob(services) {
  const defects = grading.rollDefects();
  const list = services.filter((id) => more.services[id]);
  if (list.includes('clean') && defects.crease && !list.includes('iron')) list.push('iron');
  return { services: list, card: grading.rollCard(1), defects, spots: grading.rollSpots(), seed: crypto.randomBytes(2).toString('hex') };
}

router.get('/shop-demo', requireAdmin, (req, res) => {
  res.render('shop-demo', { title: 'Shop-Demo' });
});

router.get('/js/shop-layout.js', requireAdmin, (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, '..', 'shop', 'layout.js'));
});

router.get('/js/shop-customers.js', requireAdmin, (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, '..', 'shop', 'customers.js'));
});

router.get('/vendor/phaser.min.js', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'private, max-age=604800');
  res.type('application/javascript').sendFile(require.resolve('phaser/dist/phaser.min.js'));
});

router.get('/api/shop-demo', requireAdmin, async (req, res, next) => {
  try {
    res.json({
      state: await load(req.user._id), catalog: CATALOG, goods: GOODS, groups: GROUPS, unitPrice: UNIT_PRICE,
      licenses: LICENSES, services: SERVICES, packs: SERVICE_PACKS,
    });
  } catch (err) {
    next(err);
  }
});

// Eine Aktion: { type, ... } als JSON im Feld "aktion" (dazu _csrf)
router.post('/api/shop-demo', requireAdmin, async (req, res, next) => {
  try {
    let a;
    try {
      a = JSON.parse(typeof req.body.aktion === 'string' ? req.body.aktion : '');
    } catch {
      a = null;
    }
    const type = a && ACTIONS.find((t) => t === a.type);
    if (!type) return res.status(400).json({ error: 'Unbekannte Aktion.' });
    const action = {
      type,
      id: typeof a.id === 'string' ? a.id : '',
      uid: Number(a.uid),
      bid: Number(a.bid),
      jid: Number(a.jid),
      did: Number(a.did),
      at: Number(a.at),
      cid: Number(a.cid),
      n: Number(a.n),
      ware: typeof a.ware === 'string' ? a.ware : '',
      service: typeof a.service === 'string' ? a.service : '',
      price: Number(a.price),
      x: Number(a.x),
      y: Number(a.y),
      rot: layout.rot4(a.rot), // 0–3 = Blickrichtung der Vorderseite
      wall: a.wall === 'n' || a.wall === 'w' ? a.wall : undefined,
      amount: Number(a.amount),
      lines: Array.isArray(a.lines)
        ? a.lines.slice(0, 10).map((l) => ({ uid: Number(l && l.uid), ware: typeof (l && l.ware) === 'string' ? l.ware : '', qty: Number(l && l.qty) }))
        : [],
      stars: Number(a.stars),
      why: typeof a.why === 'string' ? a.why : '',
      miss: typeof a.miss === 'string' ? a.miss : '',
      aborted: !!a.aborted,
      ...(type === 'buyUnit' ? { price: UNIT_PRICE } : {}),
      // Auftrag: nur die gewünschten Dienste kommen vom Browser, Karte und Zustand würfelt der Server
      ...(type === 'takeJob' ? { job: rollJob(Array.isArray(a.services) ? a.services.filter((x) => typeof x === 'string').slice(0, 6) : []) } : {}),
    };
    const state = await load(req.user._id);
    const r = layout.apply(state, catalog, goods, action, more);
    if (r.error) return res.status(400).json({ error: r.error, state });
    // nach Ladenschluss bewegen sich die Marktpreise (Zufall nur hier auf dem Server)
    if (type === 'closeDay') r.state = layout.moveMarket(r.state, goods, Math.random);
    await save(req.user._id, r.state);
    res.json({ state: r.state, ...(type === 'takeJob' ? { jid: r.state.jobs[r.state.jobs.length - 1].jid } : {}) });
  } catch (err) {
    next(err);
  }
});

// ---------- Arbeitstisch (Grading-Tisch der Seite im Demo-Modus) ----------

/** Auftrag + Schritte für diesen Tisch → { state, job, steps } oder { error } */
async function benchFor(userId, jid, station) {
  const state = await load(userId);
  const job = state.jobs.find((j) => j.jid === jid);
  const stepsHere = Object.entries(BENCH_STEPS).find(([k]) => k === station);
  if (!job || !stepsHere) return { error: 'Diesen Auftrag gibt es nicht mehr.' };
  const steps = stepsHere[1].filter((id) => job.services.includes(id) && !job.done.includes(id));
  if (!steps.length || !steps.includes(layout.nextService(job))) return { error: 'An diesem Tisch ist für die Karte nichts zu tun.' };
  return { state, job, steps };
}

/**
 * Arbeitstisch öffnen: prüft Auftrag/Tisch, merkt sich den Tisch am Auftrag und liefert die Daten für den Tisch
 * → { jobData } oder { error }. Genutzt von der Seite im Fenster (GET /shop-demo/werkbank) und vom Phaser-Tisch
 * im Laden (GET /api/shop-demo/werkbank, public/js/shop-werkbank-phaser.js)
 */
async function openBench(userId, jid, station, remember) {
  const b = await benchFor(userId, jid, station);
  if (b.error) return b;
  const { job, steps } = b;
  if (steps.includes('slab') && !layout.supplier(b.state, 'mat_slab')) return { error: 'Kein leerer Slab am Kartenbewertungstisch – erst Slabs bestellen und einräumen.' };
  // Der Tisch der Seite (Fenster) schickt den Tisch beim Fertig-Melden nicht mit – nur dafür merken (kostet einen
  // Schreibzugriff); der Phaser-Tisch schickt "tisch" mit, sein Öffnen bleibt ein reiner Lesezugriff (schneller)
  if (remember) {
    b.state.jobs.find((j) => j.jid === job.jid).bench = station;
    await save(userId, b.state);
  }
  const cleaned = job.done.includes('clean');
  const card = cardInfo(job.card);
  return {
    jobData: {
      demo: true,
      id: String(job.jid),
      steps,
      card,
      back: card && card.season ? '/img/tcg-backs/' + card.season + '.webp' : null,
      customer: 'Kunde ' + job.jid,
      shop: { name: 'Shop-Demo', code: 'SD' },
      cert: String(parseInt(job.seed, 16) * 977 + job.jid).padStart(8, '0').slice(-8),
      spots: cleaned ? [] : job.spots,
      defects: job.defects,
      center: centerShift(job.defects && job.defects.centering, job.seed),
      centerCap: job.defects && job.defects.centering ? centeringCap(job.defects.centering) : 10,
      centerScale: CENTERING_SCALE.map(({ from, to, cap }) => ({ from, to, cap })),
      minMs: 0,
      crease: job.defects && job.defects.crease ? creaseLine(job.seed) : null,
      iron: job.results.iron !== undefined ? { smooth: job.results.iron } : null,
      ironUrl: '/shop-demo/werkbank/buegeln',
      gradeUrl: '/shop-demo/werkbank/benoten',
      startedAt: Date.now(),
      guess: job.results.guess || null,
      grade: job.results.guess ? job.results.grade : null,
      player: false,
      services: null,
      tools: [],
    },
  };
}

router.get('/shop-demo/werkbank', requireAdmin, async (req, res, next) => {
  try {
    const b = await openBench(req.user._id, Number(req.query.auftrag), str(req.query.tisch), true);
    if (b.error) return res.status(400).type('text/plain').send(b.error);
    res.render('shop-werkbank', { title: 'Arbeitstisch', pay: grading.PAY, centeringScale: CENTERING_SCALE, jobData: b.jobData });
  } catch (err) {
    next(err);
  }
});

router.get('/api/shop-demo/werkbank', requireAdmin, async (req, res, next) => {
  try {
    const b = await openBench(req.user._id, Number(req.query.auftrag), str(req.query.tisch));
    if (b.error) return res.status(400).json({ error: b.error });
    res.json({ jobData: b.jobData });
  } catch (err) {
    next(err);
  }
});

/** Ein Schritt am offenen Arbeitstisch: fn(job) ändert den Auftrag und gibt die Antwort zurück */
async function benchStep(req, res, fn) {
  const jid = Number(str(req.body.job));
  const state = await load(req.user._id);
  const job = state.jobs.find((j) => j.jid === jid);
  if (!job) return res.status(400).json({ error: 'Diesen Auftrag gibt es nicht mehr.' });
  // Tisch: vom Phaser-Tisch mitgeschickt, sonst der gemerkte (Tisch der Seite im Fenster)
  const sent = str(req.body.tisch);
  job.bench = Object.keys(BENCH_STEPS).find((k) => k === sent) || job.bench;
  if (!job.bench) return res.status(400).json({ error: 'Kein Arbeitstisch.' });
  const out = fn(job, state);
  if (out.error) return res.status(400).json(out);
  await save(req.user._id, out.state || state);
  res.json(out.json);
}

router.post('/shop-demo/werkbank/buegeln', requireAdmin, (req, res, next) =>
  benchStep(req, res, (job) => {
    if (!job.services.includes('iron') || job.results.iron !== undefined) return { error: 'Diese Karte ist schon gebügelt.' };
    const input = grading.ironInput({ smooth: Number(str(req.body.smooth)), burns: Number(str(req.body.burns)) });
    job.defects = applyIron(job.defects, input, creaseLine(job.seed));
    job.results.iron = input.smooth;
    return { json: { ...input, cap: ironCap(input.smooth), defects: job.defects } };
  }).catch(next)
);

router.post('/shop-demo/werkbank/benoten', requireAdmin, (req, res, next) =>
  benchStep(req, res, (job) => {
    const guess = Number.parseInt(str(req.body.grade), 10);
    if (!job.services.includes('grade') || job.results.guess) return { error: 'Die Karte ist schon benotet.' };
    if (!(guess >= 1 && guess <= 10)) return { error: 'Ungültige Note.' };
    job.results.guess = guess;
    job.results.grade = gradeFor(job.defects);
    return { json: { guess, grade: job.results.grade } };
  }).catch(next)
);

// Fertig am Tisch: Reinigung/Versiegelung übernehmen, Schritte abhaken (verbraucht beim Versiegeln einen leeren Slab)
router.post('/shop-demo/werkbank/fertig', requireAdmin, (req, res, next) =>
  benchStep(req, res, (job, state) => {
    const steps = (BENCH_STEPS[job.bench] || []).filter((id) => job.services.includes(id) && !job.done.includes(id));
    const pct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    const results = {};
    if (steps.includes('clean')) results.clean = pct(str(req.body.clean));
    if (steps.includes('iron') && job.results.iron === undefined) results.iron = 0; // Bügeln übersprungen
    if (steps.includes('slab')) results.seal = pct(str(req.body.seal));
    if (steps.includes('grade') && !job.results.guess) return { error: 'Erst benoten.' };
    const r = layout.apply(state, catalog, goods, { type: 'benchDone', jid: job.jid, steps, results, defects: job.defects }, more);
    if (r.error) return { error: r.error };
    const done = r.state.jobs.find((j) => j.jid === job.jid);
    delete done.bench;
    // neuer Stand gleich mit – der Laden muss danach nichts mehr nachladen (Schließen des Tisches ohne Ruckeln)
    return { state: r.state, json: { demo: true, jid: job.jid, steps, results: done.results, next: layout.nextService(done), state: r.state } };
  }).catch(next)
);

module.exports = router;

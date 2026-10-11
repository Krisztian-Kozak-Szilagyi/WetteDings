// Spieler-Aufträge im Grading (#204, Etappe B): Mitglieder reichen eigene Karten bei Grading-Shops anderer Mitglieder
// ein. Ablauf:
//   einreichen mit gebuchten Bausteinen (Reinigung immer, dazu Bügeln und/oder Benoten + Slab, optional Express; Preis
//   = Summe der Festpreise des Shops, wird eingezogen, Karte gesperrt, eine Folie geht ab) → der Shop nimmt den Auftrag
//   an (Express zuerst, vor den NPC-Aufträgen, gradingService.takeJob) → putzt und erledigt die gebuchten Schritte → die
//   Karte kommt gebügelt bzw. als Slab mit Kürzel und Note des Shops zurück, der Shop bekommt den Preis
//   (gradingService.finishJob) → der Kunde kann 1–5 Sterne geben.
// Läuft die Frist ab (Auftrag wartet zu lange oder bleibt liegen) oder storniert der Kunde einen wartenden Auftrag,
// bekommt er sein Geld zurück und die Karte ist wieder frei.
const mongoose = require('mongoose');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgCard } = require('../models/Tcg');
const { GradingShop, GradingJob, GradingOrder } = require('../models/Grading');
const { inTransaction } = require('../services/betService');
const { notify } = require('../services/notifyService');
const { UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');
const catalog = require('../tcg/catalog');
const { lockedDocs, claim, lockLabel } = require('../tcg/locks');
const { visibleMarks } = require('./condition');
const reputation = require('./reputation');
const { settings, SERVICES } = require('./gradingService');

const ORDER_LEVEL = 3; // Spieler-Aufträge erst ab der Slab-Werkstatt – ohne Slab keine sichtbare Note
const OPEN = ['wartet', 'in_arbeit'];
const RATE_DAYS = 7; // so lange nach der Rückgabe kann der Kunde bewerten
const ORDERS_HREF = '/grading/einreichen';
// Schnell-Tags zur Bewertung (#204, Google-Stil): fester Katalog statt Freitext – keine Moderation nötig
const REVIEW_TAGS = [
  { key: 'sauber', label: 'Blitzsauber', good: true },
  { key: 'schnell', label: 'Schnell', good: true },
  { key: 'fair', label: 'Note fair', good: true },
  { key: 'preis', label: 'Preis top', good: true },
  { key: 'verpackt', label: 'Top verpackt', good: true },
  { key: 'teuer', label: 'Zu teuer', good: false },
  { key: 'langsam', label: 'Langsam', good: false },
  { key: 'streng', label: 'Note zu streng', good: false },
];
const TAG_MAX = 3;
const tagByKey = Object.fromEntries(REVIEW_TAGS.map((t) => [t.key, t]));
/** Tags einer Bewertung prüfen: höchstens TAG_MAX aus dem Katalog, doppelte zählen einmal, leer ist erlaubt */
function validTags(raw) {
  const list = [...new Set((Array.isArray(raw) ? raw : raw ? [raw] : []).map(String))];
  if (list.length > TAG_MAX) throw new UserError(`Bitte höchstens ${TAG_MAX} Stichworte.`);
  if (list.some((k) => !tagByKey[k])) throw new UserError('Dieses Stichwort gibt es nicht.');
  return list;
}
const SHOP_HREF = '/grading';

const cardName = (id) => (catalog.cardById[id] ? catalog.cardById[id].name : id);

// ---------- Reine Regeln ----------
const SERVICE_KEYS = SERVICES.map((x) => x.key);
// Warteschlange: Express zuerst, sonst der älteste
const QUEUE_SORT = { 'services.express': -1, createdAt: 1 };

/** Festpreise eines Shops je Baustein (Cent): eigener Preis im Rahmen, sonst der Standardpreis – { base, iron, slab, express } */
function shopPrices(shop, s = settings) {
  const own = (shop && shop.prices) || {};
  return Object.fromEntries(
    SERVICE_KEYS.map((k) => {
      const r = s.servicePrice[k];
      const p = Number.isInteger(own[k]) ? own[k] : r.def;
      return [k, Math.max(r.min, Math.min(r.max, p))];
    })
  );
}

/** Gebuchte Bausteine aufbereiten: { iron, slab, express, review } als Booleans (Reinigung ist dabei, außer bei der Zweitprüfung) */
const normServices = (v = {}) => (v.review ? { iron: false, slab: false, express: !!v.express, review: true } : { iron: !!v.iron, slab: !!v.slab, express: !!v.express, review: false });
/** Bausteine eines Auftrags – ältere Aufträge ohne services waren Bügeln (wenn nötig) + Slab */
const servicesOf = (order) => (order && order.services ? normServices(order.services) : { iron: true, slab: true, express: false, review: false });

/** Preis eines Auftrags bei diesem Shop: { parts: { base, iron?, slab?, express? }, total } */
function priceOf(shop, services, s = settings) {
  const all = shopPrices(shop, s);
  const want = normServices(services);
  const parts = want.review ? { review: all.review } : { base: all.base };
  for (const k of ['iron', 'slab', 'express']) if (want[k]) parts[k] = all[k];
  return { parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
}

/** Liegen alle Festpreise (Cent) im Rahmen? prices: { base, iron, slab, express } */
const validPrices = (prices, s = settings) => !!prices && SERVICE_KEYS.every((k) => Number.isInteger(prices[k]) && prices[k] >= s.servicePrice[k].min && prices[k] <= s.servicePrice[k].max);

/** Nimmt dieser Shop Spieler-Aufträge an? (angestellt, Stufe 3+, mit Kürzel) */
const acceptsOrders = (shop) => !!shop && !!shop.active && (shop.level || 1) >= ORDER_LEVEL && !!shop.code;

/** Frist ab jetzt – mit Express kürzer */
const deadline = (now = Date.now(), s = settings, services = null) => new Date(now + (services && services.express ? s.expressDays : s.orderDays) * 864e5);

// ---------- Geld ----------
/** Preis an den Kunden zurück (in der Transaktion), Buchung grading_erstattung */
async function refundOwner(order, session) {
  await User.updateOne({ _id: order.owner }, { $inc: { balance: order.price } }, { session });
  await Ledger.create([{ user: order.owner, type: 'grading_erstattung', amount: order.price, betTitle: `${cardName(order.card)} bei ${order.shopCode}` }], { session });
}

/**
 * Offenen Auftrag beenden und erstatten: status = 'abgelaufen' | 'storniert'. Ein angefangener Spieler-Job beim Shop
 * wird gelöscht. Gibt den Auftrag zurück – oder null, wenn er schon nicht mehr offen war (gleichzeitiger Abschluss).
 */
async function closeWithRefund(orderId, status, session) {
  const order = await GradingOrder.findOneAndUpdate({ _id: orderId, status: { $in: OPEN } }, { $set: { status, doneAt: new Date() } }, { new: true, session }).lean();
  if (!order) return null;
  if (order.job) await GradingJob.deleteOne({ _id: order.job, status: 'offen' }, { session });
  await refundOwner(order, session);
  return order;
}

// ---------- Abfragen ----------
/** Bilder und Noten der ausgestellten Slabs mehrerer Shops: Map shopId → [{ id, card, slab }] */
async function showcasesOf(shops) {
  const ids = shops.flatMap((s) => s.showcase || []);
  if (!ids.length) return new Map();
  const docs = await TcgCard.find({ _id: { $in: ids }, slab: { $ne: null } }).select('user card rarity foiledAt slab').lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return new Map(
    shops.map((s) => [
      String(s._id),
      (s.showcase || [])
        .map((id) => byId.get(String(id)))
        .filter((d) => d && String(d.user) === String(s._id) && catalog.cardById[d.card])
        .map((d) => ({ id: String(d._id), card: catalog.cardById[d.card], rarity: d.rarity, foiledAt: d.foiledAt, slab: { code: d.slab.code, grade: d.slab.grade } })),
    ])
  );
}

/** Vitrinen-Boost eines Shops (Anteil) aus seinen ausgestellten Slabs */
function boostOf(showcase = []) {
  return reputation.showcaseBoost(showcase.map((x) => ({ rank: (catalog.rarityByKey[x.rarity] || {}).rank || 0, grade: x.slab.grade })));
}

/** Shop für die Anzeige: Kennzahlen, Preis, Warteschlange, Vitrine, Boost */
function shopView(s, owners, queues, showcases) {
  const showcase = showcases.get(String(s._id)) || [];
  return {
    id: String(s._id),
    name: s.name,
    code: s.code,
    owner: owners.get(String(s._id)) || '?',
    level: s.level,
    prices: shopPrices(s),
    queue: queues.get(String(s._id)) || 0,
    rating: reputation.ratingOf(s),
    showcase,
    boost: boostOf(showcase),
    jobsDone: s.jobsDone || 0,
    playerJobsDone: s.playerJobsDone || 0,
  };
}

/** Warteschlangen (wartende + angefangene Aufträge) je Shop: Map shopId → Anzahl */
async function queuesOf(shopIds) {
  const rows = await GradingOrder.aggregate([{ $match: { shop: { $in: shopIds }, status: { $in: OPEN } } }, { $group: { _id: '$shop', n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

/** Alle Shops, die Spieler-Aufträge annehmen – nach Reputation sortiert (eigener Shop mit dabei, markiert vom Aufrufer) */
async function shopsForOrders() {
  const shops = await GradingShop.find({ active: true, level: { $gte: ORDER_LEVEL }, code: { $type: 'string' } }).lean();
  const ids = shops.map((s) => s._id);
  const [users, queues, showcases] = await Promise.all([User.find({ _id: { $in: ids }, deletedAt: null }).select('username').lean(), queuesOf(ids), showcasesOf(shops)]);
  const owners = new Map(users.map((u) => [String(u._id), u.username]));
  return shops
    .filter((s) => owners.has(String(s._id)))
    .map((s) => shopView(s, owners, queues, showcases))
    .sort((a, b) => b.rating.reputation - a.rating.reputation || a.name.localeCompare(b.name, 'de'));
}

/** Ein Shop nach Kürzel (auch ohne Spieler-Aufträge, z. B. Stufe 2) – oder null */
async function shopByCode(code) {
  const s = await GradingShop.findOne({ code: String(code || '').toUpperCase() }).lean();
  if (!s) return null;
  const [user, queues, showcases] = await Promise.all([User.findById(s._id).select('username deletedAt').lean(), queuesOf([s._id]), showcasesOf([s])]);
  if (!user || user.deletedAt) return null;
  return { ...shopView(s, new Map([[String(s._id), user.username]]), queues, showcases), accepts: acceptsOrders(s) };
}

/**
 * Eigene Karten, die sich einreichen lassen: nicht gesperrt (außer Folie – die geht beim Einreichen ab). Slabs nur zur
 * Zweitprüfung (#204, slab gesetzt). [{ id, card, rarity, foiledAt, slab, damaged, creased, ironed, marks }] – seltenste zuerst
 */
async function submittable(userId) {
  const [docs, locked] = await Promise.all([
    TcgCard.find({ user: userId }).select('card rarity foiledAt slab damaged creased ironedAt condition.defects.scratches condition.defects.crease').lean(),
    lockedDocs(userId),
  ]);
  return docs
    .filter((d) => {
      const r = locked.reasons.get(String(d._id));
      return catalog.cardById[d.card] && (!r || r === (d.slab ? 'slab' : 'folie'));
    })
    .map((d) => ({
      id: String(d._id),
      card: catalog.cardById[d.card],
      rarity: d.rarity,
      foiledAt: d.foiledAt,
      slab: d.slab ? { code: d.slab.code, grade: d.slab.grade } : null,
      damaged: !!d.damaged,
      creased: !!d.creased,
      ironed: !!d.ironedAt,
      marks: d.damaged && !d.foiledAt ? visibleMarks(d.condition && d.condition.defects, d._id, !!d.ironedAt) : null,
    }))
    .sort((a, b) => ((catalog.rarityByKey[b.rarity] || {}).rank || 0) - ((catalog.rarityByKey[a.rarity] || {}).rank || 0) || a.card.name.localeCompare(b.card.name, 'de'));
}

/** Aufträge eines Kunden (neueste zuerst) – mit „bewertbar“ */
async function myOrders(userId, now = Date.now()) {
  const list = await GradingOrder.find({ owner: userId }).sort({ createdAt: -1 }).limit(30).lean();
  return list.map((o) => ({ ...o, services: servicesOf(o), cardInfo: catalog.cardById[o.card] || null, rateable: canRate(o, now) }));
}

/** Wartende Aufträge eines Shops (Express zuerst, sonst älteste zuerst) – mit aufbereiteten Bausteinen */
const queueFor = async (shopId) => (await GradingOrder.find({ shop: shopId, status: 'wartet' }).sort(QUEUE_SORT).lean()).map((o) => ({ ...o, services: servicesOf(o) }));

/** Erledigte Aufträge eines Shops (neueste zuerst) – für den Reiter „Aufträge“ im Hub */
const shopHistory = async (shopId, limit = 20) =>
  (await GradingOrder.find({ shop: shopId, status: { $in: ['fertig', 'abgelaufen', 'storniert'] } }).sort({ doneAt: -1 }).limit(limit).lean()).map((o) => ({ ...o, services: servicesOf(o) }));

/** Darf der Kunde diesen Auftrag (noch) bewerten? */
const canRate = (o, now = Date.now()) => o.status === 'fertig' && o.stars == null && !!o.doneAt && now - new Date(o.doneAt).getTime() <= RATE_DAYS * 864e5;

// ---------- Aktionen ----------
/** Festpreise des eigenen Shops setzen (Cent je Baustein, im Rahmen) – gelten für neue Aufträge, offene behalten ihren Preis */
async function setPrices({ user, prices }) {
  const bad = SERVICES.find(({ key }) => !validPrices({ ...shopPrices(null), [key]: prices[key] }));
  if (bad) {
    const r = settings.servicePrice[bad.key];
    throw new UserError(`${bad.label}: Der Preis muss zwischen ${euro(r.min)} und ${euro(r.max)} liegen.`);
  }
  const res = await GradingShop.updateOne({ _id: user._id }, { $set: { prices: Object.fromEntries(SERVICE_KEYS.map((k) => [k, prices[k]])) } });
  if (!res.matchedCount) throw new UserError('Du hast keinen Grading-Shop.');
}

/**
 * Karte einreichen mit gebuchten Bausteinen (services: { iron, slab, express }): mindestens Bügeln oder Benoten + Slab,
 * Bügeln nur bei einem ungebügelten Knick. Eigener Shop geht nicht, Shop muss Spieler-Aufträge annehmen. Eine Folie geht
 * ab (eine Karte im Slab muss erst aufgebrochen werden), der Preis wird eingezogen, die Karte ist bis zur Rückgabe gesperrt.
 */
async function submit({ user, shopCode, doc, services }) {
  if (!mongoose.isValidObjectId(doc)) throw new UserError('Diese Karte gibt es nicht.');
  const want = normServices(services);
  if (!want.iron && !want.slab && !want.review) throw new UserError('Wähle mindestens „Knick bügeln“ oder „Benoten + Slab“.');
  await expireDue();
  const shop = await GradingShop.findOne({ code: String(shopCode || '').toUpperCase() }).lean();
  if (!acceptsOrders(shop)) throw new UserError('Dieser Shop nimmt gerade keine Aufträge von Mitgliedern an.');
  if (String(shop._id) === String(user._id)) throw new UserError('Deine eigene Karte kannst du nicht bei deinem eigenen Shop einreichen.');
  const { parts, total: price } = priceOf(shop, want);
  let order;
  try {
    order = await inTransaction(async (session) => {
      const card = await TcgCard.findOne({ _id: doc, user: user._id }).select('card foiledAt slab condition.defects.crease condition.defects.ironed').session(session).lean();
      if (!card) throw new UserError('Diese Karte gehört dir nicht (mehr).');
      // Zweitprüfung nur für Slabs eines anderen Shops; sonst nur Karten ohne Slab
      if (want.review) {
        if (!card.slab) throw new UserError('Eine Zweitprüfung gibt es nur für Karten im Slab.');
        if (card.slab.code === shop.code || (shop.codeHistory || []).includes(card.slab.code)) throw new UserError('Dieser Slab stammt von genau diesem Shop – wähle für die Zweitprüfung einen anderen.');
      } else if (card.slab) throw new UserError('Die Karte steckt schon in einem Slab – brich ihn zuerst auf.');
      const defects = (card.condition && card.condition.defects) || {};
      if (want.iron && !(defects.crease && !defects.ironed)) throw new UserError('Diese Karte hat keinen Knick, den man noch bügeln kann.');
      const reason = (await lockedDocs(user._id, session)).reasons.get(String(card._id));
      if (reason && reason !== (want.review ? 'slab' : 'folie')) throw new UserError(`Die Karte ist gerade gesperrt (${lockLabel(reason)}).`);
      const paid = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: price } }, { $inc: { balance: -price } }, { new: true, session });
      if (!paid) throw new UserError(`Dein Guthaben reicht nicht – der Auftrag kostet ${euro(price)}.`);
      await claim([card._id], user._id, session);
      if (card.foiledAt && !want.review) await TcgCard.updateOne({ _id: card._id }, { $set: { foiledAt: null } }, { session });
      const [created] = await GradingOrder.create(
        [{ owner: user._id, ownerName: user.username, shop: shop._id, shopCode: shop.code, shopName: shop.name, doc: card._id, card: card.card, price, priceParts: parts, services: want, expiresAt: deadline(Date.now(), settings, want) }],
        { session }
      );
      await Ledger.create([{ user: user._id, type: 'grading_auftrag', amount: -price, betTitle: `${cardName(card.card)} bei ${shop.code}` }], { session });
      return created.toObject();
    });
  } catch (err) {
    if (err.code === 11000) throw new UserError('Diese Karte steckt schon in einem Auftrag.');
    throw err;
  }
  const what = SERVICES.filter(({ key }) => key !== 'base' && want[key]).map((x) => x.short).join(', ');
  await notify(shop._id, { area: 'Grading', href: SHOP_HREF, text: `${user.username} hat dir „${cardName(order.card)}“ geschickt: ${what} (${euro(price)}).` });
  return order;
}

/** Wartenden Auftrag stornieren (nur der Kunde, nur solange der Shop nicht angefangen hat) */
async function cancel({ user, orderId }) {
  if (!mongoose.isValidObjectId(orderId)) throw new UserError('Diesen Auftrag gibt es nicht.');
  const found = await GradingOrder.findOne({ _id: orderId, owner: user._id }).lean();
  if (!found) throw new UserError('Diesen Auftrag gibt es nicht.');
  if (found.status !== 'wartet') throw new UserError(found.status === 'in_arbeit' ? 'Der Shop arbeitet schon an deiner Karte.' : 'Dieser Auftrag ist schon erledigt.');
  const order = await inTransaction(async (session) => {
    const o = await GradingOrder.findOneAndUpdate({ _id: found._id, status: 'wartet' }, { $set: { status: 'storniert', doneAt: new Date() } }, { new: true, session }).lean();
    if (!o) throw new UserError('Der Shop hat gerade angefangen – stornieren geht nicht mehr.');
    await refundOwner(o, session);
    return o;
  });
  await notify(order.shop, { area: 'Grading', href: SHOP_HREF, text: `${user.username} hat den Auftrag „${cardName(order.card)}“ storniert.` });
  return order;
}

/** Abgelaufene Aufträge erstatten (beim Laden der Seiten und vor dem Annehmen) – gibt die Zahl zurück */
async function expireDue(now = new Date()) {
  const due = await GradingOrder.find({ status: { $in: OPEN }, expiresAt: { $lte: now } }).select('_id').limit(100).lean();
  let n = 0;
  for (const { _id } of due) {
    const order = await inTransaction((session) => closeWithRefund(_id, 'abgelaufen', session));
    if (!order) continue;
    n++;
    await notify(order.owner, { area: 'Grading', href: ORDERS_HREF, text: `${order.shopCode} hat deine Karte „${cardName(order.card)}“ nicht rechtzeitig gegradet – du bekommst ${euro(order.price)} zurück.` });
    await notify(order.shop, { area: 'Grading', href: SHOP_HREF, text: `Der Auftrag „${cardName(order.card)}“ von ${order.ownerName} ist abgelaufen – das Geld ging zurück.` });
  }
  return n;
}

/** Alle offenen Aufträge eines Shops erstatten (Kündigung) – in der Transaktion des Aufrufers; gibt die Aufträge zurück */
async function refundShop(shopId, session) {
  const open = await GradingOrder.find({ shop: shopId, status: { $in: OPEN } }).select('_id').session(session).lean();
  const out = [];
  for (const { _id } of open) {
    const o = await closeWithRefund(_id, 'storniert', session);
    if (o) out.push(o);
  }
  return out;
}

/**
 * Konto gelöscht (#204): offene Aufträge dieses Kunden enden ohne Erstattung (die Karte verschwindet mit dem Konto,
 * das Guthaben verfällt ohnehin); ein angefangener Job beim Shop wird gelöscht. In der Transaktion des Aufrufers –
 * gibt die Aufträge zurück (zum Benachrichtigen der Shops).
 */
async function dropOwner(ownerId, session) {
  const open = await GradingOrder.find({ owner: ownerId, status: { $in: OPEN } }).session(session).lean();
  if (!open.length) return [];
  await GradingOrder.updateMany({ _id: { $in: open.map((o) => o._id) }, status: { $in: OPEN } }, { $set: { status: 'storniert', doneAt: new Date() } }, { session });
  const jobs = open.map((o) => o.job).filter(Boolean);
  if (jobs.length) await GradingJob.deleteMany({ _id: { $in: jobs }, status: 'offen' }, { session });
  return open;
}

/**
 * Bewertung des Kunden: 1–5 Sterne und bis zu TAG_MAX Schnell-Tags, einmal, bis RATE_DAYS nach der Rückgabe – die
 * Sterne zählen fürs Rating und die Reputation
 */
async function rate({ user, orderId, stars, tags = [] }) {
  if (!(Number.isInteger(stars) && stars >= 1 && stars <= 5)) throw new UserError('Bitte vergib 1 bis 5 Sterne.');
  const picked = validTags(tags);
  if (!mongoose.isValidObjectId(orderId)) throw new UserError('Diesen Auftrag gibt es nicht.');
  const found = await GradingOrder.findOne({ _id: orderId, owner: user._id }).lean();
  if (!found || !canRate(found)) throw new UserError('Diesen Auftrag kannst du nicht (mehr) bewerten.');
  await inTransaction(async (session) => {
    const res = await GradingOrder.updateOne({ _id: found._id, stars: null }, { $set: { stars, tags: picked, ratedAt: new Date() } }, { session });
    if (!res.modifiedCount) throw new UserError('Du hast diesen Auftrag schon bewertet.');
    await GradingShop.updateOne({ _id: found.shop }, { $inc: { 'stars.sum': stars, 'stars.n': 1, reputation: reputation.starGain(stars) } }, { session });
  });
  const said = picked.length ? ` – „${picked.map((k) => tagByKey[k].label).join('“, „')}“` : '';
  await notify(found.shop, { area: 'Grading', href: `${SHOP_HREF}?reiter=bewertungen`, text: `${user.username} hat deinen Auftrag „${cardName(found.card)}“ mit ${stars} ${stars === 1 ? 'Stern' : 'Sternen'} bewertet${said}.` });
}

/**
 * Bewertungen eines Shops, neueste zuerst (#204, Google-Stil): [{ id, stars, tags: [{ key, label, good }], ratedAt,
 * owner: { username, avatar } | null, card, result, services }]
 */
async function shopReviews(shopId, limit = 20) {
  const list = await GradingOrder.find({ shop: shopId, stars: { $ne: null } }).sort({ ratedAt: -1 }).limit(limit).lean();
  const users = await User.find({ _id: { $in: [...new Set(list.map((o) => String(o.owner)))] } }).select('username avatar deletedAt').lean();
  const byId = new Map(users.filter((u) => !u.deletedAt).map((u) => [String(u._id), u]));
  return list.map((o) => ({
    id: String(o._id),
    stars: o.stars,
    tags: (o.tags || []).map((k) => tagByKey[k]).filter(Boolean),
    ratedAt: o.ratedAt,
    owner: byId.get(String(o.owner)) || null,
    card: catalog.cardById[o.card] || null,
    result: o.result,
    services: servicesOf(o),
    shopCode: o.shopCode,
  }));
}

/** Verteilung der Sterne eines Shops: [Anzahl 5★, 4★, 3★, 2★, 1★] */
async function starHistogram(shopId) {
  const rows = await GradingOrder.aggregate([{ $match: { shop: new mongoose.Types.ObjectId(String(shopId)), stars: { $ne: null } } }, { $group: { _id: '$stars', n: { $sum: 1 } } }]);
  const by = new Map(rows.map((r) => [r._id, r.n]));
  return [5, 4, 3, 2, 1].map((s) => by.get(s) || 0);
}

/** Neue Bewertungen seit dem letzten Blick aufs Handy (Badge auf dem Schreibtisch) */
async function newReviewCount(shop) {
  if (!shop) return 0;
  return GradingOrder.countDocuments({ shop: shop._id, ratedAt: { $gt: shop.reviewsSeenAt || new Date(0) } });
}

const markReviewsSeen = (userId) => GradingShop.updateOne({ _id: userId }, { $set: { reviewsSeenAt: new Date() } });

/**
 * Vitrine des eigenen Shops festlegen: nur eigene Slabs, höchstens showcaseMax, nicht im Handel. Reihenfolge wie
 * übergeben. Ausgestellte Slabs sind gesperrt (Grund 'vitrine') und boosten den Reputationsanstieg.
 */
async function setShowcase({ user, docs }) {
  const ids = [...new Set((docs || []).map(String))];
  if (ids.some((id) => !mongoose.isValidObjectId(id))) throw new UserError('Diese Karte gibt es nicht.');
  if (ids.length > settings.showcaseMax) throw new UserError(`In die Vitrine passen höchstens ${settings.showcaseMax} Slabs.`);
  const shop = await GradingShop.findById(user._id).lean();
  if (!shop || !shop.code) throw new UserError('Du hast keinen Grading-Shop.');
  const [owned, locked] = await Promise.all([TcgCard.find({ _id: { $in: ids }, user: user._id, slab: { $ne: null } }).select('_id').lean(), lockedDocs(user._id)]);
  if (owned.length !== ids.length) throw new UserError('In die Vitrine kommen nur eigene Slabs.');
  const busy = ids.find((id) => !['slab', 'vitrine'].includes(locked.reasons.get(id)));
  if (busy) throw new UserError(`Ein Slab ist gerade gesperrt (${lockLabel(locked.reasons.get(busy))}).`);
  await GradingShop.updateOne({ _id: user._id }, { $set: { showcase: ids } });
}

/** Eigene Slabs für die Vitrine-Auswahl: [{ id, card, rarity, foiledAt, slab, shown, lock }] */
async function showcaseChoices(userId) {
  const [docs, shop, locked] = await Promise.all([
    TcgCard.find({ user: userId, slab: { $ne: null } }).select('card rarity foiledAt slab').lean(),
    GradingShop.findById(userId).select('showcase').lean(),
    lockedDocs(userId),
  ]);
  const shown = new Set(((shop && shop.showcase) || []).map(String));
  return docs
    .filter((d) => catalog.cardById[d.card])
    .map((d) => {
      const r = locked.reasons.get(String(d._id));
      return { id: String(d._id), card: catalog.cardById[d.card], rarity: d.rarity, foiledAt: d.foiledAt, slab: { code: d.slab.code, grade: d.slab.grade }, shown: shown.has(String(d._id)), lock: r && !['slab', 'vitrine'].includes(r) ? r : null };
    })
    .sort((a, b) => Number(b.shown) - Number(a.shown) || b.slab.grade - a.slab.grade);
}

module.exports = {
  REVIEW_TAGS,
  TAG_MAX,
  validTags,
  shopReviews,
  starHistogram,
  newReviewCount,
  markReviewsSeen,
  ORDER_LEVEL,
  OPEN,
  RATE_DAYS,
  QUEUE_SORT,
  shopPrices,
  normServices,
  servicesOf,
  priceOf,
  validPrices,
  acceptsOrders,
  deadline,
  canRate,
  boostOf,
  showcasesOf,
  shopsForOrders,
  shopByCode,
  submittable,
  myOrders,
  queueFor,
  shopHistory,
  setPrices,
  submit,
  cancel,
  expireDue,
  refundShop,
  dropOwner,
  closeWithRefund,
  rate,
  setShowcase,
  showcaseChoices,
};

// Spieler-Aufträge im Grading (#204, Etappe B): Mitglieder reichen eigene Karten bei Grading-Shops anderer Mitglieder
// ein. Ablauf:
//   einreichen (Preis wird eingezogen, Karte gesperrt, eine Folie geht ab) → der Shop nimmt den Auftrag an (vor den
//   NPC-Aufträgen, gradingService.takeJob) → putzt, bügelt, benotet, versiegelt → die Karte kommt als Slab mit Kürzel
//   und Note des Shops zurück, der Shop bekommt den Preis (gradingService.finishJob) → der Kunde kann 1–5 Sterne geben.
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
const { settings } = require('./gradingService');

const ORDER_LEVEL = 3; // Spieler-Aufträge erst ab der Slab-Werkstatt – ohne Slab keine sichtbare Note
const OPEN = ['wartet', 'in_arbeit'];
const RATE_DAYS = 7; // so lange nach der Rückgabe kann der Kunde bewerten
const ORDERS_HREF = '/grading/einreichen';
const SHOP_HREF = '/grading';

const cardName = (id) => (catalog.cardById[id] ? catalog.cardById[id].name : id);

// ---------- Reine Regeln ----------
/** Preis eines Shops für Spieler-Aufträge (Cent): eigener Preis im Rahmen, sonst der Standardpreis */
function priceOf(shop, s = settings) {
  const p = shop && Number.isInteger(shop.price) ? shop.price : s.orderPrice.def;
  return Math.max(s.orderPrice.min, Math.min(s.orderPrice.max, p));
}

/** Liegt ein Preis (Cent) im Rahmen? */
const validPrice = (cents, s = settings) => Number.isInteger(cents) && cents >= s.orderPrice.min && cents <= s.orderPrice.max;

/** Nimmt dieser Shop Spieler-Aufträge an? (angestellt, Stufe 3+, mit Kürzel) */
const acceptsOrders = (shop) => !!shop && !!shop.active && (shop.level || 1) >= ORDER_LEVEL && !!shop.code;

/** Frist ab jetzt */
const deadline = (now = Date.now(), s = settings) => new Date(now + s.orderDays * 864e5);

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
    price: priceOf(s),
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
 * Eigene Karten, die sich einreichen lassen: kein Slab, nicht gesperrt (außer Folie – die geht beim Einreichen ab).
 * [{ id, card, rarity, foiledAt, damaged, creased, ironed, marks }] – seltenste zuerst
 */
async function submittable(userId) {
  const [docs, locked] = await Promise.all([
    TcgCard.find({ user: userId, slab: null }).select('card rarity foiledAt damaged creased ironedAt condition.defects.scratches condition.defects.crease').lean(),
    lockedDocs(userId),
  ]);
  return docs
    .filter((d) => {
      const r = locked.reasons.get(String(d._id));
      return catalog.cardById[d.card] && (!r || r === 'folie');
    })
    .map((d) => ({
      id: String(d._id),
      card: catalog.cardById[d.card],
      rarity: d.rarity,
      foiledAt: d.foiledAt,
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
  return list.map((o) => ({ ...o, cardInfo: catalog.cardById[o.card] || null, rateable: canRate(o, now) }));
}

/** Wartende Aufträge eines Shops (älteste zuerst) */
const queueFor = (shopId) => GradingOrder.find({ shop: shopId, status: 'wartet' }).sort({ createdAt: 1 }).lean();

/** Darf der Kunde diesen Auftrag (noch) bewerten? */
const canRate = (o, now = Date.now()) => o.status === 'fertig' && o.stars == null && !!o.doneAt && now - new Date(o.doneAt).getTime() <= RATE_DAYS * 864e5;

// ---------- Aktionen ----------
/** Preis des eigenen Shops setzen (Cent, im Rahmen) */
async function setPrice({ user, price }) {
  if (!validPrice(price)) throw new UserError(`Der Preis muss zwischen ${euro(settings.orderPrice.min)} und ${euro(settings.orderPrice.max)} liegen.`);
  const res = await GradingShop.updateOne({ _id: user._id }, { $set: { price } });
  if (!res.matchedCount) throw new UserError('Du hast keinen Grading-Shop.');
}

/**
 * Karte einreichen: eigener Shop geht nicht, Shop muss Spieler-Aufträge annehmen. Eine Folie geht ab (eine Karte im
 * Slab muss erst aufgebrochen werden), der Preis wird eingezogen, die Karte ist bis zur Rückgabe gesperrt.
 */
async function submit({ user, shopCode, doc }) {
  if (!mongoose.isValidObjectId(doc)) throw new UserError('Diese Karte gibt es nicht.');
  await expireDue();
  const shop = await GradingShop.findOne({ code: String(shopCode || '').toUpperCase() }).lean();
  if (!acceptsOrders(shop)) throw new UserError('Dieser Shop nimmt gerade keine Aufträge von Mitgliedern an.');
  if (String(shop._id) === String(user._id)) throw new UserError('Deine eigene Karte kannst du nicht bei deinem eigenen Shop einreichen.');
  const price = priceOf(shop);
  let order;
  try {
    order = await inTransaction(async (session) => {
      const card = await TcgCard.findOne({ _id: doc, user: user._id }).select('card foiledAt slab').session(session).lean();
      if (!card) throw new UserError('Diese Karte gehört dir nicht (mehr).');
      if (card.slab) throw new UserError('Die Karte steckt schon in einem Slab – brich ihn zuerst auf.');
      const reason = (await lockedDocs(user._id, session)).reasons.get(String(card._id));
      if (reason && reason !== 'folie') throw new UserError(`Die Karte ist gerade gesperrt (${lockLabel(reason)}).`);
      const paid = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: price } }, { $inc: { balance: -price } }, { new: true, session });
      if (!paid) throw new UserError(`Dein Guthaben reicht nicht – der Auftrag kostet ${euro(price)}.`);
      await claim([card._id], user._id, session);
      if (card.foiledAt) await TcgCard.updateOne({ _id: card._id }, { $set: { foiledAt: null } }, { session });
      const [created] = await GradingOrder.create(
        [{ owner: user._id, ownerName: user.username, shop: shop._id, shopCode: shop.code, shopName: shop.name, doc: card._id, card: card.card, price, expiresAt: deadline() }],
        { session }
      );
      await Ledger.create([{ user: user._id, type: 'grading_auftrag', amount: -price, betTitle: `${cardName(card.card)} bei ${shop.code}` }], { session });
      return created.toObject();
    });
  } catch (err) {
    if (err.code === 11000) throw new UserError('Diese Karte steckt schon in einem Auftrag.');
    throw err;
  }
  await notify(shop._id, { area: 'Grading', href: SHOP_HREF, text: `${user.username} hat dir „${cardName(order.card)}“ zum Graden geschickt (${euro(price)}).` });
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

/** Bewertung des Kunden: 1–5 Sterne, einmal, bis RATE_DAYS nach der Rückgabe – zählt fürs Rating und die Reputation */
async function rate({ user, orderId, stars }) {
  if (!(Number.isInteger(stars) && stars >= 1 && stars <= 5)) throw new UserError('Bitte vergib 1 bis 5 Sterne.');
  if (!mongoose.isValidObjectId(orderId)) throw new UserError('Diesen Auftrag gibt es nicht.');
  const found = await GradingOrder.findOne({ _id: orderId, owner: user._id }).lean();
  if (!found || !canRate(found)) throw new UserError('Diesen Auftrag kannst du nicht (mehr) bewerten.');
  await inTransaction(async (session) => {
    const res = await GradingOrder.updateOne({ _id: found._id, stars: null }, { $set: { stars, ratedAt: new Date() } }, { session });
    if (!res.modifiedCount) throw new UserError('Du hast diesen Auftrag schon bewertet.');
    await GradingShop.updateOne({ _id: found.shop }, { $inc: { 'stars.sum': stars, 'stars.n': 1, reputation: reputation.starGain(stars) } }, { session });
  });
  await notify(found.shop, { area: 'Grading', href: SHOP_HREF, text: `${user.username} hat deinen Auftrag „${cardName(found.card)}“ mit ${stars} ${stars === 1 ? 'Stern' : 'Sternen'} bewertet.` });
}

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
  ORDER_LEVEL,
  OPEN,
  RATE_DAYS,
  priceOf,
  validPrice,
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
  setPrice,
  submit,
  cancel,
  expireDue,
  refundShop,
  closeWithRefund,
  rate,
  setShowcase,
  showcaseChoices,
};

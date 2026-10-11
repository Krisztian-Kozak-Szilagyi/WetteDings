const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { GradingShop, GradingJob, GradingSettings, GradingOrder } = require('../models/Grading');
const { inTransaction } = require('../services/betService');
const { today } = require('../services/bonusService');
const { UserError } = require('../lib/util');
const { euro, slabCert } = require('../lib/viewHelpers');
const { logSettingsChange } = require('../stats/settingsLog');
const catalog = require('../tcg/catalog');
const { rollGradingFoil, ITEM_TYPES } = require('../items/itemService');
const foil = require('../items/foil');
const estimate = require('./estimate');
const { rnd, chance, pick, weighted, rollDefects, gradeFor, applyIron, creaseLine, ironCap, CREASE_SEGMENTS, PROFILES: CONDITION_PROFILES } = require('./condition');
const { notify } = require('../services/notifyService');
const { TcgCard } = require('../models/Tcg');
const { lockedDocs, isLocked, claim } = require('../tcg/locks');
const reputation = require('./reputation');
// Spieler-Aufträge (#204, Etappe B) – erst beim Aufruf laden: orderService braucht selbst die Einstellungen von hier
const orders = () => require('./orderService');

// ---------- Spielregeln (Demo-Werte) ----------
const CONTRACT_DAYS = 10; // so lange kann man nach der Annahme nicht kündigen
const MS_PER_SPOT = 800; // Mindestzeit pro Fleck (gegen automatisches "Fertig"-Senden)
const MS_PER_SEGMENT = 300; // Mindestzeit pro geglättetem Stück Knick beim Bügeln (#204)

// Arbeitsschritte: clean = Flecken entfernen, iron = Knick bügeln (nur Karten mit Knick, #204), grade = Note
// bestimmen, slab = einschweißen. Kosten, Lohn und Aufträge pro Tag stehen in den Einstellungen (Admin-Panel).
const LEVELS = [
  { level: 1, name: 'Putzstube', steps: ['clean'], perk: 'Karten reinigen und zurückschicken' },
  { level: 2, name: 'Grading-Labor', steps: ['clean', 'iron'], perk: 'Knicke bügeln – auch eigene Karten; sauber geglättet bringt Extra-Lohn' },
  { level: 3, name: 'Slab-Werkstatt', steps: ['clean', 'iron', 'grade', 'slab'], perk: 'Karten benoten (1–10) und im Slab versiegeln – richtige Noten und saubere Versiegelung bringen Extra-Lohn; mit Glück ein Folienfund' },
  { level: 4, name: 'Premium-Labor', steps: ['clean', 'iron', 'grade', 'slab'], premium: true, perk: 'Karten von Mitgliedern annehmen, Preise festlegen, Vitrine – und Stammkunden zahlen besser (mehr Lohn)' },
];
// Ab dieser Stufe kann man bügeln – Kundenkarten und eigene Karten
const IRON_LEVEL = 2;

// Werkzeug-Upgrades (#204): zweiter Ausbau-Zweig neben den Stufen – nur Komfort am Arbeitstisch, kein Lohn. Ab Stufe
// level kaufbar, Preise in den Einstellungen (toolCosts). Wirkung im Browser (public/js/grading.js, job.tools)
const TOOLS = [
  { key: 'tuch', name: 'Mikrofasertuch', level: 1, perk: 'Größerer Putzradius – Flecken sind schneller erwischt' },
  { key: 'eisen', name: 'Profi-Bügeleisen', level: 2, perk: 'Erhitzt langsamer – weniger Gefahr von Brandflecken' },
  { key: 'schablone', name: 'Zentrierschablone', level: 3, perk: 'Messlinien rasten deutlich stärker an der Bildkante ein' },
  { key: 'uv', name: 'UV-Lampe Pro', level: 3, perk: 'Größerer Lichtkegel – Ecken und Kanten schneller abgeleuchtet' },
];
const toolByKey = Object.fromEntries(TOOLS.map((t) => [t.key, t]));

/**
 * Arbeitsschritte eines Auftrags: Bügeln nur, wenn die Kundenkarte einen Knick hat, der noch nicht gebügelt ist.
 * Spieler-Aufträge mit gebuchten Bausteinen (job.services, #204): Bügeln nur, wenn gebucht; Benoten und Versiegeln nur
 * mit dem Baustein slab. Ohne services (NPC, ältere Aufträge) entscheidet allein die Stufe.
 */
const stepsFor = (job) =>
  job.services && job.services.review
    ? ['grade'] // Zweitprüfung: die Karte bleibt im Slab, nur benoten
    : levelInfo(job.level).steps.filter((s) => {
    if (s === 'iron') return !!(job.defects && job.defects.crease && !job.defects.ironed) && (!job.services || !!job.services.iron);
    if (s === 'grade' || s === 'slab') return !job.services || !!job.services.slab;
    return true;
  });
/** Spieler-Auftrag (Karte eines Mitglieds) statt NPC-Kunde? */
const isPlayerJob = (job) => !!job && job.source === 'spieler';

// Karten der Kunden: erst ab Holo (wer schickt schon eine Crumpled zur Echtheitsprüfung?).
// [Seltenheit, Gewicht, Lohn-Zuschlag in %] – je seltener, desto unwahrscheinlicher und desto mehr Lohn
const CUSTOMER_RARITIES = [
  ['holo', 45, 0],
  ['bockhaber', 25, 5],
  ['glitch', 14, 10],
  ['icon', 9, 15],
  ['boss', 5, 20],
  ['sith', 2, 50],
];
/** Lohn-Zuschlag in % für die Seltenheit der Kundenkarte (0, wenn unbekannt) */
const rarityBonus = (rarity) => (CUSTOMER_RARITIES.find(([k]) => k === rarity) || [null, 0, 0])[2];

const CUSTOMERS = ['Sammler Günther', 'Frau Hildebrandt', 'Kevin (12)', 'Onkel Horst', 'Auktionshaus Lemke', 'Dr. Brösel', 'Tante Uschi', 'Herr Kowalski', 'Jacqueline', 'Investor Maximilian', 'Oma Erna', 'Der Typ vom Flohmarkt'];

// ---------- Einstellungen (Admin) ----------
// jobs = NPC-Aufträge pro Tag (alle Stufen), pay = Lohn in Cent pro Schritt (clean: ganz sauber; grade: exakte Note,
// ±1 = halb; slab: perfekt versiegelt; iron: Knick ganz glatt), costs = Ausbaukosten in Cent für Stufe 2, 3, 4,
// premium = Lohn-Aufschlag in % auf Stufe 4.
// Spieler-Aufträge (#204, Etappe B): playerJobs pro Tag, servicePrice = Preisrahmen und Standardpreis je Baustein (Cent,
// siehe SERVICES), orderDays = Frist (so lange wartet ein Auftrag bzw. darf er in Arbeit sein), expressDays = Frist mit
// Express-Zuschlag, showcaseMax = Plätze in der Vitrine
const DEFAULTS = {
  open: false,
  jobs: 10,
  playerJobs: 10,
  pay: { clean: 2500, grade: 3000, slab: 3500, iron: 2000 },
  costs: [100000, 150000, 180000],
  premium: 30,
  servicePrice: {
    base: { min: 1000, max: 20000, def: 2000 },
    iron: { min: 1000, max: 30000, def: 3000 },
    slab: { min: 1000, max: 50000, def: 6000 },
    express: { min: 0, max: 30000, def: 3000 },
    review: { min: 1000, max: 30000, def: 3000 },
  },
  orderDays: 3,
  expressDays: 1,
  showcaseMax: 6,
  toolCosts: { tuch: 30000, schablone: 60000, eisen: 50000, uv: 40000 },
};
// Bausteine eines Spieler-Auftrags (#204): base ist immer dabei, dazu mindestens iron oder slab; express ist ein Zuschlag.
// review (Zweitprüfung) steht allein: ein Slab eines anderen Shops wird blind nachbenotet – ohne Reinigung
const SERVICES = [
  { key: 'base', label: 'Annahme & Reinigung', short: 'Reinigung' },
  { key: 'iron', label: 'Knick bügeln', short: 'Bügeln' },
  { key: 'slab', label: 'Benoten + Slab', short: 'Slab' },
  { key: 'express', label: 'Express-Zuschlag', short: 'Express' },
  { key: 'review', label: 'Zweitprüfung', short: 'Zweitprüfung' },
];
const copyServicePrice = (sp) => Object.fromEntries(SERVICES.map(({ key }) => [key, { ...sp[key] }]));
const settings = { ...DEFAULTS, pay: { ...DEFAULTS.pay }, costs: [...DEFAULTS.costs], servicePrice: copyServicePrice(DEFAULTS.servicePrice), toolCosts: { ...DEFAULTS.toolCosts } };
const PAY = settings.pay; // gleiches Objekt – Änderungen im Admin-Panel gelten sofort
const validCents = (v) => Number.isInteger(v) && v >= 0 && v <= 100000000;
/** Preisrahmen { min, max, def } in Cent mit min ≤ def ≤ max */
const validRange = (p) => !!p && [p.min, p.max, p.def].every(validCents) && p.min <= p.def && p.def <= p.max;

/** Ergänzt die Stufe um die aktuellen Einstellungen (Kosten, Aufträge, Lohnfaktor) */
function levelInfo(level) {
  const l = LEVELS[Math.min(LEVELS.length, Math.max(1, level)) - 1];
  return { ...l, cost: l.level > 1 ? settings.costs[l.level - 2] : 0, jobs: settings.jobs, factor: l.premium ? 1 + settings.premium / 100 : 1 };
}

function apply(doc) {
  if (!doc) return;
  if (typeof doc.open === 'boolean') settings.open = doc.open;
  if (Number.isInteger(doc.jobs) && doc.jobs >= 0 && doc.jobs <= 100) settings.jobs = doc.jobs;
  if (doc.pay) for (const k of Object.keys(PAY)) if (validCents(doc.pay[k])) PAY[k] = doc.pay[k];
  if (Array.isArray(doc.costs) && doc.costs.length === 3 && doc.costs.every(validCents)) settings.costs = [...doc.costs];
  if (Number.isFinite(doc.premium) && doc.premium >= 0 && doc.premium <= 500) settings.premium = doc.premium;
  if (Number.isInteger(doc.playerJobs) && doc.playerJobs >= 0 && doc.playerJobs <= 100) settings.playerJobs = doc.playerJobs;
  // Preisrahmen je Baustein: jeder Baustein einzeln – ein ungültiger lässt die anderen gelten
  if (doc.servicePrice) {
    for (const { key } of SERVICES) {
      const p = doc.servicePrice[key];
      if (validRange(p)) settings.servicePrice[key] = { min: p.min, max: p.max, def: p.def };
    }
  }
  if (Number.isInteger(doc.orderDays) && doc.orderDays >= 1 && doc.orderDays <= 30) settings.orderDays = doc.orderDays;
  if (Number.isInteger(doc.expressDays) && doc.expressDays >= 1 && doc.expressDays <= 30) settings.expressDays = doc.expressDays;
  if (Number.isInteger(doc.showcaseMax) && doc.showcaseMax >= 0 && doc.showcaseMax <= 24) settings.showcaseMax = doc.showcaseMax;
  if (doc.toolCosts) for (const { key } of TOOLS) if (validCents(doc.toolCosts[key])) settings.toolCosts[key] = doc.toolCosts[key];
}
async function loadSettings() {
  apply(await GradingSettings.findById('grading').lean());
}
/** Aktuell geltende Werte (für den Einstellungs-Verlauf) */
const current = () => JSON.parse(JSON.stringify({ ...settings, pay: PAY }));

async function saveSettings({ admin, ...values }) {
  await GradingSettings.updateOne({ _id: 'grading' }, { $set: { ...values, updatedByName: admin.username } }, { upsert: true });
  const before = current();
  apply(values);
  await logSettingsChange({ area: 'grading', before, after: current(), by: admin });
}

// ---------- Auftrag auswürfeln ----------
// Würfel-Hilfen, Mängel und Note teilen sich Kundenaufträge und Karten der Mitglieder (src/grading/condition.js)

/** Karte des Kunden: Seltenheit nach CUSTOMER_RARITIES (nur Seltenheiten, zu denen es Karten gibt) */
function rollCard() {
  const list = CUSTOMER_RARITIES.filter(([k]) => (catalog.cardsByRarity[k] || []).length);
  const [key] = list[weighted(list.map(([, w]) => w))];
  return pick(catalog.cardsByRarity[key]).id;
}

/** Flecken auf Vorder- und Rückseite (Positionen in % der Kartenfläche) */
function rollSpots() {
  const count = 4 + crypto.randomInt(4); // 4–7
  const spots = [];
  for (let i = 0; i < count; i++) {
    spots.push({
      side: i === 0 ? 'f' : i === 1 ? 'b' : chance(0.55) ? 'f' : 'b', // auf jeden Fall auch hinten etwas
      x: Math.round(rnd(14, 86)),
      y: Math.round(rnd(12, 88)),
      r: Math.round(rnd(7, 14)),
      kind: pick(['fleck', 'fleck', 'staub', 'finger', 'kaffee']),
    });
  }
  return spots;
}

/** Lohn eines Auftrags in Cent. clean = wie sauber die Karte zurückging (0–100 %), iron = wie glatt gebügelt (0–100 %) */
/**
 * Lohn eines NPC-Auftrags nach Posten (#204, für den Abschluss-Bildschirm): parts = Lohn je Schritt vor Zuschlägen,
 * extra = Premium- und Seltenheits-Zuschlag, total = Summe (wie payFor)
 */
function payParts({ level, clean = 100, grade, guess, seal, rarity, iron = null }) {
  const info = levelInfo(level);
  const parts = { clean: Math.round((PAY.clean * Math.max(0, Math.min(100, clean))) / 100) };
  if (info.steps.includes('iron') && Number.isFinite(iron)) parts.iron = Math.round((PAY.iron * Math.max(0, Math.min(100, iron))) / 100);
  if (info.steps.includes('grade')) {
    const diff = Math.abs(grade - guess);
    parts.grade = diff === 0 ? PAY.grade : diff === 1 ? PAY.grade / 2 : 0;
  }
  if (info.steps.includes('slab')) parts.slab = Math.round((PAY.slab * Math.max(0, Math.min(100, seal))) / 100);
  const sum = Object.values(parts).reduce((a, b) => a + b, 0);
  const total = Math.round(sum * info.factor * (1 + rarityBonus(rarity) / 100));
  return { parts, extra: total - sum, total };
}
const payFor = (input) => payParts(input).total;

// ---------- Ablauf ----------

/**
 * Heute verbrauchte Aufträge einer Quelle ('npc' oder 'spieler', #204): nur die auf der aktuellen Stufe – wer ausbaut,
 * bekommt am selben Tag ein neues volles Kontingent (#96). Der offene Auftrag zählt mit, wenn er heute auf dieser
 * Stufe angenommen wurde. Aufträge ohne source sind NPC-Aufträge.
 */
function usedToday({ done, open, level, day, source = 'npc' }) {
  const of = (j) => (j.source || 'npc') === source;
  const running = [].concat(open || []); // aktiver und angenommene Aufträge
  return done.filter((j) => j.level === level && of(j)).length + running.filter((j) => j.day === day && j.level === level && of(j)).length;
}

/** So viele Aufträge kann ein Shop gleichzeitig angenommen haben (der aktive mitgezählt) */
const MAX_ACCEPTED = 5;
/** Laufende Aufträge: der aktive (offen) und die im Hintergrund (angenommen) */
const RUNNING = ['offen', 'angenommen'];

/**
 * Tageskontingente (#204): used = NPC-Aufträge (fertige, abgebrochene und laufende), playerUsed = Aufträge von
 * Mitgliedern (fertige und laufende – abgebrochene gehen zurück in den Eingang und zählen nicht)
 */
const dayQuota = ({ done, dropped = [], running, level, day }) => ({
  used: usedToday({ done: done.concat(dropped), open: running, level, day }),
  playerUsed: usedToday({ done, open: running, level, day, source: 'spieler' }),
});

/**
 * Arbeitszeit eines Auftrags in ms (#204) für die Mindestzeiten beim Putzen und Bügeln: die gesammelte Zeit plus die
 * laufende, solange er aktiv ist – das Warten unter „Angenommen“ zählt nicht. Ältere Aufträge ohne activeAt zählen ab createdAt.
 */
function workedMs(job, now = Date.now()) {
  if (job.status !== 'offen') return job.workMs || 0;
  const since = job.activeAt || (job.workMs ? null : job.createdAt);
  return (job.workMs || 0) + (since ? Math.max(0, now - new Date(since).getTime()) : 0);
}
/** Felder, um einen Auftrag aktiv zu machen bzw. in den Hintergrund zu legen (die Arbeitszeit bleibt erhalten) */
const activate = (now = new Date()) => ({ status: 'offen', activeAt: now });
const park = (job, now = new Date()) => ({ status: 'angenommen', activeAt: null, workMs: workedMs(job, now.getTime()) });

/**
 * Aktiven Auftrag für die Werkbank (#204): die Werkbank schickt mit, an welchem Auftrag sie arbeitet. Ist inzwischen
 * ein anderer aktiv (zweiter Tab, Zurück-Taste nach „Auswählen“), greift nichts daneben – sonst landeten Note, Bügeln
 * und Sauberkeit auf der falschen Karte.
 */
async function benchJob(user, jobId, session = null) {
  if (!jobId || !mongoose.isValidObjectId(jobId)) throw new UserError('Die Werkbank ist nicht mehr aktuell – lade die Seite neu.');
  const job = await GradingJob.findOne({ _id: jobId, user: user._id, status: 'offen' }).session(session);
  if (job) return job;
  const any = await GradingJob.exists({ user: user._id, status: 'offen' }).session(session);
  throw new UserError(any ? 'Auf der Werkbank liegt inzwischen ein anderer Auftrag – lade die Seite neu.' : 'Du hast keinen offenen Auftrag.');
}

// Wert des Shops im Gesamtvermögen (Rangliste, Profil, Dashboard): die Hälfte der bezahlten Ausbaukosten
// (Krisztian, 2026-10-05) – mit den aktuellen Kosten aus den Einstellungen.
const SHOP_VALUE_PERCENT = 50;
/** Wert eines Shops dieser Stufe in Cent (Stufe 1 = 0) */
function shopValue(level, costs = settings.costs) {
  const paid = costs.slice(0, Math.max(0, Math.min(LEVELS.length, level || 1) - 1)).reduce((s, c) => s + c, 0);
  return Math.floor((paid * SHOP_VALUE_PERCENT) / 100);
}
/** Wert je Stufe [Stufe 1, 2, 3, 4] – für die Ranglisten-Aggregation */
const shopValues = () => LEVELS.map((l) => shopValue(l.level));

/**
 * Shop, offener Auftrag und heutige Aufträge. limit/used = NPC-Aufträge, playerLimit/playerUsed = Aufträge von
 * Mitgliedern (#204, ab Stufe 4), waiting = wartende Spieler-Aufträge dieses Shops
 */
async function getState(userId) {
  const day = today();
  let [shop, open, parked, done, dropped, waiting] = await Promise.all([
    GradingShop.findById(userId).lean(),
    GradingJob.findOne({ user: userId, status: 'offen' }).lean(),
    GradingJob.find({ user: userId, status: 'angenommen' }).sort({ createdAt: 1 }).lean(),
    GradingJob.find({ user: userId, day, status: 'fertig' }).sort({ doneAt: -1 }).lean(),
    GradingJob.find({ user: userId, day, status: 'abgebrochen' }).select('level source').lean(), // zählen fürs Tageslimit mit
    GradingOrder.countDocuments({ shop: userId, status: 'wartet' }),
  ]);
  // Ist nichts aktiv (fertig oder abgebrochen), rückt der älteste angenommene Auftrag nach
  if (!open && parked.length) {
    const promoted = await GradingJob.findOneAndUpdate({ _id: parked[0]._id, status: 'angenommen' }, { $set: activate() }, { new: true }).lean().catch(() => null);
    open = promoted || (await GradingJob.findOne({ user: userId, status: 'offen' }).lean());
    parked = parked.filter((j) => !open || String(j._id) !== String(open._id));
  }
  const running = [open, ...parked].filter(Boolean);
  const info = levelInfo(shop ? shop.level : 1);
  const players = !!shop && orders().acceptsOrders(shop);
  return {
    shop,
    info,
    next: info.level < LEVELS.length ? levelInfo(info.level + 1) : null,
    open,
    parked,
    accepted: running.length,
    done,
    limit: info.jobs,
    ...dayQuota({ done, dropped, running, level: info.level, day }),
    playerLimit: players ? settings.playerJobs : 0,
    waiting: players ? waiting : 0,
  };
}

/** Job annehmen: Vertrag über CONTRACT_DAYS Tage, ab jetzt kein Tagesbonus */
async function hire({ user }) {
  const now = new Date();
  const res = await GradingShop.updateOne(
    { _id: user._id, active: { $ne: true } },
    { $set: { active: true, hiredAt: now, lockedUntil: new Date(now.getTime() + CONTRACT_DAYS * 864e5) }, $setOnInsert: { level: 1 } },
    { upsert: true }
  ).catch((err) => {
    if (err.code === 11000) return { matchedCount: 0, upsertedCount: 0 };
    throw err;
  });
  if (!res.matchedCount && !res.upsertedCount) throw new UserError('Du arbeitest bereits im Grading-Shop.');
}

/** Kündigen – erst nach Ablauf der Vertragsbindung */
async function quit({ user }) {
  const shop = await GradingShop.findById(user._id).lean();
  if (!shop || !shop.active) throw new UserError('Du arbeitest nicht im Grading-Shop.');
  if (shop.lockedUntil && shop.lockedUntil > new Date()) throw new UserError('Dein Vertrag läuft noch – kündigen kannst du erst danach.');
  // Spieler-Aufträge (#204): wer kündigt, gibt alle offenen zurück – die Kunden bekommen ihr Geld
  const refunded = await inTransaction(async (session) => {
    const orders = await require('./orderService').refundShop(user._id, session);
    await GradingJob.deleteMany({ user: user._id, status: { $in: ['offen', 'angenommen'] } }, { session });
    await GradingShop.updateOne({ _id: user._id }, { $set: { active: false } }, { session });
    return orders;
  });
  for (const o of refunded) await notify(o.owner, { area: 'Grading', href: '/grading/einreichen', text: `${o.shopCode} hat geschlossen – du bekommst ${euro(o.price)} für „${(catalog.cardById[o.card] || {}).name || o.card}“ zurück.` });
}

// ---------- Name und Kürzel (#204) ----------
// Das Kürzel steht auf den Slabs (statt "BfW GRADING"). BFW gehört dem Haus.
// Der Name steht groß auf dem Namensschild des Hubs – länger als 20 Zeichen bricht dort um
const SHOP_NAME_MIN = 3;
const SHOP_NAME_MAX = 20;
const CODE_RE = /^[A-Z0-9]{2,5}$/;
const RESERVED_CODES = ['BFW'];

/** Name und Kürzel prüfen und vereinheitlichen: { name, code } oder UserError */
function validShopName({ name, code }) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  const c = String(code || '').replace(/\s+/g, '').toUpperCase();
  if (n.length < SHOP_NAME_MIN || n.length > SHOP_NAME_MAX) throw new UserError(`Der Name deines Shops braucht ${SHOP_NAME_MIN} bis ${SHOP_NAME_MAX} Zeichen.`);
  if (!CODE_RE.test(c)) throw new UserError('Das Kürzel besteht aus 2 bis 5 Buchstaben oder Ziffern.');
  if (RESERVED_CODES.includes(c)) throw new UserError(`Das Kürzel ${c} ist reserviert.`);
  return { name: n, code: c };
}

/**
 * Shop benennen. Der Name lässt sich jederzeit ändern; das Kürzel nur beim ersten Mal frei – danach wird eine Änderung
 * zur Anfrage, die ein Admin oder Dev freigibt (#204: das Kürzel steht auf Slabs und trägt Reputation).
 * Gibt { name, code, requested } zurück (requested = beantragtes neues Kürzel).
 */
async function setName({ user, name, code }) {
  const values = validShopName({ name, code });
  const shop = await GradingShop.findById(user._id).select('active code').lean();
  if (!shop || !shop.active) throw new UserError('Du arbeitest nicht im Grading-Shop.');
  if (shop.code && values.code !== shop.code) {
    await GradingShop.updateOne({ _id: user._id }, { $set: { name: values.name } });
    await requestCode({ user, code: values.code });
    return { name: values.name, code: shop.code, requested: values.code };
  }
  const res = await GradingShop.updateOne({ _id: user._id, active: true }, { $set: values }).catch((err) => {
    if (err.code === 11000) throw new UserError(`Das Kürzel ${values.code} hat schon ein anderer Shop.`);
    throw err;
  });
  if (!res.matchedCount) throw new UserError('Du arbeitest nicht im Grading-Shop.');
  return values;
}

// ---------- Kürzel-Anfragen (#204) ----------
/** Admins und Devs – bekommen die Anfragen als Benachrichtigung */
async function staffIds() {
  const config = require('../config');
  const staff = await User.find({ deletedAt: null, $or: [{ role: 'dev' }, { usernameLower: { $in: config.adminUsernames } }] }).select('_id').lean();
  return staff.map((u) => u._id);
}

/** Neues Kürzel beantragen (ersetzt eine offene Anfrage). Das Kürzel darf kein anderer Shop haben. */
async function requestCode({ user, code }) {
  const { code: c } = validShopName({ name: 'Anfrage', code });
  const shop = await GradingShop.findById(user._id).select('code').lean();
  if (!shop || !shop.code) throw new UserError('Gib deinem Shop zuerst einen Namen und ein Kürzel.');
  if (c === shop.code) throw new UserError('Das ist schon dein Kürzel.');
  if (await GradingShop.exists({ code: c })) throw new UserError(`Das Kürzel ${c} hat schon ein anderer Shop.`);
  await GradingShop.updateOne({ _id: user._id }, { $set: { codeRequest: { code: c, at: new Date() } } });
  for (const id of await staffIds()) {
    await notify(id, { area: 'Grading', href: '/admin?bereich=moderation&teil=kuerzel', key: 'grading:kuerzel', text: `${user.username} möchte das Shop-Kürzel von ${shop.code} auf ${c} ändern.`, many: (n) => `${n} Anfragen für neue Shop-Kürzel.` });
  }
  return c;
}

/** Offene Kürzel-Anfragen (älteste zuerst): [{ shop, username, name, code, requested, at }] */
async function codeRequests() {
  const shops = await GradingShop.find({ 'codeRequest.code': { $type: 'string' } }).select('name code codeRequest').sort({ 'codeRequest.at': 1 }).lean();
  const users = await User.find({ _id: { $in: shops.map((s) => s._id) } }).select('username').lean();
  const names = new Map(users.map((u) => [String(u._id), u.username]));
  return shops.map((s) => ({ shop: String(s._id), username: names.get(String(s._id)) || '?', name: s.name, code: s.code, requested: s.codeRequest.code, at: s.codeRequest.at }));
}
const codeRequestCount = () => GradingShop.countDocuments({ 'codeRequest.code': { $type: 'string' } });

/**
 * Anfrage entscheiden (Admin oder Dev): approve = neues Kürzel übernehmen (das alte kommt in codeHistory – ältere
 * Slabs tragen es weiter), sonst ablehnen. Der Shop wird benachrichtigt.
 */
async function decideCodeRequest({ actor, shopId, approve }) {
  const shop = await GradingShop.findById(shopId).select('code codeRequest').lean();
  if (!shop || !shop.codeRequest) throw new UserError('Diese Anfrage gibt es nicht mehr.');
  const wanted = shop.codeRequest.code;
  if (approve) {
    const res = await GradingShop.updateOne(
      { _id: shopId, 'codeRequest.code': wanted },
      { $set: { code: wanted, codeRequest: null }, ...(shop.code && { $addToSet: { codeHistory: shop.code } }) }
    ).catch((err) => {
      if (err.code === 11000) throw new UserError(`Das Kürzel ${wanted} hat inzwischen ein anderer Shop.`);
      throw err;
    });
    if (!res.modifiedCount) throw new UserError('Diese Anfrage hat sich gerade geändert.');
  } else {
    await GradingShop.updateOne({ _id: shopId, 'codeRequest.code': wanted }, { $set: { codeRequest: null } });
  }
  await notify(shopId, {
    area: 'Grading',
    href: '/grading',
    text: approve ? `Dein neues Shop-Kürzel ${wanted} ist freigegeben (von ${actor.username}).` : `Dein Wunsch-Kürzel ${wanted} wurde abgelehnt – es bleibt bei ${shop.code}.`,
  });
  return { code: approve ? wanted : shop.code, old: shop.code };
}

/** Werkzeuge zum Anzeigen: Katalog mit Preis, gekauft? und ab welcher Stufe */
function toolsFor(shop) {
  const owned = new Set((shop && shop.tools) || []);
  const level = (shop && shop.level) || 1;
  return TOOLS.map((t) => ({ ...t, cost: settings.toolCosts[t.key], owned: owned.has(t.key), available: level >= t.level }));
}

/** Werkzeug kaufen (einmal je Werkzeug, ab seiner Stufe) – gebucht wie ein Ausbau */
async function buyTool({ user, key }) {
  const tool = toolByKey[key];
  if (!tool) throw new UserError('Dieses Werkzeug gibt es nicht.');
  const cost = settings.toolCosts[key];
  return inTransaction(async (session) => {
    const shop = await GradingShop.findById(user._id).session(session);
    if (!shop || !shop.active) throw new UserError('Du arbeitest nicht im Grading-Shop.');
    if ((shop.level || 1) < tool.level) throw new UserError(`${tool.name} gibt es ab Stufe ${tool.level}.`);
    if ((shop.tools || []).includes(key)) throw new UserError(`„${tool.name}“ hast du schon.`);
    const paid = await User.updateOne({ _id: user._id, balance: { $gte: cost } }, { $inc: { balance: -cost } }, { session });
    if (!paid.modifiedCount) throw new UserError(`Dafür fehlt dir Spielgeld (${euro(cost)} nötig).`);
    await GradingShop.updateOne({ _id: user._id }, { $addToSet: { tools: key } }, { session });
    await Ledger.create([{ user: user._id, type: 'grading_ausbau', amount: -cost, betTitle: tool.name }], { session });
    return { ...tool, cost };
  });
}

/** Nächste Ausbaustufe kaufen */
async function upgrade({ user }) {
  return inTransaction(async (session) => {
    const shop = await GradingShop.findById(user._id).session(session);
    if (!shop || !shop.active) throw new UserError('Du arbeitest nicht im Grading-Shop.');
    const next = shop.level < LEVELS.length ? levelInfo(shop.level + 1) : null;
    if (!next) throw new UserError('Dein Shop ist schon voll ausgebaut.');
    const paid = await User.updateOne({ _id: user._id, balance: { $gte: next.cost } }, { $inc: { balance: -next.cost } }, { session });
    if (!paid.modifiedCount) throw new UserError(`Dafür fehlt dir Spielgeld (${euro(next.cost)} nötig).`);
    shop.level = next.level;
    await shop.save({ session });
    await Ledger.create([{ user: user._id, type: 'grading_ausbau', amount: -next.cost, betTitle: next.name }], { session });
    return next;
  });
}

/**
 * Wartenden Spieler-Auftrag annehmen (#204) – den gewählten (orderId) oder Express zuerst, sonst den ältesten: Mängel
 * und Note kommen aus der echten Karte, die Flecken sind nur zum Putzen ausgewürfelt. Gibt den Job zurück – oder
 * null, wenn keiner wartet. In der Transaktion von takeJob; ist der gewählte Auftrag nicht mehr da, kommt { error } zurück
 * statt eines Fehlers – sonst würde die Transaktion samt Erstattung (Karte weg) zurückgerollt.
 */
async function takePlayerJob({ user, info, orderId, status, session }) {
  // Express zuerst, sonst der älteste; die Frist beginnt beim ersten Arbeitsbeginn neu (Express: kürzer), nach einem
  // Abbruch läuft sie weiter (orderService.startSet)
  const next = await GradingOrder.findOne({ shop: user._id, status: 'wartet', ...(orderId ? { _id: orderId } : {}) }).sort(orders().QUEUE_SORT).select('services firstStartedAt').session(session).lean();
  if (!next) return orderId ? { error: 'Dieser Auftrag ist nicht mehr im Eingang – vielleicht wurde er storniert oder ist abgelaufen.' } : null;
  const order = await GradingOrder.findOneAndUpdate({ _id: next._id, status: 'wartet' }, { $set: orders().startSet(next) }, { new: true, session }).lean();
  if (!order) return orderId ? { error: 'Dieser Auftrag ist nicht mehr im Eingang.' } : null;
  const card = await TcgCard.findOne({ _id: order.doc, user: order.owner }).select('card condition').session(session).lean();
  if (!card || !card.condition) {
    await orders().closeWithRefund(order._id, 'storniert', session); // Karte weg (z. B. vom Team entfernt): Geld zurück
    return orderId ? { error: 'Die Karte dieses Auftrags gibt es nicht mehr – der Kunde bekommt sein Geld zurück.' } : null;
  }
  const [job] = await GradingJob.create(
    [{ user: user._id, day: today(), level: info.level, card: card.card, customer: order.ownerName, spots: orders().servicesOf(order).review ? [] : rollSpots(), defects: JSON.parse(JSON.stringify(card.condition.defects)), grade: card.condition.grade, source: 'spieler', ...status, order: order._id, cardDoc: order.doc, services: orders().servicesOf(order) }],
    { session }
  );
  await GradingOrder.updateOne({ _id: order._id }, { $set: { job: job._id } }, { session });
  return { job };
}

/**
 * Nächsten Auftrag annehmen (bis MAX_ACCEPTED gleichzeitig, der erste wird aktiv): zuerst Aufträge von Mitgliedern (#204, bis playerJobs am Tag),
 * sonst NPC-Aufträge (bis jobs am Tag, Tageslimit nach Stufe). Mit orderId nimmt der Spieler gezielt einen Auftrag
 * aus dem Eingang an, mit npc = true gezielt einen NPC-Auftrag (Auftragsverwaltung am Schreibtisch).
 * Alles in einer Transaktion, die zuerst den Shop beschreibt: gleichzeitige Annahmen (Doppelklick) laufen so
 * nacheinander und zählen die Limits jeweils frisch.
 */
async function takeJob({ user, orderId = null, npc = false }) {
  if (orderId && !mongoose.isValidObjectId(orderId)) throw new UserError('Diesen Auftrag gibt es nicht.');
  await orders().expireDue();
  await getState(user._id); // rückt einen angenommenen Auftrag nach, falls keiner aktiv ist
  let res;
  try {
    res = await inTransaction(async (session) => {
      const shop = await GradingShop.findOneAndUpdate({ _id: user._id }, { $set: { takenAt: new Date() } }, { new: true, session }).lean();
      if (!shop || !shop.active) throw new UserError('Nimm zuerst den Job im Grading-Shop an.');
      if (!shop.code) throw new UserError('Gib deinem Shop zuerst einen Namen und ein Kürzel.');
      const info = levelInfo(shop.level);
      const day = today();
      // nacheinander statt Promise.all: parallele Abfragen in einer Transaktion verträgt der Treiber nicht
      const running = await GradingJob.find({ user: user._id, status: { $in: RUNNING } }).select('day level source status').session(session).lean();
      const ended = await GradingJob.find({ user: user._id, day, status: { $in: ['fertig', 'abgebrochen'] } }).select('level source status').session(session).lean();
      const { used, playerUsed } = dayQuota({ done: ended.filter((j) => j.status === 'fertig'), dropped: ended.filter((j) => j.status === 'abgebrochen'), running, level: info.level, day });
      const limit = info.jobs;
      const playerLimit = orders().acceptsOrders(shop) ? settings.playerJobs : 0;
      if (running.length >= MAX_ACCEPTED) throw new UserError(`Du hast schon ${MAX_ACCEPTED} Aufträge angenommen – schließe oder brich erst einen ab.`);
      if (orderId && playerUsed >= playerLimit) throw new UserError('Für heute hast du schon alle Aufträge von Mitgliedern gemacht – morgen geht es weiter.');
      const now = new Date();
      const status = running.some((j) => j.status === 'offen') ? { status: 'angenommen' } : activate(now); // der erste wird aktiv
      if (!npc && playerUsed < playerLimit) {
        const taken = await takePlayerJob({ user, info, orderId, status, session });
        if (taken) return taken;
      }
      if (used >= limit) throw new UserError(playerUsed < playerLimit ? 'Die NPC-Aufträge für heute sind erledigt – warte auf Karten von Mitgliedern.' : 'Für heute sind alle Aufträge erledigt – morgen kommen neue.');
      const defects = rollDefects();
      const [job] = await GradingJob.create(
        [{ user: user._id, day, level: info.level, card: rollCard(), customer: pick(CUSTOMERS), spots: rollSpots(), defects, grade: gradeFor(defects), ...status }],
        { session }
      );
      return { job };
    });
  } catch (err) {
    if (err.code === 11000) throw new UserError('Das hat gerade nicht geklappt – versuch es noch einmal.');
    throw err;
  }
  if (res.error) throw new UserError(res.error); // erst nach dem Abschluss: eine Erstattung (Karte weg) bleibt bestehen
  return res.job;
}

/**
 * Angenommenen Auftrag abbrechen (#204, jobId; ohne Angabe der aktive): Die Karte eines Mitglieds geht zurück in den
 * Eingang – die Frist läuft dabei weiter (auch nach erneutem Annehmen, orderService.startSet), angefangene Schritte
 * (Bügeln, Note) sind weg, der Kunde bekommt Bescheid. Ein NPC-Auftrag ist verbraucht und zählt fürs Tageslimit mit,
 * sonst ließen sich Kunden und Karten beliebig neu würfeln. Gibt { player } zurück.
 */
async function abortJob({ user, jobId = null }) {
  if (jobId && !mongoose.isValidObjectId(jobId)) throw new UserError('Diesen Auftrag gibt es nicht.');
  const res = await inTransaction(async (session) => {
    const job = await GradingJob.findOne({ user: user._id, status: { $in: RUNNING }, ...(jobId ? { _id: jobId } : { status: 'offen' }) }).session(session);
    if (!job) throw new UserError('Diesen Auftrag gibt es nicht mehr.');
    if (!isPlayerJob(job)) {
      Object.assign(job, { status: 'abgebrochen', doneAt: new Date(), activeAt: null });
      await job.save({ session });
      return { player: false };
    }
    const order = await GradingOrder.findOneAndUpdate({ _id: job.order, status: 'in_arbeit' }, { $set: { status: 'wartet', job: null, startedAt: null } }, { new: true, session }).select('owner card shopCode expiresAt').lean();
    await GradingJob.deleteOne({ _id: job._id, status: { $in: RUNNING } }, { session });
    return { player: true, order };
  });
  if (res.order) {
    const name = (catalog.cardById[res.order.card] || {}).name || res.order.card;
    await notify(res.order.owner, { area: 'Grading', href: '/grading/einreichen', text: `${res.order.shopCode} hat die Arbeit an deiner Karte „${name}“ unterbrochen – sie liegt wieder im Eingang. Du kannst den Auftrag jetzt auch stornieren.` });
  }
  return { player: res.player };
}

/**
 * Einen angenommenen Auftrag zum aktiven machen (Werkbank): der bisher aktive wartet mit seinem Fortschritt
 * (Bügeln, Note, Arbeitszeit) im Hintergrund weiter.
 */
async function selectJob({ user, jobId }) {
  if (!mongoose.isValidObjectId(jobId)) throw new UserError('Diesen Auftrag gibt es nicht.');
  await inTransaction(async (session) => {
    const target = await GradingJob.findOne({ _id: jobId, user: user._id, status: { $in: RUNNING } }).session(session);
    if (!target) throw new UserError('Diesen Auftrag gibt es nicht mehr.');
    if (target.status === 'offen') return; // schon aktiv
    const now = new Date();
    const current = await GradingJob.findOne({ user: user._id, status: 'offen' }).session(session).lean();
    if (current) await GradingJob.updateOne({ _id: current._id, status: 'offen' }, { $set: park(current, now) }, { session });
    await GradingJob.updateOne({ _id: target._id, status: 'angenommen' }, { $set: activate(now) }, { session });
  });
}

/**
 * Note festlegen (nur einmal pro Auftrag, ab Stufe 3). Gibt die echte Note zurück – die Mängel sieht der
 * Spieler danach markiert. Ändern lässt sich die Note nicht mehr. Bei Spieler-Aufträgen (#204) bleibt die echte Note
 * geheim (grade: null): auf den Slab kommt die Note des Shops.
 */
async function setGuess({ user, jobId, guess }) {
  if (!(Number.isInteger(guess) && guess >= 1 && guess <= 10)) throw new UserError('Bitte gib eine Note von 1 bis 10.');
  const job = (await benchJob(user, jobId)).toObject();
  if (!stepsFor(job).includes('grade')) throw new UserError(job.services ? 'Dieser Auftrag umfasst kein Benoten – nur bügeln und zurückschicken.' : 'Benoten kannst du erst ab Stufe 3.');
  if (stepsFor(job).includes('iron') && !job.iron) throw new UserError('Bügle zuerst den Knick – danach kannst du benoten.');
  const updated = await GradingJob.findOneAndUpdate({ _id: job._id, status: 'offen', guess: null }, { $set: { guess } }, { new: true }).lean();
  const final = updated || job; // schon benotet: die erste Note bleibt
  return { guess: final.guess, grade: isPlayerJob(final) ? null : final.grade };
}

// ---------- Bügeln (#204) ----------
// Der Browser meldet, wie glatt der Knick wurde (smooth 0–100 %) und wie viele Brandflecken entstanden – wie beim
// Putzen. Der Server klemmt die Werte und prüft, dass genug Zeit vergangen ist; die Folgen rechnet condition.applyIron.

/** Mindestzeit fürs Bügeln in ms: je glatter, desto länger */
const ironMinMs = (smooth) => (CREASE_SEGMENTS * MS_PER_SEGMENT * Math.max(0, Math.min(100, Number(smooth) || 0))) / 100;
/** Werte vom Browser: { smooth: 0–100 ganzzahlig, burns: 0–CREASE_SEGMENTS } */
const ironInput = ({ smooth, burns }) => ({
  smooth: Math.round(Math.max(0, Math.min(100, Number.isFinite(smooth) ? smooth : 0))),
  burns: Math.floor(Math.max(0, Math.min(CREASE_SEGMENTS, Number.isFinite(burns) ? burns : 0))),
});

/**
 * Knick einer Kundenkarte bügeln (einmal, vor dem Benoten): neue Mängel und Note. Gibt { smooth, burns, cap,
 * defects } zurück – die Mängel braucht der Arbeitstisch für die Auflösung nach dem Benoten.
 */
async function ironJob({ user, jobId, smooth, burns }) {
  const job = (await benchJob(user, jobId)).toObject();
  if (!stepsFor(job).includes('iron')) throw new UserError(levelInfo(job.level).steps.includes('iron') ? 'Diese Karte hat keinen Knick.' : `Bügeln kannst du erst ab Stufe ${IRON_LEVEL}.`);
  if (job.iron) throw new UserError('Diese Karte ist schon gebügelt.');
  const input = ironInput({ smooth, burns });
  if (workedMs(job) < ironMinMs(input.smooth)) throw new UserError('So schnell kann niemand bügeln – versuch es noch einmal.');
  const defects = applyIron(job.defects, input, creaseLine(job.cardDoc || job._id)); // Spielerkarte: Knick wie auf dem Exemplar
  const updated = await GradingJob.findOneAndUpdate(
    { _id: job._id, status: 'offen', iron: null, guess: null },
    { $set: { iron: input, defects, grade: gradeFor(defects) } },
    { new: true }
  ).lean();
  if (!updated) throw new UserError('Diese Karte ist schon gebügelt.');
  return { ...input, cap: ironCap(input.smooth), defects: updated.defects };
}

// ---------- Eigene Karten bügeln (#204) ----------
// Wer im Grading-Shop ab Stufe IRON_LEVEL arbeitet, kann eigene unfolierte Karten mit Knick bügeln – einmal je Knick.
// Kein Lohn; das Ergebnis bleibt an der Karte (höhere Obergrenze, Brandflecken als Kratzer). Die Note bleibt geheim.

/** Eigene Exemplare zum Bügeln: unfoliert, mit Knick, noch nicht gebügelt, nicht gesperrt – [{ id, card }] */
async function ironableCards(userId) {
  const [docs, locked] = await Promise.all([
    TcgCard.find({ user: userId, creased: true, ironedAt: null, foiledAt: null }).select('card').sort({ createdAt: -1 }).lean(),
    lockedDocs(userId),
  ]);
  return docs.filter((d) => !isLocked(locked, d)).map((d) => ({ id: String(d._id), card: d.card }));
}

/** Prüft Shop und Stufe fürs Bügeln eigener Karten */
async function ironShop(userId, session = null) {
  const shop = await GradingShop.findById(userId).session(session);
  if (!shop || !shop.active) throw new UserError('Bügeln kannst du nur, solange du im Grading-Shop arbeitest.');
  if (shop.level < IRON_LEVEL) throw new UserError(`Bügeln kannst du erst ab Stufe ${IRON_LEVEL}.`);
  return shop;
}

/** Bügeln einer eigenen Karte beginnen: merkt sich Exemplar und Startzeit (für die Mindestzeit) */
async function startIroning({ user, doc }) {
  return inTransaction(async (session) => {
    const shop = await ironShop(user._id, session);
    const card = await TcgCard.findOne({ _id: doc, user: user._id }).select('card foiledAt creased ironedAt').session(session).lean();
    if (!card) throw new UserError('Diese Karte gehört dir nicht (mehr).');
    if (card.foiledAt) throw new UserError('Folierte Karten sind eingeschweißt – zum Bügeln zuerst die Folie abziehen.');
    if (!card.creased) throw new UserError('Diese Karte hat keinen Knick.');
    if (card.ironedAt) throw new UserError('Diese Karte ist schon gebügelt.');
    if (isLocked(await lockedDocs(user._id, session), card)) throw new UserError('Die Karte ist gerade unterwegs (Quest, Dungeon, Handel oder Duell).');
    await claim([card], user._id, session);
    shop.ironing = { doc: card._id, startedAt: new Date() };
    await shop.save({ session });
    return card;
  });
}

/** Bügeln einer eigenen Karte abschließen – gibt { smooth, burns, cap, card } zurück (ohne Mängel: die bleiben geheim) */
async function finishIroning({ user, smooth, burns }) {
  return inTransaction(async (session) => {
    const shop = await ironShop(user._id, session);
    if (!shop.ironing || !shop.ironing.doc) throw new UserError('Du bügelst gerade keine Karte.');
    const input = ironInput({ smooth, burns });
    if (Date.now() - shop.ironing.startedAt.getTime() < ironMinMs(input.smooth)) throw new UserError('So schnell kann niemand bügeln – versuch es noch einmal.');
    const doc = await TcgCard.findOne({ _id: shop.ironing.doc, user: user._id, foiledAt: null, ironedAt: null }).select('card condition').session(session).lean();
    shop.ironing = null;
    await shop.save({ session });
    if (!doc || !doc.condition || !doc.condition.defects.crease) throw new UserError('Diese Karte kannst du nicht mehr bügeln.');
    const defects = applyIron(doc.condition.defects, input, creaseLine(doc._id));
    await TcgCard.updateOne(
      { _id: doc._id, user: user._id, foiledAt: null, ironedAt: null },
      { $set: { 'condition.defects': defects, 'condition.grade': gradeFor(defects), ironedAt: new Date(), damaged: true } },
      { session }
    );
    return { ...input, cap: ironCap(input.smooth), card: doc.card };
  });
}

/** Reputation, Arbeitsqualität und Treffsicherheit eines erledigten Auftrags in den Shop schreiben (#204) */
async function scoreShop({ shopId, job, session }) {
  const shop = await GradingShop.findById(shopId).select('showcase').session(session).lean();
  const showcase = shop ? (await orders().showcasesOf([{ _id: shopId, showcase: shop.showcase }])).get(String(shopId)) || [] : [];
  const quality = reputation.qualityOf({ clean: job.clean, seal: job.seal, iron: job.iron });
  const inc = { 'quality.sum': quality, 'quality.n': 1, reputation: reputation.reputationGain({ quality, player: isPlayerJob(job), boost: orders().boostOf(showcase) }) };
  if (job.guess != null) Object.assign(inc, { 'hits.n': 1, 'hits.exact': job.guess === job.grade ? 1 : 0 });
  await GradingShop.updateOne({ _id: shopId }, { $inc: inc }, { session });
  return { quality, reputation: inc.reputation };
}

/**
 * Spieler-Auftrag abschließen (#204), in der Transaktion von finishJob: Die Karte bekommt das Ergebnis des Bügelns und –
 * mit dem Baustein slab – einen Slab mit Kürzel und Note des Shops; der Shop bekommt den Preis. Gibt den Auftrag zurück.
 */
async function finishPlayerJob({ job, shop, session }) {
  const order = await GradingOrder.findOne({ _id: job.order, status: 'in_arbeit' }).session(session);
  if (!order) throw new UserError('Dieser Auftrag ist abgelaufen – die Karte ging an den Kunden zurück.');
  const now = new Date();
  if (job.services && job.services.review) return finishReview({ job, shop, order, now, session });
  const d = job.defects.toObject ? job.defects.toObject() : job.defects;
  const slabbed = stepsFor(job).includes('slab');
  const set = slabbed ? { foiledAt: now, slab: { code: shop.code, grade: job.guess, at: now, cert: slabCert(order.doc) } } : {};
  if (job.iron) Object.assign(set, { 'condition.defects': d, 'condition.grade': job.grade, ironedAt: now, creased: !!d.crease, damaged: (d.scratches || []).length > 0 || !!d.crease });
  const res = Object.keys(set).length ? await TcgCard.updateOne({ _id: order.doc, user: order.owner }, { $set: set }, { session }) : { matchedCount: await TcgCard.countDocuments({ _id: order.doc, user: order.owner }).session(session) };
  if (!res.matchedCount) throw new UserError('Die Karte gibt es nicht mehr.');
  Object.assign(order, { status: 'fertig', doneAt: now, result: { grade: slabbed ? job.guess : null, clean: job.clean, seal: job.seal, iron: job.iron ? job.iron.smooth : null } });
  await order.save({ session });
  await User.updateOne({ _id: job.user }, { $inc: { balance: order.price } }, { session });
  await Ledger.create([{ user: job.user, type: 'grading_einnahme', amount: order.price, betTitle: `${(catalog.cardById[job.card] || {}).name || job.card} für ${order.ownerName}` }], { session });
  return order.toObject();
}

/**
 * Zweitprüfung abschließen (#204, in der Transaktion von finishJob): gleiche Note → der Slab bekommt einen Vermerk
 * „bestätigt von …“; andere Note → neuer Slab mit Kürzel und Note des Prüfers, das alte Etikett kommt in die Geschichte.
 * Lag die alte Note 2 oder mehr neben der echten, verliert der Aussteller Reputation. Der Prüfer bekommt den Preis.
 */
async function finishReview({ job, shop, order, now, session }) {
  const card = await TcgCard.findOne({ _id: order.doc, user: order.owner }).select('slab').session(session).lean();
  if (!card || !card.slab) throw new UserError('Die Karte steckt nicht mehr im Slab.');
  const old = card.slab;
  const changed = job.guess !== old.grade;
  const update = changed
    ? { $set: { slab: { code: shop.code, grade: job.guess, at: now, cert: old.cert || slabCert(order.doc), history: [...(old.history || []), { code: old.code, grade: old.grade, at: old.at }] } } }
    : { $push: { 'slab.reviews': { code: shop.code, grade: job.guess, at: now } } };
  await TcgCard.updateOne({ _id: order.doc, user: order.owner }, update, { session });
  // Aussteller lag deutlich daneben: weniger Reputation (alte BfW-Slabs haben keinen Shop)
  const issuerWrong = old.code && old.code !== 'BfW' && Math.abs((old.grade || 0) - job.grade) >= 2;
  const issuer = issuerWrong ? await GradingShop.findOneAndUpdate({ $or: [{ code: old.code }, { codeHistory: old.code }] }, { $inc: { reputation: -reputation.REVIEW_PENALTY } }, { session }).select('_id').lean() : null;
  Object.assign(order, { status: 'fertig', doneAt: now, result: { grade: job.guess, clean: null, seal: null, iron: null, before: old.grade, changed, issuer: old.code } });
  await order.save({ session });
  await User.updateOne({ _id: job.user }, { $inc: { balance: order.price } }, { session });
  await Ledger.create([{ user: job.user, type: 'grading_einnahme', amount: order.price, betTitle: `Zweitprüfung ${(catalog.cardById[job.card] || {}).name || job.card} für ${order.ownerName}` }], { session });
  return { ...order.toObject(), issuerShop: issuer ? issuer._id : null };
}

/**
 * Auftrag abschließen und an den Kunden zurückschicken: Lohn gutschreiben (Spieler-Aufträge: den Preis des Auftrags).
 * clean = Sauberkeit 0–100 %. Wer versiegelt (ab Stufe 3), findet mit kleiner Chance eine Folie fürs Inventar.
 */
async function finishJob({ user, jobId, clean, seal }) {
  const done = await inTransaction(async (session) => {
    const job = await benchJob(user, jobId, session);
    const steps = stepsFor(job);
    // ohne Putzschritt (Zweitprüfung) gilt die Karte als sauber
    const cleanQ = !steps.includes('clean') ? 100 : Number.isFinite(clean) ? Math.round(Math.max(0, Math.min(100, clean))) : 0;
    if (steps.includes('iron') && !job.iron) throw new UserError('Bügle zuerst den Knick.');
    // Putzen (und Bügeln) braucht Zeit: je sauberer, desto länger muss der Auftrag mindestens gelaufen sein
    const ironMs = job.iron ? ironMinMs(job.iron.smooth) : 0;
    if (workedMs(job) < (job.spots.length * MS_PER_SPOT * cleanQ) / 100 + ironMs) throw new UserError('So schnell kann niemand putzen – versuch es noch einmal.');
    if (steps.includes('grade') && job.guess === null) throw new UserError('Bitte benote die Karte zuerst.');
    const sealQ = steps.includes('slab') ? (Number.isFinite(seal) ? Math.round(Math.max(0, Math.min(100, seal))) : 0) : null;
    const card = catalog.cardById[job.card];
    const player = isPlayerJob(job);
    const shop = await GradingShop.findById(user._id).select('code').session(session).lean();
    Object.assign(job, { clean: cleanQ, seal: sealQ });
    // Spieler-Auftrag: Karte als Slab zurück, der Shop bekommt den Preis (kein Lohn vom Haus)
    const order = player ? await finishPlayerJob({ job, shop, session }) : null;
    const pay = player ? order.price : payFor({ level: job.level, clean: cleanQ, grade: job.grade, guess: job.guess, seal: sealQ, rarity: card && card.rarity, iron: job.iron ? job.iron.smooth : null });
    const foilFound = sealQ > 0 && (await rollGradingFoil({ userId: user._id, session }));
    // Posten für Abschluss-Bildschirm und Kassenzettel (NPC: Lohn je Schritt; Mitglieder-Auftrag: gebuchte Bausteine)
    const breakdown = player ? { parts: { ...(order.priceParts || {}) }, extra: 0, total: pay } : payParts({ level: job.level, clean: cleanQ, grade: job.grade, guess: job.guess, seal: sealQ, rarity: card && card.rarity, iron: job.iron ? job.iron.smooth : null });
    Object.assign(job, { status: 'fertig', pay, foilFound, shopCode: (shop && shop.code) || null, doneAt: new Date(), parts: { ...breakdown.parts, extra: breakdown.extra } });
    await job.save({ session });
    if (!player) {
      await User.updateOne({ _id: user._id }, { $inc: { balance: pay } }, { session });
      await Ledger.create([{ user: user._id, type: 'grading_lohn', amount: pay, betTitle: card ? `${card.name} für ${job.customer}` : job.customer }], { session });
    }
    await GradingShop.updateOne({ _id: user._id }, { $inc: { jobsDone: 1, earned: pay, ...(player && { playerJobsDone: 1 }) } }, { session });
    const score = await scoreShop({ shopId: user._id, job, session });
    return { ...job.toObject(), order, breakdown, score };
  });
  if (done.foilFound) await notify(user._id, { area: 'Grading', href: '/inventar', text: 'Beim Versiegeln ist dir eine Folie übrig geblieben – sie liegt in deinem Inventar.' });
  if (done.order) {
    const name = (catalog.cardById[done.card] || {}).name || done.card;
    const r = done.order.result;
    const review = done.order.services && done.order.services.review;
    const what = review
      ? r.changed
        ? `Zweitprüfung bei ${done.shopCode} ergibt Note ${r.grade} statt ${r.before} – neuer Slab`
        : `Zweitprüfung bei ${done.shopCode} bestätigt Note ${r.grade}`
      : r.grade != null
        ? `Slab ${done.shopCode}, Note ${done.guess}`
        : `gebügelt bei ${done.shopCode}`;
    await notify(done.order.owner, { area: 'Grading', href: '/grading/einreichen', text: `„${name}“ ist zurück: ${what}. Bewerte den Shop!` });
    if (done.order.issuerShop) await notify(done.order.issuerShop, { area: 'Grading', href: '/grading', text: `Zweitprüfung: Dein Slab „${name}“ (Note ${r.before}) lag deutlich daneben – ${done.shopCode} vergab ${r.grade}. Das kostet Reputation.` });
  }
  return done;
}

// ---------- Lohn-Schätzung fürs Admin-Panel ----------
/** Feste Werte für die Schätzung (Stufen, Seltenheits-Faktor, Folienwert pro versiegeltem Auftrag, Profile) */
function estimateInput() {
  const folie = ITEM_TYPES.find((t) => t.key === 'folie');
  return {
    levels: LEVELS.map(({ level, name, steps, premium }) => ({ level, name, steps, premium: !!premium })),
    factor: estimate.rarityFactor(CUSTOMER_RARITIES, (k) => (catalog.cardsByRarity[k] || []).length > 0),
    foilValue: ((foil.settings.gradingChance / 10000) * (folie ? folie.sell : 0)),
    profiles: estimate.PROFILES,
    creaseChance: CONDITION_PROFILES.kunde.crease, // so viele Kundenkarten haben einen Knick (Bügeln, #204)
  };
}

/** Schätzung mit den aktuellen Einstellungen */
const estimateNow = () => estimate.estimate({ ...estimateInput(), settings: { jobs: settings.jobs, pay: PAY, costs: settings.costs, premium: settings.premium } });

/** Tatsächlich verdient (letzte days Tage, ohne Folien) je Stufe: Aufträge, Ø Lohn pro Auftrag und pro Arbeitstag */
async function actualStats(days = 30) {
  const since = new Date(Date.now() - days * 864e5);
  const rows = await GradingJob.aggregate([
    { $match: { status: 'fertig', doneAt: { $gte: since } } },
    { $group: { _id: { level: '$level', user: '$user', day: '$day' }, n: { $sum: 1 }, pay: { $sum: '$pay' } } },
    { $group: { _id: '$_id.level', jobs: { $sum: '$n' }, pay: { $sum: '$pay' }, workDays: { $sum: 1 }, users: { $addToSet: '$_id.user' } } },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({ level: r._id, jobs: r.jobs, users: r.users.length, perJob: Math.round(r.pay / r.jobs), jobsPerDay: r.jobs / r.workDays, perWorkDay: Math.round(r.pay / r.workDays) }));
}

/** Arbeitet das Mitglied gerade im Grading-Shop? (dann kein Tagesbonus) */
const isWorking = (userId) => GradingShop.exists({ _id: userId, active: true }).then(Boolean);

module.exports = { TOOLS, toolsFor, buyTool, payParts, SERVICES, validRange, requestCode, codeRequests, codeRequestCount, decideCodeRequest, isPlayerJob, scoreShop, IRON_LEVEL, MS_PER_SEGMENT, stepsFor, ironMinMs, ironInput, ironJob, ironableCards, startIroning, finishIroning, validShopName, SHOP_NAME_MIN, SHOP_NAME_MAX, setName, usedToday, shopValue, shopValues, SHOP_VALUE_PERCENT, estimateInput, estimateNow, actualStats, CONTRACT_DAYS, MS_PER_SPOT, LEVELS, PAY, CUSTOMER_RARITIES, rarityBonus, rollCard, levelInfo, settings, loadSettings, saveSettings, rollSpots, rollDefects, gradeFor, payFor, getState, hire, quit, upgrade, takeJob, abortJob, selectJob, MAX_ACCEPTED, dayQuota, workedMs, activate, park, setGuess, finishJob, isWorking };

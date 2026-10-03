const crypto = require('crypto');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { GradingShop, GradingJob, GradingSettings } = require('../models/Grading');
const { inTransaction } = require('../services/betService');
const { today } = require('../services/bonusService');
const { UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');
const catalog = require('../tcg/catalog');

// ---------- Spielregeln (Demo-Werte) ----------
const CONTRACT_DAYS = 10; // so lange kann man nach der Annahme nicht kündigen
const MS_PER_SPOT = 800; // Mindestzeit pro Fleck (gegen automatisches "Fertig"-Senden)

// Arbeitsschritte: clean = Flecken entfernen, grade = Note bestimmen, slab = einschweißen.
// Kosten, Lohn und Aufträge pro Tag stehen in den Einstellungen (Admin-Panel).
const LEVELS = [
  { level: 1, name: 'Putzstube', steps: ['clean'], perk: 'Karten reinigen und zurückschicken' },
  { level: 2, name: 'Grading-Labor', steps: ['clean', 'grade'], perk: 'Karten benoten (1–10) – richtige Noten bringen Extra-Lohn' },
  { level: 3, name: 'Slab-Werkstatt', steps: ['clean', 'grade', 'slab'], perk: 'Karten im Slab versiegeln – saubere Versiegelung bringt Extra-Lohn' },
  { level: 4, name: 'Premium-Labor', steps: ['clean', 'grade', 'slab'], premium: true, perk: 'Sammler bringen nur noch seltene Karten (ab Gold) – mehr Lohn' },
];

const CUSTOMERS = ['Sammler Günther', 'Frau Hildebrandt', 'Kevin (12)', 'Onkel Horst', 'Auktionshaus Lemke', 'Dr. Brösel', 'Tante Uschi', 'Herr Kowalski', 'Jacqueline', 'Investor Maximilian', 'Oma Erna', 'Der Typ vom Flohmarkt'];

// ---------- Einstellungen (Admin) ----------
// jobs = Aufträge pro Tag (alle Stufen), pay = Lohn in Cent pro Schritt (clean: ganz sauber; grade: exakte Note,
// ±1 = halb; slab: perfekt versiegelt), costs = Ausbaukosten in Cent für Stufe 2, 3, 4, premium = Lohn-Aufschlag
// in % auf Stufe 4
const DEFAULTS = { open: false, jobs: 10, pay: { clean: 2500, grade: 2000, slab: 1500 }, costs: [150000, 500000, 1200000], premium: 30 };
const settings = { ...DEFAULTS, pay: { ...DEFAULTS.pay }, costs: [...DEFAULTS.costs] };
const PAY = settings.pay; // gleiches Objekt – Änderungen im Admin-Panel gelten sofort
const validCents = (v) => Number.isInteger(v) && v >= 0 && v <= 100000000;

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
}
async function loadSettings() {
  apply(await GradingSettings.findById('grading').lean());
}
async function saveSettings({ admin, ...values }) {
  await GradingSettings.updateOne({ _id: 'grading' }, { $set: { ...values, updatedByName: admin.username } }, { upsert: true });
  apply(values);
}

// ---------- Auftrag auswürfeln ----------
const rnd = (min, max) => min + (crypto.randomInt(1000000) / 1000000) * (max - min);
const chance = (p) => crypto.randomInt(1000000) < p * 1000000;
const pick = (list) => list[crypto.randomInt(list.length)];
/** Index nach Gewichten, z. B. [40, 35, 18, 7] */
function weighted(weights) {
  let roll = crypto.randomInt(weights.reduce((s, w) => s + w, 0));
  for (let i = 0; i < weights.length; i++) {
    if (roll < weights[i]) return i;
    roll -= weights[i];
  }
  return 0;
}

/** Karte des Kunden: wie beim Pack nach Seltenheit gewürfelt (ohne geheime); Premium-Labor nur ab Gold */
function rollCard(level) {
  const rarities = catalog.RARITIES.filter((r) => !r.hidden && catalog.cardsByRarity[r.key].length && (level < 4 || r.rank >= catalog.rarityByKey.gold.rank));
  const r = rarities[weighted(rarities.map((x) => Math.max(1, x.weight)))];
  return pick(catalog.cardsByRarity[r.key]).id;
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

/** Mängel der Vorderseite und die daraus folgende Note (10 minus Abzüge, mindestens 1) */
function rollDefects() {
  const scratches = Array.from({ length: weighted([40, 35, 18, 7]) }, () => ({
    x: Math.round(rnd(20, 80)),
    y: Math.round(rnd(18, 82)),
    len: Math.round(rnd(14, 30)),
    angle: Math.round(rnd(-70, 70)),
  }));
  const corners = [0, 1, 2, 3].filter(() => chance(0.15));
  const edges = Array.from({ length: weighted([60, 30, 10]) }, () => ({ side: crypto.randomInt(4), pos: Math.round(rnd(20, 80)) }));
  const crease = chance(0.08);
  return { scratches, corners, edges, crease };
}

/** Note aus den Mängeln: Kratzer, Ecke, Kantenmacke je −1, Knick −3 */
function gradeFor(defects) {
  const minus = defects.scratches.length + defects.corners.length + defects.edges.length + (defects.crease ? 3 : 0);
  return Math.max(1, 10 - minus);
}

/** Lohn eines Auftrags in Cent. clean = wie sauber die Karte zurückging (0–100 %) */
function payFor({ level, clean = 100, grade, guess, seal }) {
  const info = levelInfo(level);
  let pay = Math.round((PAY.clean * Math.max(0, Math.min(100, clean))) / 100);
  if (info.steps.includes('grade')) {
    const diff = Math.abs(grade - guess);
    if (diff === 0) pay += PAY.grade;
    else if (diff === 1) pay += PAY.grade / 2;
  }
  if (info.steps.includes('slab')) pay += Math.round((PAY.slab * Math.max(0, Math.min(100, seal))) / 100);
  return Math.round(pay * info.factor);
}

// ---------- Ablauf ----------

/** Shop, offener Auftrag und heutige Aufträge */
async function getState(userId) {
  const day = today();
  const [shop, open, done] = await Promise.all([
    GradingShop.findById(userId).lean(),
    GradingJob.findOne({ user: userId, status: 'offen' }).lean(),
    GradingJob.find({ user: userId, day, status: 'fertig' }).sort({ doneAt: -1 }).lean(),
  ]);
  const info = levelInfo(shop ? shop.level : 1);
  return { shop, info, next: info.level < LEVELS.length ? levelInfo(info.level + 1) : null, open, done, limit: info.jobs, used: done.length + (open && open.day === day ? 1 : 0) };
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
  await GradingJob.deleteMany({ user: user._id, status: 'offen' });
  await GradingShop.updateOne({ _id: user._id }, { $set: { active: false } });
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

/** Nächsten Auftrag annehmen (höchstens einer offen, Tageslimit nach Stufe) */
async function takeJob({ user }) {
  const { shop, info, open, used, limit } = await getState(user._id);
  if (!shop || !shop.active) throw new UserError('Nimm zuerst den Job im Grading-Shop an.');
  if (open) throw new UserError('Du hast noch einen offenen Auftrag.');
  if (used >= limit) throw new UserError('Für heute sind alle Aufträge erledigt – morgen kommen neue.');
  const defects = rollDefects();
  try {
    return await GradingJob.create({
      user: user._id,
      day: today(),
      level: info.level,
      card: rollCard(info.level),
      customer: pick(CUSTOMERS),
      spots: rollSpots(),
      defects,
      grade: gradeFor(defects),
    });
  } catch (err) {
    if (err.code === 11000) throw new UserError('Du hast noch einen offenen Auftrag.');
    throw err;
  }
}

/**
 * Note festlegen (nur einmal pro Auftrag, ab Stufe 2). Gibt die echte Note zurück – die Mängel sieht der
 * Spieler danach markiert. Ändern lässt sich die Note nicht mehr.
 */
async function setGuess({ user, guess }) {
  if (!(Number.isInteger(guess) && guess >= 1 && guess <= 10)) throw new UserError('Bitte gib eine Note von 1 bis 10.');
  const job = await GradingJob.findOne({ user: user._id, status: 'offen' }).lean();
  if (!job) throw new UserError('Du hast keinen offenen Auftrag.');
  if (!levelInfo(job.level).steps.includes('grade')) throw new UserError('Benoten kannst du erst ab Stufe 2.');
  const updated = await GradingJob.findOneAndUpdate({ _id: job._id, status: 'offen', guess: null }, { $set: { guess } }, { new: true }).lean();
  const final = updated || job; // schon benotet: die erste Note bleibt
  return { guess: final.guess, grade: final.grade };
}

/** Auftrag abschließen und an den Kunden zurückschicken: Lohn gutschreiben. clean = Sauberkeit 0–100 % */
async function finishJob({ user, clean, seal }) {
  return inTransaction(async (session) => {
    const job = await GradingJob.findOne({ user: user._id, status: 'offen' }).session(session);
    if (!job) throw new UserError('Du hast keinen offenen Auftrag.');
    const info = levelInfo(job.level);
    const cleanQ = Number.isFinite(clean) ? Math.round(Math.max(0, Math.min(100, clean))) : 0;
    // Putzen braucht Zeit: je sauberer, desto länger muss der Auftrag mindestens gelaufen sein
    if (Date.now() - job.createdAt.getTime() < (job.spots.length * MS_PER_SPOT * cleanQ) / 100) throw new UserError('So schnell kann niemand putzen – versuch es noch einmal.');
    if (info.steps.includes('grade') && job.guess === null) throw new UserError('Bitte benote die Karte zuerst.');
    const sealQ = info.steps.includes('slab') ? (Number.isFinite(seal) ? Math.round(Math.max(0, Math.min(100, seal))) : 0) : null;
    const pay = payFor({ level: job.level, clean: cleanQ, grade: job.grade, guess: job.guess, seal: sealQ });
    Object.assign(job, { status: 'fertig', clean: cleanQ, seal: sealQ, pay, doneAt: new Date() });
    await job.save({ session });
    await User.updateOne({ _id: user._id }, { $inc: { balance: pay } }, { session });
    await GradingShop.updateOne({ _id: user._id }, { $inc: { jobsDone: 1, earned: pay } }, { session });
    const card = catalog.cardById[job.card];
    await Ledger.create([{ user: user._id, type: 'grading_lohn', amount: pay, betTitle: card ? `${card.name} für ${job.customer}` : job.customer }], { session });
    return job.toObject();
  });
}

/** Arbeitet das Mitglied gerade im Grading-Shop? (dann kein Tagesbonus) */
const isWorking = (userId) => GradingShop.exists({ _id: userId, active: true }).then(Boolean);

module.exports = { CONTRACT_DAYS, MS_PER_SPOT, LEVELS, PAY, levelInfo, settings, loadSettings, saveSettings, rollSpots, rollDefects, gradeFor, payFor, getState, hire, quit, upgrade, takeJob, setGuess, finishJob, isWorking };

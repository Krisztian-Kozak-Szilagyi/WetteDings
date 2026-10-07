/**
 * Schulden: Was ein Mitglied nicht sofort bezahlen kann (z. B. eSports-Konkurs oder Austritt), bleibt als Schuld
 * stehen (User.debt, Cent). Getilgt wird automatisch aus dem Guthaben – bei jedem Seitenaufruf und jeder Aktion,
 * BEVOR die Aktion läuft (Middleware), dazu regelmäßig per Job. So lässt sich eine Strafe nicht durch vorheriges
 * Ausgeben umgehen: jede neue Einnahme geht zuerst an die Schuld. Die Rangliste zieht offene Schulden vom Vermögen ab.
 */
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { inTransaction } = require('./betService');

/**
 * Betrag vom Guthaben abbuchen, soweit vorhanden; der Rest wird zur Schuld. Läuft in der Transaktion des Aufrufers.
 * @returns {Promise<{paid: number, debt: number}>}  paid = sofort abgebucht, debt = neu als Schuld vermerkt (Cent)
 */
async function charge(userId, cents, { type, title }, session) {
  const u = await User.findById(userId).select('balance').session(session).lean();
  if (!u) return { paid: 0, debt: 0 };
  const paid = Math.min(cents, Math.max(0, u.balance));
  const debt = cents - paid;
  if (paid || debt) await User.updateOne({ _id: userId }, { $inc: { balance: -paid, debt } }, { session });
  if (paid) await Ledger.create([{ user: userId, type, amount: -paid, betTitle: title }], { session });
  return { paid, debt };
}

/** Offene Schuld aus dem Guthaben tilgen (so weit es reicht) → getilgter Betrag in Cent */
async function collect(userId) {
  return inTransaction(async (session) => {
    const u = await User.findById(userId).select('balance debt').session(session).lean();
    const take = u ? Math.min(u.debt || 0, Math.max(0, u.balance)) : 0;
    if (take <= 0) return 0;
    const res = await User.updateOne({ _id: userId, balance: { $gte: take }, debt: { $gte: take } }, { $inc: { balance: -take, debt: -take } }, { session });
    if (!res.modifiedCount) return 0;
    await Ledger.create([{ user: userId, type: 'schuld_tilgung', amount: -take, betTitle: 'Offene Schulden' }], { session });
    return take;
  });
}

/** Middleware: vor jeder Seite und Aktion zuerst Schulden tilgen (nur wer welche hat – kostet sonst nichts) */
async function collectMiddleware(req, res, next) {
  if (!req.user || !(req.user.debt > 0) || !(req.user.balance > 0)) return next();
  try {
    const take = await collect(req.user._id);
    if (take) {
      req.user.balance -= take;
      req.user.debt -= take;
    }
  } catch (err) {
    console.error('Schuldentilgung fehlgeschlagen:', err.message);
  }
  next();
}

/** Job: alle Schuldner mit Guthaben tilgen (z. B. nach Gewinnen, die ohne Seitenaufruf eingehen) */
async function collectAll() {
  const list = await User.find({ debt: { $gt: 0 }, balance: { $gt: 0 } }).select('_id').limit(500).lean();
  let n = 0;
  for (const u of list) n += (await collect(u._id).catch(() => 0)) ? 1 : 0;
  return n;
}

module.exports = { charge, collect, collectMiddleware, collectAll };

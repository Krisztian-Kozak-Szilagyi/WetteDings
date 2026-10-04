// Erfolge vergeben, anzeigen und bestätigen.
// Vergabe: Erfolg anlegen + 100 € gutschreiben + Buchung – alles in einer Transaktion. Der eindeutige Index
// (user + key) verhindert doppelte Vergabe auch bei gleichzeitigen Läufen: Die zweite Transaktion scheitert,
// es gibt kein Geld. Das Fenster mit OK erscheint danach auf jeder Seite, bis es bestätigt wurde.
const mongoose = require('mongoose');
const Achievement = require('../models/Achievement');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { DungeonRun } = require('../models/Dungeon');
const Bet = require('../models/Bet');
const { inTransaction } = require('../services/betService');
const notifyService = require('../services/notifyService');
const { ACHIEVEMENTS, SPECIAL, REWARD, byKey, find } = require('./list');

const isDuplicate = (err) => err && (err.code === 11000 || /E11000/.test(err.message || ''));

/** Vergibt einen Erfolg samt Belohnung. Gibt true zurück, wenn er neu vergeben wurde. */
async function grant(userId, key) {
  if (!byKey[key] || !mongoose.isValidObjectId(userId)) return false;
  const id = new mongoose.Types.ObjectId(String(userId));
  if (await Achievement.exists({ user: id, key })) return false;
  let granted = null;
  try {
    granted = await inTransaction(async (session) => {
      const user = await User.findOneAndUpdate({ _id: id, deletedAt: null }, { $inc: { balance: REWARD } }, { session, new: true, projection: { username: 1 } });
      if (!user) return null; // gelöschtes oder unbekanntes Konto
      await Achievement.create([{ user: id, key, reward: REWARD, earnedAt: new Date() }], { session });
      await Ledger.create([{ user: id, type: 'erfolg', amount: REWARD, betTitle: byKey[key].name, meta: { achievement: key } }], { session });
      return user.username;
    });
  } catch (err) {
    if (isDuplicate(err)) return false; // parallel schon vergeben – die Transaktion ist samt Gutschrift zurückgerollt
    throw err;
  }
  if (granted) {
    await notifyService.notify(id, { area: 'Erfolge', text: `Erfolg freigeschaltet: ${byKey[key].name} (+${REWARD / 100} €)`, href: `/profil/${encodeURIComponent(granted)}` });
  }
  return !!granted;
}

/** Einzelstücke an die vorgesehenen Konten (beim Start; ohne Konto passiert nichts) */
async function grantSpecial() {
  for (const [key, name] of SPECIAL) {
    const user = await User.findOne({ usernameLower: name, deletedAt: null }).select('_id').lean();
    if (user && (await grant(user._id, key))) console.log(`Erfolg "${key}" an ${name} vergeben.`);
  }
}

/** Alle automatischen Erfolge prüfen und an neue Inhaber vergeben (Job, alle paar Minuten) */
let checking = null; // laufende Prüfung (nie zwei gleichzeitig)
let again = false; // während einer Prüfung kam eine neue Aktion → danach noch einmal prüfen
let soonTimer = null;

function checkAll() {
  if (checking) {
    again = true;
    return checking;
  }
  checking = runCheck().finally(() => {
    checking = null;
    if (again) {
      again = false;
      soon();
    }
  });
  return checking;
}

/**
 * Nach einer Aktion eines Mitglieds (POST): in 2 Sekunden prüfen – mehrere Aktionen kurz hintereinander lösen nur
 * eine Prüfung aus. Das Fenster erscheint dann beim nächsten Seitenaufruf. Der 5-Minuten-Job bleibt als Rückfall
 * (z. B. für Lotterie-Ziehung und Zeit auf Platz 1, die ohne Aktion entstehen).
 */
function soon(delay = 2000) {
  if (soonTimer) return;
  soonTimer = setTimeout(() => {
    soonTimer = null;
    checkAll().catch((err) => console.error('Erfolge-Fehler:', err));
  }, delay);
  if (soonTimer.unref) soonTimer.unref();
}

async function runCheck() {
  for (const a of ACHIEVEMENTS) {
    if (!a.holders) continue;
    try {
      const ids = (await a.holders()).filter(Boolean).map(String);
      if (!ids.length) continue;
      const have = new Set((await Achievement.distinct('user', { key: a.key })).map(String));
      for (const id of ids) {
        if (!have.has(id)) await grant(id, a.key);
      }
    } catch (err) {
      console.error(`Erfolg "${a.key}" konnte nicht geprüft werden:`, err.message);
    }
  }
}

/** Ältester noch nicht bestätigter Erfolg (für das Fenster) und wie viele insgesamt offen sind */
async function nextUnseen(userId) {
  const docs = await Achievement.find({ user: userId, seenAt: null }).sort({ earnedAt: 1 }).limit(20).select('key earnedAt reward').lean();
  const known = docs.filter((d) => byKey[d.key]);
  if (!known.length) return null;
  const d = known[0];
  const a = byKey[d.key];
  return { id: String(d._id), key: d.key, name: a.name, text: a.text, unique: !!a.unique, reward: d.reward, left: known.length };
}

/** Fenster bestätigt */
async function markSeen(userId, id) {
  if (!mongoose.isValidObjectId(id)) return;
  await Achievement.updateOne({ _id: id, user: userId, seenAt: null }, { $set: { seenAt: new Date() } });
}

/** Erfolge eines Mitglieds */
const earnedOf = (userId) => Achievement.find({ user: userId }).select('key earnedAt').lean();

/** Wie viele Mitglieder jeden Erfolg haben, und Zahl der Mitglieder (für "x % der Spieler") */
async function shares() {
  const [rows, members] = await Promise.all([Achievement.aggregate([{ $group: { _id: '$key', n: { $sum: 1 } } }]), User.countDocuments({ deletedAt: null })]);
  return { counts: Object.fromEntries(rows.map((r) => [r._id, r.n])), members };
}

/**
 * Mitspieler: mit wem das Mitglied am häufigsten zusammen gespielt hat – gemeinsame Dungeons und Duelle.
 * Ergebnis: bis zu `limit` Einträge { user, username, together, dungeons, duels, achievements }.
 */
async function playmates(userId, limit = 5) {
  const id = new mongoose.Types.ObjectId(String(userId));
  const [dungeon, duelsAsCreator, duelsAsOpponent] = await Promise.all([
    DungeonRun.aggregate([
      { $match: { 'members.user': id, status: 'fertig' } },
      { $unwind: '$members' },
      { $match: { 'members.user': { $nin: [null, id] } } },
      { $group: { _id: '$members.user', n: { $sum: 1 } } },
    ]),
    Bet.aggregate([{ $match: { creator: id, duel: { $exists: true }, status: { $in: ['entschieden', 'annulliert'] } } }, { $group: { _id: '$duel.opponent', n: { $sum: 1 } } }]),
    Bet.aggregate([{ $match: { 'duel.opponent': id, status: { $in: ['entschieden', 'annulliert'] } } }, { $group: { _id: '$creator', n: { $sum: 1 } } }]),
  ]);
  const map = new Map();
  const add = (rows, field) =>
    rows.forEach((r) => {
      if (!r._id || r._id.equals(id)) return;
      const k = String(r._id);
      const e = map.get(k) || { id: r._id, dungeons: 0, duels: 0 };
      e[field] += r.n;
      map.set(k, e);
    });
  add(dungeon, 'dungeons');
  add(duelsAsCreator, 'duels');
  add(duelsAsOpponent, 'duels');
  const top = [...map.values()].map((e) => ({ ...e, together: e.dungeons + e.duels })).sort((a, b) => b.together - a.together);
  if (!top.length) return [];
  const ids = top.slice(0, limit * 2).map((e) => e.id);
  const [users, counts] = await Promise.all([
    User.find({ _id: { $in: ids }, deletedAt: null }).select('username').lean(),
    Achievement.aggregate([{ $match: { user: { $in: ids } } }, { $group: { _id: '$user', n: { $sum: 1 } } }]),
  ]);
  const names = new Map(users.map((u) => [String(u._id), u.username]));
  const achievements = new Map(counts.map((c) => [String(c._id), c.n]));
  return top
    .filter((e) => names.has(String(e.id)))
    .slice(0, limit)
    .map((e) => ({ username: names.get(String(e.id)), together: e.together, dungeons: e.dungeons, duels: e.duels, achievements: achievements.get(String(e.id)) || 0 }));
}

module.exports = { grant, grantSpecial, checkAll, soon, nextUnseen, markSeen, earnedOf, shares, playmates, find, ACHIEVEMENTS };

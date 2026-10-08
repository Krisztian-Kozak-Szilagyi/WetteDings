const mongoose = require('mongoose');
const User = require('../models/User');
const { DevMessage, DevMessageSeen } = require('../models/DevMessage');
const { UserError } = require('../lib/util');
const config = require('../config');
const { date } = require('../lib/viewHelpers');

// Pop-up-Nachrichten vom Entwickler-Team (#132): Devs und Admin schreiben sie im Panel (Reiter „Pop-ups“),
// jedes Mitglied bekommt sie als Fenster – wie „Geschenk vom Team“ –, bis es sie mit „Gelesen“ bestätigt.

const TITLE_MAX = 80;
const TEXT_MIN = 5;
const TEXT_MAX = 1000;

/** Titel: eine Zeile, Leerzeichen zusammengefasst; Text: Zeilenumbrüche bleiben (höchstens eine Leerzeile am Stück) */
const cleanTitle = (input) => (typeof input === 'string' ? input : '').replace(/\s+/g, ' ').trim();
const cleanText = (input) =>
  (typeof input === 'string' ? input : '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const length = (s) => Array.from(s).length;

/** Noch aktiv: nicht beendet und nicht abgelaufen */
const isActive = (m, now = new Date()) => !m.endedAt && (!m.expiresAt || new Date(m.expiresAt) > now);
const activeFilter = (now = new Date()) => ({ endedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] });

/** Prüfen und aufbereiten: { title, text, expiresAt } oder UserError */
function validate({ title, text, expiresAt = null }, now = new Date()) {
  const t = cleanTitle(title);
  const body = cleanText(text);
  if (!t) throw new UserError('Bitte gib einen Titel an.');
  if (length(t) > TITLE_MAX) throw new UserError(`Der Titel darf höchstens ${TITLE_MAX} Zeichen lang sein.`);
  if (length(body) < TEXT_MIN) throw new UserError(`Der Text braucht mindestens ${TEXT_MIN} Zeichen.`);
  if (length(body) > TEXT_MAX) throw new UserError(`Der Text darf höchstens ${TEXT_MAX} Zeichen lang sein.`);
  if (expiresAt !== null && (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()))) throw new UserError('Bitte gib ein gültiges Ablaufdatum an.');
  if (expiresAt && expiresAt <= now) throw new UserError('Das Ablaufdatum muss in der Zukunft liegen.');
  return { title: t, text: body, expiresAt };
}

/** Neue Nachricht an alle Mitglieder */
async function create({ title, text, expiresAt = null, author, now = new Date() }) {
  const clean = validate({ title, text, expiresAt }, now);
  return DevMessage.create({ ...clean, by: author._id, byName: author.username });
}

/** Bekommt dieses Mitglied überhaupt Pop-ups? Der Admin nicht – er sieht im Panel, was verschickt wurde. */
const receives = (user) => !!user && !user.isAdmin;

/**
 * Älteste aktive Nachricht, die dieses Mitglied noch nicht gelesen hat (mit Zahl der wartenden) oder null.
 * Der Admin bekommt keine, der Verfasser nicht seine eigene.
 */
async function nextUnseen(user, now = new Date()) {
  if (!receives(user)) return null;
  const userId = user._id;
  // Meist gibt es keine aktive Nachricht – dann bleibt es bei dieser einen kleinen Abfrage
  const active = await DevMessage.find({ ...activeFilter(now), by: { $ne: userId } }).sort({ createdAt: 1 }).select('_id').lean();
  if (!active.length) return null;
  const seen = new Set((await DevMessageSeen.find({ user: userId, message: { $in: active.map((m) => m._id) } }).select('message').lean()).map((s) => String(s.message)));
  const open = active.filter((m) => !seen.has(String(m._id)));
  if (!open.length) return null;
  const doc = await DevMessage.findById(open[0]._id).lean();
  return doc ? { ...doc, left: open.length } : null;
}

/** Daten für das Fenster: { id, title, text, byName, at, left } */
function popup(m) {
  if (!m) return null;
  return { id: String(m._id), title: m.title, text: m.text, byName: m.byName, at: date(m.createdAt), left: m.left || 1 };
}

/** Mit „Gelesen“ bestätigt (doppelt bestätigen schadet nicht) */
async function markSeen(userId, id) {
  if (!mongoose.isValidObjectId(id)) return;
  if (!(await DevMessage.exists({ _id: id }))) return;
  await DevMessageSeen.updateOne({ message: id, user: userId }, { $setOnInsert: { at: new Date() } }, { upsert: true }).catch((err) => {
    if (err.code !== 11000) throw err; // zwei Klicks gleichzeitig: schon gemerkt
  });
}

/**
 * Für das Panel: die letzten Nachrichten mit Status und wie viele Empfänger sie gelesen haben.
 * Empfänger = alle Mitglieder außer dem Admin und dem Verfasser (beide bekommen das Fenster nicht).
 */
async function list(limit = 30, now = new Date()) {
  const admins = config.adminUsernames;
  const [messages, receivers, authors] = await Promise.all([
    DevMessage.find().sort({ createdAt: -1 }).limit(limit).lean(),
    User.countDocuments({ deletedAt: null, usernameLower: { $nin: admins } }),
    // Verfasser, die selbst Empfänger wären (Devs, nicht gelöscht) – für sie zählt ein Empfänger weniger
    DevMessage.distinct('by').then((ids) => User.find({ _id: { $in: ids }, deletedAt: null, usernameLower: { $nin: admins } }).select('_id').lean()),
  ]);
  const authorReceives = new Set(authors.map((u) => String(u._id)));
  const counts = messages.length
    ? await DevMessageSeen.aggregate([{ $match: { message: { $in: messages.map((m) => m._id) } } }, { $group: { _id: '$message', n: { $sum: 1 } } }])
    : [];
  const seenBy = new Map(counts.map((c) => [String(c._id), c.n]));
  return messages.map((m) => {
    const members = receivers - (authorReceives.has(String(m.by)) ? 1 : 0);
    return {
      ...m,
      id: String(m._id),
      active: isActive(m, now),
      status: m.endedAt ? 'beendet' : m.expiresAt && new Date(m.expiresAt) <= now ? 'abgelaufen' : 'aktiv',
      seen: Math.min(seenBy.get(String(m._id)) || 0, members),
      members,
    };
  });
}

/** Vorzeitig beenden: erscheint danach niemandem mehr */
async function end({ id, author }) {
  if (!mongoose.isValidObjectId(id)) throw new UserError('Diese Nachricht gibt es nicht.');
  const r = await DevMessage.updateOne({ _id: id, endedAt: null }, { $set: { endedAt: new Date(), endedByName: author.username } });
  if (!r.matchedCount) throw new UserError('Diese Nachricht ist schon beendet oder existiert nicht.');
}

module.exports = { TITLE_MAX, TEXT_MIN, TEXT_MAX, cleanTitle, cleanText, isActive, receives, validate, create, nextUnseen, popup, markSeen, list, end };

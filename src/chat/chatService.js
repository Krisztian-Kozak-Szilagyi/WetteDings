// Chat zwischen Mitgliedern und im eSports-Team. Der Browser fragt regelmäßig nach (public/js/chat.js); damit das
// die Seite nicht bremst, führt der Server pro Mitglied einen Änderungszähler im Speicher (ein Prozess) und liest
// die Datenbank nur, wenn sich für dieses Mitglied etwas geändert hat.
// Datenschutz: Nachrichten, Gesprächslisten und Meldungen löscht die Datenbank nach KEEP_DAYS Tagen (TTL-Index).
// Das Team sieht private Nachrichten nur, wenn jemand eine meldet – und dann nur diese und die fünf davor.
const mongoose = require('mongoose');
const User = require('../models/User');
const { ChatMessage, ChatThread, ChatReport } = require('../models/Chat');
const { EsportsTeam } = require('../models/Esports');
const { UserError } = require('../lib/util');
const logic = require('./chatLogic');

const LIVE_TEAMS = ['offen', 'aktiv', 'eingefroren'];
const versions = logic.createVersions();
const limiter = logic.createLimiter();
const THREADS_MAX = 60;

const version = (userId) => versions.get(userId);
const isId = (id) => mongoose.isValidObjectId(id) && /^[0-9a-f]{24}$/i.test(String(id));

/** Eigenes eSports-Team (Mitglied, noch nicht aufgelöst) */
const teamOf = (userId) => EsportsTeam.findOne({ 'members.user': userId, status: { $in: LIVE_TEAMS } }).select('name ticker members.user').lean();

/**
 * Darf das Mitglied in dieses Gespräch? Gibt { key, kind, partner?, team?, members } zurück, sonst UserError.
 * members = alle, deren Gesprächsliste und Zähler sich bei einer neuen Nachricht ändern.
 */
async function access(user, key) {
  const parsed = logic.parseKey(key);
  if (parsed && parsed.kind === 'dm') {
    const partnerId = logic.partnerOf(parsed, user._id);
    if (!partnerId) throw new UserError('Dieses Gespräch gibt es nicht.');
    const partner = await User.findById(partnerId).select('username deletedAt chatBlocked').lean();
    if (!partner) throw new UserError('Dieses Gespräch gibt es nicht.');
    return { key: logic.dmKey(user._id, partnerId), kind: 'dm', partner, members: [user._id, partner._id] };
  }
  if (parsed && parsed.kind === 'team') {
    const team = await teamOf(user._id);
    if (!team || String(team._id) !== parsed.id) throw new UserError('Du bist nicht in diesem Team.');
    return { key: logic.teamKey(team._id), kind: 'team', team, members: team.members.map((m) => m.user) };
  }
  throw new UserError('Dieses Gespräch gibt es nicht.');
}

/** Namen zu Ids (für Absender und Gesprächspartner) */
async function namesOf(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const users = await User.find({ _id: { $in: unique } }).select('username deletedAt').lean();
  return new Map(users.map((u) => [String(u._id), u.deletedAt ? 'Gelöschtes Konto' : u.username]));
}

/** Übersicht: Gespräche (das eigene Team immer oben), ungelesene, blockierte Mitglieder */
async function overview(user) {
  const [threads, team, me] = await Promise.all([
    ChatThread.find({ user: user._id }).sort({ lastAt: -1 }).limit(THREADS_MAX).lean(),
    teamOf(user._id),
    User.findById(user._id).select('chatBlocked').lean(),
  ]);
  const blocked = (me && me.chatBlocked) || [];
  const names = await namesOf([...threads.flatMap((t) => [t.partner, t.lastFrom]), ...blocked]);
  const teamKey = team ? logic.teamKey(team._id) : null;
  const list = [];
  let unread = 0;
  for (const t of threads) {
    if (t.team && t.conv !== teamKey) continue; // altes Team: nicht mehr dabei
    unread += t.unread;
    list.push({
      key: t.conv,
      kind: t.team ? 'team' : 'dm',
      name: t.team ? team.name : names.get(String(t.partner)) || 'Gelöschtes Konto',
      ticker: t.team ? team.ticker : null,
      last: t.lastText,
      lastFrom: t.lastFrom ? (String(t.lastFrom) === String(user._id) ? 'Du' : names.get(String(t.lastFrom)) || '') : '',
      at: t.lastAt,
      unread: t.unread,
    });
  }
  if (team && !list.some((c) => c.key === teamKey)) list.push({ key: teamKey, kind: 'team', name: team.name, ticker: team.ticker, last: '', lastFrom: '', at: null, unread: 0 });
  list.sort((a, b) => (a.kind === 'team' ? -1 : b.kind === 'team' ? 1 : 0)); // Team zuerst, sonst neueste zuerst
  return {
    v: version(user._id),
    unread,
    conversations: list,
    blocked: blocked.map((id) => names.get(String(id))).filter(Boolean),
  };
}

const toJson = (m, names, userId) => ({
  id: String(m._id),
  from: names.get(String(m.from)) || 'Gelöschtes Konto',
  me: String(m.from) === String(userId),
  text: m.text,
  at: m.createdAt,
});

/**
 * Nachrichten eines Gesprächs: die neuesten (ohne before/after), ältere (before = Id) oder neue (after = Id).
 * Markiert das Gespräch als gelesen.
 */
async function messages(user, key, { before, after } = {}) {
  const conv = await access(user, key);
  const filter = { conv: conv.key };
  if (isId(before)) filter._id = { $lt: before };
  else if (isId(after)) filter._id = { $gt: after };
  const sort = isId(after) ? { _id: 1 } : { _id: -1 };
  const list = await ChatMessage.find(filter).sort(sort).limit(logic.PAGE + 1).lean();
  const more = list.length > logic.PAGE;
  const page = list.slice(0, logic.PAGE);
  if (!isId(after)) page.reverse(); // immer älteste zuerst
  const names = await namesOf(page.map((m) => m.from));
  const read = await ChatThread.updateOne({ user: user._id, conv: conv.key, unread: { $gt: 0 } }, { $set: { unread: 0 } });
  if (read.modifiedCount) versions.bump([user._id]); // andere Tabs zeigen die Zahl neu
  const me = conv.kind === 'dm' ? await User.findById(user._id).select('chatBlocked').lean() : null;
  return {
    v: version(user._id),
    key: conv.key,
    kind: conv.kind,
    name: conv.kind === 'team' ? conv.team.name : conv.partner.deletedAt ? 'Gelöschtes Konto' : conv.partner.username,
    partnerDeleted: conv.kind === 'dm' && !!conv.partner.deletedAt,
    blocked: conv.kind === 'dm' && ((me && me.chatBlocked) || []).some((id) => String(id) === String(conv.partner._id)),
    more: !isId(after) && more,
    messages: page.map((m) => toJson(m, names, user._id)),
  };
}

/** Gespräch mit einem Mitglied (per Name) – Schlüssel für den Browser */
async function startWith(user, username) {
  const lower = String(username || '').trim().toLowerCase();
  if (!lower) throw new UserError('Gib einen Namen ein.');
  const other = await User.findOne({ usernameLower: lower, deletedAt: null }).select('_id').lean();
  if (!other) throw new UserError('Dieses Mitglied gibt es nicht.');
  if (other._id.equals(user._id)) throw new UserError('Mit dir selbst kannst du nicht schreiben.');
  return logic.dmKey(user._id, other._id);
}

/** Nachricht senden */
async function send(user, key, rawText) {
  const text = logic.cleanText(rawText);
  if (!text) throw new UserError('Schreib erst etwas.');
  const conv = await access(user, key);
  if (conv.kind === 'dm') {
    if (conv.partner.deletedAt) throw new UserError('Dieses Konto gibt es nicht mehr.');
    const me = await User.findById(user._id).select('chatBlocked').lean();
    if (logic.blockedBetween(user._id, me && me.chatBlocked, conv.partner._id, conv.partner.chatBlocked)) throw new UserError('Ihr könnt euch gerade nicht schreiben.');
  }
  const limited = limiter(user._id);
  if (limited) throw new UserError(limited);

  const [msg] = await ChatMessage.create([{ conv: conv.key, from: user._id, text }]);
  const base = { lastAt: msg.createdAt, lastText: logic.preview(text), lastFrom: user._id };
  await ChatThread.bulkWrite(
    conv.members.map((id) => {
      const mine = String(id) === String(user._id);
      const onInsert = conv.kind === 'dm' ? { partner: mine ? conv.partner._id : user._id } : { team: conv.team._id };
      // eigener Eintrag: gelesen; die anderen: eine ungelesene mehr
      const update = mine ? { $set: { ...base, unread: 0 }, $setOnInsert: onInsert } : { $set: base, $setOnInsert: onInsert, $inc: { unread: 1 } };
      return { updateOne: { filter: { user: id, conv: conv.key }, update, upsert: true, setDefaultsOnInsert: false } };
    })
  );
  versions.bump(conv.members);
  return toJson(msg, new Map([[String(user._id), user.username]]), user._id);
}

/** Mitglied blockieren / freigeben: blockierte Mitglieder können einem nicht schreiben (und man ihnen nicht) */
async function setBlocked(user, username, on) {
  const other = await User.findOne({ usernameLower: String(username || '').trim().toLowerCase() }).select('_id').lean();
  if (!other || other._id.equals(user._id)) throw new UserError('Dieses Mitglied gibt es nicht.');
  await User.updateOne({ _id: user._id }, on ? { $addToSet: { chatBlocked: other._id } } : { $pull: { chatBlocked: other._id } });
  versions.bump([user._id, other._id]);
}

/** Nachricht melden: Kopie der Nachricht und der fünf davor geht an das Team (Moderation → Chat-Meldungen) */
async function report(user, messageId, reason) {
  if (!isId(messageId)) throw new UserError('Diese Nachricht gibt es nicht.');
  const msg = await ChatMessage.findById(messageId).lean();
  if (!msg) throw new UserError('Diese Nachricht gibt es nicht mehr.');
  await access(user, msg.conv); // nur, wer das Gespräch sehen darf
  if (msg.from.equals(user._id)) throw new UserError('Eigene Nachrichten kannst du nicht melden.');
  const before = await ChatMessage.find({ conv: msg.conv, _id: { $lt: msg._id } }).sort({ _id: -1 }).limit(logic.CONTEXT_BEFORE).lean();
  const context = [...before.reverse(), msg].map((m) => ({ from: m.from, text: m.text, at: m.createdAt, reported: m._id.equals(msg._id) }));
  try {
    await ChatReport.create({ message: msg._id, conv: msg.conv, by: user._id, reason: String(reason || '').trim().slice(0, logic.REASON_MAX), context });
  } catch (err) {
    if (err && err.code === 11000) return; // schon gemeldet
    throw err;
  }
}

const openReportCount = () => ChatReport.countDocuments({ done: false });

/** Offene Meldungen fürs Admin-Panel, mit Namen */
async function openReports() {
  const reports = await ChatReport.find({ done: false }).sort({ createdAt: -1 }).limit(100).lean();
  const names = await namesOf(reports.flatMap((r) => [r.by, ...r.context.map((c) => c.from)]));
  return reports.map((r) => ({
    id: String(r._id),
    byName: names.get(String(r.by)) || 'Gelöschtes Konto',
    reason: r.reason,
    createdAt: r.createdAt,
    team: r.conv.startsWith('team:'),
    context: r.context.map((c) => ({ from: names.get(String(c.from)) || 'Gelöschtes Konto', text: c.text, at: c.at, reported: c.reported })),
  }));
}

async function closeReport(id, staff) {
  if (!isId(id)) return false;
  const r = await ChatReport.updateOne({ _id: id, done: false }, { $set: { done: true, doneByName: staff.username } });
  return r.modifiedCount > 0;
}

/** Konto gelöscht: eigene Nachrichten, Gesprächslisten und Meldungen weg (Teil der Löschung in accountService) */
function deleteUserData(userId, session) {
  const opt = { session };
  return Promise.all([
    ChatMessage.deleteMany({ from: userId }, opt),
    ChatThread.deleteMany({ user: userId }, opt),
    ChatReport.deleteMany({ by: userId }, opt),
  ]);
}

module.exports = { version, overview, messages, startWith, send, setBlocked, report, openReportCount, openReports, closeReport, deleteUserData };

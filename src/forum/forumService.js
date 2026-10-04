const mongoose = require('mongoose');
const User = require('../models/User');
const PatchNote = require('../models/PatchNote');
const { ForumCategory, ForumThread, ForumPost, ForumRead, ForumReport, ForumModLog, ForumReaction, ForumPoll, ForumPollVote } = require('../models/Forum');
const { tagsFor, tagsIn, sanitizeTags, parseMentions } = require('./render');
const { mentionedUsers } = require('./embeds');
const { CATEGORIES, STARTERS } = require('./starters');
const reactions = require('./reactions');
const polls = require('./polls');
const config = require('../config');
const { UserError, escapeRegex } = require('../lib/util');
const { notify, short } = require('../services/notifyService');

const TITLE_MIN = 3;
const TITLE_MAX = 120;
const BODY_MAX = 10000;
const THREADS_PER_PAGE = 20;
const POSTS_PER_PAGE = 20;
const POSTS_PER_MINUTE = 5;
const PATCHNOTES_KEY = 'patchnotes';
const REASON_MAX = 300;
const MENTIONS_MAX = 20; // so viele Erwähnte pro Beitrag werden benachrichtigt
const MODLOG_PER_PAGE = 100;

/** Rolle eines angemeldeten Nutzers im Forum: 'admin' | 'dev' | 'mod' | null */
const roleOfUser = (user) => (user.isAdmin ? 'admin' : user.isDev ? 'dev' : user.isMod ? 'mod' : null);

// ---------- Erster Start: Bereiche anlegen, Patchnotes umziehen ----------
async function seed() {
  if (await ForumCategory.estimatedDocumentCount()) return;
  const make = (title, description, extra = {}) => ForumCategory.create({ title, description, ...extra });
  const staff = await make('Admin & Dev', 'Neuigkeiten vom Team – hier eröffnen nur Admin und Devs Themen.', { staffOnly: true, order: 0 });
  await make('Patchnotes', 'Was sich auf der Seite geändert hat.', { parent: staff._id, staffOnly: true, order: 0, key: PATCHNOTES_KEY });
  await make('Ankündigungen', 'Wichtiges und Geplantes.', { parent: staff._id, staffOnly: true, order: 1 });
  const general = await make('Allgemein', 'Alles rund um BfW Holdings.', { order: 1 });
  await make('Plauderecke', 'Für alles, was sonst nirgends passt.', { parent: general._id, order: 0 });
  await make('Wetten', 'Ideen, Diskussionen und Streitfälle zu Wetten.', { parent: general._id, order: 1 });
  await make('TCG & Handel', 'Karten, Packs, Tauschgesuche.', { parent: general._id, order: 2 });
  await make('IHK', 'Quests, Karten-Kombinationen, Tipps.', { parent: general._id, order: 3 });
  await make('Feedback & Bugs', 'Wünsche, Fehler und Verbesserungen.', { parent: general._id, order: 4 });
}

/**
 * Feste Bereiche und Startthemen (forum/starters.js) – bei jedem Start, legt aber nichts doppelt an:
 * Bereiche werden über ihren key gefunden, sonst über den (früheren) Titel übernommen; Startthemen gibt es je
 * starterKey nur einmal (auch wenn die Moderation eines entfernt hat). Verfasser der Startthemen ist der erste
 * Admin aus ADMIN_USERNAMES – gibt es ihn (noch) nicht, folgen sie bei einem späteren Start.
 */
async function ensureDefaults() {
  const byKey = {};
  for (const def of CATEGORIES) {
    let cat = await ForumCategory.findOne({ key: def.key }).lean();
    const parent = def.parent ? byKey[def.parent] : null;
    if (!cat && (!def.parent || parent)) {
      const titles = [def.title, ...(def.titles || [])].map((t) => new RegExp(`^${escapeRegex(t)}$`, 'i'));
      const filter = { key: null, title: { $in: titles } };
      if (def.create !== false) filter.parent = parent ? parent._id : null; // nur übernehmen: überall suchen
      const found = await ForumCategory.findOne(filter).sort({ createdAt: 1 }).lean();
      if (found) {
        const set = { key: def.key };
        if (found.title !== def.title) Object.assign(set, { title: def.title, description: def.description }); // z. B. "Wetten" → "Wetten & Duelle"
        cat = await ForumCategory.findOneAndUpdate({ _id: found._id }, { $set: set }, { new: true }).lean();
      } else if (def.create !== false) {
        cat = (await ForumCategory.create({ key: def.key, title: def.title, description: def.description, parent: parent ? parent._id : null, order: def.order })).toObject();
        console.log(`Forum: Bereich „${def.title}“ angelegt.`);
      }
    }
    if (cat) byKey[def.key] = cat;
  }

  const adminName = config.adminUsernames[0];
  const author = adminName ? await User.findOne({ usernameLower: adminName, deletedAt: null }).select('_id username').lean() : null;
  if (!author) return byKey;
  // rückwärts, damit das erste Startthema eines Bereichs oben steht (angepinnte nach dem letzten Beitrag sortiert)
  for (const s of [...STARTERS].reverse()) {
    const cat = byKey[s.category];
    if (!cat || (await ForumThread.exists({ starterKey: s.key }))) continue;
    const now = new Date();
    const thread = await ForumThread.create({ category: cat._id, title: s.title, author: author._id, authorName: author.username, pinned: true, starterKey: s.key, lastPostAt: now, lastPostBy: author._id, lastPostByName: author.username, participants: [author._id] });
    await ForumPost.create({ thread: thread._id, author: author._id, authorName: author.username, body: s.body, isFirst: true });
    console.log(`Forum: Startthema „${s.title}“ angelegt.`);
  }
  return byKey;
}

// Der Bereich "Patchnotes" ändert sich praktisch nie – kurz im Speicher halten statt bei jedem Seitenaufruf nachzuschlagen
let patchCat = null;
let patchCatAt = 0;
async function patchnotesCategory() {
  if (!patchCat || Date.now() - patchCatAt > 5 * 60 * 1000) {
    patchCat = await ForumCategory.findOne({ key: PATCHNOTES_KEY }).lean();
    patchCatAt = Date.now();
  }
  return patchCat;
}

/** Alte Patchnotes (eigene Seite) einmalig als Themen in den Bereich "Patchnotes" übernehmen. */
async function migratePatchnotes() {
  const cat = await patchnotesCategory();
  if (!cat) return;
  const notes = await PatchNote.find({ migrated: { $ne: true } }).sort({ createdAt: 1 }).lean();
  for (const n of notes) {
    const author = n.author || (await User.findOne({ username: n.authorName }).select('_id').lean() || {})._id;
    if (!author) continue; // Verfasser unbekannt (sollte nicht vorkommen)
    const comments = n.comments || [];
    const last = comments[comments.length - 1];
    const [thread] = await ForumThread.create([
      {
        category: cat._id,
        title: n.title,
        author,
        authorName: n.authorName,
        upvotes: n.upvotes || [],
        replyCount: comments.length,
        lastPostAt: last ? last.createdAt : n.createdAt,
        lastPostBy: last ? last.user : author,
        lastPostByName: last ? last.username : n.authorName,
        participants: [...new Set([String(author), ...comments.map((c) => String(c.user))])],
        createdAt: n.createdAt,
        updatedAt: n.createdAt,
      },
    ]);
    await ForumPost.insertMany(
      [
        { thread: thread._id, author, authorName: n.authorName, body: n.body, isFirst: true, createdAt: n.createdAt, updatedAt: n.createdAt },
        ...comments.map((c) => ({ thread: thread._id, author: c.user, authorName: c.username, body: sanitizeTags(c.text, []), createdAt: c.createdAt, updatedAt: c.createdAt })),
      ],
      { timestamps: false }
    );
    await PatchNote.collection.updateOne({ _id: n._id }, { $set: { migrated: true } });
  }
  if (notes.length) console.log(`Forum: ${notes.length} Patchnote(s) ins Forum übernommen.`);
}

// ---------- Rechte ----------
const can = {
  /** Themen eröffnen: in Team-Bereichen nur Admin/Dev */
  createThread: (user, cat) => !cat.staffOnly || user.isStaff,
  reply: (user, thread) => !thread.locked || user.canModerate,
  /** Bereiche anlegen: die ganze Moderation (auch Mods – das Forum zu pflegen ist ihre Aufgabe) */
  manage: (user) => !!user.canModerate,
  /**
   * Einen bestimmten Bereich ändern/löschen bzw. darin Unterbereiche anlegen.
   * Team-Bereiche ("Admin & Dev" samt Unterbereichen) sind geschützt: dort nur Admin/Dev.
   */
  manageCategory: (user, cat, parent) => !!user.isStaff || (!!user.isMod && !cat.staffOnly && !(parent && parent.staffOnly)),
  /**
   * Thema in einen anderen Bereich verschieben: die Moderation, aber Team-Bereiche (Quelle oder Ziel)
   * nur Admin/Dev – wie beim Bearbeiten von Bereichen.
   */
  moveThread: (user, from, fromParent, to, toParent) =>
    !!user.canModerate && String(from._id) !== String(to._id) && can.manageCategory(user, from, fromParent) && can.manageCategory(user, to, toParent),
  /** Einen Bereich zum Team-Bereich machen (oder das zurücknehmen): nur Admin/Dev */
  setStaffOnly: (user) => !!user.isStaff,
  editPost(user, post, thread) {
    if (post.deleted) return false;
    if (user.canModerate) return true;
    // Verfasser: solange niemand vom Team eingegriffen hat und das Thema offen ist
    return String(post.author) === String(user._id) && !post.staffEdited && !thread.locked;
  },
  deletePost: (user, post) => !post.deleted && (user.canModerate || String(post.author) === String(user._id)),
  /** Original eines gelöschten Beitrags ansehen */
  seeOriginal: (user) => user.isStaff,
  /** Reagieren (auch auf eigene Beiträge): nicht auf gelöschte Beiträge und nicht in geschlossenen Themen – auch nicht zurücknehmen */
  react: (user, post, thread) => !post.deleted && !thread.locked && !thread.deleted,
  /** Umfrage entfernen: die Moderation */
  removePoll: (user) => !!user.canModerate,
};

// ---------- Schreiben ----------
const recent = new Map(); // einfaches Limit pro Nutzer im Speicher
function throttle(user) {
  if (user.canModerate) return;
  const now = Date.now();
  const list = (recent.get(String(user._id)) || []).filter((t) => now - t < 60000);
  if (list.length >= POSTS_PER_MINUTE) throw new UserError('Nicht so schnell – bitte warte kurz, bevor du weiterschreibst.');
  list.push(now);
  recent.set(String(user._id), list);
}

function cleanBody(text, allowedTags) {
  const body = sanitizeTags(String(typeof text === 'string' ? text : '').replace(/\r\n/g, '\n').trim(), allowedTags);
  if (!body) throw new UserError('Bitte schreib einen Text.');
  if (body.length > BODY_MAX) throw new UserError(`Der Text darf höchstens ${BODY_MAX} Zeichen lang sein.`);
  return body;
}

function cleanTitle(text) {
  const title = String(typeof text === 'string' ? text : '').trim().replace(/\s+/g, ' ');
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) throw new UserError(`Der Titel muss ${TITLE_MIN}–${TITLE_MAX} Zeichen lang sein.`);
  return title;
}

const markRead = (userId, threadId, at = new Date()) => ForumRead.updateOne({ user: userId, thread: threadId }, { $set: { at } }, { upsert: true });

/**
 * @Erwähnungen benachrichtigen (nicht sich selbst, nicht wer ohnehin schon benachrichtigt wird – skip).
 * Alle Bereiche sind für alle Mitglieder lesbar (staffOnly regelt nur, wer Themen eröffnet), deshalb ohne
 * weitere Sichtbarkeitsprüfung. Wirft nie – wie notify.
 */
async function notifyMentions({ user, thread, body, href, skip = [] }) {
  try {
    const names = parseMentions(body).filter((n) => n !== user.username.toLowerCase());
    const done = new Set(skip.map(String));
    const users = (await mentionedUsers(names, MENTIONS_MAX)).filter((u) => !done.has(String(u._id)));
    await notify(users, { area: 'Forum', href, except: user, text: `${user.username} hat dich im Thema „${short(thread.title)}“ erwähnt.` });
  } catch (err) {
    console.error('Erwähnungen fehlgeschlagen:', err.message);
  }
}

// ---------- Mod-Log ----------
const MODLOG_LABELS = {
  anpinnen: 'Thema angepinnt',
  loesen: 'Thema nicht mehr angepinnt',
  schliessen: 'Thema geschlossen',
  oeffnen: 'Thema wieder geöffnet',
  entfernen: 'Thema entfernt',
  verschieben: 'Thema verschoben',
  bearbeiten: 'Beitrag bearbeitet',
  loeschen: 'Beitrag gelöscht',
  meldung: 'Meldung erledigt',
  umfrage: 'Umfrage entfernt',
};

/** Eintrag ins Mod-Log. Wirft nie: Die eigentliche Aktion ist dann schon geschehen. */
async function modLog(user, action, { thread = null, post = null, detail = '' } = {}) {
  try {
    await ForumModLog.create({
      by: user._id,
      byName: user.username,
      action,
      thread: thread ? thread._id : null,
      threadTitle: thread ? thread.title || null : null,
      post: post ? post._id : null,
      detail: String(detail || '').slice(0, 400),
    });
  } catch (err) {
    console.error('Mod-Log fehlgeschlagen:', err.message);
  }
}

/** Eine Seite des Mod-Logs (neueste zuerst) */
async function modLogPage(page = 1) {
  const total = await ForumModLog.countDocuments();
  const pages = Math.max(1, Math.ceil(total / MODLOG_PER_PAGE));
  const p = Math.min(pages, Math.max(1, page));
  const entries = await ForumModLog.find().sort({ createdAt: -1, _id: -1 }).skip((p - 1) * MODLOG_PER_PAGE).limit(MODLOG_PER_PAGE).lean();
  return { entries: entries.map((e) => ({ ...e, label: MODLOG_LABELS[e.action] || e.action })), page: p, pages, total };
}

/** poll (optional): { question, options (eine Antwort pro Zeile), endsAt } aus dem Formular – siehe forum/polls.js */
async function createThread({ user, categoryId, title, body, poll = null }) {
  const cat = mongoose.isValidObjectId(categoryId) ? await ForumCategory.findById(categoryId).lean() : null;
  if (!cat) throw new UserError('Diesen Bereich gibt es nicht.');
  if (!can.createThread(user, cat)) throw new UserError('In diesem Bereich eröffnen nur Admin und Devs Themen.');
  const t = cleanTitle(title);
  const b = cleanBody(body, tagsFor(roleOfUser(user)));
  const p = poll ? polls.parsePollInput(poll, { timeZone: config.timezone }) : null; // vor dem Anlegen prüfen
  throttle(user);
  const now = new Date();
  const thread = await ForumThread.create({ category: cat._id, title: t, author: user._id, authorName: user.username, lastPostAt: now, lastPostBy: user._id, lastPostByName: user.username, participants: [user._id] });
  await ForumPost.create({ thread: thread._id, author: user._id, authorName: user.username, body: b, isFirst: true });
  if (p) await ForumPoll.create({ thread: thread._id, ...p });
  await markRead(user._id, thread._id, now);
  await notifyMentions({ user, thread, body: b, href: `/forum/t/${thread._id}` });
  return thread;
}

async function reply({ user, threadId, body }) {
  const thread = mongoose.isValidObjectId(threadId) ? await ForumThread.findOne({ _id: threadId, deleted: false }) : null;
  if (!thread) throw new UserError('Dieses Thema gibt es nicht.');
  if (!can.reply(user, thread)) throw new UserError('Dieses Thema ist geschlossen.');
  const b = cleanBody(body, tagsFor(roleOfUser(user)));
  throttle(user);
  const now = new Date();
  const post = await ForumPost.create({ thread: thread._id, author: user._id, authorName: user.username, body: b });
  await ForumThread.updateOne({ _id: thread._id }, { $inc: { replyCount: 1 }, $set: { lastPostAt: now, lastPostBy: user._id, lastPostByName: user.username }, $addToSet: { participants: user._id } });
  await markRead(user._id, thread._id, now);
  const title = short(thread.title);
  const base = { area: 'Forum', href: `/forum/t/${thread._id}`, key: `forum:${thread._id}`, except: user };
  await notify(thread.author, {
    ...base,
    text: `${user.username} hat in deinem Thema „${title}“ geantwortet.`,
    many: (n) => `${n} neue Antworten in deinem Thema „${title}“.`,
  });
  // alle anderen, die im Thema geschrieben haben
  const others = thread.participants.filter((id) => String(id) !== String(thread.author));
  await notify(others, {
    ...base,
    text: `${user.username} hat im Thema „${title}“ geantwortet.`,
    many: (n) => `${n} neue Antworten im Thema „${title}“.`,
  });
  await notifyMentions({ user, thread, body: b, href: `/forum/t/${thread._id}?seite=letzte#b-${post._id}`, skip: [thread.author, ...thread.participants] });
  return { thread, post };
}

/** Beitrag samt Thema laden (für Bearbeiten/Löschen/Melden) */
async function loadPost(postId) {
  const post = mongoose.isValidObjectId(postId) ? await ForumPost.findById(postId) : null;
  const thread = post ? await ForumThread.findOne({ _id: post.thread, deleted: false }) : null;
  if (!post || !thread) throw new UserError('Diesen Beitrag gibt es nicht.');
  return { post, thread };
}

async function editPost({ user, postId, body, title }) {
  const { post, thread } = await loadPost(postId);
  if (!can.editPost(user, post, thread)) throw new UserError('Diesen Beitrag kannst du nicht (mehr) bearbeiten.');
  const own = String(post.author) === String(user._id);
  // Erlaubt sind die Tags des Bearbeitenden und die, die schon echt im Text stehen (z. B. vom Team gesetzt)
  post.body = cleanBody(body, [...tagsFor(roleOfUser(user)), ...tagsIn(post.body)]);
  if (own) post.editedAt = new Date();
  else {
    post.staffEdited = true; // ab jetzt kann der Verfasser nicht mehr bearbeiten
    if (roleOfUser(user) === 'mod') post.modEdited = true;
  }
  await post.save();
  // Titel des Themas: über den Eröffnungsbeitrag
  const oldTitle = thread.title;
  if (post.isFirst && typeof title === 'string' && title.trim()) {
    thread.title = cleanTitle(title);
    await thread.save();
  }
  if (!own) await modLog(user, 'bearbeiten', { thread, post, detail: `Beitrag von ${post.authorName}${thread.title !== oldTitle ? ` · Titel vorher: „${oldTitle}“` : ''}` });
  return { post, thread };
}

async function deletePost({ user, postId }) {
  const { post, thread } = await loadPost(postId);
  if (!can.deletePost(user, post)) throw new UserError('Diesen Beitrag kannst du nicht löschen.');
  const own = String(post.author) === String(user._id);
  post.original = post.body;
  post.body = '';
  post.deleted = true;
  post.deletedByRole = own ? 'autor' : roleOfUser(user);
  await post.save();
  if (!own) await modLog(user, 'loeschen', { thread, post, detail: `Beitrag von ${post.authorName}` });
  return { post, thread };
}

/** Moderation eines Themas: anpinnen, schließen, entfernen */
async function moderateThread({ user, threadId, action }) {
  if (!user.canModerate) throw new UserError('Das darf nur die Moderation.');
  const set = { anpinnen: { pinned: true }, loesen: { pinned: false }, schliessen: { locked: true }, oeffnen: { locked: false }, entfernen: { deleted: true } }[action];
  if (!set || !mongoose.isValidObjectId(threadId)) throw new UserError('Unbekannte Aktion.');
  const thread = await ForumThread.findOneAndUpdate({ _id: threadId, deleted: false }, { $set: set }, { new: true });
  if (!thread) throw new UserError('Dieses Thema gibt es nicht.');
  await modLog(user, action, { thread });
  return thread;
}

/** Thema in einen anderen Bereich verschieben (Moderation) */
async function moveThread({ user, threadId, categoryId }) {
  if (!mongoose.isValidObjectId(threadId) || !mongoose.isValidObjectId(categoryId)) throw new UserError('Bitte einen Bereich wählen.');
  const thread = await ForumThread.findOne({ _id: threadId, deleted: false });
  if (!thread) throw new UserError('Dieses Thema gibt es nicht.');
  const [from, to] = await Promise.all([ForumCategory.findById(thread.category).lean(), ForumCategory.findById(categoryId).lean()]);
  if (!from || !to) throw new UserError('Diesen Bereich gibt es nicht.');
  if (String(from._id) === String(to._id)) throw new UserError('Das Thema ist schon in diesem Bereich.');
  const [fromParent, toParent] = await Promise.all([
    from.parent ? ForumCategory.findById(from.parent).lean() : null,
    to.parent ? ForumCategory.findById(to.parent).lean() : null,
  ]);
  if (!can.moveThread(user, from, fromParent, to, toParent)) throw new UserError('Themen in oder aus Team-Bereichen verschieben nur Admin und Devs.');
  thread.category = to._id;
  await thread.save();
  await modLog(user, 'verschieben', { thread, detail: `${from.title} → ${to.title}` });
  return { thread, to };
}

// ---------- Reaktionen ----------
/** Reaktion setzen oder (beim zweiten Klick) zurücknehmen. Gibt { post, thread, on } zurück. */
async function toggleReaction({ user, postId, reaction }) {
  if (!reactions.reactionByKey[reaction]) throw new UserError('Diese Reaktion gibt es nicht.');
  const { post, thread } = await loadPost(postId);
  if (!can.react(user, post, thread)) throw new UserError(thread.locked ? 'Dieses Thema ist geschlossen.' : 'Auf diesen Beitrag kann man nicht mehr reagieren.');
  const key = { post: post._id, user: user._id, reaction };
  const removed = await ForumReaction.deleteOne(key);
  if (removed.deletedCount) return { post, thread, on: false };
  try {
    await ForumReaction.create({ ...key, thread: thread._id, userName: user.username });
  } catch (err) {
    if (err.code !== 11000) throw err; // Doppelklick: schon gesetzt
  }
  return { post, thread, on: true };
}

/** Reaktionen aller Beiträge einer Seite – eine Abfrage. Map postId → Liste (siehe reactions.summarize) */
async function reactionsFor(postIds, userId) {
  if (!postIds.length) return new Map();
  const docs = await ForumReaction.find({ post: { $in: postIds } }).sort({ createdAt: 1 }).select('post user userName reaction').lean();
  return reactions.summarize(docs, userId);
}

// ---------- Umfragen ----------
/** Umfrage eines Themas für die Anzeige: Frage, eigene Stimme, Ergebnis (nur nach der Stimme oder wenn vorbei) */
async function pollView(thread, user) {
  const poll = await ForumPoll.findOne({ thread: thread._id }).lean();
  if (!poll) return null;
  const [mine, counted] = await Promise.all([
    ForumPollVote.findOne({ poll: poll._id, user: user._id }).select('option').lean(),
    ForumPollVote.aggregate([{ $match: { poll: poll._id } }, { $group: { _id: '$option', n: { $sum: 1 } } }]),
  ]);
  const closed = polls.isClosed(poll, thread);
  const result = polls.results(poll.options, Object.fromEntries(counted.map((c) => [c._id, c.n])));
  return {
    ...poll,
    closed,
    myVote: mine ? mine.option : null,
    total: result.total,
    rows: mine || closed ? result.rows : null, // vorher kein Zwischenstand
    canVote: !mine && !closed,
    canRemove: can.removePoll(user),
  };
}

async function vote({ user, threadId, option }) {
  const thread = mongoose.isValidObjectId(threadId) ? await ForumThread.findOne({ _id: threadId, deleted: false }).lean() : null;
  const poll = thread ? await ForumPoll.findOne({ thread: thread._id }).lean() : null;
  if (!poll) throw new UserError('Diese Umfrage gibt es nicht (mehr).');
  const voted = !!(await ForumPollVote.exists({ poll: poll._id, user: user._id }));
  const error = polls.voteError(poll, thread, { option, voted });
  if (error) throw new UserError(error);
  try {
    await ForumPollVote.create({ poll: poll._id, user: user._id, option });
  } catch (err) {
    if (err.code === 11000) throw new UserError('Du hast schon abgestimmt.');
    throw err;
  }
  return thread;
}

/** Umfrage samt Stimmen entfernen (Moderation) – kommt ins Mod-Log */
async function removePoll({ user, threadId }) {
  if (!can.removePoll(user)) throw new UserError('Das darf nur die Moderation.');
  const thread = mongoose.isValidObjectId(threadId) ? await ForumThread.findOne({ _id: threadId, deleted: false }).lean() : null;
  const poll = thread ? await ForumPoll.findOne({ thread: thread._id }).lean() : null;
  if (!poll) throw new UserError('Diese Umfrage gibt es nicht (mehr).');
  const votes = await ForumPollVote.countDocuments({ poll: poll._id });
  await ForumPollVote.deleteMany({ poll: poll._id });
  await ForumPoll.deleteOne({ _id: poll._id });
  await modLog(user, 'umfrage', { thread, detail: `„${poll.question}“ (${votes} ${votes === 1 ? 'Stimme' : 'Stimmen'})` });
  return thread;
}

async function toggleUpvote({ user, threadId }) {
  if (!mongoose.isValidObjectId(threadId)) throw new UserError('Dieses Thema gibt es nicht.');
  const added = await ForumThread.updateOne({ _id: threadId, deleted: false, upvotes: { $ne: user._id } }, { $addToSet: { upvotes: user._id } });
  if (!added.modifiedCount) await ForumThread.updateOne({ _id: threadId }, { $pull: { upvotes: user._id } });
}

async function report({ user, postId, reason }) {
  const why = String(reason || '').trim().replace(/\s+/g, ' ').slice(0, REASON_MAX);
  if (!why) throw new UserError('Bitte gib einen Grund für die Meldung an.');
  const { post, thread } = await loadPost(postId);
  if (post.deleted) throw new UserError('Dieser Beitrag wurde schon gelöscht.');
  try {
    await ForumReport.create({ post: post._id, thread: thread._id, by: user._id, byName: user.username, reason: why });
  } catch (err) {
    if (err.code !== 11000) throw err; // schon gemeldet – kein Fehler
  }
  return thread;
}

/** Meldung als erledigt markieren (Moderation) – mit Eintrag im Mod-Log */
async function resolveReport({ user, reportId }) {
  if (!user.canModerate || !mongoose.isValidObjectId(reportId)) return null;
  const r = await ForumReport.findOneAndUpdate({ _id: reportId, done: false }, { $set: { done: true } }, { new: true }).lean();
  if (!r) return null; // gibt es nicht oder schon erledigt
  const thread = await ForumThread.findById(r.thread).select('title').lean();
  await modLog(user, 'meldung', { thread: thread || { _id: r.thread }, post: { _id: r.post }, detail: `gemeldet von ${r.byName}${r.reason ? `: „${r.reason}“` : ''}` });
  return r;
}

// ---------- Lesen: ungelesen, Abzeichen ----------
/** Map threadId → zuletzt gelesen */
async function readMap(userId) {
  const reads = await ForumRead.find({ user: userId }).select('thread at').lean();
  return new Map(reads.map((r) => [String(r.thread), r.at]));
}
const isUnread = (reads, thread) => {
  const at = reads.get(String(thread._id));
  return !at || thread.lastPostAt > at;
};

/**
 * Abzeichen am Menüpunkt: seit dem letzten Besuch des Forums …
 *  mine  = Neues in Themen, die man eröffnet oder in denen man geschrieben hat (rot)
 *  other = Neues im restlichen Forum (zweite Farbe)
 */
async function navCounts(user) {
  const base = { deleted: false, lastPostAt: { $gt: user.forumSeenAt || user.createdAt }, lastPostBy: { $ne: user._id } };
  const [mine, other] = await Promise.all([
    ForumThread.countDocuments({ ...base, participants: user._id }),
    ForumThread.countDocuments({ ...base, participants: { $ne: user._id } }),
  ]);
  return { mine, other };
}

/** Neue Patchnotes seit dem letzten Blick in den Bereich (Abzeichen im Footer) */
async function patchNewCount(user) {
  const cat = await patchnotesCategory();
  if (!cat) return 0;
  return ForumThread.countDocuments({ category: cat._id, deleted: false, author: { $ne: user._id }, createdAt: { $gt: user.patchSeenAt || user.createdAt } });
}

const openReportCount = () => ForumReport.countDocuments({ done: false });

module.exports = {
  TITLE_MAX,
  BODY_MAX,
  THREADS_PER_PAGE,
  POSTS_PER_PAGE,
  PATCHNOTES_KEY,
  REASON_MAX,
  MODLOG_LABELS,
  roleOfUser,
  seed,
  ensureDefaults,
  migratePatchnotes,
  patchnotesCategory,
  can,
  createThread,
  reply,
  loadPost,
  editPost,
  deletePost,
  moderateThread,
  moveThread,
  toggleUpvote,
  toggleReaction,
  reactionsFor,
  pollView,
  vote,
  removePoll,
  report,
  resolveReport,
  modLogPage,
  markRead,
  readMap,
  isUnread,
  navCounts,
  patchNewCount,
  openReportCount,
};

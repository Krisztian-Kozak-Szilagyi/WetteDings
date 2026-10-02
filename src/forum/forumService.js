const mongoose = require('mongoose');
const User = require('../models/User');
const PatchNote = require('../models/PatchNote');
const { ForumCategory, ForumThread, ForumPost, ForumRead, ForumReport } = require('../models/Forum');
const { tagsFor, tagsIn, sanitizeTags } = require('./render');
const { UserError } = require('../lib/util');

const TITLE_MIN = 3;
const TITLE_MAX = 120;
const BODY_MAX = 10000;
const THREADS_PER_PAGE = 20;
const POSTS_PER_PAGE = 20;
const POSTS_PER_MINUTE = 5;
const PATCHNOTES_KEY = 'patchnotes';

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

const patchnotesCategory = () => ForumCategory.findOne({ key: PATCHNOTES_KEY }).lean();

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
  /** Bereiche anlegen/ändern */
  manage: (user) => user.isStaff,
  editPost(user, post, thread) {
    if (post.deleted) return false;
    if (user.canModerate) return true;
    // Verfasser: solange niemand vom Team eingegriffen hat und das Thema offen ist
    return String(post.author) === String(user._id) && !post.staffEdited && !thread.locked;
  },
  deletePost: (user, post) => !post.deleted && (user.canModerate || String(post.author) === String(user._id)),
  /** Original eines gelöschten Beitrags ansehen */
  seeOriginal: (user) => user.isStaff,
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

async function createThread({ user, categoryId, title, body }) {
  const cat = mongoose.isValidObjectId(categoryId) ? await ForumCategory.findById(categoryId).lean() : null;
  if (!cat) throw new UserError('Diesen Bereich gibt es nicht.');
  if (!can.createThread(user, cat)) throw new UserError('In diesem Bereich eröffnen nur Admin und Devs Themen.');
  const t = cleanTitle(title);
  const b = cleanBody(body, tagsFor(roleOfUser(user)));
  throttle(user);
  const now = new Date();
  const thread = await ForumThread.create({ category: cat._id, title: t, author: user._id, authorName: user.username, lastPostAt: now, lastPostBy: user._id, lastPostByName: user.username, participants: [user._id] });
  await ForumPost.create({ thread: thread._id, author: user._id, authorName: user.username, body: b, isFirst: true });
  await markRead(user._id, thread._id, now);
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
  if (post.isFirst && typeof title === 'string' && title.trim()) {
    thread.title = cleanTitle(title);
    await thread.save();
  }
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
  return { post, thread };
}

/** Moderation eines Themas: anpinnen, schließen, entfernen */
async function moderateThread({ user, threadId, action }) {
  if (!user.canModerate) throw new UserError('Das darf nur die Moderation.');
  const set = { anpinnen: { pinned: true }, loesen: { pinned: false }, schliessen: { locked: true }, oeffnen: { locked: false }, entfernen: { deleted: true } }[action];
  if (!set || !mongoose.isValidObjectId(threadId)) throw new UserError('Unbekannte Aktion.');
  const thread = await ForumThread.findOneAndUpdate({ _id: threadId, deleted: false }, { $set: set }, { new: true });
  if (!thread) throw new UserError('Dieses Thema gibt es nicht.');
  return thread;
}

async function toggleUpvote({ user, threadId }) {
  if (!mongoose.isValidObjectId(threadId)) throw new UserError('Dieses Thema gibt es nicht.');
  const added = await ForumThread.updateOne({ _id: threadId, deleted: false, upvotes: { $ne: user._id } }, { $addToSet: { upvotes: user._id } });
  if (!added.modifiedCount) await ForumThread.updateOne({ _id: threadId }, { $pull: { upvotes: user._id } });
}

async function report({ user, postId, reason }) {
  const { post, thread } = await loadPost(postId);
  if (post.deleted) throw new UserError('Dieser Beitrag wurde schon gelöscht.');
  try {
    await ForumReport.create({ post: post._id, thread: thread._id, by: user._id, byName: user.username, reason: String(reason || '').trim().slice(0, 300) });
  } catch (err) {
    if (err.code !== 11000) throw err; // schon gemeldet – kein Fehler
  }
  return thread;
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
  roleOfUser,
  seed,
  migratePatchnotes,
  patchnotesCategory,
  can,
  createThread,
  reply,
  loadPost,
  editPost,
  deletePost,
  moderateThread,
  toggleUpvote,
  report,
  markRead,
  readMap,
  isUnread,
  navCounts,
  patchNewCount,
  openReportCount,
};

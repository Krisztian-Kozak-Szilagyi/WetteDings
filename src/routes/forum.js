const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const { ForumCategory, ForumThread, ForumPost, ForumReport } = require('../models/Forum');
const { requireLogin } = require('../middleware');
const forum = require('../forum/forumService');
const { render, tagsFor } = require('../forum/render');
const { str, UserError } = require('../lib/util');

const router = express.Router();
router.use('/forum', requireLogin);

// Jeder Besuch im Forum löscht die Abzeichen am Menüpunkt (die Markierungen im Forum selbst bleiben)
router.use('/forum', async (req, res, next) => {
  if (req.method === 'GET') {
    await User.updateOne({ _id: req.user._id }, { $set: { forumSeenAt: new Date() } });
    res.locals.forumMine = 0;
    res.locals.forumOther = 0;
  }
  next();
});

const valid = (id) => mongoose.isValidObjectId(id);
const notFound = (res, message) => res.status(404).render('error', { title: 'Forum', status: 404, message });
const pageOf = (req, total, perPage) => {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const want = req.query.seite === 'letzte' ? pages : Number.parseInt(req.query.seite, 10) || 1;
  return { pages, page: Math.min(pages, Math.max(1, want)) };
};

/** Aktion ausführen; Fehler als Hinweis zeigen und zurück */
async function act(req, res, back, fn) {
  try {
    const to = await fn();
    return res.redirect(to || back);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
    return res.redirect(back);
  }
}

/** Kennzahlen je Bereich aus allen sichtbaren Themen: Anzahl, Beiträge, letzter Beitrag, ungelesen */
async function categoryStats(user) {
  const [threads, reads] = await Promise.all([
    ForumThread.find({ deleted: false }).select('category title replyCount lastPostAt lastPostByName').lean(),
    forum.readMap(user._id),
  ]);
  const stats = new Map();
  for (const t of threads) {
    const key = String(t.category);
    const s = stats.get(key) || { threads: 0, posts: 0, last: null, unread: 0 };
    s.threads += 1;
    s.posts += 1 + t.replyCount;
    if (!s.last || t.lastPostAt > s.last.lastPostAt) s.last = t;
    if (forum.isUnread(reads, t)) s.unread += 1;
    stats.set(key, s);
  }
  return stats;
}
const EMPTY = { threads: 0, posts: 0, last: null, unread: 0 };

// ---------- Übersicht ----------
router.get('/forum', async (req, res) => {
  const [cats, stats, reports] = await Promise.all([
    ForumCategory.find().sort({ order: 1, createdAt: 1 }).lean(),
    categoryStats(req.user),
    req.user.canModerate ? forum.openReportCount() : 0,
  ]);
  const withStats = (c) => ({ ...c, stats: stats.get(String(c._id)) || EMPTY });
  const roots = cats
    .filter((c) => !c.parent)
    .map((c) => {
      const subs = cats.filter((s) => String(s.parent) === String(c._id)).map(withStats);
      const own = withStats(c);
      return { ...own, subs, unread: own.stats.unread + subs.reduce((n, s) => n + s.stats.unread, 0) };
    });
  res.render('forum', {
    title: 'Forum',
    roots,
    reports,
    canManage: forum.can.manage(req.user),
    canSetStaffOnly: forum.can.setStaffOnly(req.user),
    // Hauptbereiche, unter denen dieses Mitglied Unterbereiche anlegen darf
    parentChoices: cats.filter((c) => !c.parent && forum.can.manageCategory(req.user, c, null)),
  });
});

// ---------- Bereich ----------
router.get('/forum/k/:id', async (req, res) => {
  const cat = valid(req.params.id) ? await ForumCategory.findById(req.params.id).lean() : null;
  if (!cat) return notFound(res, 'Diesen Bereich gibt es nicht.');
  const filter = { category: cat._id, deleted: false };
  const [parent, subsRaw, total, stats, reads] = await Promise.all([
    cat.parent ? ForumCategory.findById(cat.parent).lean() : null,
    ForumCategory.find({ parent: cat._id }).sort({ order: 1, createdAt: 1 }).lean(),
    ForumThread.countDocuments(filter),
    categoryStats(req.user),
    forum.readMap(req.user._id),
  ]);
  const { page, pages } = pageOf(req, total, forum.THREADS_PER_PAGE);
  const threads = await ForumThread.find(filter).sort({ pinned: -1, lastPostAt: -1 }).skip((page - 1) * forum.THREADS_PER_PAGE).limit(forum.THREADS_PER_PAGE).lean();
  // Patchnotes: Besuch merken → Abzeichen im Footer verschwindet
  if (cat.key === forum.PATCHNOTES_KEY) {
    await User.updateOne({ _id: req.user._id }, { $set: { patchSeenAt: new Date() } });
    res.locals.patchNew = 0;
  }
  res.render('forum-kategorie', {
    title: cat.title,
    cat,
    parent,
    subs: subsRaw.map((s) => ({ ...s, stats: stats.get(String(s._id)) || EMPTY })),
    threads: threads.map((t) => ({ ...t, unread: forum.isUnread(reads, t) })),
    page,
    pages,
    total,
    canCreate: forum.can.createThread(req.user, cat),
    canManage: forum.can.manageCategory(req.user, cat, parent),
    canSetStaffOnly: forum.can.setStaffOnly(req.user),
    myTags: tagsFor(forum.roleOfUser(req.user)),
    titleMax: forum.TITLE_MAX,
    bodyMax: forum.BODY_MAX,
  });
});

router.post('/forum/k/:id/thema', (req, res) =>
  act(req, res, `/forum/k/${req.params.id}#neu`, async () => {
    const thread = await forum.createThread({ user: req.user, categoryId: req.params.id, title: str(req.body.title), body: req.body.body });
    return `/forum/t/${thread._id}`;
  })
);

// ---------- Thema ----------
router.get('/forum/t/:id', async (req, res) => {
  const thread = valid(req.params.id) ? await ForumThread.findOne({ _id: req.params.id, deleted: false }).lean() : null;
  if (!thread) return notFound(res, 'Dieses Thema gibt es nicht (mehr).');
  const [cat, total, reads] = await Promise.all([ForumCategory.findById(thread.category).lean(), ForumPost.countDocuments({ thread: thread._id }), forum.readMap(req.user._id)]);
  const parent = cat && cat.parent ? await ForumCategory.findById(cat.parent).lean() : null;
  const { page, pages } = pageOf(req, total, forum.POSTS_PER_PAGE);
  const posts = await ForumPost.find({ thread: thread._id }).sort({ createdAt: 1, _id: 1 }).skip((page - 1) * forum.POSTS_PER_PAGE).limit(forum.POSTS_PER_PAGE).lean();
  const lastRead = reads.get(String(thread._id)) || null;
  await forum.markRead(req.user._id, thread._id); // jetzt gilt alles als gelesen
  const mine = (p) => String(p.author) === String(req.user._id);
  res.render('forum-thema', {
    title: thread.title,
    thread,
    cat,
    parent,
    page,
    pages,
    total,
    posts: posts.map((p) => ({
      ...p,
      html: p.deleted ? '' : render(p.body),
      originalHtml: p.deleted && forum.can.seeOriginal(req.user) && p.original ? render(p.original) : null,
      isNew: !mine(p) && (!lastRead || p.createdAt > lastRead), // seit dem letzten Besuch dazugekommen
      mine: mine(p),
      canEdit: forum.can.editPost(req.user, p, thread),
      canDelete: forum.can.deletePost(req.user, p),
    })),
    upvoted: thread.upvotes.some((id) => id.equals(req.user._id)),
    canReply: forum.can.reply(req.user, thread),
    myTags: tagsFor(forum.roleOfUser(req.user)),
    bodyMax: forum.BODY_MAX,
  });
});

router.post('/forum/t/:id/antwort', (req, res) =>
  act(req, res, `/forum/t/${req.params.id}#antwort`, async () => {
    const { post } = await forum.reply({ user: req.user, threadId: req.params.id, body: req.body.body });
    return `/forum/t/${req.params.id}?seite=letzte#b-${post._id}`;
  })
);

router.post('/forum/t/:id/upvote', (req, res) => act(req, res, `/forum/t/${req.params.id}`, () => forum.toggleUpvote({ user: req.user, threadId: req.params.id }).then(() => null)));

router.post('/forum/t/:id/moderation', (req, res) =>
  act(req, res, `/forum/t/${req.params.id}`, async () => {
    const action = str(req.body.action);
    const thread = await forum.moderateThread({ user: req.user, threadId: req.params.id, action });
    if (action === 'entfernen') {
      req.flash('info', 'Thema entfernt.');
      return `/forum/k/${thread.category}`;
    }
    return null;
  })
);

// ---------- Beitrag: bearbeiten, löschen, melden ----------
router.get('/forum/b/:id/bearbeiten', async (req, res) => {
  try {
    const { post, thread } = await forum.loadPost(req.params.id);
    if (!forum.can.editPost(req.user, post, thread)) throw new UserError('Diesen Beitrag kannst du nicht (mehr) bearbeiten.');
    const own = String(post.author) === String(req.user._id);
    res.render('forum-bearbeiten', { title: 'Beitrag bearbeiten', post, thread, own, myTags: tagsFor(forum.roleOfUser(req.user)), titleMax: forum.TITLE_MAX, bodyMax: forum.BODY_MAX });
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
    res.redirect('/forum');
  }
});

router.post('/forum/b/:id/bearbeiten', (req, res) =>
  act(req, res, `/forum/b/${req.params.id}/bearbeiten`, async () => {
    const { post, thread } = await forum.editPost({ user: req.user, postId: req.params.id, body: req.body.body, title: req.body.title });
    return `/forum/t/${thread._id}#b-${post._id}`;
  })
);

router.post('/forum/b/:id/loeschen', (req, res) =>
  act(req, res, '/forum', async () => {
    const { post, thread } = await forum.deletePost({ user: req.user, postId: req.params.id });
    return `/forum/t/${thread._id}#b-${post._id}`;
  })
);

router.post('/forum/b/:id/melden', (req, res) =>
  act(req, res, '/forum', async () => {
    const thread = await forum.report({ user: req.user, postId: req.params.id, reason: str(req.body.reason) });
    req.flash('success', 'Danke – der Beitrag wurde der Moderation gemeldet.');
    return `/forum/t/${thread._id}#b-${req.params.id}`;
  })
);

// ---------- Meldungen (Moderation) ----------
router.get('/forum/meldungen', async (req, res, next) => {
  if (!req.user.canModerate) return next('route');
  const reports = await ForumReport.find({ done: false }).sort({ createdAt: -1 }).limit(100).lean();
  const posts = await ForumPost.find({ _id: { $in: reports.map((r) => r.post) } }).select('authorName body deleted thread').lean();
  const byId = new Map(posts.map((p) => [String(p._id), p]));
  res.render('forum-meldungen', { title: 'Meldungen', reports: reports.map((r) => ({ ...r, postDoc: byId.get(String(r.post)) || null })) });
});

router.post('/forum/meldungen/:id/erledigt', async (req, res, next) => {
  if (!req.user.canModerate) return next('route');
  if (valid(req.params.id)) await ForumReport.updateOne({ _id: req.params.id }, { $set: { done: true } });
  res.redirect('/forum/meldungen');
});

// ---------- Bereiche verwalten (Admin/Dev) ----------
function categoryInput(req) {
  const title = str(req.body.title).trim();
  if (title.length < 2 || title.length > 60) throw new UserError('Der Name des Bereichs muss 2–60 Zeichen lang sein.');
  return {
    title,
    description: str(req.body.description).trim().slice(0, 200),
    staffOnly: forum.can.setStaffOnly(req.user) && req.body.staffOnly === '1', // Mods können keine Team-Bereiche anlegen
    order: Math.max(0, Math.min(999, Number.parseInt(req.body.order, 10) || 0)),
  };
}

router.post('/forum/bereiche', (req, res, next) => {
  if (!forum.can.manage(req.user)) return next('route');
  return act(req, res, '/forum#bereiche', async () => {
    const data = categoryInput(req);
    const parentId = str(req.body.parent);
    let parent = null;
    if (parentId) {
      parent = valid(parentId) ? await ForumCategory.findById(parentId).lean() : null;
      if (!parent) throw new UserError('Den übergeordneten Bereich gibt es nicht.');
      if (parent.parent) throw new UserError('Unterbereiche können keine eigenen Unterbereiche haben.');
      if (!forum.can.manageCategory(req.user, parent, null)) throw new UserError('In Team-Bereichen legen nur Admin und Devs Unterbereiche an.');
    }
    await ForumCategory.create({ ...data, parent: parent ? parent._id : null });
    req.flash('success', `Bereich „${data.title}“ angelegt.`);
    return '/forum';
  });
});

router.post('/forum/bereiche/:id', (req, res, next) => {
  if (!forum.can.manage(req.user)) return next('route');
  return act(req, res, `/forum/k/${req.params.id}`, async () => {
    const cat = valid(req.params.id) ? await ForumCategory.findById(req.params.id).lean() : null;
    if (!cat) throw new UserError('Diesen Bereich gibt es nicht.');
    const parent = cat.parent ? await ForumCategory.findById(cat.parent).lean() : null;
    if (!forum.can.manageCategory(req.user, cat, parent)) throw new UserError('Team-Bereiche können nur Admin und Devs ändern.');
    if (req.body.action === 'loeschen') {
      const [threads, subs] = await Promise.all([ForumThread.countDocuments({ category: cat._id, deleted: false }), ForumCategory.countDocuments({ parent: cat._id })]);
      if (cat.key) throw new UserError('Dieser Bereich wird von der Seite gebraucht und kann nicht gelöscht werden.');
      if (threads || subs) throw new UserError('Nur leere Bereiche (ohne Themen und Unterbereiche) können gelöscht werden.');
      await ForumCategory.deleteOne({ _id: cat._id });
      req.flash('info', `Bereich „${cat.title}“ gelöscht.`);
      return cat.parent ? `/forum/k/${cat.parent}` : '/forum';
    }
    const data = categoryInput(req);
    if (!forum.can.setStaffOnly(req.user)) delete data.staffOnly; // Mods ändern den Team-Status nicht
    await ForumCategory.updateOne({ _id: cat._id }, { $set: data });
    req.flash('success', 'Bereich gespeichert.');
    return null;
  });
});

// Die alte Patchnotes-Seite führt jetzt in den Forum-Bereich
router.get('/patchnotes', requireLogin, async (req, res) => {
  const cat = await forum.patchnotesCategory();
  res.redirect(cat ? `/forum/k/${cat._id}` : '/forum');
});

module.exports = router;

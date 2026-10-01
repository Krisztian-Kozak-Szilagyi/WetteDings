const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const PatchNote = require('../models/PatchNote');
const { requireLogin, requireAdmin } = require('../middleware');
const { render } = require('../patchnotes/render');
const { str } = require('../lib/util');

const TITLE_MAX = 120;
const BODY_MAX = 10000;
const COMMENT_MAX = 500;
const COMMENTS_PER_NOTE = 300;

const router = express.Router();
router.use('/patchnotes', requireLogin);

/** Anzahl Patchnotes seit dem letzten Besuch (für das Abzeichen im Footer) */
const newCount = (user) => PatchNote.countDocuments({ createdAt: { $gt: user.patchSeenAt || user.createdAt } });

router.get('/patchnotes', async (req, res) => {
  const [notes] = await Promise.all([
    PatchNote.find().sort({ createdAt: -1 }).limit(50).lean(),
    // Besuch merken: alle Patchnotes gelten ab jetzt als gelesen
    User.updateOne({ _id: req.user._id }, { $set: { patchSeenAt: new Date() } }),
  ]);
  const seen = req.user.patchSeenAt || req.user.createdAt;
  res.locals.patchNew = 0;
  res.render('patchnotes', {
    title: 'Patchnotes',
    notes: notes.map((n) => ({
      ...n,
      html: render(n.body),
      isNew: n.createdAt > seen,
      upvoted: n.upvotes.some((id) => id.equals(req.user._id)),
    })),
    titleMax: TITLE_MAX,
    bodyMax: BODY_MAX,
    commentMax: COMMENT_MAX,
  });
});

router.post('/patchnotes', requireAdmin, async (req, res) => {
  const title = str(req.body.title).trim();
  const body = (typeof req.body.body === 'string' ? req.body.body : '').trim();
  if (!title || title.length > TITLE_MAX) req.flash('error', `Bitte einen Titel angeben (höchstens ${TITLE_MAX} Zeichen).`);
  else if (!body || body.length > BODY_MAX) req.flash('error', `Bitte einen Text angeben (höchstens ${BODY_MAX} Zeichen).`);
  else {
    await PatchNote.create({ title, body, authorName: req.user.username });
    req.flash('success', 'Patchnote veröffentlicht.');
  }
  res.redirect('/patchnotes');
});

// Ab hier geht es um eine bestimmte Patchnote
router.param('id', (req, res, next, id) => {
  if (mongoose.isValidObjectId(id)) return next();
  req.flash('error', 'Diese Patchnote gibt es nicht.');
  res.redirect('/patchnotes');
});

router.post('/patchnotes/:id/loeschen', requireAdmin, async (req, res) => {
  await PatchNote.deleteOne({ _id: req.params.id });
  req.flash('info', 'Patchnote gelöscht.');
  res.redirect('/patchnotes');
});

// Upvote setzen bzw. wieder zurücknehmen
router.post('/patchnotes/:id/upvote', async (req, res) => {
  const me = req.user._id;
  const added = await PatchNote.updateOne({ _id: req.params.id, upvotes: { $ne: me } }, { $addToSet: { upvotes: me } });
  if (!added.modifiedCount) await PatchNote.updateOne({ _id: req.params.id }, { $pull: { upvotes: me } });
  res.redirect(`/patchnotes#p-${req.params.id}`);
});

router.post('/patchnotes/:id/kommentar', async (req, res) => {
  const text = (typeof req.body.text === 'string' ? req.body.text : '').trim();
  if (!text || text.length > COMMENT_MAX) {
    req.flash('error', `Bitte einen Kommentar schreiben (höchstens ${COMMENT_MAX} Zeichen).`);
  } else {
    const r = await PatchNote.updateOne(
      { _id: req.params.id, [`comments.${COMMENTS_PER_NOTE - 1}`]: { $exists: false } },
      { $push: { comments: { user: req.user._id, username: req.user.username, text } } }
    );
    if (!r.modifiedCount) req.flash('error', 'Hier kann nicht mehr kommentiert werden.');
  }
  res.redirect(`/patchnotes#p-${req.params.id}`);
});

// Eigenen Kommentar löschen (Admins: jeden)
router.post('/patchnotes/:id/kommentar/:commentId/loeschen', async (req, res) => {
  if (mongoose.isValidObjectId(req.params.commentId)) {
    const own = req.user.isAdmin ? {} : { user: req.user._id };
    await PatchNote.updateOne({ _id: req.params.id }, { $pull: { comments: { _id: req.params.commentId, ...own } } });
  }
  res.redirect(`/patchnotes#p-${req.params.id}`);
});

module.exports = router;
module.exports.newCount = newCount;

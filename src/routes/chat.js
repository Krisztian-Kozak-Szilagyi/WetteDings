// Chat (public/js/chat.js): alles als JSON. Steht in app.js vor Statistik und Menü-Zählern, weil der Browser
// regelmäßig nachfragt – /chat/stand antwortet ohne Datenbank, solange sich für das Mitglied nichts geändert hat.
const express = require('express');
const chat = require('../chat/chatService');
const { UserError, str } = require('../lib/util');

const router = express.Router();

router.use('/chat', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.status(401).json({ error: 'Bitte melde dich an.' });
  next();
});

// Fehler der Mitglieder (UserError) als Meldung im Chat, alles andere an die Fehlerseite
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof UserError) return res.status(400).json({ error: err.message });
    next(err);
  }
};

// Stand: gleich → nur die Zahl; sonst die Übersicht (Gespräche, ungelesene, blockierte)
router.get('/chat/stand', handle(async (req, res) => {
  const v = chat.version(req.user._id);
  if (String(v) === str(req.query.v)) return res.json({ v });
  res.json(await chat.overview(req.user));
}));

// Nachrichten eines Gesprächs (?c=Schlüssel, optional vor=/nach=Nachrichten-Id)
router.get('/chat/verlauf', handle(async (req, res) => {
  res.json(await chat.messages(req.user, str(req.query.c), { before: str(req.query.vor), after: str(req.query.nach) }));
}));

// Neues Gespräch mit einem Mitglied (Name) → Schlüssel
router.post('/chat/mit', handle(async (req, res) => {
  res.json({ key: await chat.startWith(req.user, str(req.body.name)) });
}));

router.post('/chat/senden', handle(async (req, res) => {
  res.json({ message: await chat.send(req.user, str(req.body.c), str(req.body.text)) });
}));

router.post('/chat/melden', handle(async (req, res) => {
  await chat.report(req.user, str(req.body.id), str(req.body.grund));
  res.json({ ok: true });
}));

router.post('/chat/blockieren', handle(async (req, res) => {
  await chat.setBlocked(req.user, str(req.body.name), req.body.an === '1');
  res.json({ ok: true });
}));

module.exports = router;

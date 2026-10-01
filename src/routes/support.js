const express = require('express');
const { requireLogin } = require('../middleware');
const User = require('../models/User');
const chat = require('../support/chatService');
const { str } = require('../lib/util');

const router = express.Router();
router.use('/support', requireLogin);

const MAX_MESSAGE = 500; // Zeichen pro Nachricht
const MAX_HISTORY = 12; // gespeicherte/angezeigte Nachrichten (Nutzer + Bot) pro Sitzung
const CONTEXT_MESSAGES = 6; // davon an das Modell geschickt (Token-Limit)
const CONTEXT_CHARS = 700; // pro Nachricht im Kontext
const LIMIT_PER_HOUR = 30;
const MIN_GAP_MS = 2000;

// Einfaches Limit pro Nutzer (im Speicher; reicht für einen einzelnen Prozess)
const recent = new Map();
function rateLimited(userId) {
  const key = String(userId);
  const now = Date.now();
  const list = (recent.get(key) || []).filter((t) => now - t < 3600000);
  if (list.length && now - list[list.length - 1] < MIN_GAP_MS) return 'Nicht so schnell – Warren denkt noch nach.';
  if (list.length >= LIMIT_PER_HOUR) return 'Du hast das Limit für diese Stunde erreicht. Bitte versuch es später noch einmal.';
  list.push(now);
  recent.set(key, list);
  return null;
}

const history = (req) => (Array.isArray(req.session.supportChat) ? req.session.supportChat : []);

router.get('/support/verlauf', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ enabled: chat.isEnabled(), consent: !!req.user.supportConsentAt, messages: history(req) });
});

// Einmalige Einwilligung: Chat-Nachrichten gehen an einen KI-Dienst in den USA (Art. 6 Abs. 1 lit. a, Art. 49 Abs. 1 lit. a DSGVO)
router.post('/support/einwilligung', async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $set: { supportConsentAt: new Date() } });
  res.json({ ok: true });
});

router.post('/support/chat', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user.supportConsentAt) return res.status(403).json({ error: 'Bitte stimme zuerst der Übermittlung an den KI-Dienst zu.' });
  const message = str(req.body.message).trim().slice(0, MAX_MESSAGE);
  if (!message) return res.status(400).json({ error: 'Bitte schreib eine Frage.' });
  const limited = rateLimited(req.user._id);
  if (limited) return res.status(429).json({ error: limited });

  try {
    const past = history(req);
    const context = past.slice(-CONTEXT_MESSAGES).map((m) => ({ role: m.role, content: m.content.slice(0, CONTEXT_CHARS) }));
    const { text } = await chat.reply({ history: context, message });
    req.session.supportChat = [...past, { role: 'user', content: message }, { role: 'assistant', content: text }].slice(-MAX_HISTORY);
    res.json({ reply: text });
  } catch (err) {
    if (!(err instanceof chat.SupportUnavailable)) throw err;
    res.status(503).json({ error: err.message });
  }
});

router.post('/support/neu', (req, res) => {
  req.session.supportChat = [];
  res.json({ ok: true });
});

module.exports = router;

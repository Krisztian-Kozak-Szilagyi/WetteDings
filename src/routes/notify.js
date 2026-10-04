// Glocke: Benachrichtigung öffnen (markiert sie als gelesen), einzeln oder alle als gelesen markieren.
// Mit JavaScript schickt app.js die Formulare im Hintergrund (Antwort JSON), sonst geht es zurück zur Seite.
const express = require('express');
const { requireLogin } = require('../middleware');
const notifyService = require('../services/notifyService');

const router = express.Router();

const wantsJson = (req) => (req.get('Accept') || '').includes('application/json');
const back = (req) => notifyService.safeHref(typeof req.body.zurueck === 'string' ? req.body.zurueck : '/');

async function answer(req, res) {
  if (wantsJson(req)) return res.json({ unread: await notifyService.unreadCount(req.user._id) });
  res.redirect(back(req));
}

// Anklicken: als gelesen markieren und zum Ziel weiterleiten
router.get('/benachrichtigungen/:id', requireLogin, async (req, res) => {
  const n = await notifyService.markRead(req.user._id, req.params.id);
  res.redirect(n ? notifyService.safeHref(n.href) : '/');
});

router.post('/benachrichtigungen/alle-gelesen', requireLogin, async (req, res) => {
  await notifyService.markAllRead(req.user._id);
  await answer(req, res);
});

router.post('/benachrichtigungen/:id/gelesen', requireLogin, async (req, res) => {
  await notifyService.markRead(req.user._id, req.params.id);
  await answer(req, res);
});

module.exports = router;

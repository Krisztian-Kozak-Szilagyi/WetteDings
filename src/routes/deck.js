// Deckbau (Vorbereitung Kampfmodus): EJS ist nur der Rahmen, Daten und Speichern laufen über JSON (public/js/deck.js).
// Vorerst nur für Admins, bis es genug Kampfkarten gibt.
const express = require('express');
const { requireAdmin } = require('../middleware');
const deckService = require('../game/deckService');
const { str, UserError } = require('../lib/util');

const router = express.Router();

router.get('/deck', requireAdmin, (req, res) => {
  res.render('deck', { title: 'Deckbau' });
});

router.get('/api/deck', requireAdmin, async (req, res, next) => {
  try {
    res.json(await deckService.overview(req.user._id));
  } catch (err) {
    next(err);
  }
});

const fail = (res, err, next) => (err instanceof UserError ? res.status(400).json({ error: err.message }) : next(err));

// Speichern: karten = Karten-IDs mit Komma getrennt (Wiederholung = mehrere Exemplare)
router.post('/api/deck', requireAdmin, async (req, res, next) => {
  try {
    const ids = str(req.body.karten).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    const deck = await deckService.saveDeck(req.user._id, { deckId: str(req.body.id), name: str(req.body.name), ids });
    res.json({ deck });
  } catch (err) {
    fail(res, err, next);
  }
});

router.post('/api/deck/loeschen', requireAdmin, async (req, res, next) => {
  try {
    await deckService.deleteDeck(req.user._id, str(req.body.id));
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, next);
  }
});

module.exports = router;

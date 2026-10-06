// Bosskampf (Vorbereitung Kampfmodus): erster Test, wie sich ein Bossraum anfühlt. Vorerst nur für Admins.
// EJS ist nur der Rahmen, der Boss wird in public/js/bossfight.js auf ein Canvas gezeichnet.
const express = require('express');
const { requireAdmin } = require('../middleware');

const router = express.Router();

router.get('/bossfight', requireAdmin, (req, res) => {
  res.render('bossfight', { title: 'Bosskampf' });
});

module.exports = router;

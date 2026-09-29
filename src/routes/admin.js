const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Bet = require('../models/Bet');
const { requireAdmin } = require('../middleware');
const coinEngine = require('../coin/engine');
const { CODE_TTL_MINUTES, formatCode, createCode, listActiveCodes, revokeCode } = require('../services/codeService');

const router = express.Router();

router.get('/admin', requireAdmin, async (req, res) => {
  const [codes, userCount, openBets, totalBets] = await Promise.all([
    listActiveCodes(),
    User.countDocuments(),
    Bet.countDocuments({ status: 'offen' }),
    Bet.countDocuments(),
  ]);
  res.render('admin', {
    title: 'Admin',
    codes,
    formatCode,
    ttlMinutes: CODE_TTL_MINUTES,
    stats: { userCount, openBets, totalBets },
    now: Date.now(),
    coin: coinEngine.isRunning() ? coinEngine.snapshot() : null,
    manipulation: coinEngine.manipulationStatus(),
    durations: DURATIONS,
  });
});

// ---------- Samantha Coin steuern (nur Admins, für Nutzer unsichtbar) ----------

const DURATIONS = [0, 1, 5, 15, 30, 60];

router.post('/admin/coin', requireAdmin, async (req, res) => {
  const percent = Number(String(req.body.percent || '').replace(',', '.').replace('−', '-'));
  const minutes = Number(req.body.minutes);
  if (!Number.isFinite(percent) || percent === 0 || percent < -99 || percent > 1000) {
    req.flash('error', 'Bitte eine Änderung zwischen −99 % und +1000 % angeben (nicht 0).');
  } else if (!DURATIONS.includes(minutes)) {
    req.flash('error', 'Ungültige Dauer.');
  } else if (!coinEngine.isRunning()) {
    req.flash('error', 'Die Kurs-Engine läuft nicht.');
  } else {
    await coinEngine.startManipulation({ percent, minutes });
    const sign = percent > 0 ? '+' : '';
    req.flash('success', minutes
      ? `Kurssteuerung aktiv: ${sign}${percent} % über ${minutes} Min. (zusätzlich zur normalen Schwankung).`
      : `Kurs sofort um ${sign}${percent} % verändert.`);
  }
  res.redirect('/admin#coin');
});

router.post('/admin/coin/stopp', requireAdmin, async (req, res) => {
  if (coinEngine.isRunning()) await coinEngine.cancelManipulation();
  req.flash('info', 'Kurssteuerung beendet – der Kurs bewegt sich wieder nur zufällig.');
  res.redirect('/admin#coin');
});

router.post('/admin/codes', requireAdmin, async (req, res) => {
  const code = await createCode(req.user);
  req.flash('success', `Neuer Registrierungscode: ${formatCode(code.code)} – gültig für ${CODE_TTL_MINUTES} Minuten und eine Person.`);
  res.redirect('/admin');
});

router.post('/admin/codes/:id/loeschen', requireAdmin, async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) await revokeCode(req.params.id);
  req.flash('info', 'Code gelöscht.');
  res.redirect('/admin');
});

module.exports = router;

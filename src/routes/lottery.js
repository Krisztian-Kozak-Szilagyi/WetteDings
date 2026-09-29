const express = require('express');
const config = require('../config');
const { requireLogin } = require('../middleware');
const { LotteryRound, LotteryEntry } = require('../models/Lottery');
const lottery = require('../services/lotteryService');
const { str, UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');

const router = express.Router();
router.use('/lotterie', requireLogin);

async function lotteryVersion() {
  const [round, lastDrawn] = await Promise.all([
    LotteryRound.findOne({ status: 'offen' }).select('tickets').lean(),
    LotteryRound.findOne({ status: 'gezogen' }).sort({ drawnAt: -1 }).select('_id').lean(),
  ]);
  return [round ? round._id : '-', round ? round.tickets : 0, lastDrawn ? lastDrawn._id : '-', Math.floor(Date.now() / 60000)].join(':');
}

router.get('/lotterie', async (req, res) => {
  const round = await lottery.ensureOpenRound();
  const liveVersion = await lotteryVersion(); // vor dem Laden der übrigen Daten
  const [myEntry, entries, history] = await Promise.all([
    LotteryEntry.findOne({ round: round._id, user: req.user._id }).lean(),
    LotteryEntry.find({ round: round._id }).sort({ tickets: -1, createdAt: 1 }).limit(100).lean(),
    LotteryRound.find({ status: 'gezogen' }).sort({ drawnAt: -1 }).limit(10).lean(),
  ]);
  const lastDrawn = history[0] || null;
  res.render('lottery', {
    title: 'Lotterie',
    liveVersion,
    round,
    myEntry,
    entries,
    history,
    lastDrawn,
    iWonLast: !!(lastDrawn && lastDrawn.winner && String(lastDrawn.winner) === String(req.user._id)),
    selling: round.startsAt <= new Date() && round.drawAt > new Date(),
    ticketPrice: config.lotteryTicketPrice,
    maxTickets: config.lotteryMaxTicketsPerPurchase,
    lotteryTime: config.lotteryTime,
    drawTime: lottery.drawTime(),
  });
});

// Versionsstand für die Live-Aktualisierung
router.get('/lotterie/stand', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ v: await lotteryVersion() });
});

router.post('/lotterie/kaufen', async (req, res) => {
  try {
    const count = parseInt(str(req.body.count), 10);
    const r = await lottery.buyTickets({ user: req.user, count });
    const nums = r.range.from === r.range.to ? `Losnummer ${r.range.from}` : `Losnummern ${r.range.from}–${r.range.to}`;
    req.flash('success', `Du hast ${r.count} ${r.count === 1 ? 'Los' : 'Lose'} für ${euro(r.cost)} gekauft (${nums}). Viel Glück!`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/lotterie');
});

module.exports = router;

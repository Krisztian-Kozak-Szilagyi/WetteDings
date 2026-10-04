const express = require('express');
const config = require('../config');
const { requireLogin } = require('../middleware');
const { LotteryRound, LotteryEntry } = require('../models/Lottery');
const lottery = require('../services/lotteryService');
const catalog = require('../tcg/catalog');
const { str, UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');

const router = express.Router();
router.use('/lotterie', requireLogin);

// Bilder der Gewinne im Jackpot und auf den Lotterie-Kacheln
const PRIZE_IMAGES = { pack: catalog.PACK_TYPES[0].image, folie: '/img/items/folie.svg' };

async function lotteryVersion(k) {
  const [round, lastDrawn] = await Promise.all([
    LotteryRound.findOne({ ...k.filter, status: 'offen' }).select('tickets prizeCash prizePacks prizeFoils').lean(),
    LotteryRound.findOne({ ...k.filter, status: 'gezogen' }).sort({ drawnAt: -1 }).select('_id').lean(),
  ]);
  const prizes = round ? [round.prizeCash || 0, round.prizePacks || 0, round.prizeFoils || 0].join('-') : '-';
  return [round ? round._id : '-', round ? round.tickets : 0, prizes, lastDrawn ? lastDrawn._id : '-', Math.floor(Date.now() / 60000)].join(':');
}

/** Wann wird gezogen? (für Kopfzeile und Kacheln) */
function scheduleText(k) {
  if (k.key === 'woche') return `Jeden Sonntag · Ziehung um ${lottery.bigDrawTime()} Uhr`;
  if (k.key === 'monat') return `Am 28. jedes Monats · Ziehung um ${lottery.bigDrawTime()} Uhr`;
  return `Täglich · Ziehung um ${lottery.drawTime()} Uhr · neue Runde ab ${config.lotteryTime} Uhr`;
}

for (const k of lottery.KINDS) {
  router.get(k.path, async (req, res) => {
    const round = await lottery.ensureOpenRound(Date.now(), k.key);
    const liveVersion = await lotteryVersion(k); // vor dem Laden der übrigen Daten
    const others = lottery.KINDS.filter((o) => o.key !== k.key);
    const [myEntry, entries, history, otherRounds] = await Promise.all([
      LotteryEntry.findOne({ round: round._id, user: req.user._id }).lean(),
      LotteryEntry.find({ round: round._id }).sort({ tickets: -1, createdAt: 1 }).limit(100).lean(),
      LotteryRound.find({ ...k.filter, status: 'gezogen' }).sort({ drawnAt: -1 }).limit(10).lean(),
      Promise.all(others.map((o) => lottery.ensureOpenRound(Date.now(), o.key))),
    ]);
    const lastDrawn = history[0] || null;
    res.render('lottery', {
      title: k.title,
      lotto: { ...k, schedule: scheduleText(k) },
      lottoTiles: others.map((o, i) => ({ ...o, schedule: scheduleText(o), round: otherRounds[i] })),
      prizeImages: PRIZE_IMAGES,
      liveVersion,
      round,
      myEntry,
      entries,
      history,
      lastDrawn,
      iWonLast: !!(lastDrawn && lastDrawn.winner && String(lastDrawn.winner) === String(req.user._id)),
      selling: round.startsAt <= new Date() && round.drawAt > new Date(),
      ticketPrice: lottery.ticketPrice(k.key),
      maxTickets: config.lotteryMaxTicketsPerPurchase,
      lotteryTime: config.lotteryTime,
      drawTime: lottery.drawTime(),
      bigDrawTime: lottery.bigDrawTime(),
    });
  });

  // Versionsstand für die Live-Aktualisierung
  router.get(`${k.path}/stand`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ v: await lotteryVersion(k) });
  });

  router.post(`${k.path}/kaufen`, async (req, res) => {
    try {
      const count = parseInt(str(req.body.count), 10);
      const r = await lottery.buyTickets({ user: req.user, count, kind: k.key });
      const nums = r.range.from === r.range.to ? `Losnummer ${r.range.from}` : `Losnummern ${r.range.from}–${r.range.to}`;
      req.flash('success', `Du hast ${r.count} ${r.count === 1 ? 'Los' : 'Lose'} für ${euro(r.cost)} gekauft (${nums}). Viel Glück!`);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      req.flash('error', err.message);
    }
    res.redirect(k.path);
  });
}

module.exports = router;

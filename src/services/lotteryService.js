/**
 * Tägliche Lotterie.
 *  - Ein Los kostet config.lotteryTicketPrice (100 €). Man kann mehrere Lose kaufen (mehr Lose = höhere Chance).
 *  - Jedes Los bekommt eine fortlaufende Nummer. Bei der Ziehung wird eine Losnummer zufällig gezogen
 *    (kryptografisch sicherer Zufall); der Besitzer bekommt den gesamten Topf.
 *  - Ziehung am Folgetag, immer 1 Minute vor Beginn der nächsten Lotterie (Standard: Ziehung 19:59, Start 20:00).
 */
const crypto = require('crypto');
const config = require('../config');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { LotteryRound, LotteryEntry } = require('../models/Lottery');
const { inTransaction } = require('./betService');
const { parseZonedLocal, toZonedLocalInput } = require('../lib/time');
const { UserError } = require('../lib/util');

const MIN = 60 * 1000;

/** Uhrzeit der Ziehung: 1 Minute vor dem Lotterie-Start, z. B. "19:59" */
function drawTime() {
  const [h, m] = config.lotteryTime.split(':').map(Number);
  const total = (h * 60 + m + 24 * 60 - 1) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function addDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Nächster Ziehungszeitpunkt nach startMs (deutsche Zeit, sommerzeitsicher) */
function nextDrawAfter(startMs) {
  const day = toZonedLocalInput(new Date(startMs), config.timezone).slice(0, 10);
  const t = drawTime();
  let candidate = parseZonedLocal(`${day}T${t}`, config.timezone);
  if (candidate.getTime() <= startMs) candidate = parseZonedLocal(`${addDays(day, 1)}T${t}`, config.timezone);
  return candidate;
}

/** Sorgt dafür, dass es eine offene Runde gibt (beim Start und nach jeder Ziehung) */
async function ensureOpenRound(startMs = Date.now()) {
  const open = await LotteryRound.findOne({ status: 'offen' }).lean();
  if (open) return open;
  const last = await LotteryRound.findOne().sort({ number: -1 }).select('number').lean();
  try {
    const round = await LotteryRound.create({
      number: last ? last.number + 1 : 1,
      startsAt: new Date(startMs),
      drawAt: nextDrawAfter(startMs),
    });
    return round.toObject();
  } catch (err) {
    if (err.code === 11000) return LotteryRound.findOne({ status: 'offen' }).lean(); // parallel angelegt
    throw err;
  }
}

async function buyTickets({ user, count }) {
  if (!Number.isInteger(count) || count < 1 || count > config.lotteryMaxTicketsPerPurchase) {
    throw new UserError(`Du kannst 1 bis ${config.lotteryMaxTicketsPerPurchase} Lose auf einmal kaufen.`);
  }
  const cost = count * config.lotteryTicketPrice;

  return inTransaction(async (session) => {
    const now = new Date();
    const current = await LotteryRound.findOne({ status: 'offen' }).session(session);
    if (!current) throw new UserError('Gerade läuft keine Lotterie. Bitte versuche es gleich noch einmal.');
    if (current.startsAt > now) {
      throw new UserError('Die Ziehung läuft gerade – die nächste Lotterie startet in Kürze.');
    }

    const round = await LotteryRound.findOneAndUpdate(
      { _id: current._id, status: 'offen', drawAt: { $gt: now } },
      { $inc: { tickets: count, pot: cost } },
      { new: true, session }
    );
    if (!round) throw new UserError('Der Losverkauf für diese Ziehung ist beendet.');

    const debited = await User.findOneAndUpdate(
      { _id: user._id, balance: { $gte: cost } },
      { $inc: { balance: -cost } },
      { new: true, session }
    );
    if (!debited) throw new UserError('Dein Guthaben reicht dafür nicht aus.');

    const range = { from: round.tickets - count + 1, to: round.tickets };
    const existing = await LotteryEntry.findOne({ round: round._id, user: user._id }).session(session);
    if (existing) {
      await LotteryEntry.updateOne({ _id: existing._id }, { $inc: { tickets: count }, $push: { ranges: range } }, { session });
    } else {
      await LotteryEntry.create([{ round: round._id, user: user._id, username: user.username, tickets: count, ranges: [range] }], {
        session,
      });
      await LotteryRound.updateOne({ _id: round._id }, { $inc: { participants: 1 } }, { session });
    }
    await Ledger.create([{ user: user._id, type: 'lotto_los', amount: -cost }], { session });
    return { count, cost, range, round: round.number };
  });
}

/** Zieht eine fällige Runde. Gibt das Ergebnis zurück oder null, wenn nichts fällig war. */
async function drawDueRound(now = new Date()) {
  const result = await inTransaction(async (session) => {
    const round = await LotteryRound.findOne({ status: 'offen', drawAt: { $lte: now } }).session(session);
    if (!round) return null;

    let winner = null;
    let winningTicket = null;
    if (round.tickets > 0) {
      winningTicket = crypto.randomInt(1, round.tickets + 1);
      winner = await LotteryEntry.findOne({
        round: round._id,
        ranges: { $elemMatch: { from: { $lte: winningTicket }, to: { $gte: winningTicket } } },
      }).session(session);
      if (!winner) throw new Error(`Los ${winningTicket} in Runde ${round.number} nicht gefunden.`);
      await User.updateOne({ _id: winner.user }, { $inc: { balance: round.pot } }, { session });
      await Ledger.create([{ user: winner.user, type: 'lotto_gewinn', amount: round.pot }], { session });
    }

    const updated = await LotteryRound.updateOne(
      { _id: round._id, status: 'offen' },
      {
        $set: {
          status: 'gezogen',
          drawnAt: now,
          winningTicket,
          winner: winner ? winner.user : null,
          winnerName: winner ? winner.username : null,
        },
      },
      { session }
    );
    if (updated.modifiedCount !== 1) return null;
    return { number: round.number, drawAt: round.drawAt, pot: round.pot, tickets: round.tickets, winningTicket, winnerName: winner ? winner.username : null };
  });

  if (result) {
    // Nächste Runde startet 1 Minute nach der (geplanten) Ziehung – bzw. sofort, falls die Ziehung verspätet war
    await ensureOpenRound(Math.max(result.drawAt.getTime() + MIN, Date.now()));
  }
  return result;
}

/** Wird regelmäßig aufgerufen: fällige Ziehungen durchführen und eine offene Runde sicherstellen */
async function runLottery() {
  let r;
  while ((r = await drawDueRound())) {
    console.log(
      r.winnerName
        ? `Lotterie #${r.number}: Los ${r.winningTicket} von ${r.tickets} gewinnt – ${r.winnerName} erhält ${(r.pot / 100).toFixed(2)} €.`
        : `Lotterie #${r.number}: keine Lose verkauft.`
    );
  }
  await ensureOpenRound();
}

module.exports = { drawTime, nextDrawAfter, ensureOpenRound, buyTickets, drawDueRound, runLottery };

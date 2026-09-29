const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../config');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const { computePayouts } = require('../lib/payout');
const { UserError } = require('../lib/util');

const SYSTEM_ACTOR = { system: true, username: 'System' };

/** Führt fn in einer MongoDB-Transaktion aus (bei Konflikten automatische Wiederholung). */
async function inTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/** Bucht Guthaben ab – schlägt fehl, wenn nicht genug da ist (atomar). */
async function debit(userId, amount, session) {
  const user = await User.findOneAndUpdate(
    { _id: userId, balance: { $gte: amount } },
    { $inc: { balance: -amount } },
    { new: true, session }
  );
  if (!user) throw new UserError('Dein Guthaben reicht für diesen Einsatz nicht aus.');
  return user;
}

async function registerUser({ username, email, password }) {
  const passwordHash = await bcrypt.hash(password, 12);
  return inTransaction(async (session) => {
    const [user] = await User.create(
      [
        {
          username,
          usernameLower: username.toLowerCase(),
          email,
          passwordHash,
          balance: config.startBalance,
        },
      ],
      { session }
    );
    await Ledger.create([{ user: user._id, type: 'startguthaben', amount: config.startBalance }], { session });
    return user;
  });
}

async function createBet({ user, title, description, deadline, side, amount }) {
  return inTransaction(async (session) => {
    await debit(user._id, amount, session);
    const [bet] = await Bet.create(
      [
        {
          title,
          description,
          creator: user._id,
          creatorName: user.username,
          creatorSide: side,
          deadline,
          totalJa: side === 'ja' ? amount : 0,
          totalNein: side === 'nein' ? amount : 0,
          participants: 1,
        },
      ],
      { session }
    );
    await Position.create([{ bet: bet._id, user: user._id, username: user.username, side, amount }], { session });
    await Ledger.create([{ user: user._id, type: 'einsatz', amount: -amount, bet: bet._id, betTitle: title }], {
      session,
    });
    return bet;
  });
}

async function placeStake({ user, betId, side, amount }) {
  return inTransaction(async (session) => {
    const existing = await Position.findOne({ bet: betId, user: user._id }).session(session);
    if (existing && existing.side !== side) {
      throw new UserError(
        `Du hast in dieser Wette bereits auf „${existing.side === 'ja' ? 'Ja' : 'Nein'}“ gesetzt. ` +
          'Du kannst deinen Einsatz nur auf derselben Seite erhöhen.'
      );
    }

    const inc = side === 'ja' ? { totalJa: amount } : { totalNein: amount };
    if (!existing) inc.participants = 1;
    const bet = await Bet.findOneAndUpdate(
      { _id: betId, status: 'offen', deadline: { $gt: new Date() } },
      { $inc: inc },
      { new: true, session }
    );
    if (!bet) throw new UserError('Diese Wette nimmt keine Einsätze mehr an.');

    await debit(user._id, amount, session);

    if (existing) {
      await Position.updateOne({ _id: existing._id }, { $inc: { amount } }, { session });
    } else {
      await Position.create([{ bet: bet._id, user: user._id, username: user.username, side, amount }], { session });
    }
    await Ledger.create([{ user: user._id, type: 'einsatz', amount: -amount, bet: bet._id, betTitle: bet.title }], {
      session,
    });
    return bet;
  });
}

/** Einsatzschluss vorziehen (sofort schließen). */
async function closeBet({ actor, betId }) {
  const bet = await Bet.findById(betId);
  if (!bet) throw new UserError('Wette nicht gefunden.');
  const isOwner = String(bet.creator) === String(actor._id);
  if (!isOwner && !actor.isAdmin) throw new UserError('Nur der Ersteller oder ein Admin darf das.');
  const res = await Bet.updateOne(
    { _id: betId, status: 'offen', deadline: { $gt: new Date() } },
    { $set: { deadline: new Date() } }
  );
  if (res.modifiedCount !== 1) throw new UserError('Der Einsatzschluss ist bereits erreicht.');
}

/**
 * Wette abschließen und auszahlen.
 * outcome: 'ja' | 'nein' | 'annulliert'
 */
async function resolveBet({ actor, betId, outcome, reason = null }) {
  if (!['ja', 'nein', 'annulliert'].includes(outcome)) throw new UserError('Ungültiges Ergebnis.');

  return inTransaction(async (session) => {
    const now = new Date();
    const bet = await Bet.findById(betId).session(session);
    if (!bet) throw new UserError('Wette nicht gefunden.');
    if (bet.status !== 'offen') throw new UserError('Diese Wette ist bereits abgeschlossen.');

    const isAdmin = actor.system || actor.isAdmin;
    const isOwner = !actor.system && String(bet.creator) === String(actor._id);
    if (!isOwner && !isAdmin) throw new UserError('Nur der Ersteller oder ein Admin kann diese Wette abschließen.');
    if (outcome !== 'annulliert' && !isAdmin && bet.deadline > now) {
      throw new UserError('Das Ergebnis kann erst nach dem Einsatzschluss festgelegt werden.');
    }

    const positions = await Position.find({ bet: bet._id }).sort({ createdAt: 1, _id: 1 }).session(session).lean();
    const { payouts, refunded } = computePayouts(
      positions.map((p) => ({ id: String(p._id), side: p.side, amount: p.amount })),
      outcome
    );

    const updated = await Bet.updateOne(
      { _id: bet._id, status: 'offen' },
      {
        $set: {
          status: outcome === 'annulliert' ? 'annulliert' : 'entschieden',
          outcome: outcome === 'annulliert' ? null : outcome,
          resolvedAt: now,
          resolvedBy: actor.system ? null : actor._id,
          resolvedByName: actor.username,
          voidReason: outcome === 'annulliert' ? (reason || '').slice(0, 300) || null : null,
          refunded,
        },
      },
      { session }
    );
    if (updated.modifiedCount !== 1) throw new UserError('Diese Wette ist bereits abgeschlossen.');

    const userOps = [];
    const positionOps = [];
    const ledgerDocs = [];
    let paidTotal = 0;
    let winnerCount = 0;

    for (const p of positions) {
      const payout = payouts.get(String(p._id)) || 0;
      positionOps.push({
        updateOne: { filter: { _id: p._id }, update: { $set: { payout, settledAt: now } } },
      });
      if (payout > 0) {
        userOps.push({ updateOne: { filter: { _id: p.user }, update: { $inc: { balance: payout } } } });
        ledgerDocs.push({
          user: p.user,
          type: refunded ? 'erstattung' : 'auszahlung',
          amount: payout,
          bet: bet._id,
          betTitle: bet.title,
        });
        paidTotal += payout;
        winnerCount++;
      }
    }

    if (positionOps.length) await Position.bulkWrite(positionOps, { session });
    if (userOps.length) await User.bulkWrite(userOps, { session });
    if (ledgerDocs.length) await Ledger.insertMany(ledgerDocs, { session });

    return { refunded, paidTotal, winnerCount, outcome };
  });
}

module.exports = { SYSTEM_ACTOR, registerUser, createBet, placeStake, closeBet, resolveBet };

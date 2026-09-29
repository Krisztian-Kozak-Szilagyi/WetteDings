const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../config');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const { computePayouts } = require('../lib/payout');
const { UserError } = require('../lib/util');
const { redeemCode } = require('./codeService');

const SYSTEM_ACTOR = { system: true, username: 'System' };
const NOTE_MIN = 5;
const NOTE_MAX = 500;
const MAX_EDITS = 50;

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

const isOwnerOf = (bet, actor) => !actor.system && String(bet.creator) === String(actor._id);

/**
 * Registrierung – nur mit gültigem Registrierungscode. Code-Einlösung und Konto-Erstellung
 * passieren in einer Transaktion: scheitert eins davon, bleibt der Code gültig.
 */
async function registerUser({ username, email, password, code }) {
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
    const redeemed = await redeemCode(code, user, session);
    if (!redeemed) {
      throw new UserError('Der Registrierungscode ist ungültig, abgelaufen oder wurde bereits verwendet.');
    }
    await Ledger.create([{ user: user._id, type: 'startguthaben', amount: config.startBalance }], { session });
    return user;
  });
}

/**
 * Neue Wette. options: [{ key, label }] (bei Ja/Nein: ja + nein).
 * Der Ersteller setzt nicht mit, sondern erhält bei Entscheidung eine Provision vom Topf.
 * Die Optionen sind danach fest – es gibt bewusst keine Funktion zum Hinzufügen.
 */
async function createBet({ user, title, description, type, options, deadline, resultAt }) {
  return Bet.create({
    title,
    description,
    type,
    options: options.map((o) => ({ key: o.key, label: o.label, total: 0 })),
    creator: user._id,
    creatorName: user.username,
    creatorFeePercent: config.creatorFeePercent,
    deadline,
    resultAt,
    participants: 0,
  });
}

async function placeStake({ user, betId, side, amount }) {
  return inTransaction(async (session) => {
    const current = await Bet.findById(betId).session(session);
    if (!current) throw new UserError('Wette nicht gefunden.');
    // Neue Regel: Wettersteller dürfen an ihrer eigenen Wette nicht teilnehmen
    if (isOwnerOf(current, user)) {
      throw new UserError('Als Wettersteller kannst du nicht auf deine eigene Wette setzen – du erhältst dafür eine Provision vom Topf.');
    }
    if (!current.options.some((o) => o.key === side)) throw new UserError('Bitte wähle eine gültige Option.');

    const existing = await Position.findOne({ bet: betId, user: user._id }).session(session);
    if (existing && existing.side !== side) {
      const label = (current.options.find((o) => o.key === existing.side) || { label: '?' }).label;
      throw new UserError(
        `Du hast in dieser Wette bereits auf „${label}“ gesetzt. ` +
          'Du kannst deinen Einsatz nur auf derselben Option erhöhen.'
      );
    }

    const inc = { 'options.$.total': amount };
    if (!existing) inc.participants = 1;
    const bet = await Bet.findOneAndUpdate(
      { _id: betId, status: 'offen', deadline: { $gt: new Date() }, 'options.key': side },
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
  if (!isOwnerOf(bet, actor) && !actor.isAdmin) throw new UserError('Nur der Ersteller oder ein Admin darf das.');
  const res = await Bet.updateOne(
    { _id: betId, status: 'offen', deadline: { $gt: new Date() } },
    { $set: { deadline: new Date() } }
  );
  if (res.modifiedCount !== 1) throw new UserError('Der Einsatzschluss ist bereits erreicht.');
}

/**
 * Beschreibung (Ersteller oder Admin, solange die Wette offen ist) und Titel (nur Admin) ändern.
 * Jede Änderung wird im Verlauf festgehalten.
 */
async function editBet({ actor, betId, title, description }) {
  const bet = await Bet.findById(betId);
  if (!bet) throw new UserError('Wette nicht gefunden.');
  const isAdmin = !!actor.isAdmin;
  if (!isOwnerOf(bet, actor) && !isAdmin) throw new UserError('Nur der Ersteller oder ein Admin darf diese Wette bearbeiten.');
  if (bet.status !== 'offen' && !isAdmin) throw new UserError('Abgeschlossene Wetten können nur noch von Admins bearbeitet werden.');

  const now = new Date();
  const edits = [];
  if (title !== undefined && title !== bet.title) {
    if (!isAdmin) throw new UserError('Den Titel kann nur ein Admin ändern. Bitte wende dich an einen Admin.');
    edits.push({ at: now, byName: actor.username, field: 'title', oldValue: bet.title, newValue: title });
    bet.title = title;
  }
  if (description !== undefined && description !== bet.description) {
    edits.push({ at: now, byName: actor.username, field: 'description', oldValue: bet.description, newValue: description });
    bet.description = description;
  }
  if (!edits.length) return { changed: false, bet };

  bet.edits = [...bet.edits, ...edits].slice(-MAX_EDITS);
  await bet.save();
  return { changed: true, bet };
}

/**
 * Wette abschließen und auszahlen.
 * outcome: key der eingetretenen Option oder 'annulliert'.
 * note: Pflicht-Begründung (bei Entscheidung und Annullierung), damit das Ergebnis nachvollziehbar bleibt.
 * Der Ersteller (und Admins) dürfen jederzeit entscheiden – die Wette wird dabei sofort geschlossen.
 */
async function resolveBet({ actor, betId, outcome, note }) {
  const text = String(note || '').trim().replace(/\r\n/g, '\n');
  if (text.length < NOTE_MIN) {
    throw new UserError(`Bitte begründe das Ergebnis (mindestens ${NOTE_MIN} Zeichen), damit es später nachvollziehbar ist.`);
  }
  if (text.length > NOTE_MAX) throw new UserError(`Die Begründung darf höchstens ${NOTE_MAX} Zeichen lang sein.`);

  return inTransaction(async (session) => {
    const now = new Date();
    const bet = await Bet.findById(betId).session(session);
    if (!bet) throw new UserError('Wette nicht gefunden.');
    if (bet.status !== 'offen') throw new UserError('Diese Wette ist bereits abgeschlossen.');

    const isAdmin = actor.system || actor.isAdmin;
    if (!isOwnerOf(bet, actor) && !isAdmin) throw new UserError('Nur der Ersteller oder ein Admin kann diese Wette abschließen.');
    const winner = bet.options.find((o) => o.key === outcome);
    if (outcome !== 'annulliert' && !winner) throw new UserError('Ungültiges Ergebnis.');

    const positions = await Position.find({ bet: bet._id }).sort({ createdAt: 1, _id: 1 }).session(session).lean();
    const { payouts, refunded, fee } = computePayouts(
      positions.map((p) => ({ id: String(p._id), side: p.side, amount: p.amount })),
      outcome,
      bet.creatorFeePercent || 0
    );

    const updated = await Bet.updateOne(
      { _id: bet._id, status: 'offen' },
      {
        $set: {
          status: outcome === 'annulliert' ? 'annulliert' : 'entschieden',
          outcome: outcome === 'annulliert' ? null : outcome,
          resolvedAt: now,
          // Falls vor dem Einsatzschluss entschieden wurde, gilt die Wette ab jetzt als geschlossen
          deadline: bet.deadline > now ? now : bet.deadline,
          resolvedBy: actor.system ? null : actor._id,
          resolvedByName: actor.username,
          resolutionNote: text,
          voidReason: outcome === 'annulliert' ? text.slice(0, 300) : null,
          refunded,
          creatorFee: fee,
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

    if (fee > 0) {
      userOps.push({ updateOne: { filter: { _id: bet.creator }, update: { $inc: { balance: fee } } } });
      ledgerDocs.push({ user: bet.creator, type: 'provision', amount: fee, bet: bet._id, betTitle: bet.title });
    }

    if (positionOps.length) await Position.bulkWrite(positionOps, { session });
    if (userOps.length) await User.bulkWrite(userOps, { session });
    if (ledgerDocs.length) await Ledger.insertMany(ledgerDocs, { session });

    return { refunded, paidTotal, winnerCount, fee, outcome, label: winner ? winner.label : null };
  });
}

module.exports = { SYSTEM_ACTOR, NOTE_MIN, NOTE_MAX, inTransaction, registerUser, createBet, placeStake, closeBet, editBet, resolveBet };

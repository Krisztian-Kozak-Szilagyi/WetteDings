const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../config');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const { computePayouts, splitFee } = require('../lib/payout');
const { verdictRole, evaluateVotes } = require('../lib/verdict');
const { UserError } = require('../lib/util');
const { redeemCode } = require('./codeService');
const { assertUsernameAllowed } = require('./usernameRules');

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
const isRefereeOf = (bet, actor) => !actor.system && !!bet.referee && String(bet.referee) === String(actor._id);

/**
 * Registrierung – nur mit gültigem Registrierungscode. Code-Einlösung und Konto-Erstellung
 * passieren in einer Transaktion: scheitert eins davon, bleibt der Code gültig.
 * Der Benutzername wird hier verbindlich geprüft (reservierte Namen tragen Rechte, siehe
 * services/usernameRules) – unabhängig davon, was die aufrufende Route schon geprüft hat.
 */
async function registerUser({ username, email, password, code }) {
  const name = assertUsernameAllowed(username);
  const passwordHash = await bcrypt.hash(password, 12);
  return inTransaction(async (session) => {
    const [user] = await User.create(
      [
        {
          username: name,
          usernameLower: name.toLowerCase(),
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
 * Ersteller und Schiedsrichter setzen nicht mit, sondern teilen sich bei Entscheidung die Provision.
 * Die Optionen sind danach fest – es gibt bewusst keine Funktion zum Hinzufügen.
 * referee: Mitglied ({ _id, username }), das das Ergebnis gemeinsam mit dem Ersteller bestätigt.
 */
async function createBet({ user, title, description, type, options, deadline, resultAt, referee, group = null }) {
  if (!referee) throw new UserError('Bitte wähle einen Schiedsrichter für diese Wette aus.');
  if (String(referee._id) === String(user._id)) throw new UserError('Du kannst nicht selbst Schiedsrichter deiner Wette sein.');
  return Bet.create({
    title,
    description,
    type,
    options: options.map((o) => ({ key: o.key, label: o.label, total: 0 })),
    creator: user._id,
    creatorName: user.username,
    referee: referee._id,
    refereeName: referee.username,
    group: group ? group._id : null, // Gruppen-Wette: nur für Mitglieder sichtbar
    groupName: group ? group.name : null,
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
    // Der Schiedsrichter entscheidet mit über den Ausgang und darf deshalb kein eigenes Interesse haben
    if (isRefereeOf(current, user)) {
      throw new UserError('Als Schiedsrichter dieser Wette kannst du nicht mitsetzen – du bestätigst am Ende das Ergebnis.');
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
  if (!isOwnerOf(bet, actor) && !isRefereeOf(bet, actor) && !actor.isAdmin && !actor.isDev) {
    throw new UserError('Nur der Ersteller, der Schiedsrichter oder ein Admin darf das.');
  }
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
 * Schließt die Wette ab und zahlt aus. Rechte und Stimmen sind an dieser Stelle bereits geprüft;
 * der Aufruf passiert immer innerhalb der Transaktion von resolveBet.
 * via: wie das Ergebnis zustande kam ('einstimmig' | 'dev' | 'ersteller' | 'system').
 */
async function payOut({ session, bet, outcome, note, actor, votes, via, now }) {
  const winner = bet.options.find((o) => o.key === outcome) || null;
  const positions = await Position.find({ bet: bet._id }).sort({ createdAt: 1, _id: 1 }).session(session).lean();
  const { payouts, refunded, fee } = computePayouts(
    positions.map((p) => ({ id: String(p._id), side: p.side, amount: p.amount })),
    outcome,
    bet.creatorFeePercent || 0
  );

  // Provision tragen Wettersteller und Schiedsrichter gemeinsam – je die Hälfte
  const feeShare = splitFee(fee, !!bet.referee);

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
        resolvedVia: via,
        resolutionNote: note,
        voidReason: outcome === 'annulliert' ? note.slice(0, 300) : null,
        refunded,
        creatorFee: feeShare.creator,
        refereeFee: feeShare.referee,
        votes,
        disputed: false,
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

  if (feeShare.creator > 0) {
    userOps.push({ updateOne: { filter: { _id: bet.creator }, update: { $inc: { balance: feeShare.creator } } } });
    ledgerDocs.push({ user: bet.creator, type: 'provision', amount: feeShare.creator, bet: bet._id, betTitle: bet.title });
  }
  if (feeShare.referee > 0) {
    userOps.push({ updateOne: { filter: { _id: bet.referee }, update: { $inc: { balance: feeShare.referee } } } });
    ledgerDocs.push({ user: bet.referee, type: 'provision_schiri', amount: feeShare.referee, bet: bet._id, betTitle: bet.title });
  }

  if (positionOps.length) await Position.bulkWrite(positionOps, { session });
  if (userOps.length) await User.bulkWrite(userOps, { session });
  if (ledgerDocs.length) await Ledger.insertMany(ledgerDocs, { session });

  return {
    kind: 'entschieden',
    via,
    refunded,
    paidTotal,
    winnerCount,
    fee,
    creatorFee: feeShare.creator,
    refereeFee: feeShare.referee,
    outcome,
    label: winner ? winner.label : null,
  };
}

/**
 * Stimme zum Ausgang abgeben – und abschließen, sobald das Ergebnis feststeht.
 * outcome: key der eingetretenen Option oder 'annulliert'.
 * note: Pflicht-Begründung, damit jede Stimme nachvollziehbar bleibt.
 *
 * Wettersteller und Schiedsrichter müssen sich einig sein; die zweite, übereinstimmende Stimme
 * zahlt aus. Weichen die Stimmen ab, ist die Wette strittig und ein Dev gibt die entscheidende
 * Stimme ab (Dev-Panel → Streitfälle). Eine abgegebene Stimme kann bis zum Abschluss geändert
 * werden – stimmt sie dann mit der anderen überein, löst sich der Streitfall von selbst.
 *
 * Rückgabe: { kind: 'entschieden' | 'offen' | 'streitig', … }
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

    const role = verdictRole(bet, actor);
    if (!role) throw new UserError('Nur der Wettersteller, der Schiedsrichter oder ein Dev kann diese Wette abschließen.');
    const winner = bet.options.find((o) => o.key === outcome) || null;
    if (outcome !== 'annulliert' && !winner) throw new UserError('Ungültiges Ergebnis.');

    const vote = { role, by: actor.system ? null : actor._id, byName: actor.username, outcome, note: text, at: now };
    // Je Rolle zählt nur die letzte Stimme
    const votes = [...(bet.toObject().votes || []).filter((v) => v.role !== role), vote];
    const hasReferee = !!bet.referee;

    // Das System (automatische Annullierung) und Devs entscheiden sofort – Devs lösen damit Streitfälle.
    if (role === 'system' || role === 'dev') {
      return payOut({ session, bet, outcome, note: text, actor, votes, via: role, now });
    }

    const verdict = evaluateVotes(votes, { hasReferee });
    if (verdict.decided) {
      const via = hasReferee ? 'einstimmig' : 'ersteller';
      return payOut({ session, bet, outcome: verdict.outcome, note: text, actor, votes, via, now });
    }

    // Noch keine Einigung: Stimme festhalten. Die erste Stimme beendet sofort die Einsatzphase, damit
    // niemand mit dem Wissen um eine bereits abgegebene Stimme noch setzen kann.
    const updated = await Bet.updateOne(
      { _id: bet._id, status: 'offen' },
      { $set: { votes, disputed: verdict.disputed, deadline: bet.deadline > now ? now : bet.deadline } },
      { session }
    );
    if (updated.modifiedCount !== 1) throw new UserError('Diese Wette ist bereits abgeschlossen.');

    return {
      kind: verdict.disputed ? 'streitig' : 'offen',
      role,
      outcome,
      label: winner ? winner.label : null,
      // Wer jetzt am Zug ist bzw. anders gestimmt hat
      other: role === 'creator' ? bet.refereeName : bet.creatorName,
    };
  });
}

/**
 * Wette vollständig löschen (nur Admin/Dev): Sie verschwindet überall, auch aus dem Archiv.
 * Ist sie noch offen, gehen vorher alle Einsätze zurück (wie bei einer Annullierung). Bei einer bereits
 * abgeschlossenen Wette bleiben die Auszahlungen bestehen; es wird nur der Eintrag entfernt.
 * Buchungen im Kontoauszug bleiben erhalten (ohne Link auf die Wette).
 */
async function deleteBet({ actor, betId }) {
  if (!actor.isAdmin && !actor.isDev) throw new UserError('Nur Admin und Devs können Wetten löschen.');
  const bet = await Bet.findById(betId).select('title status').lean();
  if (!bet) throw new UserError('Wette nicht gefunden.');
  const wasOpen = bet.status === 'offen';
  if (wasOpen) await resolveBet({ actor: SYSTEM_ACTOR, betId, outcome: 'annulliert', note: `Gelöscht von ${actor.username} – alle Einsätze wurden erstattet.` });
  await inTransaction(async (session) => {
    await Position.deleteMany({ bet: betId }, { session });
    await require('../models/Comment').deleteMany({ bet: betId }, { session });
    await Ledger.updateMany({ bet: betId }, { $set: { bet: null } }, { session });
    await Bet.deleteOne({ _id: betId }, { session });
  });
  // Titel ohne Zeilenumbrüche ins Protokoll (er stammt von Nutzern)
  const logTitle = String(bet.title).replace(/[\r\n]+/g, ' ');
  console.log(`Wette "${logTitle}" (${betId}) gelöscht von ${actor.username}${wasOpen ? ' – Einsätze erstattet' : ''}.`);
  return { title: bet.title, refunded: wasOpen };
}

/** Offene Streitfälle (Ersteller und Schiedsrichter uneinig) – Abzeichen und Liste im Dev-Panel */
const disputedFilter = () => ({ status: 'offen', disputed: true });
const disputedCount = () => Bet.countDocuments(disputedFilter());

/**
 * Wetten, in denen die andere Seite schon abgestimmt hat und ich noch nicht –
 * ich bin also am Zug (Abzeichen am Menüpunkt „Wetten“).
 */
function pendingVoteFilter(userId) {
  return {
    status: 'offen',
    disputed: false,
    'votes.0': { $exists: true }, // mindestens eine Stimme liegt vor
    $or: [
      { creator: userId, votes: { $not: { $elemMatch: { role: 'creator' } } } },
      { referee: userId, votes: { $not: { $elemMatch: { role: 'referee' } } } },
    ],
  };
}
const pendingVoteCount = (userId) => Bet.countDocuments(pendingVoteFilter(userId));

module.exports = {
  SYSTEM_ACTOR,
  NOTE_MIN,
  NOTE_MAX,
  inTransaction,
  registerUser,
  createBet,
  placeStake,
  closeBet,
  editBet,
  resolveBet,
  deleteBet,
  disputedFilter,
  disputedCount,
  pendingVoteFilter,
  pendingVoteCount,
};

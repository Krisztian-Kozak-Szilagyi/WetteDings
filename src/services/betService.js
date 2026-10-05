const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../config');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const { computePayouts, computeDuelPayouts, splitFee } = require('../lib/payout');
const { TcgCard } = require('../models/Tcg');
const catalog = require('../tcg/catalog');
const { verdictRole, devMayDecide, evaluateVotes } = require('../lib/verdict');
const { UserError } = require('../lib/util');
const { redeemCode } = require('./codeService');
const { assertUsernameAllowed } = require('./usernameRules');
const notifyService = require('./notifyService');
const { euro } = require('../lib/viewHelpers');

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
    await User.updateOne({ _id: user._id }, { $set: { registrationCode: redeemed.code, invitedByName: redeemed.createdByName } }, { session });
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
    // Duell: die beiden Beteiligten setzen beim Herausfordern bzw. Annehmen; Zuschauer setzen, sobald das Duell
    // läuft, auf einen der beiden – in einem eigenen Topf (siehe payOut)
    if (current.duel) {
      if (String(current.creator) === String(user._id) || String(current.duel.opponent) === String(user._id)) {
        throw new UserError('Du bist an diesem Duell beteiligt – dein Einsatz steht schon fest.');
      }
      if (current.duel.state !== 'aktiv') throw new UserError('Mitwetten geht erst, wenn das Duell begonnen hat.');
    }
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
  const rows = positions.map((p) => ({ id: String(p._id), user: p.user, side: p.side, amount: p.amount }));
  // Duell: Beteiligte und Zuschauer haben getrennte Töpfe (#67); sonst ein gemeinsamer Topf
  const duelPay = bet.duel ? computeDuelPayouts(rows, outcome, bet.creatorFeePercent || 0, [bet.creator, bet.duel.opponent]) : null;
  const { payouts, fee, refunded: baseRefunded } = duelPay || computePayouts(rows, outcome, bet.creatorFeePercent || 0);
  // Duell: Karten wechseln nur bei einem echten Ergebnis den Besitzer – dann gilt es nicht als "alles erstattet"
  const cardsMove = !!bet.duel && outcome !== 'annulliert' && !!winner && (bet.duel.cards || []).length > 0;
  const refunded = duelPay ? duelPay.refunded && !cardsMove : baseRefunded;
  const refundedIds = duelPay ? duelPay.refundedIds : refunded ? new Set(rows.map((r) => r.id)) : new Set();

  // Provision tragen Wettersteller und Schiedsrichter gemeinsam – je die Hälfte
  const feeShare = splitFee(fee, !!bet.referee, { duel: !!bet.duel });

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

  // Gelöschte Konten bekommen nichts mehr gutgeschrieben: Ihr Anteil verfällt und verlässt die Wirtschaft
  // (an der Position bleibt er vermerkt). Sonst sammelte sich Guthaben auf Konten, die niemand mehr nutzen kann.
  const recipients = [...positions.map((p) => p.user), bet.creator, bet.referee].filter(Boolean);
  const goneDocs = await User.find({ _id: { $in: recipients }, deletedAt: { $ne: null } }).select('_id').session(session).lean();
  const gone = new Set(goneDocs.map((u) => String(u._id)));
  const isGone = (id) => gone.has(String(id));

  const userOps = [];
  const positionOps = [];
  const ledgerDocs = [];
  let paidTotal = 0;
  let winnerCount = 0;
  let forfeited = 0;

  for (const p of positions) {
    const payout = payouts.get(String(p._id)) || 0;
    positionOps.push({
      updateOne: { filter: { _id: p._id }, update: { $set: { payout, settledAt: now } } },
    });
    if (payout > 0 && isGone(p.user)) {
      forfeited += payout;
    } else if (payout > 0) {
      userOps.push({ updateOne: { filter: { _id: p.user }, update: { $inc: { balance: payout } } } });
      ledgerDocs.push({
        user: p.user,
        type: refundedIds.has(String(p._id)) ? 'erstattung' : 'auszahlung', // Duell: je Topf
        amount: payout,
        bet: bet._id,
        betTitle: bet.title,
      });
      paidTotal += payout;
      winnerCount++;
    }
  }

  if (feeShare.creator > 0 && isGone(bet.creator)) forfeited += feeShare.creator;
  else if (feeShare.creator > 0) {
    userOps.push({ updateOne: { filter: { _id: bet.creator }, update: { $inc: { balance: feeShare.creator } } } });
    ledgerDocs.push({ user: bet.creator, type: 'provision', amount: feeShare.creator, bet: bet._id, betTitle: bet.title });
  }
  if (feeShare.referee > 0 && isGone(bet.referee)) forfeited += feeShare.referee;
  else if (feeShare.referee > 0) {
    userOps.push({ updateOne: { filter: { _id: bet.referee }, update: { $inc: { balance: feeShare.referee } } } });
    ledgerDocs.push({ user: bet.referee, type: 'provision_schiri', amount: feeShare.referee, bet: bet._id, betTitle: bet.title });
  }

  if (positionOps.length) await Position.bulkWrite(positionOps, { session });

  // Duell mit Karten: Die Karte des Verlierers geht an den Gewinner (beide waren bis jetzt gesperrt).
  // Bei Annullierung bleibt jede Karte, wo sie ist – die Sperre endet mit dem Abschluss.
  let cardsWon = null;
  if (cardsMove) {
    const winnerId = outcome === 'o1' ? bet.creator : bet.duel.opponent;
    const lost = bet.duel.cards.filter((c) => c.side !== outcome);
    if (!isGone(winnerId)) {
      for (const c of lost) {
        const moved = await TcgCard.updateOne({ _id: c.doc, user: c.user }, { $set: { user: winnerId } }, { session });
        if (moved.modifiedCount !== 1) throw new UserError('Eine der eingesetzten Karten ist nicht mehr da. Bitte wende dich an einen Admin.');
      }
      await User.updateOne({ _id: winnerId }, { $addToSet: { tcgSeen: { $each: lost.map((c) => c.card) } } }, { session });
    }
    cardsWon = { winner: winnerId, cards: bet.duel.cards };
  }
  const notes = resultNotes({ bet, positions, payouts, refunded, refundedIds, outcome, label: winner ? winner.label : null, note, actor, feeShare, isGone, cardsWon });
  if (userOps.length) await User.bulkWrite(userOps, { session });
  if (ledgerDocs.length) await Ledger.insertMany(ledgerDocs, { session });

  return {
    kind: 'entschieden',
    via,
    refunded,
    paidTotal,
    winnerCount,
    forfeited,
    fee,
    creatorFee: feeShare.creator,
    refereeFee: feeShare.referee,
    outcome,
    label: winner ? winner.label : null,
    notes, // Benachrichtigungen – resolveBet verschickt sie nach der Transaktion
  };
}

/**
 * Benachrichtigungen zum Ergebnis: jeder Mitwettende (Gewinn, Verlust oder Erstattung), dazu Wettersteller und
 * Schiedsrichter ohne eigenen Einsatz. Wer entschieden hat und gelöschte Konten bekommen nichts.
 */
function resultNotes({ bet, positions, payouts, refunded, refundedIds = new Set(), outcome, label, note, actor, feeShare, isGone, cardsWon = null }) {
  const title = notifyService.short(bet.title);
  const actorId = actor && !actor.system ? String(actor._id) : null;
  const skip = (id) => !id || String(id) === actorId || isGone(id);
  const per = new Map(); // je Mitglied: Einsatz und Auszahlung (man kann mehrfach setzen)
  for (const p of positions) {
    const e = per.get(String(p.user)) || { user: p.user, stake: 0, payout: 0, refunded: true };
    e.stake += p.amount;
    e.payout += payouts.get(String(p._id)) || 0;
    if (!refundedIds.has(String(p._id))) e.refunded = false;
    per.set(String(p.user), e);
  }
  // Duell mit Karten: welche Karten jemand gewinnt bzw. verliert
  const cardNames = (list) => list.map((c) => `„${(catalog.cardById[c.card] || { name: c.card }).name}“`).join(' und ');
  const cardText = (userId) => {
    if (!cardsWon) return '';
    const mine = cardsWon.cards.filter((c) => String(c.user) === String(userId));
    if (String(cardsWon.winner) === String(userId)) return ` Dazu bekommst du die Karte ${cardNames(cardsWon.cards.filter((c) => String(c.user) !== String(userId)))}.`;
    return mine.length ? ` Deine Karte ${cardNames(mine)} geht an den Gewinner.` : '';
  };
  const notes = [];
  for (const e of per.values()) {
    if (skip(e.user)) continue;
    let text;
    const isParty = !!bet.duel && [String(bet.creator), String(bet.duel.opponent)].includes(String(e.user));
    if (isParty && cardsWon && outcome !== 'annulliert') {
      // Beteiligte im Kartenduell: Ergebnis mit Karten (Geld kann 0 sein)
      const won = String(cardsWon.winner) === String(e.user);
      text = won
        ? `Gewonnen! „${title}“ endete mit „${label}“${e.payout > 0 ? ` – du bekommst ${euro(e.payout)}` : ''}.${cardText(e.user)}`
        : `Verloren: „${title}“ endete mit „${label}“${e.stake > 0 ? ` (Einsatz ${euro(e.stake)})` : ''}.${cardText(e.user)}`;
      notes.push({ user: e.user, text });
      continue;
    }
    if (outcome === 'annulliert') {
      text = bet.duel
        ? `Duell „${title}“: ${note} Dein Einsatz von ${euro(e.stake)} wurde erstattet.`
        : `Die Wette „${title}“ wurde annulliert – dein Einsatz von ${euro(e.stake)} wurde erstattet.`;
    } else if (refunded || (bet.duel && e.refunded)) {
      text = `„${title}“ endete mit „${label}“, aber ohne Gegenseite – dein Einsatz von ${euro(e.stake)} wurde erstattet.`;
    } else if (e.payout > 0) {
      text = `Gewonnen! „${title}“ endete mit „${label}“ – du bekommst ${euro(e.payout)}.`;
    } else {
      text = `Verloren: „${title}“ endete mit „${label}“ (Einsatz ${euro(e.stake)}).`;
    }
    notes.push({ user: e.user, text });
  }
  // Wettersteller und Schiedsrichter ohne eigenen Einsatz
  for (const [id, fee] of [[bet.creator, feeShare.creator], [bet.referee, feeShare.referee]]) {
    if (skip(id) || per.has(String(id)) || notes.some((n) => String(n.user) === String(id))) continue;
    const base = outcome === 'annulliert' ? `Die Wette „${title}“ wurde annulliert.` : `Die Wette „${title}“ ist entschieden: „${label}“.`;
    notes.push({ user: id, text: fee > 0 ? `${base} Deine Provision: ${euro(fee)}.` : base });
  }
  return notes;
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
async function resolveBet({ actor, betId, outcome, note, quietFor = null }) {
  const text = String(note || '').trim().replace(/\r\n/g, '\n');
  if (text.length < NOTE_MIN) {
    throw new UserError(`Bitte begründe das Ergebnis (mindestens ${NOTE_MIN} Zeichen), damit es später nachvollziehbar ist.`);
  }
  if (text.length > NOTE_MAX) throw new UserError(`Die Begründung darf höchstens ${NOTE_MAX} Zeichen lang sein.`);

  const result = await inTransaction(async (session) => {
    const now = new Date();
    const bet = await Bet.findById(betId).session(session);
    if (!bet) throw new UserError('Wette nicht gefunden.');
    if (bet.status !== 'offen') throw new UserError('Diese Wette ist bereits abgeschlossen.');

    const role = verdictRole(bet, actor);
    if (bet.duel && role !== 'system') {
      // Duell: die beiden Beteiligten entscheiden nie mit – auch nicht als Dev
      const id = String(actor._id);
      if (id === String(bet.creator) || id === String(bet.duel.opponent)) throw new UserError('Im Duell entscheidet allein der Schiedsrichter.');
      if (bet.duel.state !== 'aktiv') throw new UserError('Das Duell hat noch nicht begonnen – es fehlt noch eine Zusage.');
    }
    if (!role) throw new UserError('Nur der Wettersteller, der Schiedsrichter oder ein Dev kann diese Wette abschließen.');
    const winner = bet.options.find((o) => o.key === outcome) || null;
    if (outcome !== 'annulliert' && !winner) throw new UserError('Ungültiges Ergebnis.');
    if (role === 'dev' && !devMayDecide(bet, outcome, now)) {
      throw new UserError('Ein Ergebnis kannst du als Dev erst festlegen, wenn die Wette strittig ist oder der Auswertungstermin vorbei ist. Annullieren geht jederzeit.');
    }

    const vote = { role, by: actor.system ? null : actor._id, byName: actor.username, outcome, note: text, at: now };
    // Je Rolle zählt nur die letzte Stimme
    const votes = [...(bet.toObject().votes || []).filter((v) => v.role !== role), vote];
    const hasReferee = !!bet.referee;

    // Das System (automatische Annullierung) und Devs entscheiden sofort – Devs lösen damit Streitfälle
    // oder liegengebliebene Wetten (wann sie dürfen: devMayDecide).
    if (role === 'system' || role === 'dev') {
      return payOut({ session, bet, outcome, note: text, actor, votes, via: role, now });
    }
    // Duell: der Schiedsrichter entscheidet allein
    if (bet.duel) return payOut({ session, bet, outcome, note: text, actor, votes, via: 'schiedsrichter', now });

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
  if (result.notes) {
    const href = `/wetten/${betId}`;
    // quietFor: wer die Absage selbst ausgelöst hat (System-Aktion im Namen eines Mitglieds) bekommt keine Meldung
    await Promise.all(result.notes.filter((n) => !quietFor || String(n.user) !== String(quietFor)).map((n) => notifyService.notify(n.user, { area: 'Wetten', href, text: n.text })));
    delete result.notes;
  }
  return result;
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
  // Benachrichtigungen zeigen nicht mehr auf die gelöschte Wette, sondern auf den Kontoauszug
  await notifyService.retarget(`/wetten/${betId}`, '/konto/auszug');
  // Titel ohne Zeilenumbrüche ins Protokoll (er stammt von Nutzern)
  const logTitle = String(bet.title).replace(/\n|\r/g, ' ');
  const logActor = String(actor.username).replace(/\n|\r/g, ' ');
  const logId = String(betId).replace(/\n|\r/g, '');
  console.log(`Wette "${logTitle}" (${logId}) gelöscht von ${logActor}${wasOpen ? ' – Einsätze erstattet' : ''}.`);
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
    $or: [
      {
        status: 'offen',
        disputed: false,
        duel: null,
        'votes.0': { $exists: true }, // mindestens eine Stimme liegt vor
        $or: [
          { creator: userId, votes: { $not: { $elemMatch: { role: 'creator' } } } },
          { referee: userId, votes: { $not: { $elemMatch: { role: 'referee' } } } },
        ],
      },
      // Duell: der Schiedsrichter ist am Zug, sobald der Termin der Auswertung erreicht ist
      { status: 'offen', 'duel.state': 'aktiv', referee: userId, resultAt: { $lte: new Date() } },
    ],
  };
}

/** Duell-Anfragen, auf die ich noch antworten muss (als Herausgeforderter oder Schiedsrichter) */
function duelInviteFilter(userId) {
  return {
    status: 'offen',
    'duel.state': 'angefragt',
    $or: [
      { 'duel.opponent': userId, 'duel.opponentAcceptedAt': null },
      { referee: userId, 'duel.refereeAcceptedAt': null },
    ],
  };
}

/** Abzeichen am Menüpunkt "Wetten": fehlende Stimmen und offene Duell-Anfragen */
const pendingVoteCount = async (userId) => {
  const [votes, invites] = await Promise.all([Bet.countDocuments(pendingVoteFilter(userId)), Bet.countDocuments(duelInviteFilter(userId))]);
  return votes + invites;
};

/** Sichtbarkeit: Duell-Anfragen sehen nur die drei Beteiligten (Admin/Devs über canSeeBet) */
const hiddenDuelFilter = (userId) => ({ $or: [{ 'duel.state': { $ne: 'angefragt' } }, { creator: userId }, { referee: userId }, { 'duel.opponent': userId }] });

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
  resultNotes,
  deleteBet,
  disputedFilter,
  disputedCount,
  pendingVoteFilter,
  pendingVoteCount,
  duelInviteFilter,
  hiddenDuelFilter,
};

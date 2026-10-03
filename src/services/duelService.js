// Duell (Head-to-Head-Wette): Ein Mitglied fordert ein anderes heraus. Beide setzen denselben Betrag; ein
// Schiedsrichter entscheidet allein und bekommt DUEL_FEE_PERCENT % vom Topf. Die Wette gilt erst, wenn der
// Herausgeforderte UND der Schiedsrichter angenommen haben – lehnt einer ab oder läuft die Frist ab, bekommt
// der Herausforderer seinen Einsatz zurück. Bis dahin sehen sie nur die drei Beteiligten.
const config = require('../config');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const DuelTip = require('../models/DuelTip');
const { UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');
const betService = require('./betService');

const DUEL_FEE_PERCENT = 3;
const INVITE_HOURS = 48; // so lange haben Herausgeforderter und Schiedsrichter Zeit zum Annehmen
const YEAR = 366 * 24 * 60 * 60 * 1000;

/** Herausforderung anlegen; der Einsatz des Herausforderers wird sofort abgebucht */
async function create({ user, opponent, referee, title, description = '', stake, resultAt }) {
  if (!opponent) throw new UserError('Dieses Mitglied gibt es nicht.');
  if (String(opponent._id) === String(user._id)) throw new UserError('Du kannst dich nicht selbst herausfordern.');
  if (!referee) throw new UserError('Bitte wähle einen Schiedsrichter aus.');
  if ([String(user._id), String(opponent._id)].includes(String(referee._id))) throw new UserError('Der Schiedsrichter darf keiner der beiden Beteiligten sein.');
  if (!Number.isInteger(stake) || stake < config.minStake) throw new UserError(`Der Einsatz muss mindestens ${euro(config.minStake)} betragen.`);
  const now = Date.now();
  if (!resultAt || resultAt.getTime() < now + 5 * 60 * 1000) throw new UserError('Der Termin der Auswertung muss mindestens 5 Minuten in der Zukunft liegen.');
  if (resultAt.getTime() > now + YEAR) throw new UserError('Der Termin der Auswertung darf höchstens ein Jahr in der Zukunft liegen.');
  // Frist zum Annehmen: 48 Stunden, aber nicht nach der Auswertung
  const expiresAt = new Date(Math.min(now + INVITE_HOURS * 60 * 60 * 1000, resultAt.getTime()));

  return betService.inTransaction(async (session) => {
    const [bet] = await Bet.create(
      [
        {
          title,
          description,
          type: 'optionen',
          options: [
            { key: 'o1', label: `${user.username} gewinnt`, total: stake },
            { key: 'o2', label: `${opponent.username} gewinnt`, total: 0 },
          ],
          creator: user._id,
          creatorName: user.username,
          referee: referee._id,
          refereeName: referee.username,
          creatorFeePercent: DUEL_FEE_PERCENT,
          deadline: expiresAt, // niemand sonst setzt; beim Start wird der Einsatzschluss auf "jetzt" gesetzt
          resultAt,
          participants: 1,
          duel: { opponent: opponent._id, opponentName: opponent.username, stake, state: 'angefragt', expiresAt },
        },
      ],
      { session }
    );
    const paid = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: stake } }, { $inc: { balance: -stake } }, { new: true, session });
    if (!paid) throw new UserError('Dein Guthaben reicht für diesen Einsatz nicht aus.');
    await Position.create([{ bet: bet._id, user: user._id, username: user.username, side: 'o1', amount: stake }], { session });
    await Ledger.create([{ user: user._id, type: 'einsatz', amount: -stake, bet: bet._id, betTitle: title }], { session });
    return bet;
  });
}

/** Rolle im Duell: 'challenger' | 'opponent' | 'referee' | null */
function duelRole(bet, user) {
  if (!bet.duel || !user) return null;
  const id = String(user._id);
  if (id === String(bet.creator)) return 'challenger';
  if (id === String(bet.duel.opponent)) return 'opponent';
  if (bet.referee && id === String(bet.referee)) return 'referee';
  return null;
}

/** Herausgeforderter oder Schiedsrichter nimmt an. Haben beide angenommen, beginnt das Duell. */
async function accept({ user, betId }) {
  return betService.inTransaction(async (session) => {
    const bet = await Bet.findById(betId).session(session);
    if (!bet || !bet.duel) throw new UserError('Duell nicht gefunden.');
    if (bet.status !== 'offen' || bet.duel.state !== 'angefragt') throw new UserError('Dieses Duell kann nicht mehr angenommen werden.');
    if (bet.duel.expiresAt <= new Date()) throw new UserError('Die Frist zum Annehmen ist abgelaufen.');
    const role = duelRole(bet, user);
    const now = new Date();
    if (role === 'opponent') {
      if (bet.duel.opponentAcceptedAt) throw new UserError('Du hast bereits angenommen.');
      const stake = bet.duel.stake;
      const paid = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: stake } }, { $inc: { balance: -stake } }, { new: true, session });
      if (!paid) throw new UserError(`Dein Guthaben reicht nicht – für dieses Duell brauchst du ${euro(stake)}.`);
      await Position.create([{ bet: bet._id, user: user._id, username: user.username, side: 'o2', amount: stake }], { session });
      await Ledger.create([{ user: user._id, type: 'einsatz', amount: -stake, bet: bet._id, betTitle: bet.title }], { session });
      bet.options.find((o) => o.key === 'o2').total += stake;
      bet.participants = 2;
      bet.duel.opponentAcceptedAt = now;
    } else if (role === 'referee') {
      if (bet.duel.refereeAcceptedAt) throw new UserError('Du hast bereits zugesagt.');
      bet.duel.refereeAcceptedAt = now;
    } else {
      throw new UserError('Annehmen können nur der Herausgeforderte und der Schiedsrichter.');
    }
    const started = !!(bet.duel.opponentAcceptedAt && bet.duel.refereeAcceptedAt);
    if (started) {
      bet.duel.state = 'aktiv';
      bet.deadline = now; // ab jetzt laufen keine Einsätze mehr – es wartet auf das Ergebnis
    }
    await bet.save({ session });
    return { bet, role, started };
  });
}

/** Ablehnen (Herausgeforderter/Schiedsrichter) oder zurückziehen (Herausforderer) – solange noch nicht begonnen */
async function decline({ user, betId }) {
  const bet = await Bet.findById(betId).lean();
  if (!bet || !bet.duel) throw new UserError('Duell nicht gefunden.');
  if (bet.status !== 'offen' || bet.duel.state !== 'angefragt') throw new UserError('Dieses Duell läuft bereits oder ist beendet.');
  const role = duelRole(bet, user);
  if (!role) throw new UserError('Nur die Beteiligten können das Duell absagen.');
  const note =
    role === 'challenger'
      ? `${user.username} hat die Herausforderung zurückgezogen.`
      : `${user.username} hat ${role === 'referee' ? 'das Schiedsrichteramt' : 'die Herausforderung'} abgelehnt.`;
  await betService.resolveBet({ actor: betService.SYSTEM_ACTOR, betId, outcome: 'annulliert', note });
  return { role };
}

/** Anfragen, deren Frist abgelaufen ist: annullieren, Einsätze zurück (läuft regelmäßig) */
async function expirePending(now = new Date()) {
  const stale = await Bet.find({ status: 'offen', 'duel.state': 'angefragt', 'duel.expiresAt': { $lte: now } }).select('_id').limit(100).lean();
  for (const { _id } of stale) {
    try {
      await betService.resolveBet({ actor: betService.SYSTEM_ACTOR, betId: _id, outcome: 'annulliert', note: 'Die Herausforderung wurde nicht rechtzeitig angenommen – Einsätze erstattet.' });
    } catch (err) {
      console.error(`Duell ${_id}: Ablauf fehlgeschlagen:`, err.message);
    }
  }
  return stale.length;
}

/**
 * Zuschauer-Tipp (ohne Einsatz): wer gewinnt das Duell? Nur für Unbeteiligte, solange das Duell läuft und der
 * Termin der Auswertung noch nicht erreicht ist. Ein Tipp lässt sich bis dahin ändern.
 */
async function tip({ user, betId, side }) {
  if (!['o1', 'o2'].includes(side)) throw new UserError('Bitte wähle eine Seite.');
  return betService.inTransaction(async (session) => {
    const bet = await Bet.findById(betId).session(session);
    if (!bet || !bet.duel) throw new UserError('Duell nicht gefunden.');
    if (duelRole(bet, user)) throw new UserError('Als Beteiligter kannst du nicht tippen.');
    if (bet.status !== 'offen' || bet.duel.state !== 'aktiv') throw new UserError('Tippen geht nur, solange das Duell läuft.');
    if (bet.resultAt && bet.resultAt <= new Date()) throw new UserError('Der Termin der Auswertung ist erreicht – Tipps sind nicht mehr möglich.');
    const old = await DuelTip.findOne({ bet: bet._id, user: user._id }).session(session);
    if (old && old.side === side) return { changed: false, side };
    const inc = { [`duel.tips${side === 'o1' ? 'O1' : 'O2'}`]: 1 };
    if (old) {
      inc[`duel.tips${old.side === 'o1' ? 'O1' : 'O2'}`] = -1;
      old.side = side;
      await old.save({ session });
    } else {
      await DuelTip.create([{ bet: bet._id, user: user._id, side }], { session });
    }
    await Bet.updateOne({ _id: bet._id }, { $inc: inc }, { session, timestamps: false });
    return { changed: true, side, switched: !!old };
  });
}

/** Mein Tipp in diesem Duell ('o1' | 'o2' | null) */
async function myTip(betId, userId) {
  const t = await DuelTip.findOne({ bet: betId, user: userId }).select('side').lean();
  return t ? t.side : null;
}

/** Anfragen, auf die ich antworten muss (für den Kasten auf der Wett-Übersicht) */
const invitesFor = (userId) => Bet.find(betService.duelInviteFilter(userId)).sort({ createdAt: -1 }).limit(20).lean();

module.exports = { DUEL_FEE_PERCENT, INVITE_HOURS, create, duelRole, accept, decline, tip, myTip, expirePending, invitesFor };

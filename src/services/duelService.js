// Duell (Head-to-Head-Wette): Ein Mitglied fordert ein anderes heraus. Beide setzen denselben Betrag und/oder je
// eine Karte derselben Seltenheit (mindestens Gold, #67); ein Schiedsrichter entscheidet allein und bekommt
// DUEL_FEE_PERCENT % vom Geld. Die Wette gilt erst, wenn der Herausgeforderte UND der Schiedsrichter angenommen
// haben – lehnt einer ab oder läuft die Frist ab, bekommt der Herausforderer seinen Einsatz zurück. Bis dahin sehen
// sie nur die drei Beteiligten. Läuft das Duell, können Zuschauer bis zur Auswertung auf einen der beiden setzen –
// in einem eigenen Topf (siehe lib/payout → computeDuelPayouts). Der Gewinner bekommt beide Karten.
const config = require('../config');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const { TcgCard } = require('../models/Tcg');
const { UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');
const catalog = require('../tcg/catalog');
const { lockedDocs, isLocked, claim } = require('../tcg/locks');
const betService = require('./betService');
const notifyService = require('./notifyService');

const duelHref = (bet) => `/wetten/${bet._id}`;

const DUEL_FEE_PERCENT = 3;
const INVITE_HOURS = 48; // so lange haben Herausgeforderter und Schiedsrichter Zeit zum Annehmen
const YEAR = 366 * 24 * 60 * 60 * 1000;
const MIN_CARD_RARITY = 'gold'; // Karten als Einsatz: mindestens Gold

/** Darf diese Karte (Katalog) in ein Duell? Mindestens Gold – auch Boss-Karten. */
function cardAllowed(card) {
  const r = card && catalog.rarityByKey[card.rarity];
  return !!r && r.rank >= catalog.rarityByKey[MIN_CARD_RARITY].rank;
}

const cardLabel = (c) => {
  const card = catalog.cardById[c.card];
  const r = catalog.rarityByKey[c.rarity];
  return `${card ? card.name : c.card} (${r ? r.label : c.rarity})`;
};

/** Was steht auf dem Spiel? z. B. "50,00 € und Krisz (Holo)" – für Meldungen */
function stakeText(stake, card) {
  return [stake > 0 ? euro(stake) : null, card ? cardLabel(card) : null].filter(Boolean).join(' und ');
}

/**
 * Karten, die ein Mitglied in ein Duell einsetzen kann: freie (nicht gesperrte, nicht folierte) Exemplare,
 * mindestens Gold – optional nur einer Seltenheit. [{ card, rarity, free }] nach Seltenheit (seltenste zuerst).
 */
async function eligibleCards(userId, rarity = null) {
  const [docs, locked] = await Promise.all([TcgCard.find({ user: userId }).select('_id card rarity').lean(), lockedDocs(userId)]);
  const free = new Map();
  for (const d of docs) {
    const card = catalog.cardById[d.card];
    if (!cardAllowed(card) || isLocked(locked, d) || (rarity && card.rarity !== rarity)) continue;
    free.set(d.card, (free.get(d.card) || 0) + 1);
  }
  return [...free.entries()]
    .map(([id, n]) => ({ card: catalog.cardById[id], rarity: catalog.rarityByKey[catalog.cardById[id].rarity], free: n }))
    .sort((a, b) => b.rarity.rank - a.rarity.rank || a.card.name.localeCompare(b.card.name, 'de'));
}

/** Ein freies Exemplar der Karte innerhalb der Transaktion sperren; gibt den Duell-Eintrag zurück */
async function takeCard({ user, cardId, side, rarity = null, session }) {
  const card = catalog.cardById[cardId];
  if (!card) throw new UserError('Diese Karte gibt es nicht.');
  if (!cardAllowed(card)) throw new UserError('Als Einsatz geht nur eine Karte ab Gold.');
  if (rarity && card.rarity !== rarity) throw new UserError(`Du musst eine Karte derselben Seltenheit setzen (${catalog.rarityByKey[rarity].label}).`);
  const [docs, locked] = await Promise.all([
    TcgCard.find({ user: user._id, card: card.id }).sort({ createdAt: -1 }).select('_id').session(session).lean(),
    lockedDocs(user._id, session),
  ]);
  const doc = docs.find((d) => !isLocked(locked, d));
  if (!doc) throw new UserError(`Du hast kein freies Exemplar von „${card.name}“ (Karten auf Quest, im Handel, im Duell oder foliert gehen nicht).`);
  await claim([doc], user._id, session);
  return { user: user._id, side, doc: doc._id, card: card.id, rarity: card.rarity };
}

/** Geldeinsatz: 0 nur zusammen mit einer Karte, sonst mindestens der Mindesteinsatz */
function checkStake(stake, withCard) {
  if (!Number.isInteger(stake) || stake < 0) throw new UserError('Bitte gib einen gültigen Betrag an.');
  if (stake === 0 && !withCard) throw new UserError('Setze Geld, eine Karte oder beides.');
  if (stake > 0 && stake < config.minStake) throw new UserError(`Der Geldeinsatz muss mindestens ${euro(config.minStake)} betragen (oder 0 € mit einer Karte).`);
}

/** Herausforderung anlegen; Einsatz und Karte des Herausforderers werden sofort reserviert */
async function create({ user, opponent, referee, title, description = '', stake, cardId = null, resultAt }) {
  if (!opponent) throw new UserError('Dieses Mitglied gibt es nicht.');
  if (String(opponent._id) === String(user._id)) throw new UserError('Du kannst dich nicht selbst herausfordern.');
  if (!referee) throw new UserError('Bitte wähle einen Schiedsrichter aus.');
  if ([String(user._id), String(opponent._id)].includes(String(referee._id))) throw new UserError('Der Schiedsrichter darf keiner der beiden Beteiligten sein.');
  checkStake(stake, !!cardId);
  const now = Date.now();
  if (!resultAt || resultAt.getTime() < now + 5 * 60 * 1000) throw new UserError('Der Termin der Auswertung muss mindestens 5 Minuten in der Zukunft liegen.');
  if (resultAt.getTime() > now + YEAR) throw new UserError('Der Termin der Auswertung darf höchstens ein Jahr in der Zukunft liegen.');
  // Frist zum Annehmen: 48 Stunden, aber nicht nach der Auswertung
  const expiresAt = new Date(Math.min(now + INVITE_HOURS * 60 * 60 * 1000, resultAt.getTime()));

  const created = await betService.inTransaction(async (session) => {
    const myCard = cardId ? await takeCard({ user, cardId, side: 'o1', session }) : null;
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
          deadline: expiresAt, // vor dem Start setzt niemand sonst; beim Start: Zuschauer bis zur Auswertung
          resultAt,
          participants: 1,
          duel: { opponent: opponent._id, opponentName: opponent.username, stake, cardRarity: myCard ? myCard.rarity : null, cards: myCard ? [myCard] : [], state: 'angefragt', expiresAt },
        },
      ],
      { session }
    );
    if (stake > 0) {
      const paid = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: stake } }, { $inc: { balance: -stake } }, { new: true, session });
      if (!paid) throw new UserError('Dein Guthaben reicht für diesen Einsatz nicht aus.');
      await Ledger.create([{ user: user._id, type: 'einsatz', amount: -stake, bet: bet._id, betTitle: title }], { session });
    }
    // Auch ohne Geld (nur Karte) eine Position – so zählt der Herausforderer als Beteiligter (Meldungen, Liste)
    await Position.create([{ bet: bet._id, user: user._id, username: user.username, side: 'o1', amount: stake }], { session });
    return bet;
  });
  const t = notifyService.short(title);
  const what = stakeText(stake, created.duel.cards[0]);
  await notifyService.notify(opponent._id, { area: 'Duell', href: duelHref(created), text: `${user.username} fordert dich zum Duell heraus: „${t}“ (Einsatz ${what}).` });
  await notifyService.notify(referee._id, { area: 'Duell', href: duelHref(created), text: `${user.username} möchte dich als Schiedsrichter für das Duell „${t}“ gegen ${opponent.username}.` });
  return created;
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

/**
 * Herausgeforderter oder Schiedsrichter nimmt an. Der Herausgeforderte setzt denselben Betrag und – wenn der
 * Herausforderer eine Karte gesetzt hat – eine eigene Karte derselben Seltenheit (cardId).
 * Haben beide angenommen, beginnt das Duell; ab dann können Zuschauer bis zur Auswertung mitwetten.
 */
async function accept({ user, betId, cardId = null }) {
  const result = await betService.inTransaction(async (session) => {
    const bet = await Bet.findById(betId).session(session);
    if (!bet || !bet.duel) throw new UserError('Duell nicht gefunden.');
    if (bet.status !== 'offen' || bet.duel.state !== 'angefragt') throw new UserError('Dieses Duell kann nicht mehr angenommen werden.');
    if (bet.duel.expiresAt <= new Date()) throw new UserError('Die Frist zum Annehmen ist abgelaufen.');
    const role = duelRole(bet, user);
    const now = new Date();
    if (role === 'opponent') {
      if (bet.duel.opponentAcceptedAt) throw new UserError('Du hast bereits angenommen.');
      const stake = bet.duel.stake;
      if (bet.duel.cardRarity) {
        if (!cardId) throw new UserError(`Wähle eine deiner Karten (${catalog.rarityByKey[bet.duel.cardRarity].label}) als Einsatz.`);
        bet.duel.cards.push(await takeCard({ user, cardId, side: 'o2', rarity: bet.duel.cardRarity, session }));
      }
      if (stake > 0) {
        const paid = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: stake } }, { $inc: { balance: -stake } }, { new: true, session });
        if (!paid) throw new UserError(`Dein Guthaben reicht nicht – für dieses Duell brauchst du ${euro(stake)}.`);
        await Ledger.create([{ user: user._id, type: 'einsatz', amount: -stake, bet: bet._id, betTitle: bet.title }], { session });
      }
      await Position.create([{ bet: bet._id, user: user._id, username: user.username, side: 'o2', amount: stake }], { session });
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
      // Zuschauer setzen bis zum Termin der Auswertung (#67)
      bet.deadline = bet.resultAt && bet.resultAt > now ? bet.resultAt : now;
    }
    await bet.save({ session });
    return { bet, role, started };
  });
  const { bet, role, started } = result;
  const t = notifyService.short(bet.title);
  const what = role === 'opponent' ? 'die Herausforderung' : 'das Schiedsrichteramt';
  if (started) {
    // Herausforderer und wer vorher schon zugesagt hatte
    await notifyService.notify([bet.creator, bet.duel.opponent, bet.referee], { area: 'Duell', href: duelHref(bet), except: user, text: `Das Duell „${t}“ hat begonnen – ${user.username} hat ${what} angenommen.` });
  } else {
    await notifyService.notify(bet.creator, { area: 'Duell', href: duelHref(bet), text: `${user.username} hat ${what} im Duell „${t}“ angenommen. Es fehlt noch eine Zusage.` });
  }
  return result;
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
  await betService.resolveBet({ actor: betService.SYSTEM_ACTOR, betId, outcome: 'annulliert', note, quietFor: user._id });
  // Der Herausgeforderte hat noch keinen Einsatz und bekäme sonst nichts mit
  if (role !== 'opponent') await notifyService.notify(bet.duel.opponent, { area: 'Duell', href: duelHref(bet), text: `Duell „${notifyService.short(bet.title)}“: ${note}` });
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

/** Anfragen, auf die ich antworten muss (für den Kasten auf der Wett-Übersicht) */
const invitesFor = (userId) => Bet.find(betService.duelInviteFilter(userId)).sort({ createdAt: -1 }).limit(20).lean();

module.exports = { DUEL_FEE_PERCENT, INVITE_HOURS, MIN_CARD_RARITY, cardAllowed, cardLabel, stakeText, eligibleCards, checkStake, create, duelRole, accept, decline, expirePending, invitesFor };

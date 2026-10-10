// Gesperrte Karten-Exemplare: auf einer laufenden IHK-Quest, im Dungeon, in einem offenen Handelsangebot, als Einsatz
// in einem offenen Duell oder foliert (die Folie allein sperrt nur Bank, Duell und Sammelhandel).
// Gesperrte Exemplare können nicht verkauft, gehandelt oder auf eine Quest (oder einen künftigen Dungeon)
// geschickt werden. Ausnahmen: Folierte Karten lassen sich gezielt im Handel anbieten (tradeService.create) und
// spielen in Quest, Dungeon und Turm mit (#204, { foil: true }) – dort schützt die Folie vor Schaden.
const { IhkRun } = require('../models/Ihk');
const { Trade, openFilter } = require('../models/Trade');
const { lockedFor } = require('../trade/lines');
const { TcgCard } = require('../models/Tcg');
const { DungeonParty, DungeonRun } = require('../models/Dungeon');
const Bet = require('../models/Bet');
const { UserError } = require('../lib/util');

/** { docs: [ObjectId], reasons: Map<docId, 'quest'|'dungeon'|'handel'|'duell'|'folie'> } – alle haben Vorrang vor 'folie' */
async function lockedDocs(userId, session) {
  const [foiled, run, trades, party, dungeon, duels] = await Promise.all([
    TcgCard.find({ user: userId, foiledAt: { $ne: null } }).select('_id').session(session || null).lean(),
    IhkRun.findOne({ user: userId, status: 'laeuft' }).select('cardDoc boostDoc boost2Doc').session(session || null).lean(),
    // abgelaufene Angebote sperren nicht mehr (auch wenn ihr Status noch "offen" ist)
    Trade.find({ ...openFilter(), $or: [{ seller: userId }, { to: userId }], lockDocs: { $exists: true } }).select('seller to give want lockDocs').session(session || null).lean(),
    // Dungeon: angemeldet (bis zum Start) oder gerade im Durchlauf
    DungeonParty.findOne({ 'members.user': userId }).select('members').session(session || null).lean(),
    DungeonRun.findOne({ 'members.user': userId, status: 'laeuft' }).select('members').session(session || null).lean(),
    // Duell: eingesetzte Karte, solange das Duell offen ist (angefragt oder laufend)
    Bet.find({ status: 'offen', 'duel.cards.user': userId }).select('duel.cards').session(session || null).lean(),
  ]);
  const reasons = new Map();
  foiled.forEach((d) => reasons.set(String(d._id), 'folie'));
  if (run) [run.cardDoc, run.boostDoc, run.boost2Doc].filter(Boolean).forEach((id) => reasons.set(String(id), 'quest'));
  [party, dungeon].filter(Boolean).forEach((d) =>
    d.members.filter((m) => m.user && String(m.user) === String(userId)).forEach((m) => [m.cardDoc, m.boostDoc, m.coffeeDoc, m.energyDoc].filter(Boolean).forEach((id) => reasons.set(String(id), 'dungeon')))
  );
  trades.forEach((t) => lockedFor(t, userId).forEach((id) => reasons.set(String(id), 'handel')));
  duels.forEach((b) => b.duel.cards.filter((c) => String(c.user) === String(userId)).forEach((c) => reasons.set(String(c.doc), 'duell')));
  return { docs: [...reasons.keys()], reasons };
}

/** Gesperrt? Mit foil: true zählt die Folie allein nicht als Sperre (Quest, Dungeon, Turm – #204) */
function isLocked(locked, doc, { foil = false } = {}) {
  const reason = locked.reasons.get(String(doc._id || doc));
  return !!reason && !(foil && reason === 'folie');
}

/**
 * Exemplar für Quest, Dungeon oder Turm (#204): docs = Exemplare einer Karte, neueste zuerst, mit foiledAt.
 * foiled: true = nur ein foliertes (geschützt vor Schaden), sonst lieber ein unfoliertes und nur, wenn keins frei
 * ist, ein foliertes. except: dieses Exemplar ist schon vergeben (dieselbe Karte als Charakter und Boost).
 */
function pickCopy(docs, locked, { foiled = false, except = null } = {}) {
  const free = docs.filter((d) => !isLocked(locked, d, { foil: true }) && !(except && String(d._id) === String(except._id || except)));
  const withFoil = free.find((d) => d.foiledAt);
  if (foiled) return withFoil || null;
  return free.find((d) => !d.foiledAt) || withFoil || null;
}

/** Schild für gesperrte Exemplare (Album, IHK- und Dungeon-Kartenauswahl) */
const LOCK_LABELS = { quest: 'Auf Quest', dungeon: 'Im Dungeon', handel: 'Im Handel', duell: 'Im Duell' };
const lockLabel = (reason) => LOCK_LABELS[reason] || 'Gesperrt';

/**
 * Unfolierte Exemplare je Karte: { cardId: { total, free, locked, reason, foiled } } – reason = Grund des ersten
 * gesperrten Exemplars. freeIf(reason): diese Sperre zählt als frei (z. B. die eigenen Dungeon-Karten beim Tauschen
 * in der Lobby). foil: true zählt folierte Exemplare mit – frei sind sie dann in foiled (nicht in free), gesperrt
 * (Quest, Handel …) in locked (#204).
 */
async function copiesByCard(userId, { freeIf = () => false, foil = false } = {}) {
  const [docs, locked] = await Promise.all([TcgCard.find({ user: userId, ...(foil ? {} : { foiledAt: null }) }).select('card foiledAt').lean(), lockedDocs(userId)]);
  const out = {};
  for (const d of docs) {
    const e = out[d.card] || (out[d.card] = { total: 0, free: 0, locked: 0, reason: null, foiled: 0 });
    e.total += 1;
    const reason = locked.reasons.get(String(d._id));
    if (d.foiledAt && (reason === 'folie' || (reason && freeIf(reason)))) e.foiled += 1;
    else if (!reason || freeIf(reason)) e.free += 1;
    else {
      e.locked += 1;
      if (!e.reason) e.reason = reason;
    }
  }
  return out;
}

/**
 * Sperrt Exemplare innerhalb einer Transaktion, indem auf sie geschrieben wird. Ein gleichzeitiger
 * Verkauf, Handel oder Quest-Start derselben Karte kollidiert dadurch mit dieser Transaktion
 * (WriteConflict → automatische Wiederholung) und sieht danach die Sperre – statt dass beide
 * die Karte noch als frei sehen.
 */
async function claim(docs, userId, session) {
  const ids = docs.filter(Boolean).map((d) => d._id || d);
  const res = await TcgCard.updateMany({ _id: { $in: ids }, user: userId }, { $set: { lastClaimedAt: new Date() } }, { session });
  if (res.matchedCount !== ids.length) throw new UserError('Dein Bestand hat sich geändert. Bitte versuche es erneut.');
}

module.exports = { lockedDocs, isLocked, pickCopy, claim, LOCK_LABELS, lockLabel, copiesByCard };

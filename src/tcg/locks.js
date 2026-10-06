// Gesperrte Karten-Exemplare: auf einer laufenden IHK-Quest, im Dungeon, in einem offenen Handelsangebot, als Einsatz
// in einem offenen Duell oder foliert.
// Gesperrte Exemplare können nicht verkauft, gehandelt oder auf eine Quest (oder einen künftigen Dungeon)
// geschickt werden. Ausnahme: Folierte Karten lassen sich gezielt im Handel anbieten (tradeService.create).
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
    d.members.filter((m) => m.user && String(m.user) === String(userId)).forEach((m) => [m.cardDoc, m.boostDoc].filter(Boolean).forEach((id) => reasons.set(String(id), 'dungeon')))
  );
  trades.forEach((t) => lockedFor(t, userId).forEach((id) => reasons.set(String(id), 'handel')));
  duels.forEach((b) => b.duel.cards.filter((c) => String(c.user) === String(userId)).forEach((c) => reasons.set(String(c.doc), 'duell')));
  return { docs: [...reasons.keys()], reasons };
}

const isLocked = (locked, doc) => locked.reasons.has(String(doc._id || doc));

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

module.exports = { lockedDocs, isLocked, claim };

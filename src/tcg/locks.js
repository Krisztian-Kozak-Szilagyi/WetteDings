// Gesperrte Karten-Exemplare: auf einer laufenden IHK-Quest oder in einem offenen Handelsangebot.
// Gesperrte Exemplare können nicht verkauft, gehandelt oder auf eine Quest geschickt werden.
const { IhkRun } = require('../models/Ihk');
const { Trade, openFilter } = require('../models/Trade');
const { TcgCard } = require('../models/Tcg');
const { UserError } = require('../lib/util');

/** { docs: [ObjectId], reasons: Map<docId, 'quest'|'handel'> } */
async function lockedDocs(userId, session) {
  const [run, trades] = await Promise.all([
    IhkRun.findOne({ user: userId, status: 'laeuft' }).select('cardDoc boostDoc boost2Doc').session(session || null).lean(),
    // abgelaufene Angebote sperren nicht mehr (auch wenn ihr Status noch "offen" ist)
    Trade.find({ ...openFilter(), seller: userId }).select('cardDoc').session(session || null).lean(),
  ]);
  const reasons = new Map();
  if (run) [run.cardDoc, run.boostDoc, run.boost2Doc].filter(Boolean).forEach((id) => reasons.set(String(id), 'quest'));
  trades.forEach((t) => reasons.set(String(t.cardDoc), 'handel'));
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

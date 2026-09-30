// Gesperrte Karten-Exemplare: auf einer laufenden IHK-Quest oder in einem offenen Handelsangebot.
// Gesperrte Exemplare können nicht verkauft, gehandelt oder auf eine Quest geschickt werden.
const { IhkRun } = require('../models/Ihk');
const { Trade } = require('../models/Trade');

/** { docs: [ObjectId], reasons: Map<docId, 'quest'|'handel'> } */
async function lockedDocs(userId, session) {
  const [run, trades] = await Promise.all([
    IhkRun.findOne({ user: userId, status: 'laeuft' }).select('cardDoc boostDoc').session(session || null).lean(),
    // abgelaufene Angebote sperren nicht mehr (auch wenn ihr Status noch "offen" ist)
    Trade.find({ seller: userId, status: 'offen', expiresAt: { $gt: new Date() } }).select('cardDoc').session(session || null).lean(),
  ]);
  const reasons = new Map();
  if (run) [run.cardDoc, run.boostDoc].filter(Boolean).forEach((id) => reasons.set(String(id), 'quest'));
  trades.forEach((t) => reasons.set(String(t.cardDoc), 'handel'));
  return { docs: [...reasons.keys()], reasons };
}

const isLocked = (locked, doc) => locked.reasons.has(String(doc._id || doc));

module.exports = { lockedDocs, isLocked };

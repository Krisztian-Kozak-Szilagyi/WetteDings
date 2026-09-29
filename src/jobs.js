const config = require('./config');
const Bet = require('./models/Bet');
const { resolveBet, SYSTEM_ACTOR } = require('./services/betService');

/**
 * Wetten, deren Ergebnis nach Einsatzschluss zu lange nicht eingetragen wurde,
 * werden automatisch annulliert – so bleibt kein Spielgeld für immer blockiert.
 */
async function voidStaleBets() {
  const cutoff = new Date(Date.now() - config.autoVoidDays * 24 * 60 * 60 * 1000);
  const stale = await Bet.find({ status: 'offen', deadline: { $lt: cutoff } }).select('_id').limit(100).lean();
  for (const { _id } of stale) {
    try {
      await resolveBet({
        actor: SYSTEM_ACTOR,
        betId: _id,
        outcome: 'annulliert',
        reason: `Automatisch annulliert: Kein Ergebnis innerhalb von ${config.autoVoidDays} Tagen nach Einsatzschluss.`,
      });
      console.log(`Wette ${_id} automatisch annulliert.`);
    } catch (err) {
      console.error(`Automatische Annullierung von ${_id} fehlgeschlagen:`, err.message);
    }
  }
}

function startJobs() {
  const run = () => voidStaleBets().catch((err) => console.error('Job-Fehler:', err));
  setTimeout(run, 15 * 1000).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = { startJobs, voidStaleBets };

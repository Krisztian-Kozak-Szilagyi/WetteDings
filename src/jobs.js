const config = require('./config');
const Bet = require('./models/Bet');
const { resolveBet, SYSTEM_ACTOR } = require('./services/betService');
const { runLottery } = require('./services/lotteryService');
const rankService = require('./services/rankService');
const duelService = require('./services/duelService');

/**
 * Wetten, deren Ergebnis nach Einsatzschluss zu lange nicht eingetragen wurde,
 * werden automatisch annulliert – so bleibt kein Spielgeld für immer blockiert.
 */
async function voidStaleBets() {
  const cutoff = new Date(Date.now() - config.autoVoidDays * 24 * 60 * 60 * 1000);
  // Frist läuft ab dem Auswertungstermin (bei alten Wetten ohne Termin: ab Einsatzschluss)
  const stale = await Bet.find({
    status: 'offen',
    $or: [{ resultAt: { $lt: cutoff } }, { resultAt: null, deadline: { $lt: cutoff } }],
  })
    .select('_id')
    .limit(100)
    .lean();
  for (const { _id } of stale) {
    try {
      await resolveBet({
        actor: SYSTEM_ACTOR,
        betId: _id,
        outcome: 'annulliert',
        note: `Automatisch annulliert: Kein Ergebnis innerhalb von ${config.autoVoidDays} Tagen nach dem Auswertungstermin.`,
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

  // Lotterie: fällige Ziehungen alle 15 Sekunden prüfen (Ziehung damit spätestens 15 s nach der vollen Minute)
  const lottery = () => runLottery().catch((err) => console.error('Lotterie-Fehler:', err));
  lottery();
  setInterval(lottery, 15 * 1000).unref();

  // Duell-Anfragen, die niemand rechtzeitig angenommen hat: Einsatz zurück (alle 5 Minuten)
  const duels = () => duelService.expirePending().catch((err) => console.error('Duell-Fehler:', err));
  setTimeout(duels, 20 * 1000).unref();
  setInterval(duels, 5 * 60 * 1000).unref();

  // Rangliste: jede Minute festhalten, wer gerade auf Platz 1 steht (Anzeige im Profil)
  const top1 = () => rankService.trackTop1().catch((err) => console.error('Rang-Fehler:', err));
  top1();
  setInterval(top1, rankService.TICK_MS).unref();
}

module.exports = { startJobs, voidStaleBets };

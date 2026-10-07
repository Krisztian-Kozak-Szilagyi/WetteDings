const config = require('./config');
const Bet = require('./models/Bet');
const { resolveBet, SYSTEM_ACTOR } = require('./services/betService');
const { runLottery } = require('./services/lotteryService');
const rankService = require('./services/rankService');
const duelService = require('./services/duelService');
const { takeDailySnapshot } = require('./stats/snapshot');
const dungeonService = require('./dungeon/dungeonService');
const achievementService = require('./achievements/achievementService');
const suspicionService = require('./moderation/suspicionService');
const reportService = require('./coin/reportService');

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

  // Dungeon: fällige Starts und abgelaufene Durchläufe alle 5 Sekunden prüfen
  const dungeon = () => dungeonService.tick().catch((err) => console.error('Dungeon-Fehler:', err));
  setTimeout(dungeon, 10 * 1000).unref();
  setInterval(dungeon, 5 * 1000).unref();

  // Rangliste: jede Minute festhalten, wer gerade auf Platz 1 steht (Anzeige im Profil)
  const top1 = () => rankService.trackTop1().catch((err) => console.error('Rang-Fehler:', err));
  top1();
  setInterval(top1, rankService.TICK_MS).unref();

  // Statistik: einmal pro Tag den Stand der Wirtschaft festhalten (stündlich prüfen, ob der Tag schon erfasst ist)
  const snapshot = () => takeDailySnapshot().catch((err) => console.error('Statistik-Fehler:', err));
  setTimeout(snapshot, 30 * 1000).unref();
  setInterval(snapshot, 60 * 60 * 1000).unref();

  // Erfolge: beim Start die Einzelstücke vergeben, danach alle 5 Minuten prüfen, wer neue Erfolge erreicht hat
  const achievements = () => achievementService.checkAll().catch((err) => console.error('Erfolge-Fehler:', err));
  setTimeout(() => achievementService.grantSpecial().catch((err) => console.error('Erfolge-Fehler:', err)).then(achievements), 40 * 1000).unref();
  setInterval(achievements, 5 * 60 * 1000).unref();

  // Manipulationserkennung: alle 10 Minuten nach Skript-Mustern und Wertverschiebung suchen (Hinweise im Dev-Panel)
  const suspicion = () => suspicionService.scan().catch((err) => console.error('Manipulationserkennung-Fehler:', err));
  setTimeout(suspicion, 30 * 1000).unref();
  setInterval(suspicion, 10 * 60 * 1000).unref();

  // Börsenbericht: jede Minute prüfen, ob der Bericht des Tages (18:45 Uhr) fällig ist – danach springt der ETF
  const boerse = () => reportService.runDue().catch((err) => console.error('Börsenbericht-Fehler:', err));
  setTimeout(boerse, 45 * 1000).unref();
  setInterval(boerse, 60 * 1000).unref();

  // eSports: Wochenbericht (sonntags) und Konkurs eingefrorener Teams – jede Minute bzw. stündlich prüfen
  const esports = require('./esports/esportsService');
  const league = () => esports.runDue().catch((err) => console.error('eSports-Bericht-Fehler:', err));
  setTimeout(league, 50 * 1000).unref();
  setInterval(league, 60 * 1000).unref();
  const bankrupt = () => esports.closeExpired().catch((err) => console.error('eSports-Konkurs-Fehler:', err));
  setTimeout(bankrupt, 70 * 1000).unref();
  setInterval(bankrupt, 60 * 60 * 1000).unref();
}

module.exports = { startJobs, voidStaleBets };

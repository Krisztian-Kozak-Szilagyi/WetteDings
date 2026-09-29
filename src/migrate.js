const config = require('./config');
const Bet = require('./models/Bet');

/**
 * Datenbank-Migrationen, die beim Start laufen. Idempotent – mehrfaches Ausführen schadet nicht.
 */
async function migrate() {
  // v1 -> v2: totalJa/totalNein wurden zu einer Options-Liste
  const res = await Bet.collection.updateMany({ options: { $exists: false } }, [
    {
      $set: {
        type: 'janein',
        options: [
          { key: 'ja', label: 'Ja', total: { $ifNull: ['$totalJa', 0] } },
          { key: 'nein', label: 'Nein', total: { $ifNull: ['$totalNein', 0] } },
        ],
      },
    },
    { $unset: ['totalJa', 'totalNein'] },
  ]);
  if (res.modifiedCount) console.log(`Migration: ${res.modifiedCount} Wette(n) auf Options-Format umgestellt.`);

  // Provision gesenkt: noch offene Wetten mit höherer Provision auf den aktuellen Satz setzen
  // (nur zugunsten der Teilnehmer; abgeschlossene Wetten bleiben unverändert)
  const fee = await Bet.updateMany(
    { status: 'offen', creatorFeePercent: { $gt: config.creatorFeePercent } },
    { $set: { creatorFeePercent: config.creatorFeePercent } }
  );
  if (fee.modifiedCount) {
    console.log(`Migration: Provision bei ${fee.modifiedCount} offenen Wette(n) auf ${config.creatorFeePercent} % gesenkt.`);
  }
}

module.exports = { migrate };

// Gekaufte Lose der offenen Wochen-/Monats-Lotterie erstatten (z. B. über dem Limit gekaufte Lose vor dessen Einführung).
//   node scripts/lotto-erstatten.js <Name> [Anzahl] [--woche] [--ausfuehren]
// Ohne Anzahl: alles über dem Limit (Monat 20, Woche 10). Ohne --ausfuehren wird nur angezeigt, was passieren würde.
// Auf dem Server: docker exec wettstube node scripts/lotto-erstatten.js <Name> [Anzahl] [--ausfuehren]
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const config = require('../src/config');
const { refundTickets } = require('../src/services/lotteryService');
const { euro } = require('../src/lib/viewHelpers');

(async () => {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const [username, countArg] = args.filter((a) => !a.startsWith('--'));
  if (!username) throw new Error('Aufruf: node scripts/lotto-erstatten.js <Name> [Anzahl] [--woche] [--ausfuehren]');
  const count = countArg == null ? null : Number(countArg);
  const dryRun = !flags.has('--ausfuehren');

  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15000 });
  const r = await refundTickets({ username, count, kind: flags.has('--woche') ? 'woche' : 'monat', dryRun });
  const nums = r.removed.map((x) => (x.from === x.to ? x.from : `${x.from}–${x.to}`)).join(', ');
  console.log(`${r.username}, ${r.kind === 'woche' ? 'Wochen' : 'Monats'}-Lotterie #${r.round}: ${r.before} → ${r.after} Lose, ${r.count} Lose (Nr. ${nums}) für ${euro(r.amount)} erstattet.`);
  console.log(dryRun ? 'Nur Vorschau – nichts gespeichert. Ausführen mit --ausfuehren.' : 'Gespeichert; höhere Losnummern sind aufgerückt.');
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('Fehler:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

/**
 * Ruf eines Grading-Shops setzen (nur für die lokale Entwicklung) – zum Testen der Rufstufen, ihrer Freischaltungen
 * (Mitglieder-Aufträge am Tag, Vitrinenplätze) und des Verfalls bei Inaktivität.
 *   npm run dev:ruf -- 1200               Ruf 1.200 für admin (Stufe Renommiert)
 *   npm run dev:ruf -- 20000 anna         Ruf 20.000 für einen anderen Testspieler (Legende)
 *   npm run dev:ruf -- 1200 admin 10      zusätzlich: letzter Auftrag liegt 10 Tage zurück → der Verfall greift beim
 *                                          nächsten Lauf (alle 5 Minuten) oder sofort mit: node -e "require('./src/grading/orderService').decayReputations()"
 * Danach /grading neu laden.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
Object.assign(process.env, {
  NODE_ENV: 'development',
  MONGODB_URI: 'mongodb://127.0.0.1:27027/wettstube-dev?replicaSet=dev',
  SESSION_SECRET: 'dev-secret-nur-lokal-dev-secret-nur-lokal',
  ADMIN_USERNAMES: 'admin',
  GROQ_API_KEY: '',
});

const mongoose = require(path.join(ROOT, 'node_modules', 'mongoose'));
const User = require(path.join(ROOT, 'src/models/User'));
const { GradingShop } = require(path.join(ROOT, 'src/models/Grading'));
const grading = require(path.join(ROOT, 'src/grading/gradingService'));
const orders = require(path.join(ROOT, 'src/grading/orderService'));
const reputation = require(path.join(ROOT, 'src/grading/reputation'));

async function main() {
  const value = Number(process.argv[2]);
  if (!Number.isFinite(value)) throw new Error('Ruf angeben, z. B. npm run dev:ruf -- 1200');
  const username = (process.argv[3] || 'admin').toLowerCase();
  const idle = process.argv[4] === undefined ? null : Number(process.argv[4]);
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
  await grading.loadSettings();
  const user = await User.findOne({ usernameLower: username }).select('_id username').lean();
  if (!user) throw new Error(`Spieler „${username}“ gibt es in der Dev-Datenbank nicht.`);
  const shop = await GradingShop.findById(user._id).lean();
  if (!shop || !shop.code) throw new Error(`${user.username} hat keinen Shop mit Kürzel – vorher npm run dev:knick -- ${username}.`);
  const set = { reputation: value, repDecayedDays: 0 };
  if (idle !== null && Number.isFinite(idle)) set.lastWorkedAt = new Date(Date.now() - idle * 864e5);
  await GradingShop.updateOne({ _id: user._id }, { $set: set });
  const perks = reputation.perksOf(value, { playerJobs: grading.settings.playerJobs, showcaseMax: grading.settings.showcaseMax });
  console.log(`[dev:ruf] ${shop.code} (${user.username}): Ruf ${value} – ${perks.tier}, ${perks.playerJobs} Mitglieder-Aufträge/Tag, ${perks.showcase} Vitrinenplätze, Kundschaft ×${perks.richness}`);
  if (set.lastWorkedAt) {
    const n = await orders.decayReputations();
    console.log(`[dev:ruf] Letzter Auftrag vor ${idle} Tagen – Verfall angewendet (${n} Shop/Shops betroffen).`);
  }
}

main()
  .catch((err) => {
    const down = /ECONNREFUSED|Server selection timed out/i.test(err.message);
    console.error('[dev:ruf] Fehlgeschlagen:', down ? 'Keine Dev-Datenbank erreichbar – läuft „npm run dev“ in einem zweiten Terminal?' : err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

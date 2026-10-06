const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const mongoose = require('mongoose');
const config = require('./src/config');
const { createApp } = require('./src/app');
const { startJobs } = require('./src/jobs');
const { migrate } = require('./src/migrate');
const markets = require('./src/coin/markets');
const tcgSettings = require('./src/tcg/settings');

async function main() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15000 });
  console.log('MongoDB verbunden.');
  await migrate();
  await tcgSettings.load(); // im Admin-Panel geänderte TCG-Preise
  await require('./src/ihk/ihkService').loadSettings(); // IHK: Tageslimit und Belohnungen
  await require('./src/dungeon/dungeonService').loadSettings(); // Dungeon: Termine, Lohn, Beute, Bot-Karten
  await require('./src/services/taxService').loadSettings(); // Steuersätze: Handel (Markt, Privat, Tausch) und Broker (Coins, ETFs)
  await require('./src/services/bonusService').loadSettings(); // Tagesbonus
  await require('./src/grading/gradingService').loadSettings(); // Grading-Shop: freigegeben?
  await require('./src/items/foil').loadSettings(); // Folie: Fundchance und Wertsteigerung
  await require('./src/services/lotteryService').loadSettings(); // Wochen-/Monats-Lotterie: Lospreis und Bank-Gewinn
  await require('./src/stats/settingsLog').logConfigOnStart(); // geänderte .env-Werte im Einstellungs-Verlauf vermerken
  await require('./src/forum/forumService').seed(); // Forum: Bereiche beim ersten Start
  await require('./src/forum/forumService').ensureDefaults(); // Forum: feste Bereiche (z. B. Hall of Fame) und Startthemen, je nur einmal
  await require('./src/forum/forumService').migratePatchnotes(); // alte Patchnotes ins Forum
  await require('./src/services/roles').load(); // Devs für die Abzeichen neben Namen
  await markets.start(); // Broker: SAM, COW, BOJE, BTCG

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`${config.appName} läuft auf http://${config.host}:${config.port} (${config.env})`);
  });
  startJobs();

  const shutdown = async (signal) => {
    console.log(`${signal} empfangen, fahre herunter …`);
    setTimeout(() => process.exit(1), 10000).unref();
    await markets.stop(); // Kurse zuerst speichern
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Start fehlgeschlagen:', err);
  process.exit(1);
});

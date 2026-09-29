const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const mongoose = require('mongoose');
const config = require('./src/config');
const { createApp } = require('./src/app');
const { startJobs } = require('./src/jobs');
const { migrate } = require('./src/migrate');
const coinEngine = require('./src/coin/engine');
const tcgSettings = require('./src/tcg/settings');

async function main() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15000 });
  console.log('MongoDB verbunden.');
  await migrate();
  await tcgSettings.load(); // im Admin-Panel geänderte TCG-Preise
  await coinEngine.start();

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`${config.appName} läuft auf http://${config.host}:${config.port} (${config.env})`);
  });
  startJobs();

  const shutdown = async (signal) => {
    console.log(`${signal} empfangen, fahre herunter …`);
    setTimeout(() => process.exit(1), 10000).unref();
    await coinEngine.stop(); // Kurs zuerst speichern
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

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const mongoose = require('mongoose');
const config = require('./src/config');
const { createApp } = require('./src/app');
const { startJobs } = require('./src/jobs');

async function main() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15000 });
  console.log('MongoDB verbunden.');

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`${config.appName} läuft auf http://${config.host}:${config.port} (${config.env})`);
  });
  startJobs();

  const shutdown = (signal) => {
    console.log(`${signal} empfangen, fahre herunter …`);
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Start fehlgeschlagen:', err);
  process.exit(1);
});

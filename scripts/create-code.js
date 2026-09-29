// Notfall-/Start-Code auf der Konsole erzeugen (z. B. wenn noch kein Admin existiert):
//   node scripts/create-code.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const config = require('../src/config');
const { createCode, formatCode, CODE_TTL_MINUTES } = require('../src/services/codeService');
const { createHash } = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');

(async () => {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15000 });
  const code = await createCode({ _id: new mongoose.Types.ObjectId(), username: 'Konsole' });
  console.log(`Registrierungscode: ${formatCode(code.code)} (gültig ${CODE_TTL_MINUTES} Minuten, einmal nutzbar)`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error('Fehler:', err.message);
  process.exit(1);
});
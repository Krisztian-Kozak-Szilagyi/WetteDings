/**
 * Lokale Entwicklung ohne echte Datenbank und ohne Zugangsdaten:
 * startet eine lokale MongoDB (Replica Set, nötig für Transaktionen), legt beim ersten Start
 * Testspieler mit Spielgeld, Karten und Angeboten an und startet den Server mit --watch.
 *
 *   npm run dev            Daten bleiben zwischen den Starts erhalten
 *   npm run dev -- --reset alles löschen und neu anlegen
 *
 * Die Daten liegen im Temp-Ordner (nicht im Projekt, damit Nextcloud sie nicht synchronisiert).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(os.tmpdir(), 'wettedings-dev-db');
const DB_PORT = 27027; // fest, damit der Server bei Neustarts dieselbe Adresse findet
const PASSWORD = 'test1234';
const PLAYERS = [
  { username: 'admin', balance: 500000 },
  { username: 'anna', balance: 200000 },
  { username: 'ben', balance: 150000 },
  { username: 'carla', balance: 40000 },
];

// Feste Dev-Werte; eine vorhandene .env kann sie nicht überschreiben (dotenv lässt gesetzte Variablen in Ruhe)
const devEnv = {
  NODE_ENV: 'development',
  MONGODB_URI: `mongodb://127.0.0.1:${DB_PORT}/wettstube-dev?replicaSet=dev`,
  SESSION_SECRET: 'dev-secret-nur-lokal-dev-secret-nur-lokal',
  ADMIN_USERNAMES: 'admin',
  COOKIE_SECURE: 'false',
  TRUST_PROXY: 'false',
  HOST: '127.0.0.1',
  PORT: process.env.PORT || '3000',
  GROQ_API_KEY: '', // Support-Chat bleibt aus
};

async function seed() {
  Object.assign(process.env, devEnv);
  const mongoose = require(path.join(ROOT, 'node_modules', 'mongoose'));
  const bcrypt = require('bcryptjs');
  const User = require(path.join(ROOT, 'src/models/User'));
  const Ledger = require(path.join(ROOT, 'src/models/Ledger'));
  const { TcgCard, TcgPack } = require(path.join(ROOT, 'src/models/Tcg'));
  const catalog = require(path.join(ROOT, 'src/tcg/catalog'));
  const trade = require(path.join(ROOT, 'src/trade/tradeService'));

  await mongoose.connect(devEnv.MONGODB_URI);
  try {
    if (await User.exists({})) {
      console.log('[dev] Testdaten vorhanden – nichts angelegt (neu anlegen: npm run dev -- --reset).');
      return;
    }
    console.log('[dev] Lege Testspieler, Karten und Angebote an …');
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const users = await User.insertMany(
      PLAYERS.map((p) => ({ username: p.username, usernameLower: p.username, email: `${p.username}@dev.local`, passwordHash, balance: p.balance }))
    );
    await Ledger.insertMany(users.map((u) => ({ user: u._id, type: 'startguthaben', amount: u.balance })));

    // Karten: viele häufige, ein paar seltene, einige Duplikate – jeder Spieler etwas anders
    const byRarity = (key) => catalog.CARDS.filter((c) => c.rarity === key);
    const pick = (key) => {
      const pool = byRarity(key);
      return pool.length ? pool[crypto.randomInt(pool.length)] : null;
    };
    const mix = { crumpled: 8, bfwler: 6, gold: 4, holo: 2, bockhaber: 1 };
    const cards = [];
    for (const u of users) {
      for (const [key, n] of Object.entries(mix)) {
        for (let i = 0; i < n; i++) {
          const c = pick(key);
          if (c) cards.push({ user: u._id, card: c.id, rarity: c.rarity });
        }
      }
    }
    await TcgCard.insertMany(cards);
    await TcgPack.insertMany(users.flatMap((u) => [1, 2].map(() => ({ user: u._id, type: catalog.DEFAULT_PACK, source: 'admin' }))));

    // Ein paar offene Angebote, damit die Handelsseite nicht leer ist
    // Jeweils verschiedene Karten nehmen, damit kein Exemplar doppelt im Handel steckt
    const [, anna, ben, carla] = users;
    const [annaCards, benCards, carlaCards] = await Promise.all([anna, ben, carla].map((u) => TcgCard.distinct('card', { user: u._id })));
    const benGives = benCards.find((id) => id !== benCards[0] && id !== annaCards[1]);
    const card = (id) => ({ card: id });
    await trade.create({ user: anna, gives: [card(annaCards[0])], price: 2500 });
    await trade.create({ user: ben, gives: [card(benCards[0])], price: 9900 });
    // Bündel auf dem Markt: zwei Karten zusammen
    await trade.create({ user: carla, gives: [card(carlaCards[1]), card(carlaCards[2])], price: 4000 });
    await trade.create({ user: carla, toName: 'anna', gives: [card(carlaCards[0])], price: 1500 });
    // Ben bietet Anna einen Tausch an und legt 5 € drauf
    await trade.create({ user: ben, toName: 'anna', gives: [card(benGives)], gets: [card(annaCards[1])], price: 500, iPay: true });
    // Kaufanfrage: Anna möchte eine Karte von Carla und zahlt dafür
    await trade.create({ user: anna, toName: 'carla', gets: [card(carlaCards[3])], price: 2000, iPay: true });

    console.log(`[dev] ${users.length} Spieler, ${cards.length} Karten, 6 Angebote angelegt.`);
  } finally {
    await mongoose.disconnect();
  }
}

async function main() {
  const reset = process.argv.includes('--reset');
  if (reset) fs.rmSync(DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(DB_DIR, { recursive: true });

  console.log('[dev] Starte lokale MongoDB (beim ersten Mal wird sie heruntergeladen, das dauert etwas) …');
  const replSet = await MongoMemoryReplSet.create({
    replSet: { name: 'dev', count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ port: DB_PORT, dbPath: DB_DIR }],
  });
  await replSet.waitUntilRunning();

  await seed();

  const server = spawn(process.execPath, ['--watch', path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...devEnv } });
  console.log(`[dev] Login: ${PLAYERS.map((p) => p.username).join(', ')} – Passwort "${PASSWORD}" (admin hat Admin-Rechte)`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.kill();
    await replSet.stop({ doCleanup: false }); // Daten behalten
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.on('exit', stop);
}

main().catch((err) => {
  console.error('[dev] Start fehlgeschlagen:', err);
  process.exit(1);
});

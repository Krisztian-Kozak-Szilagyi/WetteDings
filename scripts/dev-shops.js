/**
 * Testshops für „Karte graden lassen“ (#204, nur für die lokale Entwicklung): legt vier fremde Grading-Shops an, die
 * Aufträge annehmen – mit verschiedenen Preisen, Reputation, Bewertungen und Lagerbestand an leeren Slabs. So lässt sich
 * der Annahmeschalter (/grading/einreichen) mit Sortierung, Sperre ohne Slabs und Preisvergleich durchspielen.
 *
 *   npm run dev                  (in einem zweiten Terminal laufen lassen)
 *   npm run dev:shops            legt die Shops an (oder setzt sie zurück, wenn es sie schon gibt)
 *
 * Die Testshops gehören den Spielern shop_pixel, shop_goldwaage, shop_billig und shop_leer (Passwort wie bei den anderen
 * Testspielern: test1234). Keiner davon ist admin – der sieht sie also in der Liste.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
// dieselben Werte wie scripts/dev.js
Object.assign(process.env, {
  NODE_ENV: 'development',
  MONGODB_URI: 'mongodb://127.0.0.1:27027/wettstube-dev?replicaSet=dev',
  SESSION_SECRET: 'dev-secret-nur-lokal-dev-secret-nur-lokal',
  ADMIN_USERNAMES: 'admin',
  GROQ_API_KEY: '',
});

const mongoose = require(path.join(ROOT, 'node_modules', 'mongoose'));
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
const User = require(path.join(ROOT, 'src/models/User'));
const { GradingShop } = require(path.join(ROOT, 'src/models/Grading'));
const grading = require(path.join(ROOT, 'src/grading/gradingService'));
const items = require(path.join(ROOT, 'src/items/itemService'));

const tag = '[dev:shops]';

// Preise in Cent (null = Standardpreis); stars/quality/hits: Summe und Anzahl der Bewertungen
const SHOPS = [
  { user: 'shop_pixel', name: 'Pixel Grading', code: 'PXL', prices: { base: 1500, iron: 2500, slab: 5000, express: 3000, review: 4000 }, reputation: 82, stars: [47, 10], quality: [880, 10], hits: [8, 10], slabs: 6 },
  { user: 'shop_goldwaage', name: 'Goldwaage', code: 'GLW', prices: { base: 3000, iron: 4500, slab: 9000, express: 6000, review: 7000 }, reputation: 120, stars: [48, 10], quality: [950, 10], hits: [10, 10], slabs: 3 },
  { user: 'shop_billig', name: 'Billig-Grade', code: 'BLG', prices: { base: 1000, iron: 1000, slab: 1500, express: 1000, review: 1500 }, reputation: 12, stars: [26, 8], quality: [420, 8], hits: [3, 8], slabs: 10 },
  { user: 'shop_leer', name: 'Leerlager', code: 'LGR', prices: null, reputation: 40, stars: [0, 0], quality: [0, 0], hits: [0, 0], slabs: 0 },
];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
  await grading.loadSettings();
  const passwordHash = await bcrypt.hash('test1234', 10);

  for (const s of SHOPS) {
    let user = await User.findOne({ usernameLower: s.user }).select('_id').lean();
    if (!user) user = await User.create({ username: s.user, usernameLower: s.user, email: `${s.user}@dev.local`, passwordHash, balance: 100000 });
    const now = new Date();
    const set = {
      active: true,
      level: 4,
      hiredAt: now,
      lockedUntil: new Date(now.getTime() + 10 * 86400000),
      name: s.name,
      code: s.code,
      prices: s.prices || {},
      reputation: s.reputation,
      stars: { sum: s.stars[0], n: s.stars[1] },
      quality: { sum: s.quality[0], n: s.quality[1] },
      hits: { exact: s.hits[0], n: s.hits[1] },
    };
    await GradingShop.updateOne({ _id: user._id }, { $set: set }, { upsert: true });

    // Lagerbestand an leeren Slabs auf genau den Soll-Wert bringen
    const have = await items.slabStock(user._id);
    if (have < s.slabs) await items.addItems({ userIds: [user._id], type: 'slab', count: s.slabs - have, source: 'admin' });
    else if (have > s.slabs && s.slabs === 0) console.log(`${tag}   ${s.code}: ${have} leere Slabs im Lager (bleiben, Rest manuell entfernen)`);
    console.log(`${tag} ${s.code} „${s.name}“ (${s.user}): Stufe 4, ${s.slabs} leere Slabs`);
  }
  console.log(`${tag} /grading/einreichen neu laden. Die Shops sind absichtlich verschieden: günstig, teuer/top, schlecht bewertet, ohne Slabs.`);
}

main()
  .catch((err) => {
    // häufigster Fall: die Dev-Datenbank läuft nicht – sie gehört zu npm run dev
    const down = /ECONNREFUSED|Server selection timed out/i.test(err.message);
    console.error(`${tag} Fehlgeschlagen:`, down ? 'Keine Dev-Datenbank erreichbar – läuft „npm run dev“ in einem zweiten Terminal?' : err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

/**
 * Testfälle für das Handels-UI (nur für die lokale Entwicklung): Angebote mit TCG Sleeve, Slab, beschädigten
 * Karten und Gegenständen (leere Slabs, Sleeves) – auf dem Markt, privat, als Tausch und als Kaufanfrage.
 *
 *   npm run dev                  (in einem zweiten Terminal laufen lassen)
 *   npm run dev:handel           legt die Karten und Angebote an
 *
 * Danach /handel (als admin: auch „Meine Angebote“ und Anfragen an dich). Beteiligt sind anna, ben, carla und admin.
 * Läuft nur einmal – ein zweiter Lauf erkennt die Testangebote und legt nichts doppelt an (zurücksetzen: npm run dev -- --reset).
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
const User = require(path.join(ROOT, 'src/models/User'));
const { TcgCard } = require(path.join(ROOT, 'src/models/Tcg'));
const { Trade } = require(path.join(ROOT, 'src/models/Trade'));
const catalog = require(path.join(ROOT, 'src/tcg/catalog'));
const trade = require(path.join(ROOT, 'src/trade/tradeService'));
const items = require(path.join(ROOT, 'src/items/itemService'));
const { addDamage, gradeFor } = require(path.join(ROOT, 'src/grading/condition'));
const { slabCert } = require(path.join(ROOT, 'src/lib/viewHelpers'));

const tag = '[dev:handel]';
const NAMES = ['admin', 'anna', 'ben', 'carla'];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
  const users = {};
  for (const n of NAMES) {
    users[n] = await User.findOne({ usernameLower: n }).select('_id username balance').lean();
    if (!users[n]) throw new Error(`Spieler „${n}“ gibt es in der Dev-Datenbank nicht (npm run dev -- --reset).`);
  }
  if (await Trade.exists({ status: 'offen', 'give.slab.code': { $exists: true, $ne: null } })) {
    console.log(`${tag} Es gibt schon offene Angebote mit Slab – nichts angelegt (npm run dev -- --reset zum Zurücksetzen).`);
    return;
  }

  // verschiedene Karten, damit jedes Exemplar nur einmal vorkommt
  const pool = catalog.CARDS.filter((c) => ['bfwler', 'gold', 'holo', 'bockhaber'].includes(c.rarity));
  let next = 0;
  const pickCard = () => pool[next++ % pool.length];

  /** Eine Karte als Exemplar: sleeve = foliert, slab = { code, grade }, damage = ['knick'] / ['kratzer', …] */
  async function makeCard(owner, { sleeve = false, slab = null, damage = [] } = {}) {
    const c = pickCard();
    const doc = await TcgCard.create({ user: users[owner]._id, card: c.id, rarity: c.rarity });
    const set = {};
    if (damage.length) {
      const cur = await TcgCard.findById(doc._id).select('condition').lean();
      let defects = cur.condition && cur.condition.defects;
      for (const d of damage) defects = addDamage(defects, d);
      Object.assign(set, { 'condition.defects': defects, 'condition.grade': gradeFor(defects), damaged: true, creased: damage.includes('knick') });
    }
    if (slab) Object.assign(set, { foiledAt: new Date(), slab: { code: slab.code, grade: slab.grade, at: new Date(), cert: slabCert(doc._id) } });
    else if (sleeve) set.foiledAt = new Date();
    if (Object.keys(set).length) await TcgCard.updateOne({ _id: doc._id }, { $set: set });
    return { id: doc._id, card: c.id, line: { card: c.id, copy: doc._id } };
  }

  // Gegenstände: genug Sleeves und leere Slabs für die Bündel
  for (const n of ['anna', 'carla']) await items.addItems({ userIds: [users[n]._id], type: 'slab', count: 4, source: 'admin' });
  for (const n of ['anna', 'ben']) await items.addItems({ userIds: [users[n]._id], type: 'folie', count: 4, source: 'admin' });
  const item = (key, n = 1) => Array.from({ length: n }, () => ({ card: 'item:' + key }));

  const annaSlab = await makeCard('anna', { slab: { code: 'PXL', grade: 9 } });
  const benSleeve = await makeCard('ben', { sleeve: true });
  const carlaSlab = await makeCard('carla', { slab: { code: 'BfW', grade: 6 } });
  const carlaSleeve = await makeCard('carla', { sleeve: true });
  const carlaKnick = await makeCard('carla', { damage: ['knick'] });
  const carlaKnick2 = await makeCard('carla', { damage: ['knick'] });
  const carlaSlab2 = await makeCard('carla', { slab: { code: 'GLW', grade: 10 } });
  const annaSlab2 = await makeCard('anna', { slab: { code: 'GLW', grade: 10 } });
  const benSlab = await makeCard('ben', { slab: { code: 'BLG', grade: 8 } });
  const benKratzer = await makeCard('ben', { damage: ['kratzer', 'kratzer'] });
  const adminSleeve = await makeCard('admin', { sleeve: true });
  const adminKnick = await makeCard('admin', { damage: ['knick'] });
  const adminSlab = await makeCard('admin', { slab: { code: 'PXL', grade: 7 } });

  const cases = [
    ['Markt: Slab PXL 9 (anna)', { user: users.anna, gives: [annaSlab.line], price: 18000 }],
    ['Markt: Karte im Sleeve (ben)', { user: users.ben, gives: [benSleeve.line], price: 4500 }],
    ['Markt: Bündel Slab + Sleeve-Karte + Knick-Karte (carla)', { user: users.carla, gives: [carlaSlab.line, carlaSleeve.line, carlaKnick.line], price: 9000 }],
    ['Markt: 2× leerer Slab (carla)', { user: users.carla, gives: item('slab', 2), price: 7000 }],
    ['Markt: 3× TCG Sleeve (anna)', { user: users.anna, gives: item('folie', 3), price: 4000 }],
    ['Markt: Karte mit zwei Kratzern (ben)', { user: users.ben, gives: [benKratzer.line], price: 2500 }],
    ['Privat anna → admin: Slab GLW 10, admin zahlt', { user: users.anna, toName: 'admin', gives: [annaSlab2.line], price: 25000 }],
    ['Tausch ben → admin: Slab BLG 8 gegen Admins Sleeve-Karte, ben legt 5 € drauf', { user: users.ben, toName: 'admin', gives: [benSlab.line], gets: [adminSleeve.line], price: 500, iPay: true }],
    ['Kaufanfrage admin → carla: Slab GLW 10, admin zahlt 120 €', { user: users.admin, toName: 'carla', gets: [carlaSlab2.line], price: 12000, iPay: true }],
    ['Tausch carla → admin: Karte mit Knick gegen Admins Knick-Karte', { user: users.carla, toName: 'admin', gives: [carlaKnick2.line], gets: [adminKnick.line] }],
    ['Markt: Slab PXL 7 (admin)', { user: users.admin, gives: [adminSlab.line], price: 9500 }],
  ];

  let ok = 0;
  for (const [label, args] of cases) {
    try {
      await trade.create(args);
      ok++;
      console.log(`${tag} ✓ ${label}`);
    } catch (err) {
      console.log(`${tag} ✗ ${label} – ${err.message}`);
    }
  }
  console.log(`${tag} ${ok} von ${cases.length} Angeboten angelegt – /handel neu laden.`);
}

main()
  .catch((err) => {
    // häufigster Fall: die Dev-Datenbank läuft nicht – sie gehört zu npm run dev
    const down = /ECONNREFUSED|Server selection timed out/i.test(err.message);
    console.error(`${tag} Fehlgeschlagen:`, down ? 'Keine Dev-Datenbank erreichbar – läuft „npm run dev“ in einem zweiten Terminal?' : err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

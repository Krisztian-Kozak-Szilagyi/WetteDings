/**
 * Testbewertungen für einen Grading-Shop (#204, nur für die lokale Entwicklung): legt fertige Aufträge mit Sternen und
 * Schnell-Tags an, damit Handy/Bewertungen etwas zu zeigen hat. Reputation und Shop-Sterne werden mitgezählt.
 * Preis und Einzelposten stammen aus der Preisliste des Shops, damit die Kassenzettel wie echte aussehen. Gekennzeichnet sind die Testaufträge über result.seal = 4242 – ein erneuter Lauf ersetzt sie.
 *
 *   npm run dev                              (in einem zweiten Terminal laufen lassen)
 *   npm run dev:bewertungen                  für den Shop von admin
 *   npm run dev:bewertungen -- anna          für den Shop eines anderen Testspielers
 *   npm run dev:bewertungen -- anna weg      Testbewertungen wieder entfernen
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
const { TcgCard } = require(path.join(ROOT, 'src/models/Tcg'));
const { GradingShop, GradingOrder } = require(path.join(ROOT, 'src/models/Grading'));
const grading = require(path.join(ROOT, 'src/grading/gradingService'));
const orders = require(path.join(ROOT, 'src/grading/orderService'));

const tag = '[dev:bewertungen]';
const MARK = 4242; // Kennzeichen im Feld result.seal (sonst ungenutzt bei Testaufträgen)
// Sterne, Tags, Alter in Stunden, Bausteine, Note
const SAMPLES = [
  { stars: 5, tags: ['sauber', 'schnell', 'fair'], ageH: 3, services: { slab: true }, grade: 9 },
  { stars: 5, tags: ['verpackt'], ageH: 20, services: { iron: true, slab: true }, grade: 8 },
  { stars: 4, tags: ['preis', 'fair'], ageH: 50, services: { slab: true, express: true }, grade: 7 },
  { stars: 5, tags: [], ageH: 90, services: { slab: true }, grade: 10 },
  { stars: 3, tags: ['langsam', 'fair'], ageH: 170, services: { iron: true, slab: true }, grade: 6 },
  { stars: 2, tags: ['streng', 'teuer'], ageH: 300, services: { slab: true }, grade: 5 },
  { stars: 4, tags: ['schnell'], ageH: 600, services: { slab: true }, grade: 8 },
];

async function recount(shopId) {
  const rows = await GradingOrder.find({ shop: shopId, stars: { $ne: null } }).select('stars').lean();
  await GradingShop.updateOne({ _id: shopId }, { $set: { 'stars.sum': rows.reduce((a, r) => a + r.stars, 0), 'stars.n': rows.length } });
}

async function main() {
  const username = (process.argv[2] || 'admin').toLowerCase();
  const remove = process.argv[3] === 'weg';
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
  await grading.loadSettings();
  const owner = await User.findOne({ usernameLower: username }).select('_id username').lean();
  if (!owner) throw new Error(`Spieler „${username}“ gibt es in der Dev-Datenbank nicht.`);
  const shop = await GradingShop.findById(owner._id).lean();
  if (!shop || !shop.code) throw new Error(`${owner.username} hat keinen Shop mit Kürzel – vorher npm run dev:knick -- ${username}.`);

  const old = await GradingOrder.deleteMany({ shop: owner._id, 'result.seal': MARK });
  if (remove) {
    await recount(owner._id);
    console.log(`${tag} ${old.deletedCount} Testbewertung(en) von ${shop.code} entfernt.`);
    return;
  }

  const customers = await User.find({ _id: { $ne: owner._id }, deletedAt: null }).select('_id username').lean();
  if (!customers.length) throw new Error('Es gibt keine anderen Testspieler, die bewerten könnten.');
  const cards = await TcgCard.find({}).select('_id card').limit(SAMPLES.length * 3).lean();
  if (!cards.length) throw new Error('Es gibt keine Karten in der Dev-Datenbank.');

  const now = Date.now();
  const docs = SAMPLES.map((s, i) => {
    const c = customers[i % customers.length];
    const k = cards[i % cards.length];
    const at = new Date(now - s.ageH * 36e5);
    const pr = orders.shopPrices(shop);
    const parts = { base: pr.base, iron: s.services.iron ? pr.iron : null, slab: s.services.slab ? pr.slab : null, express: s.services.express ? pr.express : null };
    const price = Object.values(parts).reduce((sum, v) => sum + (v || 0), 0);
    return {
      owner: c._id, ownerName: c.username, shop: owner._id, shopCode: shop.code, shopName: shop.name || null, doc: k._id, card: k.card,
      price, priceParts: parts, services: { iron: !!s.services.iron, slab: !!s.services.slab, express: !!s.services.express }, status: 'fertig', expiresAt: at, startedAt: at, doneAt: at,
      result: { grade: s.grade, seal: MARK }, stars: s.stars, tags: s.tags, ratedAt: at,
    };
  });
  await GradingOrder.insertMany(docs);
  await recount(owner._id);
  console.log(`${tag} ${docs.length} Testbewertungen für ${shop.code} (${owner.username}) angelegt – /grading neu laden, Handy öffnen.`);
}

main()
  .catch((err) => {
    const down = /ECONNREFUSED|Server selection timed out/i.test(err.message);
    console.error(`${tag} Fehlgeschlagen:`, down ? 'Keine Dev-Datenbank erreichbar – läuft „npm run dev“ in einem zweiten Terminal?' : err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

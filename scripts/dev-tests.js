/**
 * Testdaten für Trinkgeld, Vitrinen-Reihenfolge, Slogan und den eigenen Shop-Button (nur für die lokale Entwicklung).
 *   - Slogan: der Shop bekommt einen Werbespruch (Shop-Seite, Einreich-Liste)
 *   - Vitrine: der Shop-Inhaber bekommt mindestens 5 Slabs (Noten 10 bis 6), die ersten 3 sind ausgestellt –
 *     zum Testen von Ziehen, Austauschen und Entfernen direkt in der Vitrine am Schreibtisch
 *   - Trinkgeld: 3 fertige, noch unbewertete Aufträge anderer Testspieler (Guthaben dort mindestens 50 €) –
 *     als dieser Kunde einloggen, /grading/einreichen › Bewerten mit Trinkgeld; eine Kundin bekommt wenig Guthaben
 *     (Stufen darüber sind gesperrt)
 *   - Shop-Button: nichts anzulegen – /tcg zeigt unter dem Inventar „Zum Shop“, die Seite ist /inventar/shop
 *
 *   npm run dev                      (in einem zweiten Terminal laufen lassen)
 *   npm run dev:tests                für den Shop von admin
 *   npm run dev:tests -- anna        für den Shop eines anderen Testspielers
 *   npm run dev:tests -- anna weg    die Test-Aufträge wieder entfernen (Slogan und Slabs bleiben)
 *
 * Der Shop braucht ein Kürzel (vorher npm run dev:knick) und Stufe 4, damit er in der Einreich-Liste steht.
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
const { slabCert } = require(path.join(ROOT, 'src/lib/viewHelpers'));

const tag = '[dev:tests]';
const MARK = 4343; // Kennzeichen in result.seal der Test-Aufträge
const SLOGAN = 'Jede Karte verdient eine zweite Chance';
const GRADES = [10, 9, 8, 7, 6];
const BALANCES = [10000, 5000, 150]; // 100 €, 50 €, 1,50 € (dann sind 2, 5 und 10 € gesperrt)

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
    console.log(`${tag} ${old.deletedCount} Test-Auftrag/Aufträge von ${shop.code} entfernt.`);
    return;
  }

  // Slogan
  await GradingShop.updateOne({ _id: owner._id }, { $set: { slogan: SLOGAN } });

  // Vitrine: mindestens 5 Slabs, die ersten 3 ausgestellt
  const now = new Date();
  const have = await TcgCard.find({ user: owner._id, slab: { $ne: null } }).select('_id').lean();
  const need = Math.max(0, GRADES.length - have.length);
  if (need) {
    const free = await TcgCard.find({ user: owner._id, slab: null, foiledAt: null, damaged: { $ne: true } }).select('_id').limit(need).lean();
    for (const [i, c] of free.entries()) {
      await TcgCard.updateOne({ _id: c._id }, { $set: { foiledAt: now, slab: { code: shop.code, grade: GRADES[have.length + i] || 7, at: now, cert: slabCert(c._id) } } });
    }
  }
  const slabs = await TcgCard.find({ user: owner._id, slab: { $ne: null } }).sort({ 'slab.grade': -1 }).select('_id').lean();
  const showMax = Math.min(3, grading.settings.showcaseMax || 3, slabs.length);
  await GradingShop.updateOne({ _id: owner._id }, { $set: { showcase: slabs.slice(0, showMax).map((d) => d._id) } });

  // Trinkgeld: fertige, unbewertete Aufträge
  const customers = await User.find({ _id: { $ne: owner._id }, deletedAt: null }).select('_id username').limit(BALANCES.length).lean();
  const cards = await TcgCard.find({}).select('_id card').limit(10).lean();
  if (!customers.length || !cards.length) throw new Error('Es gibt keine anderen Testspieler oder keine Karten für Test-Aufträge.');
  const pr = orders.shopPrices(shop);
  const docs = customers.map((c, i) => {
    const k = cards[i % cards.length];
    const at = new Date(now - (i + 1) * 36e5);
    const parts = { base: pr.base, iron: null, slab: pr.slab, express: null };
    return {
      owner: c._id, ownerName: c.username, shop: owner._id, shopCode: shop.code, shopName: shop.name || null, doc: k._id, card: k.card,
      price: pr.base + pr.slab, priceParts: parts, services: { iron: false, slab: true, express: false }, status: 'fertig', expiresAt: at, startedAt: at, doneAt: at,
      result: { grade: 9 - i, seal: MARK },
    };
  });
  await GradingOrder.insertMany(docs);
  await Promise.all(customers.map((c, i) => User.updateOne({ _id: c._id }, { $set: { balance: BALANCES[i] } })));

  console.log(`${tag} ${shop.code} (${owner.username}): Slogan gesetzt, ${showMax} von ${slabs.length} Slabs ausgestellt.`);
  console.log(`${tag} Unbewertete Aufträge zum Bewerten mit Trinkgeld (/grading/einreichen) bei:`);
  customers.forEach((c, i) => console.log(`${tag}   ${c.username}  – Guthaben ${(BALANCES[i] / 100).toFixed(2)} €`));
  if ((shop.level || 1) < 4) console.log(`${tag} Hinweis: ${shop.code} hat Stufe ${shop.level || 1} – für die Einreich-Liste (Slogan) npm run dev:stufe -- 4 ${username}.`);
}

main()
  .catch((err) => {
    const down = /ECONNREFUSED|Server selection timed out/i.test(err.message);
    console.error(`${tag} Fehlgeschlagen:`, down ? 'Keine Dev-Datenbank erreichbar – läuft „npm run dev“ in einem zweiten Terminal?' : err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

/**
 * Testdaten für den Eingang eines Grading-Shops (#204, nur für die lokale Entwicklung): Andere Testspieler reichen
 * Karten beim Shop ein – über den normalen Weg (orderService.submit: Preis wird abgebucht, Karte gesperrt, Frist läuft).
 * Der Shop sieht sie im Eingang und bekommt sie vor den NPC-Aufträgen (Express zuerst, dann die ältesten).
 *
 * Eingereicht werden (soweit die Kunden passende Karten haben):
 *   - Express + Benoten/Slab
 *   - Knick bügeln + Benoten/Slab (die Karte bekommt dafür einen Knick)
 *   - nur Benoten/Slab
 *   - Zweitprüfung eines Slabs aus einem anderen Shop (notfalls wird eine Karte zum BfW-Slab)
 *
 *   npm run dev                          (in einem zweiten Terminal laufen lassen)
 *   npm run dev:auftraege                für den Shop von admin
 *   npm run dev:auftraege -- anna        für den Shop eines anderen Testspielers
 *
 * Der Shop braucht Stufe 3 und ein Kürzel (sonst vorher npm run dev:knick). Danach /grading neu laden.
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
const { GradingShop } = require(path.join(ROOT, 'src/models/Grading'));
const grading = require(path.join(ROOT, 'src/grading/gradingService'));
const orders = require(path.join(ROOT, 'src/grading/orderService'));
const { addDamage, gradeFor } = require(path.join(ROOT, 'src/grading/condition'));

const tag = '[dev:auftraege]';

async function main() {
  const username = (process.argv[2] || 'admin').toLowerCase();
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
  await grading.loadSettings();
  const owner = await User.findOne({ usernameLower: username }).select('_id username').lean();
  if (!owner) throw new Error(`Spieler „${username}“ gibt es in der Dev-Datenbank nicht.`);
  const shop = await GradingShop.findById(owner._id).lean();
  if (!shop || !shop.active || !shop.code || !orders.acceptsOrders(shop)) throw new Error(`${owner.username} hat keinen Shop ab Stufe ${orders.ORDER_LEVEL} mit Kürzel – vorher npm run dev:knick -- ${username}.`);

  const customers = await User.find({ _id: { $ne: owner._id }, deletedAt: null }).select('_id username balance').lean();
  if (!customers.length) throw new Error('Es gibt keine anderen Testspieler, die etwas einreichen könnten.');
  const pick = (i) => customers[i % customers.length];

  // Kunde, Bausteine und welche Karte passt; prepare macht eine Karte passend (Knick, Slab)
  const plan = [
    { label: 'Express + Slab', services: { slab: true, express: true }, fits: (c) => !c.slab && !c.creased },
    { label: 'Bügeln + Slab', services: { iron: true, slab: true }, fits: (c) => !c.slab && c.creased && !c.ironed, prepare: 'knick' },
    { label: 'Slab', services: { slab: true }, fits: (c) => !c.slab && !c.creased },
    { label: 'Zweitprüfung', services: { review: true }, fits: (c) => c.slab && c.slab.code !== shop.code, prepare: 'slab' },
  ];

  const done = [];
  for (const [i, step] of plan.entries()) {
    const customer = pick(i);
    let cards = await orders.submittable(customer._id);
    let card = cards.find(step.fits);
    if (!card && step.prepare) {
      // eine freie, unfolierte Karte passend machen
      const free = cards.find((c) => !c.slab && !c.foiledAt && !c.damaged);
      if (free) {
        const doc = await TcgCard.findById(free.id).select('condition').lean();
        if (step.prepare === 'knick') {
          const defects = addDamage(doc.condition && doc.condition.defects, 'knick');
          await TcgCard.updateOne({ _id: free.id }, { $set: { 'condition.defects': defects, 'condition.grade': gradeFor(defects), creased: true, damaged: true, ironedAt: null } });
        } else {
          const now = new Date();
          await TcgCard.updateOne({ _id: free.id }, { $set: { foiledAt: now, slab: { code: 'BfW', grade: (doc.condition && doc.condition.grade) || 7, at: now } } });
        }
        cards = await orders.submittable(customer._id);
        card = cards.find((c) => c.id === free.id && step.fits(c));
      }
    }
    if (!card) {
      console.log(`${tag} übersprungen: ${step.label} – ${customer.username} hat keine passende Karte.`);
      continue;
    }
    // genug Guthaben für den Testauftrag
    if (customer.balance < 500000) await User.updateOne({ _id: customer._id }, { $inc: { balance: 500000 } });
    try {
      const order = await orders.submit({ user: customer, shopCode: shop.code, doc: card.id, services: step.services });
      done.push(`${step.label}: „${card.card.name}“ von ${customer.username} (${(order.price / 100).toFixed(2).replace('.', ',')} €)`);
    } catch (err) {
      console.log(`${tag} übersprungen: ${step.label} von ${customer.username} – ${err.message}`);
    }
  }

  console.log(`${tag} ${shop.code} (${owner.username}): ${done.length} Auftrag/Aufträge eingereicht`);
  for (const line of done) console.log(`${tag}   ${line}`);
  console.log(`${tag} /grading neu laden – Eingang zeigt sie, „Auftrag annehmen“ holt Express zuerst.`);
}

main()
  .catch((err) => {
    // häufigster Fall: die Dev-Datenbank läuft nicht – sie gehört zu npm run dev
    const down = /ECONNREFUSED|Server selection timed out/i.test(err.message);
    console.error(`${tag} Fehlgeschlagen:`, down ? 'Keine Dev-Datenbank erreichbar – läuft „npm run dev“ in einem zweiten Terminal?' : err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

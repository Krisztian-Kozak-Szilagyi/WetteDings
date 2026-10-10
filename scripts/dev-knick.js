/**
 * Testdaten fürs Bügeln (#204, nur für die lokale Entwicklung): Knicke entstehen sonst nur selten – bei Kunden-
 * aufträgen (6 %) und wenn man in Quest, Dungeon oder Turm verliert.
 * In der laufenden Dev-Datenbank (npm run dev) bekommt ein Spieler:
 *   - einen Grading-Shop ab Stufe 2 (mit Namen und Kürzel, falls noch keiner),
 *   - einen offenen Kundenauftrag mit Knick (ein schon offener Auftrag bekommt den Knick, Bügeln und Note zurückgesetzt),
 *   - zwei eigene unfolierte Karten mit Knick (Grading-Shop → „Eigene Karten bügeln“, Album zeigt „Knick“),
 *   - eine eigene Karte mit zwei Kratzern (Album: eigener Platz, Kratzer in der Großansicht; Handel: einzelnes Exemplar),
 *   - einen BfW-Slab (wie die früheren Folien: Etikett mit Note, spielt nicht mit).
 *
 *   npm run dev                      (in einem zweiten Terminal laufen lassen)
 *   npm run dev:knick                für admin
 *   npm run dev:knick -- anna        für einen anderen Testspieler
 *
 * Danach /grading, /tcg/album oder /handel/neu neu laden.
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
const { GradingShop, GradingJob } = require(path.join(ROOT, 'src/models/Grading'));
const grading = require(path.join(ROOT, 'src/grading/gradingService'));
const { addDamage, gradeFor } = require(path.join(ROOT, 'src/grading/condition'));
const { today } = require(path.join(ROOT, 'src/services/bonusService'));

const OWN_CARDS = 2;

async function main() {
  const username = (process.argv[2] || 'admin').toLowerCase();
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
  const user = await User.findOne({ usernameLower: username }).select('_id username').lean();
  if (!user) throw new Error(`Spieler „${username}“ gibt es in der Dev-Datenbank nicht.`);

  // Shop: angestellt, mindestens Stufe 2 (Bügeln), Name und Kürzel
  const now = new Date();
  const shop = (await GradingShop.findById(user._id).lean()) || {};
  const level = Math.max(grading.IRON_LEVEL, shop.level || 1);
  const naming = shop.code ? {} : { name: `${user.username}s Kartenklinik`, code: `K${user.username.slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}` };
  await GradingShop.updateOne(
    { _id: user._id },
    { $set: { active: true, level, ironing: null, ...naming, ...(shop.active ? {} : { hiredAt: now, lockedUntil: new Date(now.getTime() + grading.CONTRACT_DAYS * 864e5) }) } },
    { upsert: true }
  );

  // Kundenauftrag mit Knick: der offene bekommt ihn, sonst ein neuer
  const knick = (defects) => (defects && defects.crease ? { ...defects } : addDamage(defects, 'knick'));
  const open = await GradingJob.findOne({ user: user._id, status: 'offen' }).lean();
  let job;
  if (open) {
    const defects = knick({ ...open.defects, creaseCap: undefined, ironed: undefined });
    delete defects.creaseCap;
    delete defects.ironed;
    await GradingJob.updateOne({ _id: open._id }, { $set: { level, defects, grade: gradeFor(defects), iron: null, guess: null } });
    job = open._id;
  } else {
    const defects = knick(grading.rollDefects());
    job = (await GradingJob.create({ user: user._id, day: today(), level, card: grading.rollCard(), customer: 'Dr. Brösel', spots: grading.rollSpots(), defects, grade: gradeFor(defects) }))._id;
  }

  // Eigene Karten mit Knick (wie nach einer verlorenen Quest)
  const fresh = await TcgCard.find({ user: user._id, foiledAt: null, damaged: { $ne: true } }).select('card condition').limit(OWN_CARDS + 2).lean();
  const cards = fresh.slice(0, OWN_CARDS);
  for (const c of cards) {
    const defects = addDamage(c.condition.defects, 'knick');
    await TcgCard.updateOne({ _id: c._id }, { $set: { 'condition.defects': defects, 'condition.grade': gradeFor(defects), creased: true, damaged: true, ironedAt: null } });
  }
  // Eine Karte mit zwei Kratzern
  const scratched = fresh[OWN_CARDS];
  if (scratched) {
    const defects = addDamage(addDamage(scratched.condition.defects, 'kratzer'), 'kratzer');
    await TcgCard.updateOne({ _id: scratched._id }, { $set: { 'condition.defects': defects, 'condition.grade': gradeFor(defects), damaged: true } });
  }
  // Ein BfW-Slab (wie nach der Migration foilToSlab)
  const slabbed = fresh[OWN_CARDS + 1];
  if (slabbed) await TcgCard.updateOne({ _id: slabbed._id }, { $set: { foiledAt: now, slab: { code: 'BfW', grade: slabbed.condition.grade, at: now } } });

  console.log(`[dev:knick] ${user.username}: Shop Stufe ${level}${naming.code ? ` („${naming.name}“, ${naming.code})` : ''}, Auftrag mit Knick (${job}), ${cards.length} eigene Karte(n) mit Knick${scratched ? ', 1 mit Kratzern' : ''}${slabbed ? ', 1 BfW-Slab' : ''}.`);
  console.log('[dev:knick] /grading, /tcg/album oder /handel/neu neu laden.');
}

main()
  .catch((err) => {
    // häufigster Fall: die Dev-Datenbank läuft nicht – sie gehört zu npm run dev
    const down = /ECONNREFUSED|Server selection timed out/i.test(err.message);
    console.error('[dev:knick] Fehlgeschlagen:', down ? 'Keine Dev-Datenbank erreichbar – läuft „npm run dev“ in einem zweiten Terminal?' : err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

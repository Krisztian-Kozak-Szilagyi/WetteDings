/**
 * Testdaten für die Manipulationserkennung (nur für die lokale Entwicklung).
 * Legt in der laufenden Dev-Datenbank (npm run dev) den verdächtigen Spieler "Grindmaster99" an, der jedes Muster
 * einmal zeigt, dazu "Grindmaster_alt" (gleiches Gerät, Mehrfach-Konto) und acht unauffällige Spieler als Vergleich
 * für die Einnahmen.
 * Danach läuft sofort ein Scan – die Hinweise stehen unter Admin → Moderation → Auffälligkeiten.
 *
 *   npm run dev                      (in einem zweiten Terminal laufen lassen)
 *   npm run dev:verdacht             Testdaten anlegen bzw. neu anlegen, dann scannen
 *   npm run dev:verdacht -- --weg    Testdaten und ihre Hinweise wieder entfernen
 *
 * Einzelne Muster lassen sich unten in PATTERNS auskommentieren; die Schwellen stehen in
 * src/moderation/suspicionLogic.js.
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
const bcrypt = require('bcryptjs');
const User = require(path.join(ROOT, 'src/models/User'));
const Ledger = require(path.join(ROOT, 'src/models/Ledger'));
const { IhkRun } = require(path.join(ROOT, 'src/models/Ihk'));
const { CoinTrade, CoinEvent } = require(path.join(ROOT, 'src/models/Coin'));
const { TcgCard } = require(path.join(ROOT, 'src/models/Tcg'));
const Achievement = require(path.join(ROOT, 'src/models/Achievement'));
const RankStint = require(path.join(ROOT, 'src/models/RankStint'));
const { DungeonRun } = require(path.join(ROOT, 'src/models/Dungeon'));
const { GradingJob } = require(path.join(ROOT, 'src/models/Grading'));
const { Trade } = require(path.join(ROOT, 'src/models/Trade'));
const { Device, DeviceAlert } = require(path.join(ROOT, 'src/models/Device'));
const ScriptSignal = require(path.join(ROOT, 'src/models/ScriptSignal'));
const ActionTrace = require(path.join(ROOT, 'src/models/ActionTrace'));
const SuspicionAlert = require(path.join(ROOT, 'src/models/SuspicionAlert'));
const catalog = require(path.join(ROOT, 'src/tcg/catalog'));
const config = require(path.join(ROOT, 'src/config'));
const { toZonedLocalInput } = require(path.join(ROOT, 'src/lib/time'));
const gradingService = require(path.join(ROOT, 'src/grading/gradingService'));
const deviceService = require(path.join(ROOT, 'src/device/deviceService'));
const suspicionService = require(path.join(ROOT, 'src/moderation/suspicionService'));

const MAIL = '@verdacht.dev.local'; // daran erkennt --weg die Testspieler
const SUSPECT = 'Grindmaster99'; // der verdächtige Testspieler
const TEST_EVENT_PRICE = -1; // Kurssprünge der Testdaten (kein echter Kurs ist negativ) – daran erkennt --weg sie
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const now = Date.now();
const at = (ms) => new Date(ms);
const day = (ms) => toZonedLocalInput(at(ms), config.timezone).slice(0, 10);
const hourBerlin = (ms) => Number(toZonedLocalInput(at(ms), config.timezone).slice(11, 13));
/** letzte volle Stunde vor ms, deren Uhrzeit (deutsche Zeit) test(h) erfüllt */
function lastHour(ms, test) {
  let t = Math.floor(ms / HOUR) * HOUR;
  while (!test(hourBerlin(t))) t -= HOUR;
  return t;
}
const cardOf = (rarity) => catalog.CARDS.find((c) => c.rarity === rarity) || catalog.CARDS[0];

// Jedes Muster: (verdächtiger Spieler, ctx) → schreibt seine Daten. ctx = { anna, filler, zweit }
const PATTERNS = {
  // Tempo und Takt: 24 Pack-Käufe im 2-s-Takt, 12 Bank-Verkäufe je 0,3 s, 8 Wett-Einsätze je 0,5 s
  async tempoTakt(u) {
    const t0 = now - 2 * HOUR;
    await Ledger.collection.insertMany(Array.from({ length: 24 }, (_, i) => ({ user: u._id, type: 'tcg_pack', amount: -9000, createdAt: at(t0 + i * 2000 + (i % 3) * 10) })));
    await Ledger.collection.insertMany(Array.from({ length: 12 }, (_, i) => ({ user: u._id, type: 'tcg_verkauf', amount: 50, createdAt: at(t0 + HOUR + i * 300) })));
    await Ledger.collection.insertMany(Array.from({ length: 8 }, (_, i) => ({ user: u._id, type: 'einsatz', amount: -100, createdAt: at(t0 + 30 * MIN + i * 500) })));
  },

  // IHK sekundengenau: 10 Quests nachts, je 1 s nach Ablauf abgeholt, 4 s später neu gestartet
  async ihk(u) {
    const card = cardOf('gold');
    let t = lastHour(now - 6 * HOUR, (h) => h === 1);
    const runs = [];
    for (let i = 0; i < 10; i++) {
      const endsAt = t + 10 * MIN;
      const collectedAt = endsAt + SEC;
      runs.push({ user: u._id, quest: 'testdaten', difficulty: 1, required: 100, card: card.id, cardDoc: new mongoose.Types.ObjectId(), day: day(t), endsAt: at(endsAt), total: 150, success: true, reward: 1000, collectedAt: at(collectedAt), status: 'fertig', createdAt: at(t) });
      t = collectedAt + 4 * SEC;
    }
    await IhkRun.collection.insertMany(runs);
  },

  // Broker-Scalping: 16 Runden, je 30 s gehalten, 15 im Plus
  async scalping(u) {
    const t0 = now - 3 * HOUR;
    const trades = [];
    for (let i = 0; i < 16; i++) {
      const t = t0 + i * 50 * SEC;
      trades.push({ user: u._id, coin: 'SAM', side: 'kauf', units: 1000, price: 50, cents: 50000, createdAt: at(t) });
      trades.push({ user: u._id, coin: 'SAM', side: 'verkauf', units: 1000, price: 50, cents: i === 15 ? 49950 : 50080, tax: 0, createdAt: at(t + 30 * SEC) });
    }
    await CoinTrade.collection.insertMany(trades);
  },

  // Dungeon-Automatik: 13 Termine in Folge (24 Std.), je 5 s nach Öffnen der Anmeldung, Beute nie angeschaut
  async dungeon(u) {
    const last = lastHour(now - HOUR, (h) => h % 2 === 0);
    const card = cardOf('gold');
    const runs = Array.from({ length: 13 }, (_, i) => {
      const slot = last - (12 - i) * 2 * HOUR;
      const member = { user: u._id, name: u.username, card: card.id, leader: false, reward: 5000, seen: false, joinedAt: at(slot - 2 * HOUR - 10 * SEC + 5 * SEC) };
      const bot = { user: null, name: 'Testdaten-Bot', card: card.id, leader: false, reward: 0, seen: false };
      return { slot: at(slot), dungeon: 'st-ivan', members: [member, bot], fights: [], success: true, startedAt: at(slot), endsAt: at(slot + 3 * MIN), status: 'fertig', chat: [], createdAt: at(slot) };
    });
    await DungeonRun.collection.insertMany(runs);
  },

  // Grading zur Mindestzeit: 8 Aufträge, je 0,5 s nach der frühestmöglichen Zeit, perfekt
  async grading(u) {
    const spots = Array.from({ length: 10 }, (_, i) => ({ side: 'front', x: i * 10, y: 50, r: 5, kind: 'fleck' }));
    const jobs = Array.from({ length: 8 }, (_, i) => {
      const created = now - (8 - i) * 20 * MIN;
      return { user: u._id, day: day(created), level: 3, card: cardOf('holo').id, customer: 'Testdaten', spots, defects: {}, grade: 8, status: 'fertig', guess: 8, clean: 100, seal: 100, pay: 3000, foilFound: false, createdAt: at(created), doneAt: at(created + spots.length * gradingService.MS_PER_SPOT + 500) };
    });
    await GradingJob.collection.insertMany(jobs);
  },

  // Rund um die Uhr: 32 Std. lang alle 30 Minuten ein Bank-Verkauf (auch nachts)
  async dauer(u) {
    await Ledger.collection.insertMany(Array.from({ length: 65 }, (_, i) => ({ user: u._id, type: 'tcg_verkauf', amount: 400, createdAt: at(now - 32 * HOUR + i * 30 * MIN) })));
  },

  // Ungewöhnliche Einnahmen: der Verdächtige 900 € Dungeon-Lohn, acht Vergleichsspieler je 30–40 € IHK-Lohn
  async ertrag(u, { filler }) {
    await Ledger.collection.insertMany(filler.map((f, i) => ({ user: f._id, type: 'ihk_lohn', amount: 3000 + i * 100, createdAt: at(now - 2 * HOUR) })));
    await Ledger.collection.insertMany([{ user: u._id, type: 'dungeon_lohn', amount: 90000, createdAt: at(now - HOUR) }]);
  },

  // Wertverschiebung: die teuerste Karte für 1 € an anna
  async wert(u, { anna }) {
    if (!anna) return;
    const card = [...catalog.CARDS].sort((a, b) => (catalog.rarityByKey[b.rarity].sell || 0) - (catalog.rarityByKey[a.rarity].sell || 0))[0];
    await Trade.collection.insertOne({ kind: 'privat', seller: u._id, sellerName: u.username, to: anna._id, toName: anna.username, buyer: anna._id, buyerName: anna.username, give: [{ card: card.id }], want: [], price: 100, status: 'verkauft', expiresAt: at(now), closedAt: at(now - 20 * MIN), createdAt: at(now - HOUR) });
  },

  // Browser-Merkmale, Reaktionszeit, Eingaben, Falle, Rechenzentrum (Tages-Dokument wie aus requestSignals.js)
  async signale(u) {
    await ScriptSignal.collection.insertOne({
      user: u._id,
      day: day(now),
      actions: 60,
      noProbe: 40,
      noFetchMeta: 40,
      bare: 40,
      webdriver: 3,
      botUa: 5,
      uas: ['python-requests/2.31.0', 'Mozilla/5.0 HeadlessChrome/140.0'],
      tokenOk: 50,
      tokenMissing: 8,
      tokenBad: 0,
      tokenReused: 6,
      fast: 45,
      dwell: Array.from({ length: 50 }, (_, i) => 110 + (i % 5) * 5),
      withInput: 50,
      noInput: 48,
      synthetic: 12,
      hosting: 10,
      nets: ['Hetzner Online GmbH (AS24940)'],
      trap: 2,
      firstAt: at(now - 3 * HOUR),
      lastAt: at(now - 5 * MIN),
    });
  },

  // Gleichzeitig von zwei Geräten: zweimal je 6 Aktionen abwechselnd von Server (A) und Handy (B)
  async parallel(u) {
    const traces = [];
    for (const start of [now - 5 * HOUR, now - HOUR]) {
      for (let i = 0; i < 6; i++) traces.push({ user: u._id, dev: i % 2 ? 'handy0000000' : 'server000000', net: i % 2 ? 'netz-handy' : 'netz-server', at: at(start + i * MIN) });
    }
    await ActionTrace.collection.insertMany(traces);
  },

  // Kartenkreislauf und Platz 1 mit geliehenem Wert: die Sith-Karte geht für eine Crumpled-Karte reihum
  // (Verdächtiger → Zweitkonto → lena → zurück); das Zweitkonto steht danach 26 Std. vorne und bekommt "Thronfolger"
  async kreislauf(u, { zweit, filler }) {
    const sith = catalog.CARDS.find((c) => c.rarity === 'sith') || cardOf('icon');
    const crumpled = cardOf('crumpled');
    const doc = new mongoose.Types.ObjectId();
    const t0 = now - 4 * 24 * HOUR;
    const steps = [
      [u, zweit, t0],
      [zweit, filler[0], t0 + 27 * HOUR],
      [filler[0], u, t0 + 50 * HOUR],
    ];
    await Trade.collection.insertMany(
      steps.map(([from, to, t]) => ({ kind: 'tausch', seller: from._id, sellerName: from.username, to: to._id, toName: to.username, buyer: to._id, buyerName: to.username, give: [{ card: sith.id, doc }], want: [{ card: crumpled.id, doc: new mongoose.Types.ObjectId() }], price: 0, status: 'verkauft', expiresAt: at(t), closedAt: at(t), createdAt: at(t - MIN) }))
    );
    await TcgCard.collection.insertOne({ _id: doc, user: u._id, card: sith.id, rarity: sith.rarity, createdAt: at(t0 - 24 * HOUR), tradedAt: at(t0 + 50 * HOUR), tradedCost: 300 });
    await Achievement.collection.insertOne({ user: zweit._id, key: 'thronfolger', reward: 10000, earnedAt: at(t0 + 25 * HOUR), seenAt: at(t0 + 25 * HOUR) });
    await RankStint.collection.insertOne({ user: zweit._id, from: at(t0 + MIN), to: at(t0 + 26 * HOUR), minLead: 150000 });
  },

  // Sammelkonto: drei Vergleichsspieler geben dem Verdächtigen je eine Glitch-Karte für 1 €
  async netz(u, { filler }) {
    const glitch = cardOf('glitch');
    await Trade.collection.insertMany(
      filler.slice(1, 4).map((f, i) => ({ kind: 'privat', seller: f._id, sellerName: f.username, to: u._id, toName: u.username, buyer: u._id, buyerName: u.username, give: [{ card: glitch.id, doc: new mongoose.Types.ObjectId() }], want: [], price: 100, extraFrom: 'to', status: 'verkauft', expiresAt: at(now), closedAt: at(now - (10 + i) * HOUR), createdAt: at(now - (11 + i) * HOUR) }))
    );
  },

  // Reaktion auf Kurssprünge: 8 Sprünge in den letzten Tagen, je 4–6 s danach gehandelt (2 davon nachts)
  async markt(u) {
    const events = Array.from({ length: 8 }, (_, i) => ({ coin: 'SAM', at: at(i < 2 ? lastHour(now - (i + 1) * 24 * HOUR, (h) => h === 3) : now - (i * 7 + 5) * HOUR), type: i % 2 ? 'einbruch' : 'anstieg', change: i % 2 ? -0.18 : 0.22, price: TEST_EVENT_PRICE }));
    await CoinEvent.collection.insertMany(events);
    await CoinTrade.collection.insertMany(events.map((e, i) => ({ user: u._id, coin: 'SAM', side: e.change > 0 ? 'verkauf' : 'kauf', units: 1000, price: 50, cents: 50000, createdAt: at(e.at.getTime() + (4 + (i % 3)) * SEC) })));
  },

  // Mehrfach-Konto: das Zweitkonto meldet sich mit demselben Gerät (Cookie) an wie der Verdächtige → "Sicher"
  async mehrfach(u, { zweit }) {
    await deviceService.record({ userId: u._id, deviceId: 'testdaten-geraet-1', fp: 'a'.repeat(32), ip: 'testdaten-ip', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0' });
    await deviceService.record({ userId: zweit._id, deviceId: 'testdaten-geraet-1', fp: 'a'.repeat(32), ip: 'testdaten-ip', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0' });
  },
};

/** Alle Testspieler und alles, was an ihnen hängt, entfernen */
async function remove() {
  const ids = (await User.find({ email: new RegExp(`${MAIL.replace(/\./g, '\\.')}$`) }).select('_id').lean()).map((u) => u._id);
  if (!ids.length) return 0;
  await Promise.all([
    Ledger.deleteMany({ user: { $in: ids } }),
    IhkRun.deleteMany({ user: { $in: ids } }),
    CoinTrade.deleteMany({ user: { $in: ids } }),
    DungeonRun.deleteMany({ 'members.user': { $in: ids } }),
    GradingJob.deleteMany({ user: { $in: ids } }),
    Trade.deleteMany({ seller: { $in: ids } }),
    TcgCard.deleteMany({ user: { $in: ids } }),
    Achievement.deleteMany({ user: { $in: ids } }),
    RankStint.deleteMany({ user: { $in: ids } }),
    CoinEvent.deleteMany({ price: TEST_EVENT_PRICE }),
    Device.deleteMany({ user: { $in: ids } }),
    DeviceAlert.deleteMany({ users: { $in: ids } }),
    ScriptSignal.deleteMany({ user: { $in: ids } }),
    ActionTrace.deleteMany({ user: { $in: ids } }),
    SuspicionAlert.deleteMany({ users: { $in: ids } }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
  return ids.length;
}

async function main() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
  } catch {
    console.error('Keine Dev-Datenbank erreichbar – läuft "npm run dev" in einem anderen Terminal?');
    process.exit(1);
  }
  try {
    const removed = await remove();
    if (removed) console.log(`Alte Testdaten entfernt (${removed} Spieler).`);
    if (process.argv.includes('--weg')) return;

    const passwordHash = await bcrypt.hash('test1234', 10);
    const mk = (username) => ({ username, usernameLower: username.toLowerCase(), email: `${username}${MAIL}`, passwordHash, balance: 100000 });
    const normal = ['lena', 'tom', 'mia', 'paul', 'sofia', 'jonas', 'emma', 'felix'];
    const [skript, zweit, ...filler] = await User.insertMany([mk(SUSPECT), mk(`${SUSPECT.replace(/\d+$/, '')}_alt`), ...normal.map(mk)]);
    const anna = await User.findOne({ usernameLower: 'anna' }).lean();
    for (const [name, fill] of Object.entries(PATTERNS)) {
      await fill(skript, { anna, filler, zweit });
      console.log(`  ✓ ${name}`);
    }
    const found = await suspicionService.scan(new Date());
    const alerts = await SuspicionAlert.find({ users: { $in: [skript._id, zweit._id] } }).select('kind action level').lean();
    console.log(`Scan: ${found} Funde, davon ${alerts.length} für "${skript.username}" und sein Zweitkonto:`);
    for (const a of alerts) console.log(`  - ${a.kind}${a.action ? ` (${a.action})` : ''}: ${a.level === 2 ? 'Wahrscheinlich' : 'Möglich'}`);
    const group = (await suspicionService.listGroups()).find((g) => g.users.length === 1 && String(g.users[0]._id) === String(skript._id));
    if (group && group.rating) console.log(`Gesamtbewertung: ${group.rating.label} – ${group.rating.reason}`);
    console.log(`Ansehen: http://127.0.0.1:3000/admin?bereich=moderation (als admin / test1234). Anmeldung als "${skript.username}" oder "${zweit.username}" ebenfalls mit test1234.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Testdaten fehlgeschlagen:', err);
  process.exit(1);
});

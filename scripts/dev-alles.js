/**
 * Ein Testkonto bekommt alles, was es im Spiel zu besitzen gibt (nur für die lokale Entwicklung):
 *   - Spielgeld und Konfetti
 *   - jede Karte zweimal (auch die Test-Karten fürs Kampfmodus-Testen), alle im Album als besessen und erbeutet
 *   - Booster Packs jeder Art
 *   - Gegenstände jeder Art (TCG Sleeves, leere Slabs …)
 *   - alle Avatare (Kosmetik)
 *   - alle Erfolge (ohne Belohnung und ohne Fenster beim nächsten Seitenaufruf)
 * Mehrfach ausführbar: es wird nur aufgefüllt, nichts doppelt angelegt. Unveröffentlichte Karten bleiben weg.
 *
 *   npm run dev                      (in einem zweiten Terminal laufen lassen)
 *   npm run dev:alles                für admin
 *   npm run dev:alles -- anna        für einen anderen Testspieler
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
const Achievement = require(path.join(ROOT, 'src/models/Achievement'));
const { TcgCard, TcgPack } = require(path.join(ROOT, 'src/models/Tcg'));
const { Item, ItemStack } = require(path.join(ROOT, 'src/models/Item'));
const catalog = require(path.join(ROOT, 'src/tcg/catalog'));
const items = require(path.join(ROOT, 'src/items/itemService'));
const cosmetics = require(path.join(ROOT, 'src/cosmetics/catalog'));
const { ACHIEVEMENTS } = require(path.join(ROOT, 'src/achievements/list'));

const tag = '[dev:alles]';
const BALANCE = 100000000; // 1.000.000 € in Cent
const KONFETTI = 100000;
const COPIES = 2; // je Karte – so lassen sich auch Duplikate verkaufen, zerkleinern und aufwerten
const PACKS = 20; // je Pack-Art
const ITEMS = 50; // je Gegenstand

async function main() {
  const username = (process.argv[2] || 'admin').toLowerCase();
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
  const user = await User.findOne({ usernameLower: username }).select('_id username').lean();
  if (!user) throw new Error(`Spieler „${username}“ gibt es in der Dev-Datenbank nicht.`);
  const uid = user._id;

  // Karten: fehlende Exemplare bis COPIES auffüllen
  const all = [...catalog.CARDS, ...catalog.TEST_CARDS];
  const have = await TcgCard.aggregate([{ $match: { user: uid } }, { $group: { _id: '$card', n: { $sum: 1 } } }]);
  const count = new Map(have.map((h) => [h._id, h.n]));
  const cards = all.flatMap((c) => Array.from({ length: Math.max(0, COPIES - (count.get(c.id) || 0)) }, () => ({ user: uid, card: c.id, rarity: c.rarity })));
  if (cards.length) await TcgCard.insertMany(cards);
  const ids = all.map((c) => c.id);

  // Booster Packs jeder Art
  let packs = 0;
  for (const p of catalog.PACK_TYPES) {
    const n = PACKS - (await TcgPack.countDocuments({ user: uid, type: p.key }));
    if (n > 0) {
      await TcgPack.insertMany(Array.from({ length: n }, () => ({ user: uid, type: p.key, source: 'admin' })));
      packs += n;
    }
  }

  // Gegenstände jeder Art (über den itemService, damit jede Bewegung im Protokoll steht)
  let itemCount = 0;
  for (const t of items.ITEM_TYPES) {
    const owned = t.storage === 'stapel' ? ((await ItemStack.findOne({ user: uid, type: t.key }).lean()) || {}).count || 0 : await Item.countDocuments({ user: uid, type: t.key });
    const n = ITEMS - owned;
    if (n > 0) {
      await items.addItems({ userIds: [uid], type: t.key, count: n, source: 'admin' });
      itemCount += n;
    }
  }

  // Erfolge: freigeschaltet und schon gesehen, ohne Belohnung (sonst gäbe es pro Erfolg 100 € dazu)
  const now = new Date();
  const ach = await Achievement.bulkWrite(
    ACHIEVEMENTS.map((a) => ({ updateOne: { filter: { user: uid, key: a.key }, update: { $setOnInsert: { reward: 0, earnedAt: now, seenAt: now } }, upsert: true } }))
  );

  // Geld, Konfetti, Avatare, Album (schon besessen / selbst erbeutet)
  await User.updateOne(
    { _id: uid },
    {
      $set: { balance: BALANCE, debt: 0 },
      $max: { konfetti: KONFETTI },
      $addToSet: { cosmetics: { $each: cosmetics.AVATARS.map((a) => cosmetics.ownedKey(a.kind, a.key)) }, tcgSeen: { $each: ids }, tcgLooted: { $each: ids } },
    }
  );

  console.log(`${tag} ${user.username} besitzt jetzt alles:`);
  console.log(`${tag}   ${all.length} Karten je ${COPIES}× (${cards.length} neu angelegt, davon ${catalog.TEST_CARDS.length} Test-Karten)`);
  console.log(`${tag}   ${catalog.PACK_TYPES.length} Pack-Art(en) je ${PACKS}× (${packs} neu), ${items.ITEM_TYPES.length} Gegenstände je ${ITEMS}× (${itemCount} neu)`);
  console.log(`${tag}   ${cosmetics.AVATARS.length} Avatare, ${ACHIEVEMENTS.length} Erfolge (${ach.upsertedCount} neu), ${KONFETTI} Konfetti, ${(BALANCE / 100).toLocaleString('de-DE')} € Spielgeld`);
}

main()
  .catch((err) => {
    const down = /ECONNREFUSED|Server selection timed out/i.test(err.message);
    console.error(`${tag} Fehlgeschlagen:`, down ? 'Keine Dev-Datenbank erreichbar – läuft „npm run dev“ in einem zweiten Terminal?' : err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

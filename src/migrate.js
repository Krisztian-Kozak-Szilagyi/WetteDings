const config = require('./config');
const Bet = require('./models/Bet');
const { TcgCard, TcgOpening } = require('./models/Tcg');
const { IhkRun } = require('./models/Ihk');
const { Trade } = require('./models/Trade');
const { migrateTradeDoc } = require('./trade/lines');
const User = require('./models/User');
const Ledger = require('./models/Ledger');
const { LotteryRound } = require('./models/Lottery');
const { rollCondition, gradeFor, conditionV3 } = require('./grading/condition');
const { GradingJob, GradingShop } = require('./models/Grading');

/**
 * Datenbank-Migrationen, die beim Start laufen. Idempotent – mehrfaches Ausführen schadet nicht.
 */
async function migrate() {
  await migrateTrades();

  // Wochen-/Monats-Lotterie: Rundennummer und offene Runde gelten jetzt je Lotterie-Art – alte Indizes entfernen
  const lottoIdx = await LotteryRound.collection.indexes().catch(() => []);
  for (const name of ['number_1', 'status_1']) {
    if (lottoIdx.some((i) => i.name === name)) {
      await LotteryRound.collection.dropIndex(name);
      console.log(`Migration: Lotterie-Index ${name} entfernt.`);
    }
  }
  await LotteryRound.createIndexes();
  // Erfolge: der eindeutige Index (Mitglied + Erfolg) muss stehen, bevor der erste Erfolg vergeben wird
  await require('./models/Achievement').createIndexes();
  // Mage Tower: mehrere Läufe pro Tag möglich – der alte Index (ein Versuch pro Tag) muss weg, alte Einträge sind Lauf 1;
  // der neue eindeutige Index muss vor dem ersten Turm-Start stehen
  const { TowerAttempt } = require('./models/Dungeon');
  const towerIdx = await TowerAttempt.collection.indexes().catch(() => []);
  if (towerIdx.some((i) => i.name === 'user_1_day_1')) {
    await TowerAttempt.collection.dropIndex('user_1_day_1');
    console.log('Migration: Mage-Tower-Index user_1_day_1 entfernt.');
  }
  await TowerAttempt.collection.updateMany({ n: { $exists: false } }, { $set: { n: 1, esports: false } });
  await TowerAttempt.createIndexes();
  // eSports: ein Spieler in höchstens einem Team – eindeutiger Index vor dem ersten Beitritt
  await require('./models/Esports').EsportsTeam.createIndexes();
  // Grading-Shop (#204): Kürzel eindeutig – Index vor dem ersten Benennen
  await GradingShop.createIndexes();
  // #204: Festpreise je Baustein statt eines Paketpreises – der alte Preis abzüglich der Standard-Reinigung wird der
  // Preis für Benoten + Slab (geklemmt wird beim Lesen, orderService.shopPrices)
  const repriced = await migrateShopPrices();
  if (repriced) console.log(`Migration: Paketpreis von ${repriced} Grading-Shop(s) auf Bausteinpreise umgestellt.`);

  // v1 -> v2: totalJa/totalNein wurden zu einer Options-Liste
  const res = await Bet.collection.updateMany({ options: { $exists: false } }, [
    {
      $set: {
        type: 'janein',
        options: [
          { key: 'ja', label: 'Ja', total: { $ifNull: ['$totalJa', 0] } },
          { key: 'nein', label: 'Nein', total: { $ifNull: ['$totalNein', 0] } },
        ],
      },
    },
    { $unset: ['totalJa', 'totalNein'] },
  ]);
  if (res.modifiedCount) console.log(`Migration: ${res.modifiedCount} Wette(n) auf Options-Format umgestellt.`);

  // Provision gesenkt: noch offene Wetten mit höherer Provision auf den aktuellen Satz setzen
  // (nur zugunsten der Teilnehmer; abgeschlossene Wetten bleiben unverändert)
  const fee = await Bet.updateMany(
    { status: 'offen', creatorFeePercent: { $gt: config.creatorFeePercent } },
    { $set: { creatorFeePercent: config.creatorFeePercent } }
  );
  if (fee.modifiedCount) {
    console.log(`Migration: Provision bei ${fee.modifiedCount} offenen Wette(n) auf ${config.creatorFeePercent} % gesenkt.`);
  }

  // Schiedsrichter-Verfahren: Altbestand bekommt die neuen Felder (Wetten von davor haben keinen
  // Schiedsrichter – dort entscheidet weiterhin der Ersteller allein, siehe lib/verdict)
  const votes = await Bet.collection.updateMany({ votes: { $exists: false } }, { $set: { votes: [], disputed: false } });
  if (votes.modifiedCount) console.log(`Migration: ${votes.modifiedCount} Wette(n) auf das Schiedsrichter-Verfahren vorbereitet.`);

  // Good Boy wurde entfernt: Wer ihn hatte, bekommt stattdessen Lilly (auch in Quests, Angeboten und im Verlauf)
  const from = 'good-boy-holo';
  const to = 'lilly-holo';
  const dogs = await TcgCard.updateMany({ card: from }, { $set: { card: to } });
  if (dogs.modifiedCount) console.log(`Migration: ${dogs.modifiedCount}× Good Boy durch Lilly ersetzt.`);
  await IhkRun.updateMany({ card: from }, { $set: { card: to } });
  await IhkRun.updateMany({ boost: from }, { $set: { boost: to } });
  for (const side of ['give', 'want']) {
    await Trade.updateMany({ [`${side}.card`]: from }, { $set: { [`${side}.$[l].card`]: to } }, { arrayFilters: [{ 'l.card': from }] });
  }
  await TcgOpening.updateMany({ 'cards.card': from }, { $set: { 'cards.$[c].card': to } }, { arrayFilters: [{ 'c.card': from }] });

  // "Schon besessen" (tcgSeen) für Altbestand nachtragen: aktuelle Karten, alle geöffneten Packs und
  // alle über den Handel erhaltenen Karten. Läuft nur für Konten, die das Feld noch nicht haben.
  const todo = await User.find({ tcgSeen: { $exists: false } }).select('_id').lean();
  if (todo.length) {
    const ids = todo.map((u) => u._id);
    const seen = new Map(ids.map((id) => [String(id), new Set()]));
    const add = (user, card) => user && card && seen.has(String(user)) && seen.get(String(user)).add(card);
    const [cards, openings, trades] = await Promise.all([
      TcgCard.aggregate([{ $match: { user: { $in: ids } } }, { $group: { _id: { u: '$user', c: '$card' } } }]),
      TcgOpening.find({ user: { $in: ids } }).select('user cards.card').lean(),
      Trade.find({ status: 'verkauft' }).select('seller buyer to give.card want.card').lean(),
    ]);
    for (const c of cards) add(c._id.u, c._id.c);
    for (const o of openings) for (const c of o.cards) add(o.user, c.card);
    for (const t of trades) {
      for (const l of t.give || []) add(t.buyer || t.to, l.card);
      for (const l of t.want || []) add(t.seller, l.card);
    }
    await User.bulkWrite(
      ids.map((id) => ({ updateOne: { filter: { _id: id, tcgSeen: { $exists: false } }, update: { $set: { tcgSeen: [...seen.get(String(id))] } } } }))
    );
    console.log(`Migration: "schon besessen" für ${ids.length} Konto/Konten nachgetragen.`);
  }

  // "Selbst erbeutet" (tcgLooted, #127) für Altbestand nachtragen – zählt für den Erfolg „Der Archivar“: alle
  // geöffneten Packs, Boss-Karten aus Dungeon und Mage Tower, Käufe im Black Market. Nicht: Handel, Duell, Vergabe.
  // Läuft vor dem Serverstart nur für Konten, die das Feld noch nicht haben.
  const lootTodo = await User.find({ tcgLooted: { $exists: false } }).select('_id').lean();
  if (lootTodo.length) {
    const { DungeonRun } = require('./models/Dungeon');
    const BlackMarket = require('./models/BlackMarket');
    const { defOf } = require('./dungeon/dungeons');
    const catalog = require('./tcg/catalog');
    const ids = lootTodo.map((u) => u._id);
    const looted = new Map(ids.map((id) => [String(id), new Set()]));
    const add = (user, card) => user && card && looted.has(String(user)) && catalog.cardById[card] && looted.get(String(user)).add(card);
    const [openings, runs, markets] = await Promise.all([
      TcgOpening.find({ user: { $in: ids } }).select('user cards.card').lean(),
      DungeonRun.find({ status: 'fertig', 'members.bossCard': true }).select('dungeon members.user members.bossCard').lean(),
      BlackMarket.find({ 'offers.buyer': { $in: ids } }).select('offers.card offers.buyer').lean(),
    ]);
    for (const o of openings) for (const c of o.cards) add(o.user, c.card);
    for (const r of runs) {
      const d = defOf(r.dungeon);
      for (const m of r.members) if (m.bossCard && d && d.bossCard) add(m.user, d.bossCard);
    }
    for (const day of markets) for (const o of day.offers) add(o.buyer, o.card); // Gegenstände ("item:…") sind keine Karten
    await User.bulkWrite(
      ids.map((id) => ({ updateOne: { filter: { _id: id, tcgLooted: { $exists: false } }, update: { $set: { tcgLooted: [...looted.get(String(id))] } } } }))
    );
    console.log(`Migration: "selbst erbeutet" für ${ids.length} Konto/Konten nachgetragen.`);
  }

  // Gelöschte Konten, auf denen sich (vor dem Fix in payOut) noch Auszahlungen gesammelt haben: Guthaben verfällt,
  // mit Buchung, damit die Summe aller Buchungen weiter der Geldmenge entspricht
  const shells = await User.find({ deletedAt: { $ne: null }, balance: { $gt: 0 } }).select('_id balance').lean();
  for (const u of shells) {
    const done = await User.updateOne({ _id: u._id, balance: u.balance }, { $set: { balance: 0 } });
    if (done.modifiedCount) await Ledger.create({ user: u._id, type: 'konto_geloescht', amount: -u.balance });
  }
  if (shells.length) console.log(`Migration: Guthaben von ${shells.length} gelöschten Konto/Konten verfallen lassen.`);

  // #73: Karten von vor dem geheimen Zustand bekommen ihn nachträglich (Verteilung "frisch", wie neue Karten)
  const conditioned = await rollMissingConditions();
  if (conditioned) console.log(`Migration: Zustand für ${conditioned} Karte(n) ausgewürfelt.`);

  // Zentrierung zählt nur noch links/rechts: Noten neu rechnen, wo oben/unten sie bisher gedrückt hat
  const regraded = await regradeWithoutTopBottom();
  if (regraded.cards || regraded.jobs) console.log(`Migration: Note ohne Oben/Unten-Zentrierung neu berechnet (${regraded.cards} Karte(n), ${regraded.jobs} Auftrag/Aufträge).`);

  // #204: frische Karten haben keine Kratzer und Knicke mehr – unfolierte verlieren sie, folierte bleiben, wie sie sind
  const v3 = await cleanFreshConditionsV3();
  if (v3) console.log(`Migration: Zustand von ${v3} Karte(n) auf Version 3 gehoben (ohne Kratzer/Knick, wenn unfoliert).`);

  // Offene Angebote mit foliertem Exemplar: Note wie das Foliendatum an der Position vermerken (Anzeige im Handel).
  // Nur alte Positionen ohne Feld slab (#204) – neue Folien sind Schutzhüllen, deren Note geheim bleibt
  const missing = { $elemMatch: { foiledAt: { $ne: null }, grade: null, slab: { $exists: false } } };
  const trades = await Trade.find({ status: 'offen', $or: [{ give: missing }, { want: missing }] }).select('give want').lean();
  if (trades.length) {
    const ids = trades.flatMap((t) => [...t.give, ...t.want].filter((l) => l.foiledAt).map((l) => l.doc || l.copy).filter(Boolean));
    const grades = new Map((await TcgCard.find({ _id: { $in: ids } }).select('condition.grade').lean()).map((d) => [String(d._id), d.condition && d.condition.grade]));
    const withGrade = (l) => (l.foiledAt && l.grade == null ? { ...l, grade: grades.get(String(l.doc || l.copy)) || null } : l);
    // roh: über das Schema bekämen die Positionen slab: null und gälten danach als Schutzhülle (foilToSlab)
    await Trade.collection.bulkWrite(trades.map((t) => ({ updateOne: { filter: { _id: t._id }, update: { $set: { give: t.give.map(withGrade), want: t.want.map(withGrade) } } } })));
    console.log(`Migration: Note bei ${trades.length} offenen Angebot(en) mit folierter Karte vermerkt.`);
  }

  // #204: Folie wird Schutzhülle (Sleeve, ohne Note) – bisher folierte Karten zeigten ihre Note und werden BfW-Slabs
  const slabbed = await foilToSlab();
  if (slabbed.cards || slabbed.damaged || slabbed.trades) console.log(`Migration: ${slabbed.cards} folierte Karte(n) zu BfW-Slabs, ${slabbed.damaged} mit sichtbarem Schaden markiert, ${slabbed.trades} Angebot(e) ergänzt.`);
  // #204: Ø-Marktpreis – abgeschlossene Geschäfte bekommen ihren Preisbezug (nach foilToSlab: Positionen kennen slab)
  const priced = await backfillPriceRefs();
  if (priced) console.log(`Migration: Preisbezug für ${priced} abgeschlossene(s) Geschäft(e) nachgetragen.`);
  // #204: Slabs bekommen ihre Zertifikatsnummer gespeichert (die Cert-Seite sucht danach)
  const certs = await backfillSlabCerts();
  if (certs) console.log(`Migration: Zertifikatsnummer bei ${certs} Slab(s) nachgetragen.`);
  const coded = await backfillPriceCodes();
  if (coded) console.log(`Migration: Shop-Kürzel bei ${coded} Slab-Verkauf/-Verkäufen nachgetragen.`);

  // #89: Hinweise auf Mehrfach-Konten mit den aktuellen Regeln neu bewerten (baugleiche Geräte im selben WLAN,
  // geteilte Netze wie das Schulnetz)
  await require('./device/deviceService').recomputeAlerts();

  await grantTestItems();
}

/**
 * Bosskampf-Test: Admins (ADMIN_USERNAMES) haben jede Test-Karte so oft, wie sie ins Deck darf (Items 1-mal,
 * Helden 2-mal – src/game/deck.js). Fehlende Exemplare kommen bei jedem Start dazu, überzählige bleiben.
 */
async function grantTestItems() {
  const catalog = require('./tcg/catalog');
  const { copyLimit } = require('./game/deck');
  const items = catalog.TEST_CARDS;
  if (!items.length || !config.adminUsernames.length) return;
  const admins = await User.find({ usernameLower: { $in: config.adminUsernames } }).select('_id').lean();
  let added = 0;
  for (const { _id: user } of admins) {
    const have = new Map((await TcgCard.aggregate([{ $match: { user, rarity: 'test-item' } }, { $group: { _id: '$card', n: { $sum: 1 } } }])).map((r) => [r._id, r.n]));
    const docs = items.flatMap((c) => Array.from({ length: Math.max(0, copyLimit(c) - (have.get(c.id) || 0)) }, () => ({ user, card: c.id, rarity: c.rarity })));
    if (!docs.length) continue;
    await TcgCard.insertMany(docs);
    await User.updateOne({ _id: user, tcgSeen: { $exists: true } }, { $addToSet: { tcgSeen: { $each: items.map((c) => c.id) } } });
    added += docs.length;
  }
  if (added) console.log(`Migration: ${added} Test-Item-Karte(n) an Admins vergeben.`);
}

/**
 * Handel (#76): Angebote mit einer Karte (card, wantCard …) bzw. dem Tausch mit give/take auf Positionen (give/want) umstellen und den alten
 * eindeutigen Index auf cardDoc durch den auf lockDocs ersetzen. Liest roh, weil das Schema die alten Felder nicht mehr kennt.
 */
async function migrateTrades() {
  const raw = Trade.collection;
  // Alten Index zuerst entfernen: Das Umstellen löscht cardDoc, und mehrere offene Angebote ohne cardDoc
  // verletzen sonst den eindeutigen Index (doppelter Schlüssel null)
  const idx = await raw.indexes().catch(() => []);
  if (idx.some((x) => x.name === 'cardDoc_1')) {
    await raw.dropIndex('cardDoc_1');
    console.log('Migration: alter Handels-Index cardDoc_1 entfernt.');
  }
  const old = await raw.find({ card: { $exists: true } }).toArray(); // beide Vorformen (siehe lines.migrateTradeDoc)
  for (let i = 0; i < old.length; i += 500) {
    const ops = old.slice(i, i + 500).map((t) => ({ updateOne: { filter: { _id: t._id }, update: migrateTradeDoc(t) } })).filter((op) => op.updateOne.update);
    if (ops.length) await raw.bulkWrite(ops, { ordered: false });
  }
  if (old.length) console.log(`Migration: ${old.length} Handelsangebot(e) auf Positionen umgestellt.`);
  await Trade.createIndexes();
}

/** Zustand für alle Karten ohne condition auswürfeln, in Blöcken. Gibt die Zahl der ergänzten Karten zurück. */
async function rollMissingConditions(batch = 1000) {
  let done = 0;
  for (;;) {
    const ids = await TcgCard.find({ condition: { $exists: false } }).select('_id').limit(batch).lean();
    if (!ids.length) return done;
    // Filter auch auf das fehlende Feld: läuft die Migration doppelt, bleibt ein schon gewürfelter Zustand stehen
    const res = await TcgCard.bulkWrite(ids.map(({ _id }) => ({ updateOne: { filter: { _id, condition: { $exists: false } }, update: { $set: { condition: rollCondition() } } } })));
    done += res.modifiedCount;
    if (ids.length < batch) return done;
  }
}

/**
 * Zentrierung zählt nur noch links/rechts. Neu gerechnet wird, was noch niemand gesehen hat: die geheime Note
 * unfolierter Karten und offene Grading-Aufträge ohne Tipp. Folierte Karten behalten ihre sichtbare Note.
 * Nur Zustände mit oben/unten über 55 können sich ändern (darunter galt ohnehin keine Grenze). Idempotent.
 */
async function regradeWithoutTopBottom() {
  // prefix: wo defects und grade im Dokument liegen ('condition.' bei Karten, '' bei Aufträgen)
  const regrade = async (coll, filter, prefix) => {
    const docs = await coll.find(filter).project({ [`${prefix}defects`]: 1, [`${prefix}grade`]: 1 }).toArray();
    const ops = [];
    for (const d of docs) {
      const holder = prefix ? d.condition : d;
      if (!holder || !holder.defects) continue;
      const grade = gradeFor({ scratches: [], corners: [], edges: [], ...holder.defects });
      if (grade !== holder.grade) ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { [`${prefix}grade`]: grade } } } });
    }
    if (ops.length) await coll.bulkWrite(ops, { ordered: false });
    return ops.length;
  };
  const tb = { $gt: 55 };
  const cards = await regrade(TcgCard.collection, { foiledAt: null, 'condition.defects.centering.tb': tb }, 'condition.');
  const jobs = await regrade(GradingJob.collection, { status: { $in: ['offen', 'angenommen'] }, guess: null, 'defects.centering.tb': tb }, '');
  return { cards, jobs };
}

/**
 * #204: Zustände auf Version 3 heben (conditionV3) – unfolierte Karten ohne Kratzer und Knick, folierte unverändert;
 * ein Knick, den man auf der Folie sieht, wird als sichtbares creased vermerkt. In Blöcken, idempotent über die
 * Version (auch im Filter: ein inzwischen erlittener Schaden wird nie überschrieben). Gibt die Zahl der Karten zurück.
 */
async function cleanFreshConditionsV3(batch = 1000) {
  const coll = TcgCard.collection; // roh: condition ist im Schema select: false
  const old = { 'condition.v': { $lt: 3 } };
  let done = 0;
  for (;;) {
    const docs = await coll.find(old).project({ condition: 1, foiledAt: 1 }).limit(batch).toArray();
    if (!docs.length) return done;
    const ops = docs.map((d) => {
      const condition = conditionV3(d.condition, !!d.foiledAt);
      return { updateOne: { filter: { _id: d._id, ...old }, update: { $set: { condition, creased: !!condition.defects.crease } } } };
    });
    done += (await coll.bulkWrite(ops, { ordered: false })).modifiedCount;
    if (docs.length < batch) return done;
  }
}

/** Sichtbarer Schaden aus den Mängeln (#204): mindestens ein Kratzer oder ein Knick */
const isDamaged = (defects) => !!defects && ((defects.scratches || []).length > 0 || !!defects.crease);

/**
 * #204: Bisher folierte Karten zeigten ihre Note auf einem Etikett „BfW GRADING“ – sie werden BfW-Slabs (Note sichtbar,
 * Wertsteigerung wie bisher). Ab jetzt ist eine neue Folie nur eine Schutzhülle ohne Note. Außerdem: damaged für alle
 * Karten mit Kratzer oder Knick, und Handelspositionen mit foliertem Exemplar bekommen slab (aus ihrer Note).
 * Idempotent: Karten mit Feld slab bzw. damaged und Positionen mit slab werden übersprungen. Läuft nach Version 3.
 */
async function foilToSlab(batch = 1000) {
  const coll = TcgCard.collection; // roh: condition ist im Schema select: false
  let cards = 0;
  for (;;) {
    const docs = await coll.find({ foiledAt: { $ne: null }, slab: { $exists: false } }).project({ foiledAt: 1, 'condition.grade': 1 }).limit(batch).toArray();
    if (!docs.length) break;
    const ops = docs.map((d) => ({ updateOne: { filter: { _id: d._id, slab: { $exists: false } }, update: { $set: { slab: { code: 'BfW', grade: (d.condition && d.condition.grade) || null, at: d.foiledAt } } } } }));
    cards += (await coll.bulkWrite(ops, { ordered: false })).modifiedCount;
    if (docs.length < batch) break;
  }
  // Neue Folien nach dieser Migration bekommen slab: null (Schema-Default) – nur Karten ohne das Feld sind alte
  await coll.updateMany({ foiledAt: null, slab: { $exists: false } }, { $set: { slab: null } });
  let damaged = 0;
  for (;;) {
    const docs = await coll.find({ damaged: { $exists: false } }).project({ 'condition.defects.scratches': 1, 'condition.defects.crease': 1 }).limit(batch).toArray();
    if (!docs.length) break;
    const ops = docs.map((d) => ({ updateOne: { filter: { _id: d._id, damaged: { $exists: false } }, update: { $set: { damaged: isDamaged(d.condition && d.condition.defects) } } } }));
    await coll.bulkWrite(ops, { ordered: false });
    damaged += docs.filter((d) => isDamaged(d.condition && d.condition.defects)).length;
    if (docs.length < batch) break;
  }
  const noSlab = { $elemMatch: { foiledAt: { $ne: null }, slab: { $exists: false } } };
  const trades = await Trade.collection.find({ $or: [{ give: noSlab }, { want: noSlab }] }).project({ give: 1, want: 1 }).toArray();
  const withSlab = (l) => (l.foiledAt && l.slab === undefined ? { ...l, slab: { code: 'BfW', grade: l.grade == null ? null : l.grade } } : l);
  if (trades.length) {
    await Trade.collection.bulkWrite(trades.map((t) => ({ updateOne: { filter: { _id: t._id }, update: { $set: { give: (t.give || []).map(withSlab), want: (t.want || []).map(withSlab) } } } })), { ordered: false });
  }
  return { cards, damaged, trades: trades.length };
}

/** #204: priceRef für abgeschlossene Geschäfte ohne das Feld (null = kein sauberer Verkauf). Idempotent. Gibt die Zahl zurück. */
async function backfillPriceRefs(batch = 1000) {
  const { priceRefOf } = require('./trade/marketPrice');
  const coll = Trade.collection;
  let done = 0;
  for (;;) {
    const docs = await coll.find({ status: 'verkauft', priceRef: { $exists: false } }).project({ give: 1, want: 1, price: 1, extraFrom: 1 }).limit(batch).toArray();
    if (!docs.length) return done;
    await coll.bulkWrite(docs.map((t) => ({ updateOne: { filter: { _id: t._id, priceRef: { $exists: false } }, update: { $set: { priceRef: priceRefOf(t) || null } } } })), { ordered: false });
    done += docs.length;
    if (docs.length < batch) return done;
  }
}

/**
 * #204 Etappe C: Slab-Verkäufe mit Preisbezug, aber ohne Kürzel (vor Etappe C abgeschlossen) bekommen es nachgetragen
 * (null, wenn verschiedene Shops im Paket waren). Idempotent über das Feld. Gibt die Zahl zurück.
 */
async function backfillPriceCodes() {
  const { priceRefOf } = require('./trade/marketPrice');
  const coll = Trade.collection;
  const docs = await coll.find({ 'priceRef.key': /\|slab-/, 'priceRef.code': { $exists: false } }).project({ give: 1, want: 1, price: 1, extraFrom: 1 }).toArray();
  if (!docs.length) return 0;
  await coll.bulkWrite(docs.map((t) => ({ updateOne: { filter: { _id: t._id }, update: { $set: { 'priceRef.code': (priceRefOf(t) || {}).code || null } } } })), { ordered: false });
  return docs.length;
}

/**
 * #204: Grading-Shops mit altem Paketpreis (Feld price) bekommen Bausteinpreise – Reinigung zum Standard, der Rest geht
 * auf Benoten + Slab, Bügeln und Express bleiben beim Standard. Idempotent über das Feld price. Gibt die Zahl zurück.
 */
async function migrateShopPrices() {
  const coll = GradingShop.collection;
  const docs = await coll.find({ price: { $exists: true } }).project({ price: 1 }).toArray();
  if (!docs.length) return 0;
  const base = require('./grading/gradingService').settings.servicePrice.base.def;
  await coll.bulkWrite(
    docs.map((d) => ({
      updateOne: {
        filter: { _id: d._id },
        update: Number.isInteger(d.price) ? { $set: { prices: { base: null, iron: null, slab: Math.max(0, d.price - base), express: null } }, $unset: { price: '' } } : { $unset: { price: '' } },
      },
    })),
    { ordered: false }
  );
  return docs.length;
}

/** #204: Slabs ohne gespeicherte Zertifikatsnummer bekommen sie (aus der Exemplar-ID, wie auf dem Etikett). Idempotent. */
async function backfillSlabCerts(batch = 1000) {
  const { slabCert } = require('./lib/viewHelpers');
  const coll = TcgCard.collection;
  let n = 0;
  for (;;) {
    const docs = await coll.find({ slab: { $type: 'object' }, 'slab.cert': { $exists: false } }).project({ _id: 1 }).limit(batch).toArray();
    if (!docs.length) break;
    await coll.bulkWrite(docs.map((d) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { 'slab.cert': slabCert(d._id) } } } })), { ordered: false });
    n += docs.length;
    if (docs.length < batch) break;
  }
  return n;
}

module.exports = { migrate, migrateShopPrices, backfillSlabCerts, regradeWithoutTopBottom, cleanFreshConditionsV3, foilToSlab, isDamaged, backfillPriceRefs, backfillPriceCodes };

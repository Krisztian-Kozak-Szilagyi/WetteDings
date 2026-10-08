const config = require('./config');
const Bet = require('./models/Bet');
const { TcgCard, TcgOpening } = require('./models/Tcg');
const { IhkRun } = require('./models/Ihk');
const { Trade } = require('./models/Trade');
const { migrateTradeDoc } = require('./trade/lines');
const User = require('./models/User');
const Ledger = require('./models/Ledger');
const { LotteryRound } = require('./models/Lottery');
const { rollCondition, gradeFor } = require('./grading/condition');
const { GradingJob } = require('./models/Grading');

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
  // Mage Tower: ein Versuch pro Tag – der eindeutige Index muss vor dem ersten Turm-Start stehen
  await require('./models/Dungeon').TowerAttempt.createIndexes();
  // eSports: ein Spieler in höchstens einem Team – eindeutiger Index vor dem ersten Beitritt
  await require('./models/Esports').EsportsTeam.createIndexes();

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

  // Offene Angebote mit foliertem Exemplar: Note wie das Foliendatum an der Position vermerken (Anzeige im Handel)
  const missing = { $elemMatch: { foiledAt: { $ne: null }, grade: null } };
  const trades = await Trade.find({ status: 'offen', $or: [{ give: missing }, { want: missing }] }).select('give want').lean();
  if (trades.length) {
    const ids = trades.flatMap((t) => [...t.give, ...t.want].filter((l) => l.foiledAt).map((l) => l.doc || l.copy).filter(Boolean));
    const grades = new Map((await TcgCard.find({ _id: { $in: ids } }).select('condition.grade').lean()).map((d) => [String(d._id), d.condition && d.condition.grade]));
    const withGrade = (l) => (l.foiledAt && l.grade == null ? { ...l, grade: grades.get(String(l.doc || l.copy)) || null } : l);
    await Trade.bulkWrite(trades.map((t) => ({ updateOne: { filter: { _id: t._id }, update: { $set: { give: t.give.map(withGrade), want: t.want.map(withGrade) } } } })));
    console.log(`Migration: Note bei ${trades.length} offenen Angebot(en) mit folierter Karte vermerkt.`);
  }

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
  const items = catalog.CARDS.filter((c) => c.rarity === 'test-item');
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
  const jobs = await regrade(GradingJob.collection, { status: 'offen', guess: null, 'defects.centering.tb': tb }, '');
  return { cards, jobs };
}

module.exports = { migrate, regradeWithoutTopBottom };

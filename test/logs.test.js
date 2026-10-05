process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const logs = require('../src/stats/logs');
const catalog = require('../src/tcg/catalog');
const { QUESTS } = require('../src/ihk/quests');
const { DUNGEONS } = require('../src/dungeon/dungeons');

const byRarity = (r) => catalog.CARDS.find((c) => c.rarity === r);
const crumpled = byRarity('crumpled');
const glitch = byRarity('glitch');

test('Protokolle: Seite aus der Adresse, begrenzt auf 1 … pages', () => {
  assert.deepStrictEqual(logs.pageOf(undefined, 0), { total: 0, pages: 1, page: 1 });
  assert.deepStrictEqual(logs.pageOf('3', 120), { total: 120, pages: 3, page: 3 });
  assert.equal(logs.pageOf('99', 120).page, 3);
  assert.equal(logs.pageOf('-2', 120).page, 1);
  assert.equal(logs.pageOf('abc', 120).page, 1);
});

test('Protokolle: Karten zusammengefasst, seltenste zuerst, ab Holo hervorgehoben', () => {
  const summary = logs.cardSummary([
    { card: crumpled.id, rarity: 'crumpled' },
    { card: glitch.id, rarity: 'glitch' },
    { card: crumpled.id, rarity: 'crumpled' },
  ]);
  assert.equal(summary.length, 2);
  assert.equal(summary[0].rarity, 'glitch');
  assert.equal(summary[0].rare, true);
  assert.deepStrictEqual({ count: summary[1].count, rare: summary[1].rare }, { count: 2, rare: false });
  assert.match(summary[1].label, /\(Crumpled\)$/);
  // Verkaufs-Meta zählt mit count
  assert.equal(logs.cardSummary([{ card: crumpled.id, rarity: 'crumpled', count: 4 }])[0].count, 4);
  assert.deepStrictEqual(logs.cardSummary(undefined), []);
});

test('Protokolle: Karten- und Gegenstandsnamen, unbekannte IDs bleiben stehen', () => {
  assert.equal(logs.cardLabel('item:folie'), 'Folie (Gegenstand)');
  assert.equal(logs.cardLabel('gibt-es-nicht'), 'gibt-es-nicht');
  assert.equal(logs.cardLabel(null), '–');
});

test('Protokolle: Pack-Öffnung mit Art und Herkunft, alte Öffnungen ohne', () => {
  const at = new Date();
  const row = logs.packRow({ createdAt: at, username: 'anna', cost: 1000, type: catalog.DEFAULT_PACK, source: 'quest', cards: [{ card: glitch.id, rarity: 'glitch' }], best: catalog.rarityByKey.glitch.rank });
  assert.equal(row.pack, catalog.packTypeByKey[catalog.DEFAULT_PACK].label);
  assert.equal(row.source, 'IHK-Fund');
  assert.equal(row.best, 'Glitch');
  const old = logs.packRow({ createdAt: at, username: 'anna', cost: 0, cards: [], best: 0 });
  assert.equal(old.pack, '–');
  assert.equal(old.source, '–');
});

test('Protokolle: Verkäufe aus der Buchung – Bank, Gegenstand, Black Market, alte ohne Details', () => {
  const at = new Date();
  const bank = logs.sellRow({ type: 'tcg_verkauf', amount: 1500, createdAt: at, meta: { cards: [{ card: crumpled.id, rarity: 'crumpled', count: 3 }] } }, 'anna');
  assert.equal(bank.kind, 'An die Bank verkauft');
  assert.equal(bank.items[0].count, 3);
  const item = logs.sellRow({ type: 'item_verkauf', amount: 500, createdAt: at, meta: { item: 'folie', count: 2 } }, 'anna');
  assert.deepStrictEqual(item.items.map((i) => [i.label, i.count]), [['Folie (Gegenstand)', 2]]);
  const bm = logs.sellRow({ type: 'black_market', amount: -9000, createdAt: at, meta: { card: glitch.id, rarity: 'glitch' } }, 'anna');
  assert.equal(bm.kind, 'Black Market gekauft');
  assert.equal(bm.items[0].rare, true);
  const old = logs.sellRow({ type: 'tcg_verkauf', amount: 500, createdAt: at, betTitle: 'Alte Buchung' }, undefined);
  assert.equal(old.player, '–');
  assert.equal(old.items[0].label, 'Alte Buchung');
});

test('Protokolle: IHK-Quest – laufend, geschafft mit Pack, gescheitert', () => {
  const q = QUESTS[0];
  const base = { quest: q.id, difficulty: 2, card: crumpled.id, boost: glitch.id, boost2: null, reward: 0, createdAt: new Date(), endsAt: new Date() };
  const running = logs.ihkRow({ ...base, status: 'laeuft', success: true }, 'anna');
  assert.equal(running.state, 'laeuft'); // Ergebnis bleibt bis zum Ablauf verborgen
  assert.equal(running.quest, q.title);
  assert.equal(running.difficulty, 'BFWler');
  assert.equal(running.boosts.length, 1);
  const won = logs.ihkRow({ ...base, status: 'fertig', success: true, reward: 2500, pack: catalog.DEFAULT_PACK }, 'anna');
  assert.equal(won.state, 'geschafft');
  assert.equal(won.pack, catalog.packTypeByKey[catalog.DEFAULT_PACK].label);
  assert.equal(logs.ihkRow({ ...base, status: 'fertig', success: false }, 'anna').state, 'gescheitert');
});

test('Protokolle: Dungeon – Fortschritt, gescheiterter Kampf, gesuchter Spieler markiert, Bots erkannt', () => {
  const d = DUNGEONS[0];
  const anna = new mongoose.Types.ObjectId();
  const row = logs.dungeonRow(
    {
      dungeon: d.key,
      status: 'fertig',
      success: false,
      startedAt: new Date(),
      endsAt: new Date(),
      fights: [{ key: d.fights[0].key, success: true }, { key: d.fights[1].key, success: false }], // nach dem Scheitern wird nicht weitergekämpft
      members: [
        { user: anna, name: 'anna', card: crumpled.id, reward: 1000, leader: true },
        { user: null, name: 'Bot Bernd', card: glitch.id },
      ],
    },
    anna
  );
  assert.equal(row.dungeon, d.title);
  assert.equal(row.progress, '1 / 3');
  assert.equal(row.failedAt, d.fights[1].title);
  assert.deepStrictEqual(row.members.map((m) => [m.name, m.highlight, m.bot]), [['anna', true, false], ['Bot Bernd', false, true]]);
  // ohne Spieler-Filter ist niemand markiert
  assert.equal(logs.dungeonRow({ dungeon: d.key, members: [{ user: anna, name: 'anna', card: crumpled.id }] }).members[0].highlight, false);
});

test('Protokolle: jeder Log hat einen eigenen Seiten-Parameter', () => {
  const pages = logs.LOGS.map((l) => l.page);
  assert.equal(new Set(pages).size, pages.length);
  assert.ok(logs.logByKey.handel && logs.logByKey.dungeon);
});

test('Protokolle-Export: CSV für Excel mit BOM, Semikolon, Euro mit Komma und Titel', () => {
  const data = {
    total: 1,
    rows: [logs.sellRow({ type: 'tcg_verkauf', amount: 1550, createdAt: new Date('2026-10-04T18:20:17Z'), meta: { cards: [{ card: crumpled.id, rarity: 'crumpled', count: 3 }] } }, 'anna')],
  };
  const csv = logs.toCsv('verkauf', data, { title: 'Protokoll – Verkäufe' });
  assert.ok(csv.startsWith('\uFEFF'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'Protokoll – Verkäufe');
  assert.equal(lines[3], 'Zeitpunkt;Spieler;Art;Anzahl;Karten / Gegenstände;Betrag (€)');
  assert.equal(lines[4], `04.10.2026 20:20:17;anna;An die Bank verkauft;3;3× ${logs.cardLabel(crumpled.id)};15,5`);
});

test('Protokolle-Export: Dungeons mit einer Zeile pro Teilnehmer, gekürzte Exporte markiert', () => {
  const d = DUNGEONS[0];
  const row = logs.dungeonRow({ dungeon: d.key, status: 'fertig', success: true, startedAt: new Date(), endsAt: new Date(), fights: d.fights.map((f) => ({ key: f.key, success: true })), members: [{ user: new mongoose.Types.ObjectId(), name: 'anna', card: crumpled.id, reward: 25000, foil: true }, { user: null, name: 'Bot', card: glitch.id }] });
  const lines = logs.toCsv('dungeon', { total: 5, rows: [row] }, { title: 'T' }).split('\r\n');
  assert.match(lines[1], /Einträge: 1 von 5 \(gekürzt\)/);
  const body = lines.slice(4).filter(Boolean);
  assert.equal(body.length, 2);
  assert.match(body[0], /;anna;;;.*;250;ja;$/);
  assert.match(body[1], /;Bot;ja;/);
});

test('Protokolle-Export: Dateiname ohne Umlaute und Sonderzeichen', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  assert.equal(logs.exportFileName('packs', 'Jürgen Ä.', 'csv', now), 'protokoll-packs-juergen-ae-2026-10-04.csv');
  assert.equal(logs.exportFileName('ihk', null, 'json', now), 'protokoll-ihk-2026-10-04.json');
});

test('Protokolle: Wetten – Ergebnis, Streitfall, Topf und Provision', () => {
  const base = { _id: new mongoose.Types.ObjectId(), title: 'Regnet es?', options: [{ key: 'ja', label: 'Ja', total: 3000 }, { key: 'nein', label: 'Nein', total: 2000 }], creatorName: 'anna', refereeName: 'ben', createdAt: new Date(), deadline: new Date() };
  const done = logs.betRow({ ...base, status: 'entschieden', outcome: 'nein', resolvedVia: 'dev', resolvedByName: 'admin', resolvedAt: new Date(), resolutionNote: 'Laut Wetterdienst', creatorFee: 100, refereeFee: 50, participants: 4 });
  assert.equal(done.result, 'Ergebnis: Nein');
  assert.equal(done.via, 'Dev (Streitfall)');
  assert.equal(done.pot, 5000);
  assert.equal(done.fees, 150);
  assert.equal(done.note, 'Laut Wetterdienst');
  assert.equal(logs.betRow({ ...base, status: 'offen', disputed: true }).result, 'Strittig');
  const voided = logs.betRow({ ...base, status: 'annulliert', voidReason: 'Doppelt' });
  assert.deepStrictEqual([voided.result, voided.note], ['Annulliert', 'Doppelt']);
});

test('Protokolle: Einsätze – offen, gewonnen, verloren, erstattet', () => {
  const bet = { title: 'Regnet es?', options: [{ key: 'ja', label: 'Ja' }] };
  const p = { bet: new mongoose.Types.ObjectId(), username: 'anna', side: 'ja', amount: 1000, createdAt: new Date() };
  assert.deepStrictEqual([logs.stakeRow({ ...p, payout: null }, bet).state, logs.stakeRow({ ...p, payout: null }, bet).net], ['offen', null]);
  const won = logs.stakeRow({ ...p, payout: 2500 }, bet);
  assert.deepStrictEqual([won.state, won.net, won.side], ['gewonnen', 1500, 'Ja']);
  assert.equal(logs.stakeRow({ ...p, payout: 0 }, bet).state, 'verloren');
  assert.equal(logs.stakeRow({ ...p, payout: 1000 }, bet).state, 'erstattet');
  assert.equal(logs.stakeRow({ ...p, payout: null }, undefined).bet, '(gelöschte Wette)');
});

test('Protokolle: Broker, Lotterie, Grading und Buchungen', () => {
  const buy = logs.coinRow({ coin: 'SAM', side: 'kauf', units: 150000000, price: 12.5, cents: 1875, createdAt: new Date() }, 'anna');
  assert.equal(buy.asset, 'Samantha Coin (SAM)');
  assert.equal(buy.cents, -1875); // Kauf = Abbuchung
  const sale = logs.coinRow({ coin: 'SAM', side: 'verkauf', units: 1, price: 1, cents: 500, tax: 25, createdAt: new Date() });
  assert.deepStrictEqual([sale.cents, sale.tax], [500, 25]);
  assert.equal(buy.tax, 0); // ältere Aufträge ohne Steuer

  const ticket = logs.lottoRow({ type: 'lotto_los', amount: -300, createdAt: new Date(), meta: { kind: 'woche', count: 3, round: 7 } }, 'anna');
  assert.deepStrictEqual([ticket.kind, ticket.lottery, ticket.count, ticket.round], ['Lose gekauft', 'Wochen-Lotterie', 3, 7]);
  const daily = logs.lottoRow({ type: 'lotto_gewinn', amount: 9000, createdAt: new Date() }, 'anna');
  assert.deepStrictEqual([daily.kind, daily.lottery, daily.count], ['Gewinn', 'Tages-Lotterie', null]);

  const job = logs.gradingRow({ level: 2, card: crumpled.id, customer: 'Kunde', grade: 8, guess: 7, clean: 90, seal: null, pay: 1200, status: 'fertig', foilFound: true, createdAt: new Date(), doneAt: new Date() }, 'anna');
  assert.deepStrictEqual([job.shop, job.done, job.foil], ['Grading-Labor', true, true]);

  const booking = logs.ledgerRow({ type: 'bonus', amount: 500, createdAt: new Date() }, 'anna');
  assert.deepStrictEqual([booking.kind, booking.betId], ['Tagesbonus', null]);
});

test('Protokolle-Export: jeder Log hat eine CSV-Spalte je Wert', () => {
  const at = new Date();
  const samples = {
    wetten: logs.betRow({ _id: 'x', title: 'T', options: [{ key: 'ja', label: 'Ja', total: 1 }], creatorName: 'a', status: 'offen', createdAt: at, deadline: at }),
    einsaetze: logs.stakeRow({ bet: 'x', username: 'a', side: 'ja', amount: 1, payout: null, createdAt: at }, null),
    broker: logs.coinRow({ coin: 'SAM', side: 'kauf', units: 1, price: 1, cents: 1, createdAt: at }, 'a'),
    lotterie: logs.lottoRow({ type: 'lotto_los', amount: -1, createdAt: at }, 'a'),
    konto: logs.ledgerRow({ type: 'bonus', amount: 1, createdAt: at }, 'a'),
    grading: logs.gradingRow({ level: 1, card: crumpled.id, customer: 'K', grade: 5, status: 'offen', pay: 0, createdAt: at }, 'a'),
    registrierungen: logs.registrationRow({ username: 'a', realName: 'Anna A.', registrationCode: 'ABCD2345', invitedByName: 'admin', createdAt: at }),
  };
  for (const [key, row] of Object.entries(samples)) {
    const lines = logs.toCsv(key, { total: 1, rows: [row] }).slice(1).split('\r\n').filter(Boolean);
    assert.equal(lines[1].split(';').length, lines[0].split(';').length, key);
  }
  assert.equal(logs.LOGS.length, logs.LOGS.filter((l) => logs.LOG_GROUPS.some((g) => g.key === l.group)).length);
});

test('Registrierungen: Code formatiert, ältere Konten ohne Code und Einladenden', () => {
  const at = new Date('2026-01-01T12:00:00Z');
  const row = logs.registrationRow({ username: 'anna', realName: 'Anna A.', registrationCode: 'ABCD2345', invitedByName: 'admin', createdAt: at });
  assert.deepEqual(row, { at, name: 'anna', realName: 'Anna A.', code: 'ABCD-2345', invitedBy: 'admin', deleted: false });
  const old = logs.registrationRow({ username: 'ben', createdAt: at, deletedAt: at });
  assert.deepEqual([old.realName, old.code, old.invitedBy, old.deleted], [null, null, null, true]);
});

test('Gesamt: deckt jedes Protokoll ab, Buchungen ohne Doppelte, neueste zuerst', () => {
  const covered = new Set(logs.GESAMT_SOURCES.map((s) => s.log));
  for (const l of logs.LOGS) if (l.key !== 'gesamt') assert.ok(covered.has(l.key), l.key);
  // Buchungsarten, die schon ein eigenes Protokoll haben, dürfen im Gesamtprotokoll nicht noch einmal als Buchung auftauchen
  for (const t of ['lotto_los', 'lotto_gewinn', 'tcg_verkauf', 'item_verkauf', 'black_market', 'einsatz', 'coin_kauf', 'coin_verkauf', 'startguthaben', 'team_gutschrift', 'team_abzug']) {
    assert.ok(!logs.GESAMT_LEDGER_TYPES.includes(t), t);
  }
  const d = (s) => new Date(`2026-01-0${s}T12:00:00Z`);
  const merged = logs.mergeRows([[{ at: d(3), text: 'a3' }, { at: d(1), text: 'a1' }], [{ at: d(2), text: 'b2' }, { at: d(3), text: 'b3' }]]);
  assert.deepEqual(merged.map((r) => r.text), ['a3', 'b3', 'b2', 'a1']);
  const csv = logs.toCsv('gesamt', { total: 1, rows: [{ at: d(1), logLabel: 'Wetten', player: 'anna', text: 'Wette', amount: -150 }] }).slice(1).split('\r\n');
  assert.equal(csv[1], '01.01.2026 13:00:00;Wetten;anna;Wette;-1,5'); // Euro wie in den anderen Protokollen (num)
});

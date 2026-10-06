// Manipulationserkennung: Wertfluss zwischen Konten (Kartenkreislauf, Platz 1 mit geliehenem Wert, Sammelkonten),
// Reaktion auf Kurssprünge, Trefferquote und der Anschaffungswert frisch gehandelter Karten (Rangliste)
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const s = require('../src/moderation/suspicionLogic');
const { costShares } = require('../src/trade/lines');
const { LEVEL } = require('../src/device/deviceLogic');

const t0 = Date.UTC(2026, 9, 5, 10, 0, 0); // 12:00 deutsche Zeit
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

test('Wertverschiebung: großer Betrag auch bei weniger krassem Verhältnis', () => {
  const values = { sith: 1000000, crumpled: 300 };
  const valueOf = (id) => values[id] || 0;
  // Sith-Karte (10.000 €) für 3.000 €: 7.000 € verschoben, obwohl die Gegenleistung über 20 % liegt
  const f = s.valueFinding({ kind: 'privat', seller: 'a', buyer: 'b', give: [{ card: 'sith' }], want: [], price: 300000 }, valueOf);
  assert.ok(f);
  assert.equal(f.to, 'b');
  assert.equal(f.shifted, 700000);
  // für 6.000 €: mehr als die Hälfte bezahlt – unauffällig
  assert.equal(s.valueFinding({ kind: 'privat', seller: 'a', buyer: 'b', give: [{ card: 'sith' }], want: [], price: 600000 }, valueOf), null);
  // gegen eine Crumpled-Karte: wie bisher
  assert.equal(s.valueFinding({ kind: 'tausch', seller: 'a', to: 'b', buyer: 'b', give: [{ card: 'sith' }], want: [{ card: 'crumpled' }], price: 0 }, valueOf).to, 'b');
  // Wertfluss eines fairen Geschäfts: nichts verschoben
  assert.equal(s.tradeFlow({ seller: 'a', buyer: 'b', give: [{ card: 'sith' }], want: [], price: 1000000 }, valueOf).shifted, 0);
});

test('Kartenkreislauf: Sith-Karte reihum, zurück an den ersten Besitzer', () => {
  const names = new Map([['a', 'Anna'], ['b', 'Ben'], ['c', 'Cem']]);
  const chain = [
    { from: 'a', to: 'b', at: new Date(t0), via: 'handel', counter: 300 },
    { from: 'b', to: 'c', at: new Date(t0 + 26 * HOUR), via: 'handel', counter: 300 },
    { from: 'c', to: 'a', at: new Date(t0 + 52 * HOUR), via: 'handel', counter: 0 },
  ];
  const earned = [{ user: 'b', label: 'Thronfolger', at: new Date(t0 + 25 * HOUR) }];
  const f = s.circulationFinding(chain, { value: 1000000, card: 'Oliver the Sigrist (Sith)', earned, names, now: t0 + 60 * HOUR });
  assert.ok(f);
  assert.equal(f.level, LEVEL.wahrscheinlich);
  assert.deepEqual(f.users, ['a', 'b', 'c']);
  assert.equal(f.returns, 1);
  assert.equal(f.perks, 1);
  assert.match(f.summary, /Oliver the Sigrist \(Sith\).*3× weitergegeben zwischen 3 Konten, 1× zurück/);
  assert.match(f.trades[0], /Anna → Ben \(Handel, Gegenwert 3,00\s€\), Ben hielt sie 26 Std\. · Erfolg „Thronfolger“/);
  assert.match(f.trades[2], /Anna hat sie seitdem/);

  // hin und zurück zwischen zwei Konten (Duell), mittlerer Wert, kein Erfolg: möglich
  const back = s.circulationFinding([chain[0], { from: 'b', to: 'a', at: new Date(t0 + 30 * MIN), via: 'duell', counter: 0 }], { value: 60000, now: t0 + HOUR });
  assert.equal(back.level, LEVEL.moeglich);
  assert.match(back.trades[0], /hielt sie 30 Min\./);
  assert.match(back.trades[1], /Duell/);
  // A → B → C ohne Rückkehr: drei Besitzer reichen
  assert.ok(s.circulationFinding(chain.slice(0, 2), { value: 60000 }));
  // billige Karte oder nur ein Besitzerwechsel: nichts
  assert.equal(s.circulationFinding(chain, { value: s.CIRC_MIN_CENTS - 1 }), null);
  assert.equal(s.circulationFinding(chain.slice(0, 1), { value: 1000000 }), null);
});

test('Platz 1 mit geliehenem Wert', () => {
  // Ben bekommt die Karte (netto 9.997 €) und liegt danach 30 Std. mit höchstens 2.000 € Vorsprung vorne
  const stints = [{ from: new Date(t0 + MIN), to: new Date(t0 + 30 * HOUR), minLead: 200000 }];
  const flows = [{ at: new Date(t0), net: 999700 }];
  const f = s.rankFinding(stints, flows, [{ label: 'Thronfolger', at: new Date(t0 + 24 * HOUR) }]);
  assert.ok(f);
  assert.equal(f.level, LEVEL.wahrscheinlich);
  assert.equal(f.total, 999700);
  assert.match(f.summary, /30 Std\. auf Platz 1 nur dank erhaltener Werte.*„Thronfolger“/);
  // ohne Erfolg und kurz: möglich
  assert.equal(s.rankFinding([{ from: new Date(t0 + MIN), to: new Date(t0 + 2 * HOUR), minLead: 200000 }], flows).level, LEVEL.moeglich);
  // Vorsprung größer als das Geschenk: auch ohne wäre er vorne gewesen
  assert.equal(s.rankFinding([{ ...stints[0], minLead: 2000000 }], flows), null);
  // Geschenk erst lange nach Beginn des Abschnitts: zählt nicht für diesen Abschnitt
  assert.equal(s.rankFinding(stints, [{ at: new Date(t0 + 2 * HOUR), net: 999700 }]), null);
  // zu kurz auf Platz 1
  assert.equal(s.rankFinding([{ from: new Date(t0 + MIN), to: new Date(t0 + 10 * MIN), minLead: 0 }], flows), null);
  // Wert weitergegeben (netto negativ): nichts
  assert.equal(s.rankFinding(stints, [{ at: new Date(t0), net: -999700 }]), null);
});

test('Sammelkonto: mehrere Geber, kaum Rückfluss', () => {
  const names = new Map([['z', 'Zentrale'], ['a', 'A'], ['b', 'B'], ['c', 'C']]);
  const at = new Date(t0);
  const flows = [
    { from: 'a', to: 'z', shifted: 50000, at },
    { from: 'b', to: 'z', shifted: 40000, at },
    { from: 'c', to: 'z', shifted: 30000, at },
  ];
  const [f] = s.funnelFindings(flows, { names });
  assert.equal(f.user, 'z');
  assert.equal(f.count, 3);
  assert.equal(f.total, 120000);
  assert.equal(f.level, LEVEL.moeglich);
  assert.match(f.trades[0], /A: netto 500,00\s€/);
  // ein Geber ist zugleich Mehrfach-Konto: wahrscheinlich
  assert.equal(s.funnelFindings(flows, { flagged: new Set(['a:z']) })[0].level, LEVEL.wahrscheinlich);
  // nur zwei Geber
  assert.deepEqual(s.funnelFindings(flows.slice(0, 2)), []);
  // es fließt viel zurück: gegenseitiger Handel, kein Sammelkonto
  assert.deepEqual(s.funnelFindings([...flows, { from: 'z', to: 'a', shifted: 40000, at }]), []);
  // kleine Unterschiede (unter 50 €) zählen nicht
  assert.deepEqual(s.funnelFindings(flows.map((x) => ({ ...x, shifted: s.FUNNEL_FLOW_CENTS - 1 }))), []);
});

test('Broker: Reaktion auf Kurssprünge', () => {
  // 8 Kurssprünge im Abstand von 3 Stunden (tagsüber), abwechselnd Anstieg und Einbruch
  const events = Array.from({ length: 8 }, (_, i) => ({ coin: 'SAM', at: new Date(t0 + i * 20 * MIN), type: i % 2 ? 'einbruch' : 'anstieg', change: i % 2 ? -0.2 : 0.2 }));
  events.push({ coin: 'SAM', at: new Date(t0 + 5 * MIN), type: 'aufteilung', change: 1 }); // Split zählt nicht
  // Skript: 4–6 s nach jedem Sprung, nach Anstieg verkaufen, nach Einbruch kaufen
  const bot = events.slice(0, 8).map((e, i) => ({ coin: 'SAM', side: e.change > 0 ? 'verkauf' : 'kauf', createdAt: new Date(e.at.getTime() + (4 + (i % 3)) * 1000) }));
  const f = s.marketReactionFinding(bot, events);
  assert.ok(f);
  assert.equal(f.count, 8);
  assert.equal(f.events, 8);
  assert.equal(f.aligned, 8);
  assert.equal(f.night, 0);
  assert.equal(f.level, LEVEL.moeglich);
  assert.match(f.summary, /Auf 8 von 8 Kurssprüngen im Schnitt 5 s danach gehandelt/);
  // nachts (2 Uhr deutscher Zeit) wird es wahrscheinlich
  const night = Date.UTC(2026, 9, 5, 0, 0, 0);
  const nightEvents = events.slice(0, 8).map((e, i) => ({ ...e, at: new Date(night + i * 5 * MIN) }));
  const nightBot = nightEvents.map((e) => ({ coin: 'SAM', side: 'kauf', createdAt: new Date(e.at.getTime() + 3000) }));
  assert.equal(s.marketReactionFinding(nightBot, nightEvents).level, LEVEL.wahrscheinlich);
  // Mensch: handelt Minuten nach den Sprüngen
  const human = events.slice(0, 8).map((e) => ({ coin: 'SAM', side: 'kauf', createdAt: new Date(e.at.getTime() + 4 * MIN) }));
  assert.equal(s.marketReactionFinding(human, events), null);
  // nur selten schnell: unter 30 % der Sprünge
  const many = Array.from({ length: 20 }, (_, i) => ({ coin: 'SAM', at: new Date(t0 + i * 20 * MIN), type: 'anstieg', change: 0.1 }));
  assert.equal(s.marketReactionFinding(bot.slice(0, 5), many), null);
  // andere Werte zählen nicht
  assert.equal(s.marketReactionFinding(bot.map((t) => ({ ...t, coin: 'ETF' })), events), null);
});

test('Trefferquote je Muster und Stufe aus dem Urteils-Protokoll', () => {
  const at = (min) => new Date(t0 + min * MIN);
  const events = [
    { key: 'dungeon:a', event: 'bestaetigt', kind: 'dungeon', level: 2, createdAt: at(1) },
    { key: 'dungeon:b', event: 'bestaetigt', kind: 'dungeon', level: 2, createdAt: at(2) },
    { key: 'dungeon:c', event: 'fehlalarm', kind: 'dungeon', level: 1, createdAt: at(3) },
    { key: 'dungeon:d', event: 'bestaetigt', kind: 'dungeon', level: 1, createdAt: at(4) },
    // zuerst Fehlalarm, später doch bestätigt: nur das letzte Urteil zählt, mit der Stufe von damals
    { key: 'dungeon:e', event: 'fehlalarm', kind: 'dungeon', level: 1, createdAt: at(5) },
    { key: 'dungeon:e', event: 'neue_belege', kind: 'dungeon', level: 2, createdAt: at(6) },
    { key: 'dungeon:e', event: 'bestaetigt', kind: 'dungeon', level: 2, createdAt: at(7) },
    // Urteil zurückgenommen: zählt nicht
    { key: 'markt:x', event: 'bestaetigt', kind: 'markt', level: 2, createdAt: at(8) },
    { key: 'markt:x', event: 'zurueckgenommen', kind: 'markt', level: 2, createdAt: at(9) },
  ];
  const rows = s.precisionRows(events.reverse(), new Map([['dungeon', 4], ['takt', 9], ['markt', 1]]));
  const dungeon = rows.find((r) => r.kind === 'dungeon');
  assert.equal(rows[0].kind, 'dungeon'); // Muster mit Urteilen zuerst
  assert.equal(dungeon.total, 4);
  assert.equal(dungeon.confirmed, 4);
  assert.equal(dungeon.falseAlarms, 1);
  assert.equal(dungeon.rate, 0.8);
  assert.deepEqual(dungeon.levels[2], { confirmed: 3, falseAlarms: 0, rate: 1 });
  assert.deepEqual(dungeon.levels[1], { confirmed: 1, falseAlarms: 1, rate: 0.5 });
  const markt = rows.find((r) => r.kind === 'markt');
  assert.equal(markt.rate, null);
  assert.equal(markt.confirmed, 0);
  assert.equal(rows.find((r) => r.kind === 'takt').rate, null);
  // Urteile zu Mustern ohne aktuelle Hinweise erscheinen trotzdem (der Hinweis ist längst gelöscht)
  assert.equal(s.precisionRows([{ key: 'netz:z', event: 'fehlalarm', kind: 'netz', level: 1, createdAt: at(1) }])[0].falseAlarms, 1);
});

test('Urteils-Protokoll anonymisieren: Namen in allen Texten ersetzen', () => {
  const details = { count: 3, trades: ['05.10., 12:00 Anna → Ben (Handel)', 'Ben hielt sie 26 Std.'], nested: { who: 'Benjamin und Ben' }, at: new Date(t0) };
  const out = s.scrubNames(details, ['Ben']);
  assert.deepEqual(out.trades, ['05.10., 12:00 Anna → gelöschtes Konto (Handel)', 'gelöschtes Konto hielt sie 26 Std.']);
  assert.equal(out.count, 3);
  assert.ok(out.at instanceof Date);
  // längere Namen zuerst, Sonderzeichen sicher
  assert.equal(s.scrubNames('Ben.X und Ben', ['Ben', 'Ben.X']), 'gelöschtes Konto und gelöschtes Konto');
  assert.equal(s.scrubNames('nichts', []), 'nichts');
});

test('Rangliste: Anschaffungswert je erhaltenem Exemplar, nach Wert aufgeteilt', () => {
  // Sith-Karte gegen eine Crumpled-Karte (3 €): sie zählt nur 3 €
  assert.deepEqual([...costShares([{ doc: 'x', value: 1000000 }], 300)], [['x', 300]]);
  // zwei Karten für 1.000 €: nach Wert verteilt, abgerundet
  assert.deepEqual([...costShares([{ doc: 'a', value: 3000 }, { doc: 'b', value: 1000 }], 100000)], [['a', 75000], ['b', 25000]]);
  // ohne Wert gleichmäßig
  assert.deepEqual([...costShares([{ doc: 'a', value: 0 }, { doc: 'b', value: 0 }], 101)], [['a', 50], ['b', 50]]);
  // geschenkt
  assert.deepEqual([...costShares([{ doc: 'a', value: 500 }], 0)], [['a', 0]]);
});

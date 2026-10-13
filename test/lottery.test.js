process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { drawTime, bigDrawTime, nextDrawAfter, nextWeeklyDrawAfter, nextMonthlyDrawAfter, ticketAt, prizeText, settingsError } = require('../src/services/lotteryService');

test('Ziehung 1 Minute vor dem Lotterie-Start', () => {
  assert.equal(drawTime(), '19:59');
});

test('Nächste Ziehung (deutsche Zeit, sommer- und winterzeitsicher)', () => {
  // Sommerzeit: Runde startet 20:00 Berlin (18:00 UTC) -> Ziehung am Folgetag 19:59 Berlin (17:59 UTC)
  assert.equal(nextDrawAfter(Date.parse('2026-09-29T18:00:00Z')).toISOString(), '2026-09-30T17:59:00.000Z');
  // Erste Runde am Nachmittag: Ziehung noch am selben Tag
  assert.equal(nextDrawAfter(Date.parse('2026-09-29T13:00:00Z')).toISOString(), '2026-09-29T17:59:00.000Z');
  // Winterzeit: 20:00 Berlin = 19:00 UTC -> 19:59 Berlin = 18:59 UTC am Folgetag
  assert.equal(nextDrawAfter(Date.parse('2026-12-01T19:00:00Z')).toISOString(), '2026-12-02T18:59:00.000Z');
  // Umstellung auf Winterzeit (25.10.2026): Ziehung trotzdem um 19:59 Ortszeit
  assert.equal(nextDrawAfter(Date.parse('2026-10-24T18:00:00Z')).toISOString(), '2026-10-25T18:59:00.000Z');
  // Monatswechsel
  assert.equal(nextDrawAfter(Date.parse('2026-10-31T19:00:00Z')).toISOString(), '2026-11-01T18:59:00.000Z');
});

test('Ziehung ohne gelöschte Konten: k-tes Los über mehrere Bereiche', () => {
  // Lose 1–3 und 7–8 gehören Anna, 9–10 Ben (4–6 einem gelöschten Konto, nicht in der Liste)
  const entries = [{ ranges: [{ from: 1, to: 3 }, { from: 7, to: 8 }] }, { ranges: [{ from: 9, to: 10 }] }];
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((k) => ticketAt(entries, k)), [1, 2, 3, 7, 8, 9, 10]);
  assert.equal(ticketAt(entries, 8), null);
  assert.equal(ticketAt([], 1), null);
});

test('Wochen- und Monats-Ziehung 30 Minuten nach der täglichen', () => {
  assert.equal(bigDrawTime(), '20:29');
});

test('Nächste Wochen-Ziehung: sonntags 20:29 (sommer- und winterzeitsicher)', () => {
  // So, 04.10.2026 nachmittags -> noch am selben Sonntag (20:29 Berlin = 18:29 UTC)
  assert.equal(nextWeeklyDrawAfter(Date.parse('2026-10-04T13:00:00Z')).toISOString(), '2026-10-04T18:29:00.000Z');
  // Direkt nach der Ziehung -> eine Woche später
  assert.equal(nextWeeklyDrawAfter(Date.parse('2026-10-04T18:30:00Z')).toISOString(), '2026-10-11T18:29:00.000Z');
  // Mitten in der Woche
  assert.equal(nextWeeklyDrawAfter(Date.parse('2026-10-07T09:00:00Z')).toISOString(), '2026-10-11T18:29:00.000Z');
  // Umstellung auf Winterzeit (25.10.2026): 20:29 Ortszeit = 19:29 UTC
  assert.equal(nextWeeklyDrawAfter(Date.parse('2026-10-18T18:30:00Z')).toISOString(), '2026-10-25T19:29:00.000Z');
});

test('Nächste Monats-Ziehung: am 28. um 20:29', () => {
  assert.equal(nextMonthlyDrawAfter(Date.parse('2026-10-04T10:00:00Z')).toISOString(), '2026-10-28T19:29:00.000Z');
  assert.equal(nextMonthlyDrawAfter(Date.parse('2026-10-28T19:30:00Z')).toISOString(), '2026-11-28T19:29:00.000Z');
  // Jahreswechsel
  assert.equal(nextMonthlyDrawAfter(Date.parse('2026-12-28T19:30:00Z')).toISOString(), '2027-01-28T19:29:00.000Z');
  // Nach dem 28. im selben Monat -> nächster Monat
  assert.equal(nextMonthlyDrawAfter(Date.parse('2026-09-30T10:00:00Z')).toISOString(), '2026-10-28T19:29:00.000Z');
});

test('Fällt der 28. auf einen Sonntag, ziehen Wochen- und Monats-Lotterie zur selben Zeit', () => {
  // 28.02.2027 ist ein Sonntag
  const start = Date.parse('2027-02-22T10:00:00Z');
  assert.equal(nextWeeklyDrawAfter(start).toISOString(), nextMonthlyDrawAfter(start).toISOString());
});

test('Gewinn als Text', () => {
  const n = (t) => t.replace(/\s/g, ' ');
  assert.equal(n(prizeText({ cash: 123400 })), '1.234,00 €');
  assert.equal(n(prizeText({ cash: 1000000, packs: 50, foils: 2 })), '10.000,00 €, 50 Booster Packs und 2 TCG Sleeves');
  assert.equal(n(prizeText({ cash: 500, packs: 1 })), '5,00 € und 1 Booster Pack');
  assert.equal(n(prizeText({ cash: 0, packs: 50 })), '50 Booster Packs');
  assert.equal(n(prizeText({ cash: 0 })), '0,00 €');
});

test('Einstellungen Wochen-/Monats-Lotterie prüfen', () => {
  const ok = { ticketPrice: 10000, prizeCash: 1000000, prizePacks: 50, prizeFoils: 2 };
  assert.equal(settingsError(ok), null);
  assert.ok(settingsError({ ...ok, ticketPrice: 0 }));
  assert.ok(settingsError({ ...ok, prizePacks: 501 }));
  assert.ok(settingsError({ ...ok, prizeFoils: -1 }));
  assert.ok(settingsError({ ...ok, prizeCash: 1.5 }));
});

test('Tages-Lotterie: Bank-Topf im Admin-Panel einstellbar, Standard 0', () => {
  const lottery = require('../src/services/lotteryService');
  const config = require('../src/config');
  assert.deepStrictEqual(lottery.settings.taeglich, { ticketPrice: config.lotteryTicketPrice, prizeCash: 0, prizePacks: 0, prizeFoils: 0 });
  assert.strictEqual(lottery.ticketPrice('taeglich'), config.lotteryTicketPrice);
});

test('Limit pro Person: Woche 10, Monat 20, täglich ohne Limit', () => {
  const { ticketsLeft } = require('../src/services/lotteryService');
  assert.equal(ticketsLeft('woche', null), 10);
  assert.equal(ticketsLeft('woche', { tickets: 4, bought: 3 }), 7);
  assert.equal(ticketsLeft('woche', { tickets: 90 }), 0); // alter Eintrag ohne bought-Feld
  assert.equal(ticketsLeft('monat', { tickets: 5, bought: 5 }), 15);
  assert.equal(ticketsLeft('taeglich', { tickets: 500, bought: 500 }), Infinity);
});

test('Erstattung: letzte Losnummern abschneiden, höhere Nummern rücken auf', () => {
  const { cutLastTickets, shiftRanges } = require('../src/services/lotteryService');
  // Anna 1–20 und 31–42 (32 Lose), Ben 21–30 und 43–45
  const { kept, removed } = cutLastTickets([{ from: 1, to: 20 }, { from: 31, to: 42 }], 12);
  assert.deepEqual(kept, [{ from: 1, to: 20 }]);
  assert.deepEqual(removed, [{ from: 31, to: 42 }]);
  assert.deepEqual(shiftRanges([{ from: 21, to: 30 }, { from: 43, to: 45 }], removed), [{ from: 21, to: 30 }, { from: 31, to: 33 }]);
  // über mehrere Bereiche hinweg
  const cut = cutLastTickets([{ from: 1, to: 5 }, { from: 8, to: 9 }], 3);
  assert.deepEqual(cut.kept, [{ from: 1, to: 4 }]);
  assert.deepEqual(cut.removed, [{ from: 5, to: 5 }, { from: 8, to: 9 }]);
  assert.deepEqual(shiftRanges([{ from: 6, to: 7 }, { from: 10, to: 10 }], cut.removed), [{ from: 5, to: 6 }, { from: 7, to: 7 }]);
});

test('Erstattung: Preis der zuletzt gekauften Lose, bereits erstattete übersprungen', () => {
  const { refundAmount } = require('../src/services/lotteryService');
  const ledger = [
    { amount: -200000, meta: { count: 20 }, createdAt: new Date(1) }, // 100 € je Los
    { amount: -240000, meta: { count: 12 }, createdAt: new Date(2) }, // 200 € je Los
  ];
  assert.equal(refundAmount(ledger, 12), 240000);
  assert.equal(refundAmount(ledger, 14), 260000);
  assert.equal(refundAmount([...ledger, { amount: 40000, meta: { count: -2 }, createdAt: new Date(3) }], 10), 200000);
  assert.equal(refundAmount(ledger, 33), null);
});

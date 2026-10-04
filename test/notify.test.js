process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { safeHref, short, notify } = require('../src/services/notifyService');
const { resultNotes } = require('../src/services/betService');

test('Ziel einer Benachrichtigung: nur Pfade dieser Seite', () => {
  assert.equal(safeHref('/handel/verhandlung/abc'), '/handel/verhandlung/abc');
  assert.equal(safeHref('//boese.example'), '/');
  assert.equal(safeHref('/\\boese.example'), '/');
  assert.equal(safeHref('https://boese.example'), '/');
  assert.equal(safeHref({ $gt: '' }), '/');
});

test('Titel werden gekürzt und Leerraum zusammengefasst', () => {
  assert.equal(short('  Wer  gewinnt\n das Spiel? '), 'Wer gewinnt das Spiel?');
  const long = short('x'.repeat(100), 10);
  assert.equal(long.length, 10);
  assert.ok(long.endsWith('…'));
});

test('Ohne Empfänger passiert nichts (und es wird nichts geworfen)', async () => {
  await notify([], { area: 'Test', text: 'x', href: '/' });
  await notify([null, 'kein-objectid'], { area: 'Test', text: 'x', href: '/' });
  // nur der Auslöser selbst → niemand
  await notify('64b000000000000000000001', { area: 'Test', text: 'x', href: '/', except: { _id: '64b000000000000000000001' } });
});

const A = '64b0000000000000000000a1';
const B = '64b0000000000000000000b2';
const C = '64b0000000000000000000c3';
const REF = '64b0000000000000000000d4';
const none = () => false;
// euro() trennt Betrag und € mit einem geschützten Leerzeichen
const plain = (notes) => notes.map((n) => ({ ...n, text: n.text.replace(/[\u00a0\u202f]/g, ' ') }));

test('Ergebnis-Benachrichtigungen: Gewinn, Verlust, mehrere Einsätze zusammengefasst, Schiedsrichter mit Provision', () => {
  const bet = { title: 'Regnet es morgen?', creator: A, referee: REF };
  const positions = [
    { _id: 'p1', user: A, amount: 1000 },
    { _id: 'p2', user: A, amount: 500 },
    { _id: 'p3', user: B, amount: 2000 },
  ];
  const payouts = new Map([['p1', 2000], ['p2', 1000]]);
  const notes = plain(resultNotes({ bet, positions, payouts, refunded: false, outcome: 'ja', label: 'Ja', note: 'Es hat geregnet.', actor: { _id: C }, feeShare: { creator: 0, referee: 50 }, isGone: none }));
  const by = (id) => notes.filter((n) => n.user === id).map((n) => n.text);
  assert.deepEqual(by(A), ['Gewonnen! „Regnet es morgen?“ endete mit „Ja“ – du bekommst 30,00 €.']);
  assert.deepEqual(by(B), ['Verloren: „Regnet es morgen?“ endete mit „Ja“ (Einsatz 20,00 €).']);
  assert.deepEqual(by(REF), ['Die Wette „Regnet es morgen?“ ist entschieden: „Ja“. Deine Provision: 0,50 €.']);
});

test('Ergebnis-Benachrichtigungen: wer entschieden hat und gelöschte Konten bekommen nichts', () => {
  const bet = { title: 'T', creator: A, referee: REF };
  const positions = [{ _id: 'p1', user: B, amount: 100 }, { _id: 'p2', user: C, amount: 100 }];
  const notes = plain(resultNotes({ bet, positions, payouts: new Map(), refunded: true, outcome: 'annulliert', label: null, note: 'x', actor: { _id: REF }, feeShare: { creator: 0, referee: 0 }, isGone: (id) => id === C }));
  assert.deepEqual(notes.map((n) => n.user).sort(), [A, B].sort());
  assert.ok(notes.find((n) => n.user === B).text.includes('annulliert – dein Einsatz von 1,00 € wurde erstattet'));
});

test('Duell abgesagt: der Grund steht in der Benachrichtigung', () => {
  const bet = { title: 'Wer läuft schneller?', creator: A, referee: REF, duel: { opponent: B } };
  const notes = plain(resultNotes({ bet, positions: [{ _id: 'p1', user: A, amount: 500 }], payouts: new Map(), refunded: true, outcome: 'annulliert', label: null, note: 'bernd hat die Herausforderung abgelehnt.', actor: { system: true }, feeShare: { creator: 0, referee: 0 }, isGone: none }));
  assert.equal(notes.find((n) => n.user === A).text, 'Duell „Wer läuft schneller?“: bernd hat die Herausforderung abgelehnt. Dein Einsatz von 5,00 € wurde erstattet.');
});

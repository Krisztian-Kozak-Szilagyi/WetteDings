process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { isLocked, pickCopy } = require('../src/tcg/locks');

// Exemplare einer Karte, neueste zuerst (wie TcgCard.find(…).sort({ createdAt: -1 }))
const docs = [
  { _id: 'a', foiledAt: new Date() }, // foliert, frei
  { _id: 'b', foiledAt: null }, // auf Quest
  { _id: 'c', foiledAt: null }, // frei
  { _id: 'd', foiledAt: new Date() }, // foliert, im Handel
];
const locked = { reasons: new Map([['a', 'folie'], ['b', 'quest'], ['d', 'handel']]) };

test('#204: Die Folie allein sperrt nur, wenn folierte Karten nicht mitspielen dürfen', () => {
  assert.equal(isLocked(locked, docs[0]), true); // Bank, Duell, Sammelhandel
  assert.equal(isLocked(locked, docs[0], { foil: true }), false); // Quest, Dungeon, Turm
  assert.equal(isLocked(locked, docs[1], { foil: true }), true); // auf Quest bleibt gesperrt
  assert.equal(isLocked(locked, docs[3], { foil: true }), true); // im Handel bleibt gesperrt
  assert.equal(isLocked(locked, 'c', { foil: true }), false);
});

test('#204: Exemplarwahl – ohne Schalter lieber unfoliert, mit Schalter nur foliert', () => {
  assert.equal(pickCopy(docs, locked)._id, 'c');
  assert.equal(pickCopy(docs, locked, { foiled: true })._id, 'a');
  // nur folierte frei: ohne Schalter spielt das folierte (sonst wäre die Karte gar nicht spielbar)
  assert.equal(pickCopy([docs[0], docs[1]], locked)._id, 'a');
  // Schalter an, aber kein freies foliertes: kein Exemplar (statt heimlich ein ungeschütztes)
  assert.equal(pickCopy([docs[1], docs[2], docs[3]], locked, { foiled: true }), null);
  // except: dieselbe Karte als Charakter und Boost braucht zwei Exemplare
  assert.equal(pickCopy(docs, locked, { except: docs[2] })._id, 'a');
  assert.equal(pickCopy(docs, locked, { foiled: true, except: { _id: 'a' } }), null);
  assert.equal(pickCopy([], locked), null);
});

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { verdictRole, evaluateVotes } = require('../src/lib/verdict');
const { pendingVoteFilter, disputedFilter } = require('../src/services/betService');

const bet = { creator: 'u1', referee: 'u2' };
const creator = { _id: 'u1', username: 'Anna' };
const referee = { _id: 'u2', username: 'Ben' };
const dev = { _id: 'u3', username: 'Clara', isDev: true };
const stranger = { _id: 'u4', username: 'David' };

test('Rolle bei der Ergebnisfindung', () => {
  assert.equal(verdictRole(bet, creator), 'creator');
  assert.equal(verdictRole(bet, referee), 'referee');
  assert.equal(verdictRole(bet, dev), 'dev');
  assert.equal(verdictRole(bet, { _id: 'u5', username: 'Admin', isAdmin: true }), 'dev');
  assert.equal(verdictRole(bet, stranger), null);
  assert.equal(verdictRole(bet, { system: true, username: 'System' }), 'system');
});

test('Eigene Beteiligung wiegt schwerer als die Dev-Rolle', () => {
  // Ein Dev, der die Wette aufgestellt hat, stimmt als Ersteller ab und entscheidet nicht allein
  assert.equal(verdictRole(bet, { ...creator, isDev: true }), 'creator');
  assert.equal(verdictRole(bet, { ...referee, isAdmin: true }), 'referee');
  // Bei einer Wette ohne Schiedsrichter bleibt ein unbeteiligter Dev Dev
  assert.equal(verdictRole({ creator: 'u1', referee: null }, dev), 'dev');
});

test('Eine Stimme allein entscheidet nicht', () => {
  const v = evaluateVotes([{ role: 'creator', outcome: 'ja' }]);
  assert.deepEqual(v, { decided: false, disputed: false, outcome: null, missing: ['referee'] });
});

test('Einstimmig: beide nennen dasselbe Ergebnis', () => {
  const v = evaluateVotes([
    { role: 'creator', outcome: 'ja' },
    { role: 'referee', outcome: 'ja' },
  ]);
  assert.deepEqual(v, { decided: true, disputed: false, outcome: 'ja', missing: [] });
});

test('Uneinig: strittig, kein Ergebnis', () => {
  const v = evaluateVotes([
    { role: 'creator', outcome: 'ja' },
    { role: 'referee', outcome: 'nein' },
  ]);
  assert.deepEqual(v, { decided: false, disputed: true, outcome: null, missing: [] });
});

test('Annullierung braucht ebenfalls beide Stimmen', () => {
  assert.equal(evaluateVotes([{ role: 'creator', outcome: 'annulliert' }]).decided, false);
  const beide = [
    { role: 'creator', outcome: 'annulliert' },
    { role: 'referee', outcome: 'annulliert' },
  ];
  assert.deepEqual(evaluateVotes(beide), { decided: true, disputed: false, outcome: 'annulliert', missing: [] });
  // Annullierung gegen eine Option ist ein Streitfall
  assert.equal(evaluateVotes([beide[0], { role: 'referee', outcome: 'ja' }]).disputed, true);
});

test('Dev-Stimmen zählen nicht zur Einstimmigkeit', () => {
  const v = evaluateVotes([
    { role: 'creator', outcome: 'ja' },
    { role: 'dev', outcome: 'ja' },
  ]);
  assert.equal(v.decided, false);
  assert.deepEqual(v.missing, ['referee']);
});

test('Alte Wetten ohne Schiedsrichter: der Ersteller entscheidet allein', () => {
  const v = evaluateVotes([{ role: 'creator', outcome: 'ja' }], { hasReferee: false });
  assert.deepEqual(v, { decided: true, disputed: false, outcome: 'ja', missing: [] });
  assert.deepEqual(evaluateVotes([], { hasReferee: false }).missing, ['creator']);
});

test('Streitfälle: nur offene Wetten mit Uneinigkeit', () => {
  assert.deepEqual(disputedFilter(), { status: 'offen', disputed: true });
});

test('Abzeichen: Wetten, in denen meine Stimme noch fehlt', () => {
  const f = pendingVoteFilter('u1');
  assert.equal(f.status, 'offen');
  assert.equal(f.disputed, false); // Streitfälle liegen beim Dev, nicht mehr bei mir
  assert.deepEqual(f['votes.0'], { $exists: true }); // die andere Seite hat schon abgestimmt
  const [alsErsteller, alsSchiedsrichter] = f.$or;
  assert.equal(alsErsteller.creator, 'u1');
  assert.deepEqual(alsErsteller.votes, { $not: { $elemMatch: { role: 'creator' } } });
  assert.equal(alsSchiedsrichter.referee, 'u1');
  assert.deepEqual(alsSchiedsrichter.votes, { $not: { $elemMatch: { role: 'referee' } } });
});

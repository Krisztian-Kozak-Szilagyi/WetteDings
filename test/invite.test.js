process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const invites = require('../src/services/inviteService');

test('Einladungslink: Provision nur für echte Einladungen', () => {
  const now = Date.UTC(2026, 9, 6);
  const beneficiary = { deletedAt: null, bannedUntil: null };
  assert.deepEqual(invites.rewardDecision({ packs: 2, beneficiary, sameDevice: false, now }), { packs: 2, withheld: null });
  assert.deepEqual(invites.rewardDecision({ packs: 0, beneficiary, sameDevice: false, now }), { packs: 0, withheld: null });
  assert.deepEqual(invites.rewardDecision({ packs: 2, beneficiary, sameDevice: true, now }), { packs: 0, withheld: 'gleiches Gerät wie der Einladende' });
  assert.equal(invites.rewardDecision({ packs: 2, beneficiary: null, sameDevice: false, now }).packs, 0);
  assert.equal(invites.rewardDecision({ packs: 2, beneficiary: { deletedAt: new Date(now) }, sameDevice: false, now }).packs, 0);
  // Gesperrt nur, solange die Sperre läuft
  assert.equal(invites.rewardDecision({ packs: 2, beneficiary: { bannedUntil: new Date(now + 60000) }, sameDevice: false, now }).withheld, 'Einladender gesperrt');
  assert.equal(invites.rewardDecision({ packs: 2, beneficiary: { bannedUntil: new Date(now - 60000) }, sameDevice: false, now }).packs, 2);
});

test('Einladungslink: Provision aus dem Formular, Link und Texte', () => {
  for (const [input, want] of [['0', 0], ['3', 3], [' 20 ', 20], [5, 5]]) assert.equal(invites.parsePacks(input), want, String(input));
  for (const bad of [undefined, '', '-1', '21', '1.5', 'abc', ['2'], { a: 1 }]) assert.equal(invites.parsePacks(bad), null, String(bad));
  assert.equal(invites.linkUrl('https://example.org', 'ABCD2345'), 'https://example.org/registrieren?code=ABCD-2345');
  assert.equal(invites.packsText(0), 'keine Booster Packs');
  assert.equal(invites.packsText(1), 'ein Booster Pack');
  assert.equal(invites.packsText(4), '4 Booster Packs');
});

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const invites = require('../src/services/inviteService');

test('Einladung: Provision nur für echte Einladungen', () => {
  const now = Date.UTC(2026, 9, 6);
  const inviter = { deletedAt: null, bannedUntil: null };
  assert.deepEqual(invites.rewardDecision({ packs: 2, inviter, sameDevice: false, now }), { packs: 2, withheld: null });
  assert.deepEqual(invites.rewardDecision({ packs: 0, inviter, sameDevice: false, now }), { packs: 0, withheld: null });
  assert.deepEqual(invites.rewardDecision({ packs: 2, inviter, sameDevice: true, now }), { packs: 0, withheld: 'gleiches Gerät wie der Einlader' });
  assert.equal(invites.rewardDecision({ packs: 2, inviter: null, sameDevice: false, now }).packs, 0);
  assert.equal(invites.rewardDecision({ packs: 2, inviter: { deletedAt: new Date(now) }, sameDevice: false, now }).packs, 0);
  // Gesperrt nur, solange die Sperre läuft
  assert.equal(invites.rewardDecision({ packs: 2, inviter: { bannedUntil: new Date(now + 60000) }, sameDevice: false, now }).withheld, 'Einlader gesperrt');
  assert.equal(invites.rewardDecision({ packs: 2, inviter: { bannedUntil: new Date(now - 60000) }, sameDevice: false, now }).packs, 2);
});

test('Einladung: Link, Freigabe und Grenzen', () => {
  assert.equal(invites.linkUrl('https://example.org', 'ABCD2345'), 'https://example.org/registrieren?code=ABCD-2345');
  assert.equal(invites.linkTtlText, '7 Tage');
  assert.equal(invites.DEFAULTS.open, false);
  assert.ok(invites.DEFAULTS.packs >= 0 && invites.DEFAULTS.packs <= invites.MAX_PACKS);

  const open = invites.settings.open;
  try {
    invites.settings.open = false;
    assert.equal(invites.mayInvite({ isAdmin: false }), false);
    assert.equal(invites.mayInvite({ isAdmin: true }), true);
    invites.settings.open = true;
    assert.equal(invites.mayInvite({ isAdmin: false }), true);
    assert.equal(invites.mayInvite(null), false);
  } finally {
    invites.settings.open = open;
  }
});

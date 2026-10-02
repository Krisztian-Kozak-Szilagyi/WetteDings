process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const groups = require('../src/services/groupService');

test('Sichtbarkeit: öffentliche Wetten für alle, Gruppen-Wetten nur für Mitglieder (und Admin/Devs)', () => {
  const member = { _id: 'u1' };
  const dev = { _id: 'd', isStaff: true };
  const mod = { _id: 'm', isMod: true, canModerate: true };
  const pub = { group: null };
  const old = {}; // alte Wette ohne Feld
  const inGroup = { group: 'g1' };
  assert.ok(groups.canSee(pub, member, []) && groups.canSee(old, member, []));
  assert.ok(groups.canSee(inGroup, member, ['g1']));
  assert.ok(!groups.canSee(inGroup, member, []) && !groups.canSee(inGroup, member, ['g2']));
  assert.ok(groups.canSee(inGroup, dev, [])); // Streitfälle
  assert.ok(!groups.canSee(inGroup, mod, [])); // Mods moderieren nur das Forum und Kommentare
});

test('Filter für die Übersicht: öffentlich oder eigene Gruppe', () => {
  assert.deepEqual(groups.visibleFilter(['g1', 'g2']), { $or: [{ group: null }, { group: { $in: ['g1', 'g2'] } }] });
  assert.deepEqual(groups.visibleFilter([]), { $or: [{ group: null }, { group: { $in: [] } }] });
});

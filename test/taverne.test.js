process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const nav = require('../src/lib/navModel');

// Locals wie in den Views: Freigaben der Bereiche (Admin-Panel) und das angemeldete Mitglied
const locals = (path, user, open = {}, title) => ({
  currentPath: path,
  currentUser: user,
  title,
  dungeonOpen: () => !!open.dungeon,
  ihkOpen: () => !!open.ihk,
  gradingOpen: () => !!open.grading,
  esportsOpen: () => !!open.esports,
});
const ben = { username: 'ben' };
const admin = { username: 'admin', isAdmin: true, isStaff: true };

test('Taverne-Fenster: Bereich, aktiver Reiter und Startseite des Reiters', () => {
  const s = nav.taverneSection(locals('/broker/sam', ben));
  assert.equal(s.key, 'gambling');
  assert.deepEqual(s.tabs.map((t) => [t.label, t.active]), [['Wetten', false], ['Broker', true], ['Lotterie', false]]);
  assert.equal(s.root, false);
  assert.equal(nav.taverneSection(locals('/broker', ben)).root, true);
  assert.equal(nav.taverneSection(locals('/duell/neu', ben)).key, 'gambling');
  assert.equal(nav.taverneSection(locals('/slab/7', ben)).key, 'tcg');
  assert.equal(nav.taverneSection(locals('/impressum', ben)).key, 'aushang');
});

test('Taverne-Fenster: gesperrte Bereiche erscheinen nicht als Reiter', () => {
  assert.deepEqual(nav.taverneSection(locals('/dungeon', ben, { dungeon: true })).tabs.map((t) => t.label), ['Dungeon']);
  assert.deepEqual(nav.taverneSection(locals('/dungeon', ben, { dungeon: true, ihk: true, grading: true, esports: true })).tabs.map((t) => t.label), ['Dungeon', 'IHK', 'Grading', 'eSports']);
  // Admin sieht alles, auch ohne Freigabe (eSports hängt am Mage Tower)
  assert.deepEqual(nav.taverneSection(locals('/ihk', admin)).tabs.map((t) => t.label), ['Dungeon', 'IHK', 'Grading']);
});

test('Taverne-Fenster: Hinterzimmer nur für Staff – sonst allgemeines Fenster, das den Bereich nicht verrät', () => {
  assert.equal(nav.taverneSection(locals('/admin', admin)).key, 'admin');
  const s = nav.taverneSection(locals('/admin', ben, {}, 'Nicht gefunden'));
  assert.equal(s.key, 'allgemein');
  assert.equal(s.title, 'Nicht gefunden');
  assert.ok(!/admin|dev|hinterzimmer/i.test(s.title + s.sub));
});

test('Taverne-Fenster: unbekannte Seiten im allgemeinen Fenster, Gäste im alten Stil', () => {
  assert.equal(nav.taverneSection(locals('/gibt-es-nicht', ben, {}, 'Nicht gefunden')).key, 'allgemein');
  assert.equal(nav.taverneSection(locals('/wetten', null)), null);
  assert.equal(nav.taverneTheme(locals('/impressum', null)), false);
});

test('Taverne-Fenster: Profil-Reiter führt zum eigenen Profil (Name kodiert)', () => {
  const s = nav.taverneSection(locals('/konto', { username: 'Max Mü' }));
  assert.equal(s.tabs[0].href, '/profil/Max%20M%C3%BC');
});

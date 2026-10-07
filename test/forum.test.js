process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { render, sanitizeTags, tagsFor, tagsIn } = require('../src/forum/render');
const { can, roleOfUser, isUnread } = require('../src/forum/forumService');

test('Rollen-Tags: jede Rolle nur ihre eigenen, der Admin alle', () => {
  assert.deepEqual(tagsFor('admin'), ['admin', 'dev', 'mod']);
  assert.deepEqual(tagsFor('dev'), ['dev']);
  assert.deepEqual(tagsFor('mod'), ['mod']);
  assert.deepEqual(tagsFor(null), []);
});

test('Fremde Rollen-Tags werden beim Speichern entschärft (nicht fälschbar)', () => {
  // normales Mitglied: alle Rollen-Tags werden zu gewöhnlichem Text
  const user = sanitizeTags('Hallo <dev>ich bin Dev</dev> und <ADMIN>Admin</ADMIN>', tagsFor(null));
  assert.equal(user, 'Hallo ‹dev›ich bin Dev‹/dev› und ‹ADMIN›Admin‹/ADMIN›');
  assert.deepEqual(tagsIn(user), []);
  assert.ok(!render(user).includes('role-say'));
  // Mod darf <MOD>, aber nicht <dev>
  const mod = sanitizeTags('<MOD>bitte sachlich</MOD> <dev>x</dev>', tagsFor('mod'));
  assert.equal(mod, '<mod>bitte sachlich</mod> ‹dev›x‹/dev›');
  // Bearbeitung durch einen Mod: echte Tags, die schon im Text stehen, bleiben erhalten
  const stored = sanitizeTags('<dev>Hinweis</dev>', tagsFor('dev'));
  assert.equal(sanitizeTags(stored + ' <mod>ok</mod>', [...tagsFor('mod'), ...tagsIn(stored)]), '<dev>Hinweis</dev> <mod>ok</mod>');
});

test('Darstellung: Team-Kasten in der Rollenfarbe, Rest bleibt maskiert', () => {
  const html = render('Vorher\n<dev>**Wichtig** <script>x</script></dev>\nNachher');
  assert.ok(html.includes('<div class="role-say role-say-dev"><span class="role-say-label" data-text="DEV">DEV</span><p><strong>Wichtig</strong> &lt;script&gt;x&lt;/script&gt;</p></div>'));
  assert.ok(html.startsWith('<p>Vorher</p>') && html.endsWith('<p>Nachher</p>'));
  assert.ok(render('<admin>a</admin>').includes('role-say-admin') && render('<MOD>m</MOD>').includes('role-say-mod'));
});

test('Rechte: bearbeiten, löschen, Team-Bereiche, geschlossene Themen', () => {
  const member = { _id: 'u1' };
  const other = { _id: 'u2' };
  const mod = { _id: 'm', isMod: true, canModerate: true };
  const dev = { _id: 'd', isDev: true, isStaff: true, canModerate: true };
  const open = { locked: false };
  const post = { author: 'u1', deleted: false, staffEdited: false };
  assert.equal(roleOfUser(mod), 'mod');
  assert.equal(roleOfUser(dev), 'dev');
  assert.equal(roleOfUser({ isAdmin: true, isStaff: true }), 'admin');
  // Verfasser darf bearbeiten, Fremde nicht, Moderation schon
  assert.ok(can.editPost(member, post, open) && !can.editPost(other, post, open) && can.editPost(mod, post, open));
  // nach einem Eingriff des Teams oder dem Löschen kann der Verfasser nicht mehr bearbeiten
  assert.ok(!can.editPost(member, { ...post, staffEdited: true }, open));
  assert.ok(!can.editPost(member, { ...post, deleted: true }, open) && !can.editPost(dev, { ...post, deleted: true }, open));
  assert.ok(!can.editPost(member, post, { locked: true }) && can.editPost(mod, post, { locked: true }));
  assert.ok(can.deletePost(member, post) && !can.deletePost(other, post) && can.deletePost(mod, post) && !can.deletePost(mod, { ...post, deleted: true }));
  // Team-Bereich: nur Admin/Dev eröffnen Themen; geschlossene Themen: nur die Moderation antwortet
  assert.ok(!can.createThread(member, { staffOnly: true }) && !can.createThread(mod, { staffOnly: true }) && can.createThread(dev, { staffOnly: true }) && can.createThread(member, { staffOnly: false }));
  assert.ok(!can.reply(member, { locked: true }) && can.reply(mod, { locked: true }) && can.reply(member, open));
  // Original gelöschter Beiträge: nur Admin/Dev
  assert.ok(can.seeOriginal(dev) && !can.seeOriginal(mod));
  // Bereiche verwalten: auch Mods – außer in Team-Bereichen (auch deren Unterbereiche) und ohne den Team-Status zu setzen
  assert.ok(can.manage(dev) && can.manage(mod) && !can.manage(member));
  const team = { staffOnly: true };
  const normal = { staffOnly: false };
  assert.ok(can.manageCategory(mod, normal, null) && can.manageCategory(mod, normal, normal));
  assert.ok(!can.manageCategory(mod, team, null) && !can.manageCategory(mod, normal, team));
  assert.ok(can.manageCategory(dev, team, null) && !can.manageCategory(member, normal, null));
  // Bereiche samt Inhalt löschen: nur Admin/Dev, keine Mods
  assert.ok(can.deleteCategory(dev) && !can.deleteCategory(mod) && !can.deleteCategory(member));
  assert.ok(can.setStaffOnly(dev) && !can.setStaffOnly(mod));
});

test('Themen verschieben: Moderation, Team-Bereiche nur Admin/Dev, nicht in denselben Bereich', () => {
  const member = { _id: 'u1' };
  const mod = { _id: 'm', isMod: true, canModerate: true };
  const dev = { _id: 'd', isDev: true, isStaff: true, canModerate: true };
  const a = { _id: 'a', staffOnly: false };
  const b = { _id: 'b', staffOnly: false };
  const team = { _id: 't', staffOnly: true };
  const teamSub = { _id: 'ts', staffOnly: false };
  assert.ok(can.moveThread(mod, a, null, b, null) && can.moveThread(dev, a, null, b, null));
  assert.ok(!can.moveThread(member, a, null, b, null));
  assert.ok(!can.moveThread(dev, a, null, a, null)); // gleicher Bereich
  // Mods: weder in noch aus Team-Bereichen (auch nicht deren Unterbereiche)
  assert.ok(!can.moveThread(mod, a, null, team, null) && !can.moveThread(mod, team, null, a, null) && !can.moveThread(mod, a, null, teamSub, team));
  assert.ok(can.moveThread(dev, a, null, team, null) && can.moveThread(dev, teamSub, team, b, null));
});

test('Ungelesen: neuer als der letzte Besuch oder noch nie geöffnet', () => {
  const t = { _id: 't1', lastPostAt: new Date('2026-01-02') };
  assert.equal(isUnread(new Map(), t), true);
  assert.equal(isUnread(new Map([['t1', new Date('2026-01-01')]]), t), true);
  assert.equal(isUnread(new Map([['t1', new Date('2026-01-03')]]), t), false);
});

const test = require('node:test');
const assert = require('node:assert');
const d = require('../src/device/deviceLogic');

const SECRET = 'test-secret-test-secret-test-secret';

test('Geräte-Kennung: nur eigene, unveränderte Kennungen werden angenommen', () => {
  const token = d.newToken(SECRET);
  const id = d.readToken(SECRET, token);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(token.startsWith(`${id}.`), true);
  assert.notEqual(d.newToken(SECRET), token);
  assert.equal(d.readToken('anderes-geheimnis', token), null);
  const forged = `${'a'.repeat(32)}.${token.split('.')[1]}`;
  assert.equal(d.readToken(SECRET, forged), null);
  for (const bad of [null, undefined, '', 'x', ['a'], `${id}.`, `${id}.zzzzzzzzzzzzzzzz`]) assert.equal(d.readToken(SECRET, bad), null);
});

test('Cookie-Header lesen', () => {
  assert.equal(d.cookieValue('a=1; bfw.geraet=abc.def; wettstube.sid=s%3Ax', d.COOKIE), 'abc.def');
  assert.equal(d.cookieValue('wettstube.sid=s%3Ax', 'wettstube.sid'), 's:x');
  assert.equal(d.cookieValue('a=1', d.COOKIE), null);
  assert.equal(d.cookieValue(undefined, d.COOKIE), null);
  assert.equal(d.cookieValue('bfw.geraet=%E0%A4%A', d.COOKIE), null);
});

test('IP nur als Hash, Fingerabdruck nur als Hex', () => {
  const h = d.ipHash(SECRET, '203.0.113.7');
  assert.match(h, /^[0-9a-f]{20}$/);
  assert.equal(h, d.ipHash(SECRET, '203.0.113.7'));
  assert.notEqual(h, d.ipHash(SECRET, '203.0.113.8'));
  assert.equal(d.ipHash(SECRET, ''), null);
  assert.equal(d.cleanFp('ab12'.repeat(10)), 'ab12'.repeat(10));
  for (const bad of ['', 'kurz', 'XYZ'.repeat(10), { $ne: 1 }, 'a'.repeat(65)]) assert.equal(d.cleanFp(bad), null);
});

test('Treffer-Stufen: Cookie sicher, Fingerabdruck+IP wahrscheinlich, nur Fingerabdruck möglich', () => {
  const a = { deviceId: 'd1', fp: 'f1', ips: ['i1', 'i2'] };
  assert.equal(d.matchLevel(a, { deviceId: 'd1', fp: null, ips: [] }), d.LEVEL.sicher);
  assert.equal(d.matchLevel(a, { deviceId: 'd2', fp: 'f1', ips: ['i2'] }), d.LEVEL.wahrscheinlich);
  assert.equal(d.matchLevel(a, { deviceId: 'd2', fp: 'f1', ips: ['i9'] }), d.LEVEL.moeglich);
  assert.equal(d.matchLevel(a, { deviceId: 'd2', fp: 'f2', ips: ['i1'] }), 0); // gleiche IP allein zählt nicht
  assert.equal(d.matchLevel({ deviceId: 'd1', fp: null, ips: [] }, { deviceId: 'd2', fp: null, ips: [] }), 0);
  assert.equal(d.pairKey('b', 'a'), d.pairKey('a', 'b'));
});

test('Ban-Dauer in Stunden (0 = dauerhaft) und Ban-Status', () => {
  const now = Date.UTC(2026, 9, 2, 12);
  assert.equal(d.banUntil('24', now).getTime(), now + 24 * 60 * 60 * 1000);
  assert.equal(d.banUntil(' 1 ', now).getTime(), now + 60 * 60 * 1000);
  assert.equal(d.isForever(d.banUntil('0', now)), true);
  assert.equal(d.isForever(d.banUntil('720', now)), false);
  assert.ok(d.banUntil(String(d.MAX_BAN_HOURS), now));
  for (const bad of ['', '-1', '1.5', '1,5', 'x', 'immer', undefined, null, ['1'], String(d.MAX_BAN_HOURS + 1), '999999']) assert.equal(d.banUntil(bad, now), null);
  assert.equal(d.isBanned({ bannedUntil: new Date(now + 1000) }, now), true);
  assert.equal(d.isBanned({ bannedUntil: new Date(now - 1000) }, now), false);
  assert.equal(d.isBanned({ bannedUntil: null }, now), false);
  assert.equal(d.isBanned(null, now), false);
});

test('Gerätebezeichnung aus dem User-Agent', () => {
  assert.equal(d.uaLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'), 'Chrome · Windows');
  assert.equal(d.uaLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0'), 'Edge · Windows');
  assert.equal(d.uaLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari · iOS');
  assert.equal(d.uaLabel('Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0'), 'Firefox · Android');
  assert.equal(d.uaLabel(undefined), 'Browser · unbekannt');
});

test('Ban-Rechte: Admin bannt jeden außer Admins, auch dauerhaft', () => {
  const { banError } = require('../src/device/deviceLogic');
  const admin = { _id: 'a', isAdmin: true };
  assert.equal(banError(admin, { _id: 'u', username: 'Anna' }, '0'), null);
  assert.equal(banError(admin, { _id: 'd', username: 'Dev', role: 'dev' }, '24'), null);
  assert.match(banError(admin, { _id: 'b', username: 'Boss', isAdmin: true }, '24'), /Admin kann nicht/);
  assert.match(banError(admin, { _id: 'a', username: 'Ich' }, '24'), /nicht selbst/);
});

test('Ban-Rechte: Devs bannen befristet, keine Devs, keine fremden Bans überschreiben', () => {
  const { banError, DEV_MAX_BAN_HOURS } = require('../src/device/deviceLogic');
  const dev = { _id: 'd1', isAdmin: false };
  const now = Date.parse('2026-10-03T12:00:00Z');
  const anna = { _id: 'u', username: 'Anna', role: null };
  assert.equal(banError(dev, anna, '24', now), null);
  assert.equal(banError(dev, anna, String(DEV_MAX_BAN_HOURS), now), null);
  assert.equal(banError(dev, { ...anna, role: 'mod' }, '24', now), null);
  assert.match(banError(dev, anna, '0', now), /1 bis 168 Stunden/); // kein Dauerban
  assert.match(banError(dev, anna, '169', now), /1 bis 168 Stunden/);
  assert.match(banError(dev, { ...anna, role: 'dev' }, '24', now), /keine anderen Devs/);
  const bannedByAdmin = { ...anna, bannedUntil: new Date(now + 3600e3), bannedBy: 'a', bannedByName: 'Boss' };
  assert.match(banError(dev, bannedByAdmin, '24', now), /bereits von Boss gebannt/);
  // eigenen Ban darf der Dev verlängern oder verkürzen; abgelaufene Bans zählen nicht
  assert.equal(banError(dev, { ...bannedByAdmin, bannedBy: 'd1' }, '48', now), null);
  assert.equal(banError(dev, { ...bannedByAdmin, bannedUntil: new Date(now - 1000) }, '24', now), null);
});

test('Ban-Rechte: aufheben – Admin alle, Devs nur eigene', () => {
  const { unbanError } = require('../src/device/deviceLogic');
  const target = { username: 'Anna', bannedBy: 'd1', bannedByName: 'Dev1' };
  assert.equal(unbanError({ _id: 'a', isAdmin: true }, target), null);
  assert.equal(unbanError({ _id: 'd1' }, target), null);
  assert.match(unbanError({ _id: 'd2' }, target), /Dev1 vergeben/);
  assert.match(unbanError({ _id: 'd2' }, { username: 'Alt', bannedBy: null, bannedByName: 'Boss' }), /Boss vergeben/);
});

test('Ban-Verlauf: Altbestand aus den Einzelfeldern, laufende Bans schließen, Dauer als Text, neueste zuerst', () => {
  const L = require('../src/device/deviceLogic');
  const H = 3600000;
  assert.deepEqual(L.banHistory(null), []);
  assert.deepEqual(L.banHistory({ bannedAt: null }), []);
  // alter Ban, aufgehoben (bannedUntil null) → ein Eintrag "aufgehoben"
  const legacy = L.banTimeline({ bannedAt: new Date(0), bannedUntil: null, bannedByName: 'T', banReason: '' });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].state, 'aufgehoben');
  assert.equal(legacy[0].duration, null);
  assert.equal(L.banDurationText(new Date(0), new Date(5 * H)), '5 Stunden');
  assert.equal(L.banDurationText(new Date(0), new Date(H)), '1 Stunde');
  assert.equal(L.banDurationText(new Date(0), new Date(48 * H)), '2 Tage');
  assert.equal(L.banDurationText(new Date(0), new Date(25 * H)), '1 Tag 1 Stunde');
  assert.equal(L.banDurationText(new Date(0), L.FOREVER), 'dauerhaft');
  const now = new Date(100 * H);
  const list = [
    { at: new Date(10 * H), until: new Date(20 * H), byName: 'A', reason: 'x' },
    { at: new Date(90 * H), until: new Date(200 * H), byName: 'B', reason: 'y' },
  ];
  const closed = L.closeOpenBans(list, now);
  assert.equal(closed[0].liftedAt, undefined); // schon abgelaufen: bleibt
  assert.equal(closed[1].liftedAt, now);
  const tl = L.banTimeline({ banHistory: list }, now.getTime());
  assert.deepEqual(tl.map((b) => [b.byName, b.state]), [['B', 'aktiv'], ['A', 'abgelaufen']]);
  assert.equal(L.banTimeline({ banHistory: closed }, now.getTime())[0].state, 'aufgehoben');
});

test('#89: baugleiche Geräte im selben WLAN sind kein Mehrfach-Konto', () => {
  const H = 3600e3;
  const t0 = Date.UTC(2026, 9, 1);
  const at = (from, to) => ({ firstAt: new Date(t0 + from * H), lastAt: new Date(t0 + to * H) });
  // zwei Freunde mit demselben Handymodell im selben WLAN, beide nutzen die Seite über Tage parallel
  const a = { user: 'u1', deviceId: 'd1', fp: 'f1', ips: ['i1'], ...at(0, 72) };
  const b = { user: 'u2', deviceId: 'd2', fp: 'f1', ips: ['i1'], ...at(5, 80) };
  assert.equal(d.usedInParallel(a, b), true);
  assert.equal(d.matchLevel(a, b), d.LEVEL.moeglich);
  // Cookie gelöscht, gleich danach neues Konto auf demselben Gerät: nacheinander → wahrscheinlich
  const c = { user: 'u3', deviceId: 'd3', fp: 'f1', ips: ['i1'], ...at(72.5, 90) };
  assert.equal(d.usedInParallel(a, c), false); // nur 0 h Überschneidung
  assert.equal(d.matchLevel(a, c), d.LEVEL.wahrscheinlich);
  // kurze Überschneidung (unter 1 Std.) zählt nicht als parallel
  assert.equal(d.usedInParallel(a, { ...c, ...at(71.5, 90) }), false);
  // viele Konten mit gleichem Fingerabdruck im selben Netz: auch nacheinander nur möglich
  const crowd = d.commonPrints([a, b, c]);
  assert.ok(crowd.has(d.printKey('f1', 'i1')));
  assert.equal(d.matchLevel(a, c, crowd), d.LEVEL.moeglich);
  assert.equal(d.commonPrints([a, b]).size, 0); // zwei Konten sind noch keine Menge
  // ein anderes, nicht häufiges Netz zählt weiter
  assert.equal(d.matchLevel({ ...a, ips: ['i1', 'i7'] }, { ...c, ips: ['i7'] }, crowd), d.LEVEL.wahrscheinlich);
  // gleiches Cookie bleibt immer sicher
  assert.equal(d.matchLevel(a, { ...b, deviceId: 'd1' }, crowd), d.LEVEL.sicher);
  // stärkster Treffer zwischen allen Geräten zweier Konten
  assert.equal(d.pairLevel([a], [b, { ...c, user: 'u2' }]), d.LEVEL.wahrscheinlich);
  assert.equal(d.pairLevel([a], [{ deviceId: 'x', fp: 'zz', ips: [] }]), 0);
});

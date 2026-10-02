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

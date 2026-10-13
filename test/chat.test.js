const test = require('node:test');
const assert = require('node:assert');
const chat = require('../src/chat/chatLogic');

const A = '64b000000000000000000001';
const B = '64b000000000000000000002';

test('Chat: Gesprächsschlüssel ist unabhängig von der Reihenfolge', () => {
  assert.strictEqual(chat.dmKey(A, B), chat.dmKey(B, A));
  assert.deepStrictEqual(chat.parseKey(chat.dmKey(B, A)), { kind: 'dm', ids: [A, B] });
  assert.deepStrictEqual(chat.parseKey(chat.teamKey(A)), { kind: 'team', id: A });
});

test('Chat: ungültige oder vertauschte Schlüssel werden abgelehnt', () => {
  for (const key of ['', 'dm', `dm:${B}:${A}`, `dm:${A}:${A}`, `dm:${A}`, 'team:xyz', `team:${A}:x`, `foo:${A}`, `dm:${A}:${B}:x`]) {
    assert.strictEqual(chat.parseKey(key), null, key);
  }
});

test('Chat: Gesprächspartner nur für Beteiligte', () => {
  const p = chat.parseKey(chat.dmKey(A, B));
  assert.strictEqual(chat.partnerOf(p, A), B);
  assert.strictEqual(chat.partnerOf(p, B), A);
  assert.strictEqual(chat.partnerOf(p, '64b000000000000000000003'), null);
  assert.strictEqual(chat.partnerOf(chat.parseKey(chat.teamKey(A)), A), null);
});

test('Chat: Text wird gesäubert und gekürzt', () => {
  assert.strictEqual(chat.cleanText('  Hallo\r\n\r\n\r\n\r\nWelt \u0000​ '), 'Hallo\n\nWelt');
  assert.strictEqual(chat.cleanText('a‮b'), 'ab');
  assert.strictEqual(chat.cleanText('x'.repeat(5000)).length, chat.TEXT_MAX);
  assert.strictEqual(chat.cleanText(null), '');
  assert.strictEqual(chat.preview('eins\nzwei   drei'), 'eins zwei drei');
  assert.strictEqual(chat.preview('y'.repeat(200), 10).length, 10);
});

test('Chat: Blockieren gilt in beide Richtungen', () => {
  assert.strictEqual(chat.blockedBetween(A, [B], B, []), true);
  assert.strictEqual(chat.blockedBetween(A, [], B, [A]), true);
  assert.strictEqual(chat.blockedBetween(A, [], B, null), false);
});

test('Chat: Bremse – eine pro Sekunde, 30 pro Minute', () => {
  const check = chat.createLimiter();
  assert.strictEqual(check(A, 0), null);
  assert.ok(check(A, 500));
  assert.strictEqual(check(B, 500), null); // andere Mitglieder unabhängig
  let t = 1000;
  for (let i = 1; i < 30; i++, t += 1000) assert.strictEqual(check(A, t), null);
  assert.ok(check(A, t)); // 31. in derselben Minute
  assert.strictEqual(check(A, 61000), null);
});

test('Chat: Änderungszähler – gleich bis zur nächsten Änderung', () => {
  const v = chat.createVersions(100);
  assert.strictEqual(v.get(A), 100);
  v.bump([A]);
  assert.strictEqual(v.get(A), 101);
  assert.strictEqual(v.get(B), 100);
  v.bump([A, B]);
  assert.deepStrictEqual([v.get(A), v.get(B)], [102, 101]);
});

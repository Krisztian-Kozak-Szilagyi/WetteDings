const test = require('node:test');
const assert = require('node:assert');

process.env.SESSION_SECRET ||= 'x'.repeat(40);
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:1/test';
const { signalsOf, isGameAction } = require('../src/moderation/requestSignals');

const req = ({ method = 'POST', path = '/tcg/oeffnen', headers = {}, session = {} } = {}) => ({
  method,
  path,
  session,
  get: (name) => headers[name.toLowerCase()],
});
const browser = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin' };

test('Spiel-Aktionen: nur Formulare der Spielbereiche', () => {
  assert.equal(isGameAction(req()), true);
  assert.equal(isGameAction(req({ path: '/dungeon/anmelden' })), true);
  assert.equal(isGameAction(req({ path: '/dungeon/chat' })), false);
  assert.equal(isGameAction(req({ method: 'GET' })), false);
  assert.equal(isGameAction(req({ path: '/forum/neu' })), false);
});

test('Browser-Merkmale einer Anfrage', () => {
  assert.deepEqual(signalsOf(req({ headers: browser, session: { fp: 'abc' } })), { noProbe: 0, noFetchMeta: 0, bare: 0, webdriver: 0, botUa: 0 });
  assert.deepEqual(signalsOf(req({ headers: { 'user-agent': 'python-requests/2.31' }, session: {} })), { noProbe: 1, noFetchMeta: 1, bare: 1, webdriver: 0, botUa: 1 });
  assert.equal(signalsOf(req({ headers: { ...browser, 'user-agent': 'Mozilla/5.0 HeadlessChrome/140.0' }, session: { fp: 'a' } })).botUa, 1);
  assert.equal(signalsOf(req({ headers: browser, session: { fp: 'a', webdriver: true } })).webdriver, 1);
  assert.equal(signalsOf(req({ headers: {}, session: { fp: 'a' } })).botUa, 1); // ohne User-Agent
});

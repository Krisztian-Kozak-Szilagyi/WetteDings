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

const actionToken = require('../src/moderation/actionToken');
const network = require('../src/moderation/network');
const { tokenSignals } = require('../src/moderation/requestSignals');

test('Aktions-Token: einmal gültig, Doppelklick, Wiederverwendung, fremd, veraltet', () => {
  const now = Date.now();
  const tok = actionToken.issue('u1', now - 2500);
  assert.deepEqual(actionToken.check(tok, 'u1', now), { state: 'ok', ageMs: 2500 });
  assert.equal(actionToken.check(tok, 'u1', now + 500).state, 'double');
  assert.equal(actionToken.check(tok, 'u1', now + 60000).state, 'reused');
  assert.equal(actionToken.check(actionToken.issue('u1', now), 'u2', now).state, 'bad'); // anderes Konto
  assert.equal(actionToken.check('abc.def.ghi', 'u1', now).state, 'bad');
  assert.equal(actionToken.check(undefined, 'u1', now).state, 'missing');
  assert.equal(actionToken.check(actionToken.issue('u1', now - actionToken.KEEP_MS - 1000), 'u1', now).state, 'stale');
});

test('Eingabe-Zähler der Seite', () => {
  assert.deepEqual(actionToken.parseInput('t3m42u0'), { trusted: 3, moves: 42, synthetic: 0 });
  assert.equal(actionToken.parseInput('kaputt'), null);
  assert.equal(actionToken.parseInput(undefined), null);
});

test('Merkmale einer Aktion: Reaktionszeit und Eingaben', () => {
  const now = Date.now();
  const r = (body, headers = {}) => ({ body, get: (n) => headers[n.toLowerCase()] });
  const fast = tokenSignals(r({ _at: actionToken.issue('u9', now - 100), _ev: 't0m0u2' }), 'u9', now);
  assert.equal(fast.inc.tokenOk, 1);
  assert.equal(fast.inc.fast, 1);
  assert.equal(fast.inc.noInput, 1);
  assert.equal(fast.inc.synthetic, 1);
  assert.equal(fast.dwell, 100);
  // per fetch: Kopfzeilen statt Formularfelder
  const human = tokenSignals(r({}, { 'x-action-token': actionToken.issue('u9', now - 3000), 'x-action-ev': 't2m80u0' }), 'u9', now);
  assert.deepEqual([human.inc.fast, human.inc.noInput, human.dwell], [0, 0, 3000]);
  // ohne Token und ohne Eingabe-Angabe (kein JavaScript)
  const bare = tokenSignals(r({}), 'u9', now);
  assert.deepEqual([bare.inc.tokenMissing, bare.inc.withInput, bare.dwell], [1, 0, null]);
});

test('Netz: Rechenzentrum, Private Relay und IPv6-Netzanteil', () => {
  assert.equal(network.isHosting(24940, 'Hetzner Online GmbH'), true);
  assert.equal(network.isHosting(3320, 'Deutsche Telekom AG'), false);
  assert.equal(network.isHosting(99999, 'Some VPS Hosting Ltd'), true);
  assert.equal(network.isHosting(36183, 'Akamai Technologies (iCloud Private Relay)'), false);
  assert.equal(network.isHosting(13335, 'Cloudflare, Inc.'), false);
  assert.equal(network.netOf('2a02:810d:1:2:aaaa:bbbb:cccc:dddd'), '2a02:810d:1:2::/64');
  assert.equal(network.netOf('2a02:810d::1'), '2a02:810d:0:0::/64');
  assert.equal(network.netOf('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(network.lookup('1.2.3.4'), null); // ohne Datenbank aus
});

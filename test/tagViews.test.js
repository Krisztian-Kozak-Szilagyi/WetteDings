process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const tv = require('../src/coin/tagViews');

const H = 3600e3;
const D = 24 * H;
const NOW = Date.UTC(2026, 9, 10, 12);

/** Stündliche Abrufe über days Tage; Video a wächst pro Tag um perDay(k) (k = Tage vor NOW) */
function series(days, perDay) {
  const list = [];
  let n = 1e6;
  for (let h = days * 24; h >= 0; h--) {
    const t = NOW - h * H;
    n += perDay(Math.floor(h / 24)) / 24;
    list.push({ t, views: { a: Math.round(n), b: 500 } });
  }
  return list;
}

test('MK Coin: Antwort der Schnittstelle → Aufrufe je Video', () => {
  const json = { videos: [{ video_id: 'x1', views: '120' }, { url: 'u2', views: 5 }, { video_id: 'x3', views: 'abc' }, { views: 3 }] };
  assert.deepEqual(tv.parseVideos(json), { x1: 120, u2: 5 });
  assert.deepEqual(tv.parseVideos({}), {});
  assert.deepEqual(tv.parseVideos(null), {});
});

test('MK Coin: Zuwachs nur von Videos, die in beiden Abrufen vorkommen, hochgerechnet auf einen Tag', () => {
  const a = { t: 0, views: { x: 100, y: 50 } };
  const b = { t: 12 * H, views: { x: 160, z: 9999 } }; // y fehlt, z ist neu – beide zählen nicht
  assert.equal(tv.growth(a, b), 120);
  assert.equal(tv.growth(b, a), null);
  assert.equal(tv.growth(a, { t: H, views: { q: 1 } }), null);
});

test('MK Coin: mehr Zuwachs als in den Vortagen = Trend nach oben, weniger = nach unten, gleich = 0', () => {
  const flat = tv.driftFrom(series(8, () => 1000), NOW);
  assert.ok(Math.abs(flat.mu) < 0.01, `gleich ${flat.mu}`);
  const up = tv.driftFrom(series(8, (k) => (k === 0 ? 2000 : 1000)), NOW);
  assert.ok(up.sentiment > 0.9 && up.mu > 0 && up.mu <= tv.MAX_DRIFT, `doppelt ${up.sentiment}`);
  const down = tv.driftFrom(series(8, (k) => (k === 0 ? 500 : 1000)), NOW);
  assert.ok(down.sentiment < -0.9 && down.mu < 0 && down.mu >= -tv.MAX_DRIFT, `halb ${down.sentiment}`);
  const tenfold = tv.driftFrom(series(8, (k) => (k === 0 ? 10000 : 1000)), NOW);
  assert.equal(tenfold.mu, tv.MAX_DRIFT); // begrenzt
});

test('MK Coin: ohne Vortag oder ohne aktuellen Abruf kein Trend', () => {
  assert.equal(tv.driftFrom(series(0.5, () => 1000).slice(-12), NOW).mu, 0); // erst ein halber Tag
  assert.equal(tv.driftFrom(series(1, () => 1000), NOW).mu, 0); // heute ja, aber kein ganzer Vortag
  assert.ok(tv.driftFrom(series(2, (k) => (k === 0 ? 3000 : 1000)), NOW).mu > 0); // ab einem Vortag
  assert.equal(tv.driftFrom(series(8, () => 1000), NOW + 3 * H).mu, 0); // letzter Abruf zu alt
  assert.equal(tv.driftFrom([], NOW).mu, 0);
});

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const catalog = require('../src/tcg/catalog');

const sell = (key) => catalog.rarityByKey[key].sell;

test('Gewichte ergeben 100 % und werden seltener', () => {
  assert.equal(catalog.TOTAL_WEIGHT, 10000);
  for (let i = 1; i < catalog.RARITIES.length; i++) {
    assert.ok(catalog.RARITIES[i].weight < catalog.RARITIES[i - 1].weight, `${catalog.RARITIES[i].key} muss seltener sein`);
    assert.ok(catalog.RARITIES[i].sell > catalog.RARITIES[i - 1].sell, `${catalog.RARITIES[i].key} muss mehr wert sein`);
  }
  assert.equal(catalog.chance('glitch'), 0.0008);
  assert.equal(catalog.chance('icon'), 0.0002);
  assert.equal(catalog.chance('sith'), 0.0001);
  assert.equal(sell('icon'), 400000);
  assert.equal(sell('sith'), 1000000);
  // Die geheime Seltenheit erscheint nicht in den Drop-Raten
  assert.deepEqual(catalog.visibleRarities().map((r) => r.key), ['crumpled', 'bfwler', 'gold', 'holo', 'bockhaber', 'glitch', 'icon']);
  assert.equal(catalog.chance('bockhaber'), 0.003);
});

test('Ein Pack ist im Schnitt weniger wert als sein Preis', () => {
  const ev = catalog.expectedPackValue();
  assert.equal(Math.round(ev), 7156);
  assert.ok(ev < config.tcgPackPrice, `Erwartungswert ${ev} muss unter ${config.tcgPackPrice} liegen`);
});

test('2× Crumpled + 1× BFWler bleibt mindestens 5 € im Minus', () => {
  assert.ok(2 * sell('crumpled') + sell('bfwler') <= config.tcgPackPrice - 500);
});

test('Seltenheit je Wurf (Grenzen)', () => {
  assert.equal(catalog.rarityForRoll(0), 'crumpled');
  assert.equal(catalog.rarityForRoll(5808), 'crumpled');
  assert.equal(catalog.rarityForRoll(5809), 'bfwler');
  assert.equal(catalog.rarityForRoll(9988), 'bockhaber');
  assert.equal(catalog.rarityForRoll(9989), 'glitch');
  assert.equal(catalog.rarityForRoll(9996), 'glitch');
  assert.equal(catalog.rarityForRoll(9997), 'icon');
  assert.equal(catalog.rarityForRoll(9998), 'icon');
  assert.equal(catalog.rarityForRoll(9999), 'sith');
});

test('Karten werden aus den Dateinamen gelesen', () => {
  assert.equal(catalog.prettyName('bfw-energy'), 'BFW Energy');
  assert.equal(catalog.prettyName('krisz'), 'Krisz');
  assert.equal(catalog.prettyName('casino-kaffee'), 'Casino-Kaffee');
  assert.equal(catalog.cardById['lili-6-glitch'].name, 'Lili');
  assert.equal(catalog.cardById['casino-kaffee-3-gold'].rarity, 'gold');
  assert.equal(catalog.CARDS.length, 90);
  assert.equal(catalog.cardById['hermann-4-icon'].name, 'Hermann');
  assert.equal(catalog.cardById['mauch-4-icon'].rarity, 'icon');
  assert.equal(catalog.cardById['sigrist-3-glitch'].name, 'Sigrist');
  assert.equal(catalog.cardById['oliver-the-sigrist-sith'].name, 'Oliver the Sigrist');
  assert.equal(catalog.cardById['oliver-the-sigrist-sith'].rarity, 'sith');
  assert.equal(catalog.CARDS[catalog.CARDS.length - 1].id, 'oliver-the-sigrist-sith'); // letzter Platz der Sammlung
  assert.deepEqual(catalog.cardsByRarity.sith.map((c) => c.id), ['oliver-the-sigrist-sith']);
  assert.equal(catalog.cardById['aleks-5-bockhaber'].name, 'Aleks');
  assert.equal(catalog.cardById['seven-3-gold'].name, '7');
  assert.equal(catalog.cardById['grafikkarte-amd-gold'].name, 'AMD-Grafikkarte');
  assert.equal(catalog.cardById['grafikkarte-nvidia-gold'].name, 'NVIDIA-Grafikkarte');
  assert.equal(catalog.cardById['grafikkarte-nvidia-gold'].rarity, 'gold');
  assert.equal(catalog.cardById['adrian-4-holo'].name, 'Adrian');
  assert.equal(catalog.cardById['marcel-6-glitch'].name, 'Marcel');
  // Namen, die nicht aus dem Dateinamen folgen
  assert.equal(catalog.cardById['omer-3-gold'].name, 'Ömer');
  assert.equal(catalog.cardById['st-ivan-1-crumpled'].name, 'St. Ivan');
  assert.equal(catalog.cardById['hugo-holo'].name, 'Hugo');
  assert.equal(catalog.cardById['lilly-holo'].rarity, 'holo');
  assert.equal(catalog.cardById['matze-6-glitch'].name, 'Matze');
  assert.equal(catalog.cardById['pascal-5-bockhaber'].name, 'Pascal');
  const c = catalog.cardById['krisz-6-glitch'];
  assert.ok(c, 'krisz-6-glitch fehlt');
  assert.equal(c.rarity, 'glitch');
  assert.equal(c.name, 'Krisz');
  assert.equal(catalog.cardById['bfw-energy-gold'].rarity, 'gold');
  assert.ok(!catalog.CARDS.some((x) => x.id.includes('booster')), 'Pack-Bild ist keine Karte');
  for (const r of catalog.RARITIES) assert.ok(catalog.cardsByRarity[r.key].length > 0, `keine Karte für ${r.key}`);
});

test('Zufallstest: Verteilung passt zu den Gewichten', () => {
  const crypto = require('crypto');
  const n = 200000;
  const counts = Object.fromEntries(catalog.RARITIES.map((r) => [r.key, 0]));
  for (let i = 0; i < n; i++) counts[catalog.drawCard(crypto.randomInt).rarity]++;
  for (const r of catalog.RARITIES) {
    const expected = n * catalog.chance(r.key);
    const tolerance = 5 * Math.sqrt(expected) + 5; // ~5 Sigma
    assert.ok(Math.abs(counts[r.key] - expected) < tolerance, `${r.key}: ${counts[r.key]} statt ~${expected}`);
  }
});

test('Admin-Chancen: nur gültig, wenn zusammen genau 100 %', () => {
  const settings = require('../src/tcg/settings');
  const ok = { ...catalog.DEFAULT_WEIGHT };
  assert.ok(settings.validWeights(ok));
  assert.ok(!settings.validWeights({ ...ok, glitch: ok.glitch + 1 }), 'Summe 100,01 %');
  assert.ok(!settings.validWeights({ ...ok, glitch: -8, crumpled: ok.crumpled + 16 }), 'negativ');
  assert.ok(!settings.validWeights({ ...ok, glitch: 0.5, crumpled: ok.crumpled + 7.5 }), 'keine Ganzzahl');
  const { glitch, ...missing } = ok;
  assert.ok(!settings.validWeights(missing), 'fehlende Seltenheit');
  assert.ok(settings.validWeights({ ...ok, glitch: 0, crumpled: ok.crumpled + ok.glitch }), '0 % ist erlaubt');
  // Alte gespeicherte Chancen (ohne Icon/Sith) bleiben gültig: Die neuen kommen von Crumpled dazu
  const old = { crumpled: 5000, bfwler: 3612, gold: 1100, holo: 250, bockhaber: 30, glitch: 8 };
  const filled = settings.withNewRarities(old);
  assert.deepEqual(filled, { ...old, crumpled: 4997, icon: 2, sith: 1 });
  assert.ok(settings.validWeights(filled));
});

test('Ein Pack hat 3 Karten', () => {
  assert.equal(catalog.drawPack().length, 3);
});

test('Patchnotes: Auszeichnung wird zu sicherem HTML', () => {
  const { render } = require('../src/patchnotes/render');
  const html = render('# Titel\n## Unter\nErste **fette** Zeile\nzweite __unterstrichene__\n\n- eins\n- zwei <script>x</script>');
  assert.equal(html, [
    '<h3 class="pn-h1">Titel</h3>',
    '<h4 class="pn-h2">Unter</h4>',
    '<p>Erste <strong>fette</strong> Zeile<br>zweite <u>unterstrichene</u></p>',
    '<ul><li>eins</li><li>zwei &lt;script&gt;x&lt;/script&gt;</li></ul>',
  ].join('\n'));
});

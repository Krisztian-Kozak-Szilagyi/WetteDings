// Werkbank-Ansicht (Grading-Shop der Seite und Shop-Demo): so rendern wie Express – settings.views ist ein String,
// eingebundene Teile müssen also relativ zur Datei gefunden werden (2026-10-14: „partials/…“ im Partial gab HTTP 500)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const ejs = require('ejs');
const { CENTERING_SCALE } = require('../src/grading/condition');

const views = path.join(__dirname, '..', 'views');
const render = (file, extra) =>
  ejs.renderFile(path.join(views, file), Object.assign({
    settings: { views },
    euro: (c) => (c / 100).toFixed(2) + ' €',
    pay: { clean: 2500, grade: 3000, slab: 6000, iron: 2000 },
    csrfToken: 't',
    assetVersion: '1',
    appName: 'Test',
    title: 'Arbeitstisch',
    centeringScale: CENTERING_SCALE,
    jobData: { id: '1', steps: ['clean', 'iron', 'grade', 'slab'], card: { name: 'K', rarity: 'holo', rarityLabel: 'Holo' }, customer: 'Max', services: { base: true, slab: true }, player: false },
  }, extra));

test('Werkbank-Teil rendert mit allen eingebundenen Teilen', async () => {
  const html = await render('partials/grading-werkbank-body.ejs');
  assert.ok(html.includes('data-gr-panel="clean"') && html.includes('data-gr-panel="iron"') && html.includes('/grading/zuruecksenden'));
});

test('Shop-Demo-Arbeitstisch rendert (ohne Seitenmenü, Demo-Adressen)', async () => {
  const html = await render('shop-werkbank.ejs', { jobData: { demo: true, id: '1', steps: ['clean'], card: null, customer: 'Kunde 1', services: null } });
  assert.ok(html.includes('/shop-demo/werkbank/fertig'));
  assert.ok(!html.includes('← Shop') && !html.includes('<nav'));
});

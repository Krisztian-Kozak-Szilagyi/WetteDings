// Shop-Demo: Phaser-Szenen (Arbeitstisch, Kasse) ohne Browser durchspielen. Phaser übernimmt bei Szenen als Objekt nur
// init/preload/create/update und "extend" – fehlt dort eine Methode, steht das ganze Spiel (2026-10-14).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** Lädt eine Datei aus public/js wie im Browser und baut die Szene so zusammen wie Phaser */
function loadScene(file, globalName) {
  const P = {
    Math: { RandomDataGenerator: function () { return { between: (a) => a, pick: (x) => x[0] }; }, Between: () => 0 },
    Display: { Color: { GetColor: () => 0 } },
  };
  const ctx = { window: { Phaser: P }, Phaser: P, URLSearchParams, Math, Number, String, Array, Object, Set, JSON };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8'), ctx);
  let cfg;
  ctx.window[globalName].open({ scene: { getScene: () => null, add: (k, c) => { cfg = c; }, start() {}, bringToTop() {}, isActive: () => true } }, {});
  const scene = {};
  ['init', 'preload', 'create', 'update'].forEach((k) => { if (cfg[k]) scene[k] = cfg[k]; });
  Object.assign(scene, cfg.extend || {});
  const clicks = [];
  const obj = () => new Proxy(function () {}, {
    get: (t, p) => (p === 'then' ? undefined : p === 'on' ? (e, fn) => { if (e === 'pointerdown') clicks.push(fn); return obj(); } : obj()),
    apply: () => obj(),
  });
  const handlers = {};
  Object.assign(scene, {
    scale: { width: 1200, height: 800 }, textures: { exists: () => false }, add: obj(), load: obj(), tweens: obj(),
    time: { delayedCall: (ms, fn) => fn() }, scene: { stop() { scene.stopped = true; } },
    input: { on: (e, fn) => { handlers[e] = fn; }, keyboard: { on: (e, fn) => { handlers[e] = fn; }, once: (e, fn) => { handlers[e] = fn; } } },
  });
  return { scene, handlers, clicks };
}

test('Arbeitstisch: putzen, umdrehen, bügeln, Esc', () => {
  const { scene, handlers } = loadScene('shop-werkbank-phaser.js', 'ShopWerkbank');
  let cancelled = false;
  scene.init({ job: { id: '1', steps: ['clean', 'iron'], spots: [{ side: 'f', kind: 'fleck', x: 50, y: 50, r: 10 }, { side: 'b', kind: 'kaffee', x: 30, y: 30, r: 8 }], crease: { y: 50, angle: 5 } }, csrf: 't', onCancel: () => { cancelled = true; } });
  scene.create();
  scene.update(0, 16);
  handlers.pointerdown({ x: 600, y: 400 });
  for (let i = 0; i < 300; i++) handlers.pointermove({ x: 600 + (i % 2 ? 40 : -40), y: 400, isDown: true });
  assert.strictEqual(scene.cleanliness(), 50, 'vorne sauber, hinten nicht');
  handlers['keydown-F']();
  assert.strictEqual(scene.facingFront, false);
  scene.finishStep();
  assert.strictEqual(scene.step(), 'iron');
  assert.strictEqual(scene.facingFront, true, 'zum Bügeln wieder vorne');
  for (let i = 0; i < 120; i++) { handlers.pointermove({ x: 300 + i * 5, y: 400, isDown: true }); scene.update(0, 16); }
  assert.ok(scene.ironResult().smooth > 0);
  handlers['keydown-ESC']();
  assert.ok(scene.stopped && cancelled);
});

test('Kasse: alles scannen, dann kassieren', () => {
  const { scene, clicks } = loadScene('shop-kasse.js', 'ShopKasse');
  let total = null;
  scene.init({ title: 'Kunde', lines: [{ name: 'Boosterpack', qty: 3, price: 10, color: 1 }, { name: 'Kaffee', qty: 1, price: 12, color: 2 }], onDone: (r) => { total = r.total; } });
  scene.create();
  const pieces = clicks.length;
  clicks.slice(0, pieces).forEach((fn) => fn());
  assert.strictEqual(clicks.length, pieces + 1, 'nach dem Scannen erscheint „Kassieren“');
  clicks[clicks.length - 1]();
  assert.strictEqual(total, 42);
});

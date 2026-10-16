// Shop-Demo: Phaser-Szenen (Arbeitstisch, Kasse) ohne Browser durchspielen. Phaser übernimmt bei Szenen als Objekt nur
// init/preload/create/update und "extend" – fehlt dort eine Methode, steht das ganze Spiel (2026-10-14).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** Lädt eine Datei aus public/js wie im Browser und baut die Szene so zusammen wie Phaser */
function loadScene(file, globalName, fetchMock) {
  const P = {
    Math: { RandomDataGenerator: function () { return { between: (a) => a, pick: (x) => x[0] }; }, Between: () => 0 },
    Display: { Color: { GetColor: () => 0 } },
  };
  P.Math.Clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ctx = { window: { Phaser: P }, Phaser: P, URLSearchParams, Math, Number, String, Array, Object, Set, JSON, Promise, fetch: fetchMock };
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
    scale: { width: 1200, height: 800 }, textures: { exists: () => false }, add: obj(), load: obj(),
    tweens: { add: (c) => { if (c.onComplete) c.onComplete(); return obj(); } }, // Animationen sofort fertig
    time: { delayedCall: (ms, fn) => fn() }, scene: { stop() { scene.stopped = true; } },
    cameras: { main: { fadeIn() {}, fadeOut() {}, once: (e, fn) => fn() } }, // Abblenden sofort fertig
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
  handlers['keydown-R']();
  assert.strictEqual(scene.facingFront, false, 'R dreht die Karte um');
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

test('Arbeitstisch: messen, benoten, versiegeln, fertig', async () => {
  const posts = [];
  const answers = { benoten: { guess: 7, grade: 8 }, fertig: { demo: true, state: { ok: 1 } } };
  const fetchMock = (url, o) => {
    posts.push([url, String(o.body)]);
    const key = Object.keys(answers).find((k) => url.endsWith(k));
    return Promise.resolve({ json: () => answers[key] });
  };
  const { scene, handlers } = loadScene('shop-werkbank-phaser.js', 'ShopWerkbank', fetchMock);
  let done = null;
  scene.init({
    job: { id: '4', steps: ['grade', 'slab'], center: { x: 0.2 }, centerScale: [{ from: 50, to: 55, cap: 10 }, { from: 56, to: 60, cap: 9 }],
      defects: { scratches: [{ x: 40, y: 40, len: 20, angle: 10 }], corners: [1], edges: [{ side: 0, pos: 30 }], centering: { lr: 56 } } },
    station: 'card_grading_table', csrf: 't', onDone: (r) => { done = r; },
  });
  scene.create();
  assert.strictEqual(scene.step(), 'grade');
  scene.update(0, 16);
  // Messen: linke Linie an die Bildkante ziehen (Magnet)
  handlers['keydown-M']();
  assert.strictEqual(scene.mode, 'measure');
  const c = scene.card;
  handlers.pointerdown({ x: c.x + scene.guides.l * c.w, y: c.cy });
  handlers.pointermove({ x: c.x + scene.imgEdge.l * c.w + 0.5, y: c.cy, isDown: true });
  assert.strictEqual(scene.guides.l, scene.imgEdge.l, 'rastet an der Bildkante ein');
  handlers.pointerup();
  scene.pickGrade(7);
  scene.submitGrade();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual([scene.guess, scene.grade], [7, 8]);
  assert.ok(posts[0][0].endsWith('/benoten') && posts[0][1].includes('tisch=card_grading_table'));
  scene.next();
  assert.strictEqual(scene.step(), 'slab');
  scene.t = 0.425; // Zeiger genau in der Mitte (850 ms für eine Strecke)
  scene.meter.t0 = 0;
  scene.update(0, 0);
  scene.seal();
  assert.ok(scene.sealQ >= 90, 'mittig gestoppt = sauber versiegelt');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(posts[1][0].endsWith('/fertig') && posts[1][1].includes('seal=' + scene.sealQ));
  assert.deepStrictEqual(done, answers.fertig);
});

test('Arbeitstisch: Karte in den Sleeve schieben (schief hakt), Ecken umklappen, fertig', async () => {
  const posts = [];
  const fetchMock = (url, o) => { posts.push([url, String(o.body)]); return Promise.resolve({ json: () => ({ demo: true }) }); };
  const { scene, handlers } = loadScene('shop-werkbank-phaser.js', 'ShopWerkbank', fetchMock);
  scene.init({ job: { id: '7', steps: ['foil'] }, station: 'pack_opening_counter', csrf: 't', onDone: () => {} });
  scene.create();
  assert.strictEqual(scene.step(), 'foil');
  const c = scene.card;
  const fo = scene.foil;
  // schief nach unten ziehen: hakt am Rand
  fo.dx = c.w * 0.2;
  handlers.pointerdown({ x: c.cx + fo.dx, y: c.cy + fo.dy });
  handlers.pointermove({ x: c.cx + fo.dx, y: c.cy + fo.dy + c.h, isDown: true });
  assert.strictEqual(fo.phase, 'slide', 'schief = hakt');
  // gerade rücken und ganz hinein
  handlers.pointermove({ x: c.cx + 0.01 * c.w, y: c.cy + fo.dy + c.h, isDown: true });
  handlers.pointermove({ x: c.cx + 0.01 * c.w, y: c.cy + c.h * 2, isDown: true });
  assert.strictEqual(fo.phase, 'fold');
  assert.ok(fo.slideQ > 80);
  handlers.pointerup({ x: 0, y: 0 });
  // Ecken: links nach rechts unten, rechts nach links unten
  const r = scene.sleeveRect();
  handlers.pointerdown({ x: r.x + 2, y: r.y + 2 });
  handlers.pointerup({ x: r.x + 2 + c.w * 0.1, y: r.y + 2 + c.w * 0.1 });
  handlers.pointerdown({ x: r.x + r.w - 2, y: r.y + 2 });
  handlers.pointerup({ x: r.x + r.w - 2 - c.w * 0.1, y: r.y + 2 + c.w * 0.1 });
  assert.strictEqual(fo.phase, 'done');
  assert.ok(scene.foilQ > 85);
  await new Promise((res) => setTimeout(res, 0));
  assert.ok(posts.some(([u, b]) => u.endsWith('/fertig') && b.includes('foil=' + scene.foilQ) && b.includes('tisch=pack_opening_counter')));
});

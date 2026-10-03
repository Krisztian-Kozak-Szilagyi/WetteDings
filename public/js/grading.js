// Grading-Shop: Arbeitstisch mit drehbarer 3D-Karte – Flecken wegreiben, Note bestimmen, im Slab versiegeln.
// Die Auftragsdaten stehen in data-grading (views/grading.ejs); Lohn und echte Note berechnet der Server.
(function () {
  'use strict';
  var bench = document.querySelector('[data-grading]');
  if (!bench) return;
  var job = JSON.parse(bench.getAttribute('data-grading'));
  var stage = bench.querySelector('[data-gr-stage]');
  var zoomEl = bench.querySelector('[data-gr-zoom]');
  var obj = bench.querySelector('[data-gr-obj]');
  var hint = bench.querySelector('[data-gr-hint]');
  var form = bench.querySelector('[data-gr-send]');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  // ---------- Karte aufbauen ----------
  var card = el('div', 'gr-card', obj);
  var front = el('div', 'gr-face gr-front', card);
  var img = el('img', 'gr-img', front);
  img.src = job.card ? job.card.image : '';
  img.alt = job.card ? job.card.name : '';
  img.draggable = false;
  if (job.card && job.card.rank >= 3) el('div', 'gr-holo', front); // Holo und seltener schimmern

  var d = job.defects || {};
  var defects = el('div', 'gr-defects', front);
  (d.scratches || []).forEach(function (s) {
    var e = el('span', 'gr-scratch', defects);
    e.style.left = s.x + '%';
    e.style.top = s.y + '%';
    e.style.width = s.len + '%';
    e.style.transform = 'rotate(' + s.angle + 'deg)';
  });
  (d.corners || []).forEach(function (c) { el('span', 'gr-corner gr-corner-' + c, defects); });
  (d.edges || []).forEach(function (n) {
    var e = el('span', 'gr-nick gr-nick-' + n.side, defects);
    if (n.side % 2 === 0) e.style.left = n.pos + '%';
    else e.style.top = n.pos + '%';
  });
  if (d.crease) el('span', 'gr-crease', defects);
  el('div', 'gr-glare', front);

  var back = el('div', 'gr-face gr-back', card);
  el('div', 'gr-back-logo', back);
  el('div', 'gr-glare', back);

  // Flecken: hp 1 → 0 durch Reiben
  var spots = (job.spots || []).map(function (s) {
    var e = el('span', 'gr-spot gr-spot-' + s.kind, s.side === 'f' ? front : back);
    e.style.left = s.x + '%';
    e.style.top = s.y + '%';
    e.style.width = s.r * 1.6 + '%';
    var spot = { el: e, side: s.side, hp: 1, need: 140 + s.r * 14 };
    e._spot = spot;
    return spot;
  });

  // Slab (Schutzhülle) – erscheint beim Versiegeln
  var slabFront = el('div', 'gr-slab gr-slab-front', obj);
  var label = el('div', 'gr-slab-label', slabFront);
  el('div', 'gr-slab-back gr-slab', obj);
  var shadow = el('div', 'gr-shadow', zoomEl);
  zoomEl.insertBefore(shadow, zoomEl.firstChild);

  // ---------- Drehen ----------
  var rx = -10;
  var ry = 18;
  var vx = 0;
  var vy = 0;
  var tween = null;
  var drag = null;
  var zoom = 1;
  var baseZoom = 1;
  var sent = false;

  function normY() { return ((ry % 360) + 540) % 360 - 180; } // -180 … 180, 0 = Vorderseite zur Kamera

  function render() {
    obj.style.transform = 'rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg)';
    var ny = normY();
    var facingFront = Math.abs(ny) < 90;
    var fy = facingFront ? ny : (ny > 0 ? ny - 180 : ny + 180); // Neigung der gerade sichtbaren Seite
    // Der Browser trifft beim Klicken sonst auch die abgewandte Seite – sie bekommt keine Mausereignisse
    card.classList.toggle('show-back', !facingFront);
    var tilt = Math.sqrt(rx * rx + fy * fy);
    // Kratzer zeigen sich erst, wenn Licht schräg darauf fällt
    obj.style.setProperty('--scr', clamp((tilt - 12) / 18, 0, 1).toFixed(3));
    obj.style.setProperty('--holo', clamp(tilt / 35, 0, 1).toFixed(3));
    obj.style.setProperty('--gx', (50 + fy * 1.6).toFixed(1) + '%');
    obj.style.setProperty('--gy', (50 + rx * 1.6).toFixed(1) + '%');
    shadow.style.transform = 'translateX(-50%) scaleX(' + (0.35 + 0.65 * Math.abs(Math.cos((ny * Math.PI) / 180))).toFixed(3) + ')';
  }

  function tweenTo(toX, toY, ms) {
    tween = { fx: rx, fy: ry, tx: toX, ty: toY, start: performance.now(), ms: reduceMotion ? 1 : ms };
    vx = 0;
    vy = 0;
  }

  function loop(now) {
    if (sent) return;
    if (tween) {
      var t = clamp((now - tween.start) / tween.ms, 0, 1);
      var e = 1 - Math.pow(1 - t, 3);
      rx = tween.fx + (tween.tx - tween.fx) * e;
      ry = tween.fy + (tween.ty - tween.fy) * e;
      if (t >= 1) tween = null;
    } else if (!drag && (Math.abs(vx) > 0.01 || Math.abs(vy) > 0.01)) {
      // Schwung nach dem Loslassen
      ry += vy;
      rx = clamp(rx + vx, -65, 65);
      vx *= 0.93;
      vy *= 0.93;
    }
    render();
    requestAnimationFrame(loop);
  }

  // ---------- Putzen ----------
  var lastFoam = 0;
  function foam(x, y) {
    var now = performance.now();
    if (now - lastFoam < 45 || reduceMotion) return;
    lastFoam = now;
    var r = stage.getBoundingClientRect();
    var f = el('span', 'gr-foam', stage);
    f.style.left = x - r.left + (Math.random() * 16 - 8) + 'px';
    f.style.top = y - r.top + (Math.random() * 16 - 8) + 'px';
    f.style.setProperty('--s', (0.5 + Math.random()).toFixed(2));
    setTimeout(function () { f.remove(); }, 700);
  }

  function rub(spot, dist) {
    if (!spot || spot.hp <= 0) return;
    spot.hp = Math.max(0, spot.hp - dist / spot.need);
    spot.el.style.setProperty('--hp', (0.15 + spot.hp * 0.85).toFixed(3));
    if (spot.hp <= 0) {
      spot.el.classList.add('is-clean');
      var sp = el('span', 'gr-sparkle', spot.el.parentNode);
      sp.style.left = spot.el.style.left;
      sp.style.top = spot.el.style.top;
      setTimeout(function () { sp.remove(); }, 900);
      updateClean();
    }
  }

  var cleanBar = bench.querySelector('[data-gr-clean-bar]');
  var cleanText = bench.querySelector('[data-gr-clean-text]');
  function updateClean() {
    var left = spots.filter(function (s) { return s.hp > 0; });
    var f = left.filter(function (s) { return s.side === 'f'; }).length;
    cleanBar.style.width = Math.round(((spots.length - left.length) / spots.length) * 100) + '%';
    cleanText.textContent = left.length ? 'Noch ' + left.length + (left.length === 1 ? ' Fleck' : ' Flecken') + ' – vorne ' + f + ', hinten ' + (left.length - f) + '.' : 'Blitzblank!';
    if (!left.length && step === 'clean') {
      card.classList.add('is-shiny');
      // Der Server verlangt eine Mindestzeit pro Fleck – notfalls kurz warten
      var wait = Math.max(600, job.startedAt + job.minMs + 300 - Date.now());
      setTimeout(nextStep, wait);
    }
  }

  // ---------- Zeiger: Drehen oder Reiben ----------
  function spotAt(x, y) {
    var t = document.elementFromPoint(x, y);
    var e = t && t.closest ? t.closest('.gr-spot') : null;
    return e && !e.classList.contains('is-clean') ? e._spot : null;
  }

  stage.addEventListener('pointerdown', function (e) {
    if (sent || e.button > 0 || e.target.closest('.gr-tools')) return;
    var spot = step === 'clean' ? spotAt(e.clientX, e.clientY) : null;
    drag = { mode: spot ? 'rub' : 'rotate', x: e.clientX, y: e.clientY };
    tween = null;
    vx = 0;
    vy = 0;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add(spot ? 'is-rubbing' : 'is-dragging');
    hint.classList.add('is-gone');
  });

  stage.addEventListener('pointermove', function (e) {
    if (zoom > 1) {
      var r = stage.getBoundingClientRect();
      zoomEl.style.transformOrigin = e.clientX - r.left + 'px ' + (e.clientY - r.top) + 'px';
    }
    if (!drag) return;
    var dx = e.clientX - drag.x;
    var dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.mode === 'rotate') {
      var k = 0.45 / zoom;
      ry += dx * k;
      rx = clamp(rx - dy * k, -65, 65);
      // Schwung begrenzen, damit ein schneller Wisch die Karte nicht wild kreiseln lässt
      vy = clamp(dx * k, -6, 6);
      vx = clamp(-dy * k, -6, 6);
    } else {
      var spot = spotAt(e.clientX, e.clientY);
      if (spot) {
        rub(spot, Math.sqrt(dx * dx + dy * dy));
        foam(e.clientX, e.clientY);
      }
    }
  });

  function endDrag() {
    drag = null;
    stage.classList.remove('is-dragging', 'is-rubbing');
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // Mausrad: Lupe stufenlos
  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = stage.getBoundingClientRect();
    zoomEl.style.transformOrigin = e.clientX - r.left + 'px ' + (e.clientY - r.top) + 'px';
    setZoom(clamp(zoom - e.deltaY * 0.0015, 1, 2.6));
  }, { passive: false });

  function setZoom(z) {
    zoom = z;
    zoomEl.style.setProperty('--z', (zoom * baseZoom).toFixed(3));
    loupeBtn.classList.toggle('is-on', zoom > 1);
    if (zoom === 1) zoomEl.style.transformOrigin = '';
  }

  // Tastatur: Pfeiltasten drehen
  stage.tabIndex = 0;
  stage.addEventListener('keydown', function (e) {
    var map = { ArrowLeft: [0, -12], ArrowRight: [0, 12], ArrowUp: [12, 0], ArrowDown: [-12, 0] };
    if (!map[e.key]) return;
    e.preventDefault();
    tweenTo(clamp(rx + map[e.key][0], -65, 65), ry + map[e.key][1], 220);
  });

  // Werkzeuge
  bench.querySelector('[data-gr-flip]').addEventListener('click', function () {
    tweenTo(0, Math.round((ry + 180) / 180) * 180, 700);
  });
  var loupeBtn = bench.querySelector('[data-gr-loupe]');
  loupeBtn.addEventListener('click', function () { setZoom(zoom > 1 ? 1 : 2.2); });
  bench.querySelector('[data-gr-reset]').addEventListener('click', function () {
    setZoom(1);
    tweenTo(0, Math.round(ry / 360) * 360, 600);
  });

  // ---------- Arbeitsschritte ----------
  var steps = (job.steps || ['clean']).concat(['send']);
  var step = null;
  var HINTS = {
    clean: 'Ziehen zum Drehen · über Flecken reiben zum Putzen',
    grade: 'Schräg ins Licht drehen – Kratzer blitzen auf · 🔍 für Ecken und Kanten',
    slab: 'Stoppe den Zeiger im grünen Bereich',
    send: 'Fertig – ab zum Kunden!',
  };
  function setStep(name) {
    step = name;
    bench.querySelectorAll('[data-gr-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-gr-panel') !== name; });
    var idx = steps.indexOf(name);
    bench.querySelectorAll('[data-gr-steps] li').forEach(function (li, i) {
      li.classList.toggle('is-done', i < idx);
      li.classList.toggle('is-active', i === idx);
    });
    stage.classList.toggle('is-clean-step', name === 'clean');
    hint.textContent = HINTS[name] || '';
    hint.classList.remove('is-gone');
    if (name === 'slab') startMeter();
  }
  function nextStep() {
    var i = steps.indexOf(step);
    if (i < steps.length - 1) setStep(steps[i + 1]);
  }

  // Benoten
  var chosen = null;
  var gradeOk = bench.querySelector('[data-gr-grade-ok]');
  bench.querySelectorAll('[data-grade]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (step !== 'grade') return;
      chosen = Number(b.getAttribute('data-grade'));
      bench.querySelectorAll('[data-grade]').forEach(function (x) { x.classList.toggle('is-on', x === b); });
      gradeOk.disabled = false;
    });
  });
  if (gradeOk) {
    gradeOk.addEventListener('click', function () {
      if (!chosen) return;
      form.elements.grade.value = String(chosen);
      bench.querySelectorAll('[data-grade]').forEach(function (x) { x.disabled = true; });
      gradeOk.disabled = true;
      nextStep();
    });
  }

  // Versiegeln: Zeiger pendelt, Klick stoppt ihn
  var GRADE_NAMES = { 10: 'GEM MINT', 9: 'MINT', 8: 'NM-MT', 7: 'NEAR MINT', 6: 'EX-MT', 5: 'EXCELLENT', 4: 'VG-EX', 3: 'VERY GOOD', 2: 'GOOD', 1: 'POOR' };
  var needle = bench.querySelector('[data-gr-needle]');
  var sealBtn = bench.querySelector('[data-gr-seal]');
  var meterOn = false;
  var meterStart = 0;
  var meterPos = 0;
  function meterLoop(now) {
    if (!meterOn) return;
    var p = ((now - meterStart) / 850) % 2;
    meterPos = (p < 1 ? p : 2 - p) * 100;
    needle.style.left = meterPos + '%';
    requestAnimationFrame(meterLoop);
  }
  function startMeter() {
    if (!needle || meterOn) return;
    meterOn = true;
    meterStart = performance.now();
    requestAnimationFrame(meterLoop);
  }
  if (sealBtn) {
    sealBtn.addEventListener('click', function () {
      if (!meterOn) return;
      meterOn = false;
      sealBtn.disabled = true;
      var q = Math.max(0, Math.round(100 - Math.abs(meterPos - 50) * 4));
      form.elements.seal.value = String(q);
      var res = bench.querySelector('[data-gr-seal-result]');
      res.textContent = q >= 90 ? 'Perfekt versiegelt! (' + q + ' %)' : q >= 60 ? 'Sauber versiegelt. (' + q + ' %)' : q > 0 ? 'Eine kleine Luftblase … (' + q + ' %)' : 'Schief eingeschweißt! (0 %)';
      res.className = 'gr-seal-result ' + (q >= 60 ? 'gr-ok' : 'gr-bad');
      var g = Number(form.elements.grade.value) || 0;
      label.innerHTML = '';
      var info = el('div', 'gr-slab-info', label);
      el('strong', '', info).textContent = 'BfW GRADING';
      el('span', '', info).textContent = (job.card ? job.card.name + ' · ' + job.card.rarityLabel : '');
      el('span', 'gr-slab-word', info).textContent = GRADE_NAMES[g] || '';
      el('div', 'gr-slab-grade', label).textContent = g || '–';
      baseZoom = 0.82;
      setZoom(1);
      tweenTo(-6, Math.round(ry / 360) * 360 + 14, 700);
      obj.classList.add('is-slabbed');
      setTimeout(nextStep, 1300);
    });
  }

  // Zurückschicken: Karte fliegt davon, dann wird das Formular abgeschickt
  form.addEventListener('submit', function (e) {
    if (sent) return;
    e.preventDefault();
    sent = true;
    form.querySelector('button[type="submit"]').disabled = true;
    obj.classList.add('is-sent');
    setTimeout(function () { form.submit(); }, reduceMotion ? 0 : 850);
  });

  setStep(steps[0]);
  updateClean();
  render();
  requestAnimationFrame(loop);
})();

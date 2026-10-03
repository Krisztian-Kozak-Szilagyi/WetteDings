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
  var csrf = form.elements._csrf.value;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var BRUSH = 16; // Radius des Putzlappens in Pixeln (zusätzlich zur Fleckgröße)

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

  // Flecken: hp 1 → 0 durch Reiben. Ob alles weg ist, muss der Spieler selbst sehen – es gibt keine Anzeige.
  var spots = (job.spots || []).map(function (s) {
    var e = el('span', 'gr-spot gr-spot-' + s.kind, s.side === 'f' ? front : back);
    e.style.left = s.x + '%';
    e.style.top = s.y + '%';
    e.style.width = s.r * 1.6 + '%';
    return { el: e, side: s.side, hp: 1, need: 90 + s.r * 8 };
  });

  // Slab (Schutzhülle) – erscheint beim Versiegeln
  var slabBox = el('div', 'gr-slabbox', obj);
  var label = el('div', 'gr-slab-label', el('div', 'gr-slab gr-slab-front', slabBox));
  var labelBack = el('div', 'gr-slab-label gr-slab-label-back', el('div', 'gr-slab gr-slab-back', slabBox));
  ['l', 'r', 't', 'b'].forEach(function (side) { el('div', 'gr-slab-edge gr-slab-edge-' + side, slabBox); });
  var shadow = el('div', 'gr-shadow');
  zoomEl.insertBefore(shadow, zoomEl.firstChild);

  // ---------- Drehen ----------
  var rx = -10;
  var ry = 18;
  var vx = 0;
  var vy = 0;
  var tween = null;
  var drag = null;
  var facingFront = true;
  var sent = false;

  function normY() { return ((ry % 360) + 540) % 360 - 180; } // -180 … 180, 0 = Vorderseite zur Kamera

  function render() {
    obj.style.transform = 'rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg)';
    var ny = normY();
    facingFront = Math.abs(ny) < 90;
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
      vx *= 0.9;
      vy *= 0.9;
    }
    render();
    requestAnimationFrame(loop);
  }

  // ---------- Lupe ----------
  // Vergrößert wird über die echte Kartengröße (nicht per scale) – so bleibt das Bild scharf.
  // Der Punkt unter der Maus bleibt beim Zoomen stehen; bloßes Bewegen der Maus verschiebt nichts.
  var zoom = 1;
  var baseZoom = 1;
  var ox = 0;
  var oy = 0;
  var loupeBtn = bench.querySelector('[data-gr-loupe]');
  function applyZoom() {
    zoomEl.style.setProperty('--z', (zoom * baseZoom).toFixed(3));
    var w = obj.offsetWidth;
    var h = obj.offsetHeight;
    // Karte darf nicht ganz aus dem Bild rutschen
    ox = clamp(ox, -w / 2, w / 2);
    oy = clamp(oy, -h / 2, h / 2);
    zoomEl.style.transform = 'translate(' + ox.toFixed(1) + 'px, ' + oy.toFixed(1) + 'px)';
    loupeBtn.classList.toggle('is-on', zoom > 1);
  }
  function setZoom(z, px, py) {
    z = clamp(z, 1, 2.6);
    var f = z / zoom;
    var r = stage.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    if (px === undefined) {
      px = cx + ox;
      py = cy + oy;
    }
    // Punkt (px, py) relativ zur Kartenmitte bleibt an seiner Stelle
    ox = px - cx - (px - cx - ox) * f;
    oy = py - cy - (py - cy - oy) * f;
    zoom = z;
    if (zoom === 1) ox = oy = 0;
    applyZoom();
  }
  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
  }, { passive: false });
  loupeBtn.addEventListener('click', function () { setZoom(zoom > 1 ? 1 : 2.2); });

  // ---------- Maus-Werkzeug: Drehen oder Putzen ----------
  var mode = 'rotate';
  var modeBtns = bench.querySelectorAll('[data-gr-mode]');
  function setMode(m) {
    mode = m;
    modeBtns.forEach(function (b) {
      var on = b.getAttribute('data-gr-mode') === m;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    stage.classList.toggle('mode-clean', m === 'clean');
    stage.classList.toggle('mode-rotate', m === 'rotate');
    showHint();
  }
  modeBtns.forEach(function (b) {
    b.addEventListener('click', function () { setMode(b.getAttribute('data-gr-mode')); });
  });

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

  /** Reibt alle Flecken der sichtbaren Seite, die der Lappen an (x, y) berührt */
  function rubAt(x, y, dist) {
    var hit = false;
    spots.forEach(function (s) {
      if (s.hp <= 0 || (s.side === 'f') !== facingFront) return;
      var r = s.el.getBoundingClientRect();
      var dx = x - (r.left + r.width / 2);
      var dy = y - (r.top + r.height / 2);
      if (Math.sqrt(dx * dx + dy * dy) > Math.max(r.width, r.height) / 2 + BRUSH) return;
      hit = true;
      s.hp = Math.max(0, s.hp - dist / s.need);
      if (s.hp < 0.04) s.hp = 0;
      // Reste bleiben lange sichtbar: erst ganz am Ende verschwindet ein Fleck
      s.el.style.setProperty('--hp', Math.pow(s.hp, 0.6).toFixed(3));
      if (!s.hp) s.el.classList.add('is-clean');
    });
    if (hit) foam(x, y);
  }

  /** Sauberkeit in Prozent (wird beim Zurückschicken mitgeschickt) */
  function cleanliness() {
    if (!spots.length) return 100;
    var sum = spots.reduce(function (a, s) { return a + (1 - s.hp); }, 0);
    return Math.round((sum / spots.length) * 100);
  }

  // ---------- Zeiger ----------
  stage.addEventListener('pointerdown', function (e) {
    if (sent || e.button > 0 || e.target.closest('.gr-tools, .gr-modes')) return;
    e.preventDefault(); // keine Textauswahl beim Ziehen (die färbte die ganze Seite dunkel)
    drag = { x: e.clientX, y: e.clientY };
    tween = null;
    vx = 0;
    vy = 0;
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetische Ereignisse */ }
    stage.classList.add('is-pressed');
    hint.classList.add('is-gone');
    if (mode === 'clean') rubAt(e.clientX, e.clientY, 6);
  });

  stage.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x;
    var dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (mode === 'rotate') {
      var k = 0.45 / zoom;
      ry += dx * k;
      rx = clamp(rx - dy * k, -65, 65);
      // Schwung begrenzen, damit ein schneller Wisch die Karte nicht wild kreiseln lässt
      vy = clamp(dx * k, -6, 6);
      vx = clamp(-dy * k, -6, 6);
    } else {
      rubAt(e.clientX, e.clientY, Math.sqrt(dx * dx + dy * dy));
    }
  });

  function endDrag() {
    drag = null;
    stage.classList.remove('is-pressed');
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('selectstart', function (e) { e.preventDefault(); });

  // Tastatur: Pfeiltasten drehen, D/P wechseln das Werkzeug
  stage.tabIndex = 0;
  stage.addEventListener('keydown', function (e) {
    if (e.key === 'd' || e.key === 'D') return setMode('rotate');
    if (e.key === 'p' || e.key === 'P') return setMode('clean');
    var map = { ArrowLeft: [0, -12], ArrowRight: [0, 12], ArrowUp: [12, 0], ArrowDown: [-12, 0] };
    if (!map[e.key]) return;
    e.preventDefault();
    tweenTo(clamp(rx + map[e.key][0], -65, 65), ry + map[e.key][1], 220);
  });

  // Werkzeuge
  bench.querySelector('[data-gr-flip]').addEventListener('click', function () {
    tweenTo(0, Math.round((ry + 180) / 180) * 180, 700);
  });
  bench.querySelector('[data-gr-reset]').addEventListener('click', function () {
    setZoom(1);
    tweenTo(0, Math.round(ry / 360) * 360, 600);
  });

  // ---------- Arbeitsschritte ----------
  var steps = (job.steps || ['clean']).concat(['send']);
  var step = null;
  var HINTS = {
    clean: { clean: 'Putzen: mit gedrückter Maustaste über die Flecken reiben', rotate: 'Drehen: ziehen, um die Karte zu wenden · Mausrad = Lupe' },
    grade: { clean: 'Putzen: mit gedrückter Maustaste reiben', rotate: 'Schräg ins Licht drehen – Kratzer blitzen auf · Mausrad = Lupe' },
    slab: { clean: 'Stoppe den Zeiger im grünen Bereich', rotate: 'Stoppe den Zeiger im grünen Bereich' },
    send: { clean: 'Fertig – ab zum Kunden!', rotate: 'Fertig – ab zum Kunden!' },
  };
  function showHint() {
    if (!step) return;
    hint.textContent = HINTS[step][mode];
    hint.classList.remove('is-gone');
  }
  function setStep(name) {
    step = name;
    bench.querySelectorAll('[data-gr-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-gr-panel') !== name; });
    var idx = steps.indexOf(name);
    bench.querySelectorAll('[data-gr-steps] li').forEach(function (li, i) {
      li.classList.toggle('is-done', i < idx);
      li.classList.toggle('is-active', i === idx);
    });
    setMode(name === 'clean' ? 'clean' : 'rotate');
    if (name === 'slab') startMeter();
  }
  function nextStep() {
    var i = steps.indexOf(step);
    if (i < steps.length - 1) setStep(steps[i + 1]);
  }
  bench.querySelector('[data-gr-clean-ok]').addEventListener('click', nextStep);

  // Benoten: Die Note geht sofort an den Server (nur einmal möglich), danach zeigt der Tisch die Auflösung
  var chosen = null;
  var gradeOk = bench.querySelector('[data-gr-grade-ok]');
  var gradeNext = bench.querySelector('[data-gr-grade-next]');
  var verdict = bench.querySelector('[data-gr-verdict]');
  var gradeBtns = bench.querySelectorAll('[data-grade]');
  gradeBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      if (step !== 'grade' || job.guess) return;
      chosen = Number(b.getAttribute('data-grade'));
      gradeBtns.forEach(function (x) { x.classList.toggle('is-on', x === b); });
      gradeOk.disabled = false;
    });
  });
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function showVerdict(guess, grade) {
    job.guess = guess;
    job.grade = grade;
    gradeBtns.forEach(function (x) {
      var g = Number(x.getAttribute('data-grade'));
      x.disabled = true;
      x.classList.toggle('is-on', g === guess);
      x.classList.toggle('is-right', g === grade);
    });
    gradeOk.hidden = true;
    var diff = Math.abs(guess - grade);
    var found = [];
    if ((d.scratches || []).length) found.push(plural(d.scratches.length, 'Kratzer', 'Kratzer'));
    if ((d.corners || []).length) found.push(plural(d.corners.length, 'bestoßene Ecke', 'bestoßene Ecken'));
    if ((d.edges || []).length) found.push(plural(d.edges.length, 'Kantenmacke', 'Kantenmacken'));
    if (d.crease) found.push('ein Knick');
    verdict.className = 'gr-verdict ' + (diff === 0 ? 'is-right' : diff === 1 ? 'is-close' : 'is-wrong');
    verdict.innerHTML = '';
    el('strong', '', verdict).textContent = diff === 0 ? 'Exakt! Note ' + grade + '.' : diff === 1 ? 'Knapp daneben – richtig ist ' + grade + ' (halber Bonus).' : 'Daneben – richtig ist ' + grade + '.';
    el('span', '', verdict).textContent = found.length ? ' Mängel: ' + found.join(', ') + ' – jetzt rot markiert.' : ' Die Karte war makellos.';
    verdict.hidden = false;
    gradeNext.hidden = false;
    card.classList.add('is-revealed');
  }
  if (gradeOk) {
    gradeOk.addEventListener('click', function () {
      if (!chosen) return;
      gradeOk.disabled = true;
      fetch('/grading/benoten', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf, grade: String(chosen) }),
        credentials: 'same-origin',
      })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (res.error) throw new Error(res.error);
          showVerdict(res.guess, res.grade);
        })
        .catch(function (err) {
          gradeOk.disabled = false;
          verdict.className = 'gr-verdict is-wrong';
          verdict.textContent = err.message || 'Das hat nicht geklappt – bitte noch einmal.';
          verdict.hidden = false;
        });
    });
    gradeNext.addEventListener('click', function () {
      card.classList.remove('is-revealed');
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
      var g = job.guess || 0;
      label.innerHTML = '';
      var info = el('div', 'gr-slab-info', label);
      el('strong', '', info).textContent = 'BfW GRADING';
      el('span', '', info).textContent = job.card ? job.card.name + ' · ' + job.card.rarityLabel : '';
      el('span', 'gr-slab-word', info).textContent = GRADE_NAMES[g] || '';
      el('div', 'gr-slab-grade', label).textContent = g || '–';
      // Rückseite: Zertifikat mit Nummer und Strichcode
      labelBack.innerHTML = '';
      var cert = el('div', 'gr-slab-cert', labelBack);
      el('strong', '', cert).textContent = 'BfW GRADING';
      el('span', '', cert).textContent = 'Zertifikat Nr. ' + (job.cert || '');
      el('span', '', cert).textContent = 'Note ' + (g || '–') + ' · ' + (GRADE_NAMES[g] || '');
      el('div', 'gr-slab-barcode', labelBack);
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
    form.elements.clean.value = String(cleanliness());
    form.querySelector('button[type="submit"]').disabled = true;
    obj.classList.add('is-sent');
    setTimeout(function () { form.submit(); }, reduceMotion ? 0 : 850);
  });

  setStep(steps[0]);
  // Schon benotet (Seite neu geladen): Auflösung zeigen, weiter beim Benoten-Schritt
  if (job.guess && gradeOk) {
    setStep('grade');
    showVerdict(job.guess, job.grade);
  }
  applyZoom();
  render();
  requestAnimationFrame(loop);
})();

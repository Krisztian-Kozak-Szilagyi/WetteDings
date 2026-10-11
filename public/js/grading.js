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
  var form = bench.querySelector('[data-gr-send]'); // fehlt beim Bügeln eigener Karten (nur ein Schritt, #204)
  var csrf = form ? form.elements._csrf.value : bench.getAttribute('data-csrf');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Werkzeug-Upgrades (#204, gradingService.TOOLS): nur Komfort – größerer Lappen, stärkerer Magnet, kühleres Eisen, größerer UV-Kegel
  var hasTool = function (k) { return (job.tools || []).indexOf(k) >= 0; };
  var BRUSH = hasTool('tuch') ? 24 : 16; // Radius des Putzlappens in Pixeln (zusätzlich zur Fleckgröße)
  var noop = function () {};
  var sound = { clean: noop, snap: noop, flat: noop, seal: noop, send: noop, done: noop }; // echte Töne weiter unten

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  // ---------- Karte aufbauen ----------
  var card = el('div', 'gr-card' + (job.card && job.card.season ? ' season-' + job.card.season : ''), obj); // Rückseite je Season
  var front = el('div', 'gr-face gr-front' + (job.card ? ' r-' + job.card.rarity : ''), card);
  // Zentrierung: Kartenbild sitzt im Rand (Farbe der Seltenheit) ungleich weit von den Kanten weg
  if (job.center) {
    front.style.setProperty('--cx', job.center.x);
    front.style.setProperty('--cy', job.center.y);
  }
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
  // Knick: eine Linie aus Stücken, die sich einzeln glatt bügeln lassen (#204); ohne Lage (alte Aufträge) wie bisher
  var IRON_SEGMENTS = 10; // wie CREASE_SEGMENTS in src/grading/condition.js
  var creaseEl = null;
  var segs = [];
  if (d.crease) {
    creaseEl = el('span', 'gr-crease' + (job.crease ? ' is-line' : ''), defects);
    if (job.crease) {
      creaseEl.style.top = job.crease.y + '%';
      creaseEl.style.transform = 'rotate(' + job.crease.angle + 'deg)';
      for (var si = 0; si < IRON_SEGMENTS; si++) segs.push({ el: el('span', 'gr-crease-seg', creaseEl), flat: 0, heat: 0, burnt: false });
    }
    if (d.ironed || job.iron) creaseEl.classList.add('is-ironed');
  }
  el('div', 'gr-glare', front);

  var back = el('div', 'gr-face gr-back', card);
  el('div', 'gr-glare', back);

  // Flecken: hp 1 → 0 durch Reiben. Ob alles weg ist, muss der Spieler selbst sehen – es gibt keine Anzeige.
  var spots = (job.spots || []).map(function (s) {
    var e = el('span', 'gr-spot gr-spot-' + s.kind, s.side === 'f' ? front : back);
    e.style.left = s.x + '%';
    e.style.top = s.y + '%';
    e.style.width = s.r * 1.6 + '%';
    return { el: e, side: s.side, hp: 1, need: 90 + s.r * 8 };
  });
  var SAVE_KEY = 'grading-putzstand-' + job.cert;
  try {
    var saved = JSON.parse(sessionStorage.getItem(SAVE_KEY) || 'null');
    if (Array.isArray(saved) && saved.length === spots.length) {
      spots.forEach(function (s, i) {
        s.hp = clamp(Number(saved[i]) || 0, 0, 1);
        s.el.style.setProperty('--hp', Math.pow(s.hp, 0.6).toFixed(3));
        if (!s.hp) s.el.classList.add('is-clean');
      });
    }
  } catch (err) { /* ohne Speicher geht es auch */ }
  var saveTimer = null;
  function saveClean() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { sessionStorage.setItem(SAVE_KEY, JSON.stringify(spots.map(function (s) { return +s.hp.toFixed(3); }))); } catch (err) { /* egal */ }
    }, 300);
  }

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
    var scr = clamp((tilt - 12) / 18, 0, 1);
    obj.style.setProperty('--scr', scr.toFixed(3));
    // Holo schimmert schon bei leichter Neigung und tritt zurück, wo die Kratzer erscheinen (#90)
    obj.style.setProperty('--holo', (clamp(tilt / 12, 0, 1) * (1 - 0.6 * scr)).toFixed(3));
    obj.style.setProperty('--gx', (50 + fy * 1.6).toFixed(1) + '%');
    obj.style.setProperty('--gy', (50 + rx * 1.6).toFixed(1) + '%');
    shadow.style.transform = 'translateX(-50%) scaleX(' + (0.35 + 0.65 * Math.abs(Math.cos((ny * Math.PI) / 180))).toFixed(3) + ')';
    if (mode === 'measure') placeTool(); // Messebene folgt der Karte (Zoom, Verschieben)
  }

  // Kleines Signal beim Einrasten: kurz vibrieren, wo das Gerät es kann
  function feedbackTick() {
    sound.snap();
    try { if (navigator.vibrate) navigator.vibrate(8); } catch (err) { /* ohne geht es auch */ }
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
    ironTick(now);
    wetDry(now);
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
  function applyZoom() {
    zoomEl.style.setProperty('--z', (zoom * baseZoom).toFixed(3));
    var w = obj.offsetWidth;
    var h = obj.offsetHeight;
    // Karte darf nicht ganz aus dem Bild rutschen
    ox = clamp(ox, -w / 2, w / 2);
    oy = clamp(oy, -h / 2, h / 2);
    zoomEl.style.transform = 'translate(' + ox.toFixed(1) + 'px, ' + oy.toFixed(1) + 'px)';
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
    if (drag && drag.guide) return; // beim Ziehen einer Messlinie nicht zoomen
    setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
  }, { passive: false });
  // Knöpfe für Geräte ohne Mausrad: vergrößern, verkleinern, alles zurücksetzen
  bench.querySelectorAll('[data-gr-zoom-step]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var k = Number(btn.getAttribute('data-gr-zoom-step'));
      if (k) return setZoom(zoom * (k > 0 ? 1.25 : 1 / 1.25));
      setZoom(1);
      // beim Messen, Ableuchten und Bügeln bleibt die Karte flach von vorn
      if (mode === 'measure' || mode === 'uv' || mode === 'iron') tweenTo(0, Math.round(ry / 360) * 360, 450);
      else tweenTo(-10, Math.round(ry / 360) * 360 + 18, 450);
    });
  });

  // ---------- Maus-Werkzeug: Drehen, Putzen, Messen oder UV-Lampe ----------
  var mode = 'rotate';
  var modeBtns = bench.querySelectorAll('[data-gr-mode]');
  var measureBtn = bench.querySelector('[data-gr-mode="measure"]');
  var uvBtn = bench.querySelector('[data-gr-mode="uv"]');
  var ironBtn = bench.querySelector('[data-gr-mode="iron"]');
  // Messen und UV-Lampe gibt es nur beim Benoten, das Bügeleisen nur beim Bügeln (Knopf sonst ausgeblendet)
  var gradeTools = { measure: measureBtn, uv: uvBtn, iron: ironBtn };
  function setMode(m) {
    if (m in gradeTools && (!gradeTools[m] || gradeTools[m].hidden)) return;
    mode = m;
    modeBtns.forEach(function (b) {
      var on = b.getAttribute('data-gr-mode') === m;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    stage.classList.toggle('mode-clean', m === 'clean');
    stage.classList.toggle('mode-rotate', m === 'rotate');
    stage.classList.toggle('mode-measure', m === 'measure');
    stage.classList.toggle('mode-uv', m === 'uv');
    stage.classList.toggle('mode-iron', m === 'iron');
    tool.setAttribute('data-tool', m === 'clean' || m === 'iron' ? m : '');
    if (m !== 'clean' && m !== 'iron') toolOff();
    readout.hidden = m !== 'measure' || !!mbar; // mit Messleiste steht die Anzeige dort statt auf der Bühne
    if (mbar) mbar.hidden = m !== 'measure';
    if (m !== 'uv') uvOff();
    if (m === 'measure' || m === 'uv' || m === 'iron') {
      // Messen, Ableuchten und Bügeln gehen von vorn: Karte flach mit der Vorderseite zur Kamera legen
      var front0 = Math.round(ry / 360) * 360;
      tweenTo(0, front0, 350);
      if (m === 'measure') {
        // nah genug für die Bildkante – aber beide Kanten müssen auf die Bühne passen (schmale Bildschirme)
        var fit = (stage.clientWidth - 24) / (obj.offsetWidth / zoom);
        var target = clamp(Math.min(2, fit), 1, 2.6);
        if (Math.abs(zoom - target) > 0.01 || ox || oy) {
          ox = oy = 0;
          setZoom(target);
        }
        renderGuides();
      }
    }
    showHint();
  }
  modeBtns.forEach(function (b) {
    b.addEventListener('click', function () { setMode(b.getAttribute('data-gr-mode')); });
  });

  // ---------- UV-Lampe ----------
  // Der Zeiger wird zu einem violetten Lichtkegel, die Bühne dunkler. Bestoßene Ecken und Kantenmacken leuchten
  // grün, solange der Kegel sie trifft – auf hellen Karten (Holo, Icon) sind sie im normalen Licht kaum zu sehen.
  var UV_R = hasTool('uv') ? 92 : 64; // Radius des Lichtkegels in Pixeln
  if (hasTool('uv')) stage.classList.add('uv-pro');
  el('div', 'gr-uv-shade', stage); // dunkelt alles außerhalb des Kegels ab (Mitte: --ux/--uy)
  el('div', 'gr-uv-light', stage);
  var uvMarks = [].slice.call(defects.querySelectorAll('.gr-corner, .gr-nick')); // höchstens eine Handvoll
  function uvOff() {
    stage.classList.remove('uv-on');
    uvMarks.forEach(function (n) { n.classList.remove('is-uv'); });
  }
  function uvAt(x, y) {
    var r = stage.getBoundingClientRect();
    stage.style.setProperty('--ux', (x - r.left).toFixed(0) + 'px');
    stage.style.setProperty('--uy', (y - r.top).toFixed(0) + 'px');
    stage.classList.add('uv-on');
    uvMarks.forEach(function (n) {
      var b = n.getBoundingClientRect();
      var dx = x - (b.left + b.width / 2);
      var dy = y - (b.top + b.height / 2);
      n.classList.toggle('is-uv', facingFront && Math.sqrt(dx * dx + dy * dy) <= UV_R + Math.max(b.width, b.height) / 2);
    });
  }
  stage.addEventListener('pointerleave', function (e) {
    if (e.pointerType === 'mouse') toolOff();
    if (mode === 'uv' && e.pointerType === 'mouse') uvOff();
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

  // Kurzlebige Effekte auf der Bühne (Glitzern, Dampf): ein Element, das sich per CSS-Animation selbst auflöst –
  // bei reduzierter Bewegung blendet das CSS nur ein und aus (Dampf entfällt dort ganz)
  function puff(cls, x, y, life, vars) {
    var r = stage.getBoundingClientRect();
    var p = el('span', cls, stage);
    p.style.left = x - r.left + 'px';
    p.style.top = y - r.top + 'px';
    if (vars) Object.keys(vars).forEach(function (k) { p.style.setProperty(k, vars[k]); });
    setTimeout(function () { p.remove(); }, life);
    return p;
  }
  function sparkle(x, y, big) {
    var n = big ? 7 : 4;
    for (var i = 0; i < n; i++) {
      var a = (Math.PI * 2 * i) / n + Math.random() * 0.6;
      var d = (big ? 26 : 16) + Math.random() * 10;
      puff('gr-sparkle', x, y, 650, { '--dx': (Math.cos(a) * d).toFixed(1) + 'px', '--dy': (Math.sin(a) * d).toFixed(1) + 'px' });
    }
    try { if (navigator.vibrate) navigator.vibrate(big ? 14 : 6); } catch (err) { /* egal */ }
  }

  // Werkzeug am Zeiger (#204): Schwamm beim Putzen, Bügeleisen beim Bügeln – folgt der Maus (mit dem Finger beim Ziehen),
  // neigt sich in Bewegungsrichtung und drückt sich beim Reiben an
  var tool = el('div', 'gr-tool', stage);
  var toolTilt = 0;
  var toolLast = null;
  function toolAt(x, y) {
    var r = stage.getBoundingClientRect();
    if (toolLast) toolTilt = clamp(toolTilt * 0.7 + (x - toolLast.x) * 0.9, -22, 22);
    toolLast = { x: x, y: y };
    tool.style.setProperty('--tx', (x - r.left).toFixed(0) + 'px');
    tool.style.setProperty('--ty', (y - r.top).toFixed(0) + 'px');
    tool.style.setProperty('--tilt', toolTilt.toFixed(1) + 'deg');
    stage.classList.add('tool-on');
  }
  function toolOff() {
    stage.classList.remove('tool-on');
    toolLast = null;
  }

  // Nass-Glanz (#204): wo der Schwamm über die Vorderseite reibt, bleibt eine glänzende Spur, die langsam trocknet
  var wet = el('canvas', 'gr-wet', stage);
  var wetCtx = wet.getContext ? wet.getContext('2d') : null;
  var wetLast = null;
  var wetActive = 0;
  function wetSize() {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    wet.width = Math.round(stage.clientWidth * dpr);
    wet.height = Math.round(stage.clientHeight * dpr);
    if (wetCtx) wetCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  wetSize();
  window.addEventListener('resize', wetSize);
  function wetStroke(x, y) {
    if (!wetCtx || !facingFront) return; // Glanz bewegt sich nicht – auch bei reduzierter Bewegung
    var s = stage.getBoundingClientRect();
    var f = front.getBoundingClientRect();
    var px = x - s.left;
    var py = y - s.top;
    wetCtx.save();
    wetCtx.beginPath();
    wetCtx.rect(f.left - s.left, f.top - s.top, f.width, f.height); // nur auf der Karte
    wetCtx.clip();
    wetCtx.lineCap = 'round';
    wetCtx.lineJoin = 'round';
    wetCtx.strokeStyle = 'rgba(220, 240, 255, .14)';
    wetCtx.lineWidth = BRUSH * 2.2;
    wetCtx.beginPath();
    wetCtx.moveTo(wetLast ? wetLast.x : px, wetLast ? wetLast.y : py);
    wetCtx.lineTo(px, py);
    wetCtx.stroke();
    wetCtx.restore();
    wetLast = { x: px, y: py };
    wetActive = performance.now();
  }
  function wetDry(now) {
    if (!wetCtx || !wetActive) return;
    // trocknet in etwa 1,5 s nach: jedes Bild ein wenig wegnehmen
    wetCtx.save();
    wetCtx.globalCompositeOperation = 'destination-out';
    wetCtx.fillStyle = 'rgba(0, 0, 0, .035)';
    wetCtx.fillRect(0, 0, wet.width, wet.height);
    wetCtx.restore();
    if (now - wetActive > 2500) {
      wetCtx.clearRect(0, 0, wet.width, wet.height);
      wetActive = 0;
    }
  }

  // Fleckarten lösen sich verschieden schnell: Kaffee klebt (langsamer); schneller als bisher wird keiner, sonst passt
  // die Mindestzeit auf dem Server (MS_PER_SPOT) nicht mehr
  var SPOT_EASE = { kaffee: 0.7 };
  spots.forEach(function (s, i) { s.kind = (job.spots[i] || {}).kind; s.ease = SPOT_EASE[s.kind] || 1; });

  /** Reibt alle Flecken der sichtbaren Seite, die der Lappen an (x, y) berührt */
  function rubAt(x, y, dist) {
    var hit = false;
    spots.forEach(function (s) {
      if (s.hp <= 0 || (s.side === 'f') !== facingFront) return;
      var r = s.el.getBoundingClientRect();
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      var dx = x - cx;
      var dy = y - cy;
      if (Math.sqrt(dx * dx + dy * dy) > Math.max(r.width, r.height) / 2 + BRUSH) return;
      hit = true;
      s.hp = Math.max(0, s.hp - (dist * s.ease) / s.need);
      if (s.hp < 0.04) s.hp = 0;
      // Reste bleiben lange sichtbar: erst ganz am Ende verschwindet ein Fleck
      s.el.style.setProperty('--hp', Math.pow(s.hp, 0.6).toFixed(3));
      // Flecken verschmieren erst ein wenig (größer, blasser), bevor sie verschwinden
      if (s.kind === 'fleck') s.el.style.setProperty('--sc', (1 + 0.9 * s.hp * (1 - s.hp)).toFixed(3));
      if (!s.hp) {
        s.el.classList.add('is-clean');
        sparkle(cx, cy, s.el.offsetWidth > 30);
        sound.clean();
      }
    });
    if (hit) {
      foam(x, y);
      saveClean();
    }
  }

  /** Sauberkeit in Prozent (wird beim Zurückschicken mitgeschickt) */
  function cleanliness() {
    if (!spots.length) return 100;
    var sum = spots.reduce(function (a, s) { return a + (1 - s.hp); }, 0);
    return Math.round((sum / spots.length) * 100);
  }

  // ---------- Bügeln (#204) ----------
  // Das Bügeleisen glättet die Stücke des Knicks, die es berührt – und heizt sie dabei auf. Bleibt es zu lange auf
  // derselben Stelle, brennt sie an (Brandfleck, einmal je Stück). Wegbewegen lässt die Stelle wieder abkühlen.
  var IRON_R = 26; // Radius der Bügelfläche in Pixeln
  var FLAT_RATE = 1.5; // Glätte pro Sekunde Kontakt (ein Stück braucht ≈ 0,7 s)
  var HEAT_RATE = hasTool('eisen') ? 0.6 : 0.9; // Hitze pro Sekunde Kontakt (Brandfleck nach ≈ 1,1 s am Stück, Profi-Eisen ≈ 1,7 s)
  var COOL_RATE = 0.6; // Abkühlen pro Sekunde ohne Kontakt
  var ironAt = null; // Position des Bügeleisens, solange gedrückt
  var ironLast = 0;
  var ironDone = !!job.iron;
  var ironBar = bench.querySelector('[data-gr-iron-bar]');
  var ironGlow = el('div', 'gr-iron-glow', stage);
  function ironTick(now) {
    var dt = ironLast ? Math.min(0.05, (now - ironLast) / 1000) : 0;
    ironLast = now;
    if (!segs.length || ironDone) return;
    var active = mode === 'iron' && step === 'iron' && ironAt && facingFront;
    var hottest = 0;
    segs.forEach(function (s) {
      var hit = false;
      if (active) {
        var r = s.el.getBoundingClientRect();
        var dx = ironAt.x - (r.left + r.width / 2);
        var dy = ironAt.y - (r.top + r.height / 2);
        hit = Math.sqrt(dx * dx + dy * dy) <= IRON_R + Math.max(r.width, r.height) / 2;
      }
      if (hit) {
        var wasFlat = s.flat >= 1;
        s.flat = Math.min(1, s.flat + dt * FLAT_RATE);
        if (!wasFlat && s.flat >= 1 && !s.burnt) {
          // dieses Stück ist glatt: kurz funkeln
          var sr = s.el.getBoundingClientRect();
          sparkle(sr.left + sr.width / 2, sr.top + sr.height / 2, false);
          sound.flat();
        }
        s.heat += dt * HEAT_RATE;
        if (s.heat >= 1 && !s.burnt) {
          s.burnt = true;
          el('span', 'gr-burn', s.el);
        }
        if (s.heat > hottest) hottest = s.heat;
      } else s.heat = Math.max(0, s.heat - dt * COOL_RATE);
      s.el.style.setProperty('--flat', s.flat.toFixed(3));
      s.el.style.setProperty('--heat', Math.min(1, s.heat).toFixed(3));
    });
    if (ironBar) {
      ironBar.style.width = Math.round(Math.min(1, hottest) * 100) + '%';
      ironBar.parentNode.classList.toggle('is-hot', hottest > 0.7);
    }
    // Hitze am Eisen selbst: die Sohle glüht mit, kurz vor dem Brandfleck flackert es rot
    stage.style.setProperty('--hot', Math.min(1, hottest).toFixed(3));
    stage.classList.toggle('is-scorching', hottest > 0.75);
  }
  var lastSteam = 0;
  function ironMove(x, y) {
    var moved = ironAt ? Math.abs(x - ironAt.x) + Math.abs(y - ironAt.y) : 0;
    ironAt = { x: x, y: y };
    var r = stage.getBoundingClientRect();
    ironGlow.style.setProperty('--ix', x - r.left + 'px');
    ironGlow.style.setProperty('--iy', y - r.top + 'px');
    stage.classList.add('iron-on');
    // Dampf beim Bewegen
    var now = performance.now();
    if (moved > 2 && now - lastSteam > 70) {
      lastSteam = now;
      puff('gr-steam', x + (Math.random() * 30 - 15), y - 14, 900, { '--s': (0.6 + Math.random() * 0.8).toFixed(2), '--drift': (Math.random() * 20 - 10).toFixed(0) + 'px' });
    }
  }
  function ironUp() {
    ironAt = null;
    stage.classList.remove('iron-on');
  }
  /** Ergebnis fürs Server: geglättet in % und Zahl der Brandflecken */
  function ironResult() {
    var flat = segs.reduce(function (a, s) { return a + s.flat; }, 0);
    return { smooth: segs.length ? Math.round((flat / segs.length) * 100) : 0, burns: segs.filter(function (s) { return s.burnt; }).length };
  }

  // ---------- Messen (Zentrierung) ----------
  // Zwei Messlinien auf der Vorderseite (nur links/rechts – für die Note zählt nur die seitliche Zentrierung).
  // Wer sie an die Kanten des Kartenbilds zieht, liest die Ränder in mm (Kartenbreite 63 mm) und das Verhältnis ab –
  // geschätzt wird nichts, messen muss man aber selbst. Die Linien starten bewusst nicht am Bildrand.
  // Bedienung (#204): eigene Ebene über der Karte mit breiten Griffen unter der Karte (Finger verdeckt nichts), Greifen
  // mit Versatz statt Springen, Lupe beim Ziehen, leichter Magnet an der Bildkante, ‹ › zum Feinjustieren. Beim Messen
  // liegt die Karte still: kein Schweben, keine Übergänge, Zoom während des Ziehens gesperrt.
  var CARD_MM = 63;
  var guides = { l: 0.1, r: 0.9 };
  var active = 'l';
  var readout = bench.querySelector('[data-gr-measure-read]');
  var mbar = bench.querySelector('[data-gr-mbar]');
  var mtool = el('div', 'gr-mtool', stage);
  var guideEls = {};
  var gripEls = {};
  ['l', 'r'].forEach(function (k) {
    guideEls[k] = el('div', 'gr-guide gr-guide-' + k, mtool);
    gripEls[k] = el('button', 'gr-grip gr-grip-' + k, mtool);
    gripEls[k].type = 'button';
    gripEls[k].tabIndex = -1; // Tastatur: Pfeiltasten auf der Bühne und die Knöpfe der Messleiste
    gripEls[k].setAttribute('aria-hidden', 'true');
    gripEls[k].setAttribute('data-guide', k);
  });
  // Lupe: vergrößerter Ausschnitt der Vorderseite rund um die gezogene Linie (Rand in Seltenheitsfarbe + Bild)
  var LOUPE_X = 5;
  var loupe = el('div', 'gr-loupe', mtool);
  var loupeFace = el('div', 'gr-loupe-face', loupe);
  var loupeImg = el('img', 'gr-loupe-img', loupeFace);
  loupeImg.src = img.src;
  loupeImg.alt = '';
  loupeImg.draggable = false;
  el('span', 'gr-loupe-line', loupe);
  // Wo das Kartenbild wirklich anfängt und aufhört (Anteil der Kartenbreite, wie .gr-front .gr-img im CSS)
  var cxShift = job.center ? Number(job.center.x) || 0 : 0;
  var imgEdge = { l: 0.03 * (1 + cxShift), r: 0.03 * (1 + cxShift) + 0.94 };
  var SNAP = hasTool('schablone') ? 0.012 : 0.004; // Magnet: Anteil der Kartenbreite
  var frontBox = null; // Lage der Vorderseite auf der Bühne (px), beim Messen jedes Bild neu
  var mm = function (v) { return v.toFixed(1).replace('.', ',') + ' mm'; };
  // breitere Seite in ganzen Prozent (wie die Zentrierung gespeichert ist, z. B. 59 = 59/41)
  function bigShare(a, b) { return a + b > 0 ? Math.round((Math.max(a, b) / (a + b)) * 100) : null; }
  function ratio(a, b) {
    var big = bigShare(a, b);
    return big === null ? '–' : big + '/' + (100 - big);
  }
  /** Höchstnote zum gemessenen Verhältnis (Bereiche mit beiden Grenzen eingeschlossen; über dem letzten zählt er) */
  function capFor(a, b) {
    var big = bigShare(a, b);
    var scale = job.centerScale || [];
    if (big === null || !scale.length) return null;
    for (var i = 0; i < scale.length; i++) if (big <= scale[i].to) return scale[i].cap;
    return scale[scale.length - 1].cap;
  }
  // Anzeige: feste Elemente, beim Ziehen nur Text tauschen (kein Neuaufbau); vorgelesen wird erst nach dem Loslassen
  var mRead = {};
  (function buildReadout() {
    var row = el('div', 'gr-measure-row', readout);
    mRead.sides = el('span', '', row);
    mRead.ratio = el('b', '', row);
    mRead.cap = el('div', 'gr-measure-cap', readout);
    readout.removeAttribute('aria-live');
    mRead.live = el('span', 'sr-only', bench);
    mRead.live.setAttribute('aria-live', 'polite');
    if (mbar) {
      mRead.barL = mbar.querySelector('[data-gr-mval="l"]');
      mRead.barR = mbar.querySelector('[data-gr-mval="r"]');
      mRead.barRatio = mbar.querySelector('[data-gr-mratio]');
      mRead.barCap = mbar.querySelector('[data-gr-mcap]');
    }
  })();
  function renderGuides() {
    guideEls.l.style.left = gripEls.l.style.left = (guides.l * 100).toFixed(3) + '%';
    guideEls.r.style.left = gripEls.r.style.left = (guides.r * 100).toFixed(3) + '%';
    ['l', 'r'].forEach(function (k) {
      var on = k === active;
      guideEls[k].classList.toggle('is-active', on);
      gripEls[k].classList.toggle('is-active', on);
      guideEls[k].classList.toggle('is-snapped', Math.abs(guides[k] - imgEdge[k]) < 1e-6);
    });
    var l = guides.l * CARD_MM;
    var r = (1 - guides.r) * CARD_MM;
    var cap = capFor(l, r);
    mRead.sides.textContent = 'Links ' + mm(l) + ' · Rechts ' + mm(r);
    mRead.ratio.textContent = ratio(l, r);
    mRead.cap.textContent = cap ? 'Zentrierung → Obergrenze ' + cap : '';
    if (mbar) {
      mRead.barL.textContent = mm(l);
      mRead.barR.textContent = mm(r);
      mRead.barRatio.textContent = ratio(l, r);
      mRead.barCap.textContent = cap ? 'Obergrenze ' + cap : '';
    }
  }
  function announceGuides() {
    mRead.live.textContent = mRead.sides.textContent + ', ' + mRead.ratio.textContent + (mRead.cap.textContent ? ', ' + mRead.cap.textContent : '');
  }
  // Linie auf eine Position setzen; die linke bleibt in der linken Hälfte, die rechte in der anderen.
  // snap: nahe der echten Bildkante rastet sie ein (beim Ziehen; die Feinjustierung rastet nicht)
  function setGuide(k, v, snap) {
    v = k === 'l' ? clamp(v, 0, 0.499) : clamp(v, 0.501, 1);
    var was = guides[k] === imgEdge[k];
    if (snap && Math.abs(v - imgEdge[k]) <= SNAP) {
      v = imgEdge[k];
      if (!was) feedbackTick();
    }
    guides[k] = v;
    active = k;
    renderGuides();
  }
  /** Lage der Vorderseite auf der Bühne – die Messebene liegt genau darüber */
  function placeTool() {
    var s = stage.getBoundingClientRect();
    var f = front.getBoundingClientRect();
    frontBox = { left: f.left, width: f.width, top: f.top, height: f.height };
    mtool.style.left = (f.left - s.left).toFixed(1) + 'px';
    mtool.style.top = (f.top - s.top).toFixed(1) + 'px';
    mtool.style.width = f.width.toFixed(1) + 'px';
    mtool.style.height = f.height.toFixed(1) + 'px';
    // Griffe und Lupe bleiben im sichtbaren Teil der Bühne, auch wenn die vergrößerte Karte übersteht
    var visTop = Math.max(f.top, s.top);
    var visBottom = Math.min(f.bottom, s.bottom);
    mtool.style.setProperty('--grip-y', Math.min(f.height + 18, s.bottom - f.top - 52).toFixed(1) + 'px');
    mtool.style.setProperty('--loupe-y', (Math.min(visTop + 76, (visTop + visBottom) / 2) - f.top).toFixed(1) + 'px');
  }
  /** Waagerechte Position des Zeigers auf der Vorderseite (0 … 1) – die Karte liegt beim Messen flach */
  function onFront(x) {
    var r = frontBox || front.getBoundingClientRect();
    return (x - r.left) / r.width;
  }
  /** Lupe über der gezogenen Linie: gleicher Ausschnitt, LOUPE_X-fach, Mitte = Linie auf halber Kartenhöhe */
  function showLoupe(k) {
    if (!frontBox) return;
    var W = frontBox.width;
    var H = frontBox.height;
    var S = LOUPE_X;
    var size = loupe.offsetWidth || 120;
    loupeFace.style.width = W * S + 'px';
    loupeFace.style.height = H * S + 'px';
    loupeFace.style.background = getComputedStyle(front).backgroundColor;
    loupeImg.style.left = imgEdge.l * W * S + 'px';
    loupeImg.style.top = 0.0214 * H * S + 'px';
    loupeImg.style.width = 0.94 * W * S + 'px';
    loupeImg.style.height = 0.9572 * H * S + 'px';
    loupeFace.style.transform = 'translate(' + (size / 2 - guides[k] * W * S).toFixed(1) + 'px, ' + (size / 2 - 0.5 * H * S).toFixed(1) + 'px)';
    loupe.style.left = (guides[k] * 100).toFixed(3) + '%';
    loupe.classList.add('is-on');
    loupe.classList.toggle('is-snapped', guides[k] === imgEdge[k]);
  }
  function hideLoupe() { loupe.classList.remove('is-on'); }
  /** Greift ein Zeiger eine Linie? Griff unter der Karte oder nah an der Linie selbst (sonst null – kein Springen) */
  function grabGuide(e) {
    var grip = e.target.closest && e.target.closest('.gr-grip');
    if (grip) return grip.getAttribute('data-guide');
    if (!frontBox) return null;
    var reach = (e.pointerType === 'mouse' ? 10 : 22) / frontBox.width;
    var p = onFront(e.clientX);
    var dl = Math.abs(p - guides.l);
    var dr = Math.abs(p - guides.r);
    if (Math.min(dl, dr) > reach) return null;
    return dl <= dr ? 'l' : 'r';
  }
  // Messleiste unter der Bühne: ‹ › schieben die Linie um 0,05 mm (gedrückt halten = weiter)
  if (mbar) {
    mbar.querySelectorAll('[data-gr-nudge]').forEach(function (btn) {
      var k = btn.getAttribute('data-guide');
      var dir = Number(btn.getAttribute('data-gr-nudge'));
      var timer = null;
      var nudge = function () { setGuide(k, guides[k] + dir * (0.05 / CARD_MM)); };
      var stop = function () {
        clearTimeout(timer);
        clearInterval(timer);
        timer = null;
        announceGuides();
      };
      btn.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        nudge();
        timer = setTimeout(function () { timer = setInterval(nudge, 60); }, 350);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) { btn.addEventListener(ev, stop); });
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          nudge();
          announceGuides();
        }
      });
    });
  }

  // ---------- Zeiger ----------
  stage.addEventListener('pointerdown', function (e) {
    if (sent || e.button > 0 || e.target.closest('.gr-modes, .gr-zoom-btns')) return;
    e.preventDefault(); // keine Textauswahl beim Ziehen (die färbte die ganze Seite dunkel)
    drag = { x: e.clientX, y: e.clientY };
    vx = 0;
    vy = 0;
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetische Ereignisse */ }
    stage.classList.add('is-pressed');
    hint.classList.add('is-gone');
    if (mode === 'measure') {
      if (tween) return (drag = null); // Karte legt sich noch flach – erst danach messen
      placeTool();
      var k = grabGuide(e);
      if (!k) return; // daneben gedrückt: nichts springt
      drag.guide = k;
      drag.offset = onFront(e.clientX) - guides[k]; // Versatz zum Griff merken
      active = k;
      renderGuides();
      showLoupe(k);
      return;
    }
    if (mode === 'uv') return uvAt(e.clientX, e.clientY); // Ableuchten dreht die Karte nicht
    if (mode === 'iron') {
      toolAt(e.clientX, e.clientY);
      return ironMove(e.clientX, e.clientY); // Bügeln auch nicht
    }
    tween = null;
    if (mode === 'clean') {
      toolAt(e.clientX, e.clientY);
      wetLast = null;
      wetStroke(e.clientX, e.clientY);
      rubAt(e.clientX, e.clientY, 6);
    }
  });

  stage.addEventListener('pointermove', function (e) {
    // Werkzeug am Zeiger: mit der Maus immer, mit dem Finger beim Ziehen
    if ((mode === 'clean' || mode === 'iron') && !sent && (drag || e.pointerType === 'mouse')) toolAt(e.clientX, e.clientY);
    // UV-Lampe: mit der Maus schon beim Darüberfahren, mit dem Finger beim Ziehen
    if (mode === 'uv') {
      if (!sent && (drag || e.pointerType === 'mouse')) uvAt(e.clientX, e.clientY);
      return;
    }
    if (!drag) return;
    if (mode === 'measure') {
      if (drag.guide) {
        setGuide(drag.guide, onFront(e.clientX) - drag.offset, true);
        showLoupe(drag.guide);
      }
      return;
    }
    if (mode === 'iron') return ironMove(e.clientX, e.clientY);
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
      wetStroke(e.clientX, e.clientY);
      rubAt(e.clientX, e.clientY, Math.sqrt(dx * dx + dy * dy));
    }
  });

  function endDrag(e) {
    wetLast = null;
    if (e && e.pointerType && e.pointerType !== 'mouse') toolOff();
    if (drag && drag.guide) {
      hideLoupe();
      announceGuides();
    }
    drag = null;
    stage.classList.remove('is-pressed');
    ironUp();
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('selectstart', function (e) { e.preventDefault(); });

  // Tastatur: Pfeiltasten drehen (beim Messen: links/rechts die Linie fein verschieben, mit Umschalt in größeren Schritten),
  // D/P/M/U wechseln das Werkzeug
  stage.tabIndex = 0;
  stage.addEventListener('keydown', function (e) {
    if (e.key === 'd' || e.key === 'D') return setMode('rotate');
    if (e.key === 'p' || e.key === 'P') return setMode('clean');
    if (e.key === 'm' || e.key === 'M') return setMode('measure');
    if (e.key === 'u' || e.key === 'U') return setMode('uv');
    if (e.key === 'b' || e.key === 'B') return setMode('iron');
    if (mode === 'measure') {
      var stepV = e.shiftKey ? 0.01 : 0.001;
      var nudge = { ArrowLeft: -stepV, ArrowRight: stepV }[e.key];
      if (!nudge) return;
      e.preventDefault();
      return setGuide(active, guides[active] + nudge);
    }
    var map = { ArrowLeft: [0, -12], ArrowRight: [0, 12], ArrowUp: [12, 0], ArrowDown: [-12, 0] };
    if (!map[e.key]) return;
    e.preventDefault();
    tweenTo(clamp(rx + map[e.key][0], -65, 65), ry + map[e.key][1], 220);
  });


  // ---------- Arbeitsschritte ----------
  // Schon gebügelt (Seite neu geladen): der Schritt fällt weg. Eigene Karten haben nur den Schritt Bügeln.
  var steps = (job.steps || ['clean']).filter(function (s) { return s !== 'iron' || !ironDone; }).concat(form ? ['send'] : []);
  var step = null;
  var HINTS = {
    clean: { clean: 'Putzen: mit gedrückter Maustaste über die Flecken reiben', rotate: 'Drehen: ziehen, um die Karte zu wenden · Mausrad = Zoom' },
    iron: { iron: 'Bügeln: langsam über den Knick fahren – nicht stehen bleiben, sonst brennt es an · Mausrad = Zoom', rotate: 'Nimm das Bügeleisen (Taste B)' },
    grade: {
      clean: 'Putzen: mit gedrückter Maustaste reiben',
      rotate: 'Schräg ins Licht drehen – Kratzer blitzen auf · Mausrad = Zoom',
      measure: 'Messen: Griffe unten an die Kante des Kartenbilds ziehen – dort rastet die Linie ein · ‹ › oder ←→ = fein',
      uv: 'UV-Lampe: langsam an Ecken und Kanten entlangfahren – Macken leuchten grün auf · Mausrad = Zoom',
    },
    slab: { clean: 'Stoppe den Zeiger im grünen Bereich', rotate: 'Stoppe den Zeiger im grünen Bereich' },
    send: { clean: 'Fertig – ab zum Kunden!', rotate: 'Fertig – ab zum Kunden!' },
  };
  function showHint() {
    if (!step) return;
    hint.textContent = HINTS[step][mode] || HINTS[step].rotate;
    hint.classList.remove('is-gone');
  }
  function setStep(name) {
    // Stationswechsel (#204): Bühne bekommt die Stimmung der Station, die Karte rückt weiter
    if (step && step !== name && !reduceMotion) {
      zoomEl.classList.remove('is-travel');
      void zoomEl.offsetWidth;
      zoomEl.classList.add('is-travel');
      setTimeout(function () { zoomEl.classList.remove('is-travel'); }, 520);
    }
    stage.setAttribute('data-station', name);
    step = name;
    bench.querySelectorAll('[data-gr-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-gr-panel') !== name; });
    // Schritte in der Leiste nach ihrem Namen (ein schon erledigtes Bügeln steht als erledigt da)
    var order = [].slice.call(bench.querySelectorAll('[data-gr-steps] li')).map(function (li) { return li.getAttribute('data-step'); });
    var idx = order.indexOf(name);
    bench.querySelectorAll('[data-gr-steps] li').forEach(function (li, i) {
      li.classList.toggle('is-done', i < idx || (ironDone && order[i] === 'iron'));
      li.classList.toggle('is-active', i === idx);
    });
    // Messen und UV-Lampe gibt es nur beim Benoten, das Bügeleisen nur beim Bügeln
    if (measureBtn) measureBtn.hidden = name !== 'grade';
    if (uvBtn) uvBtn.hidden = name !== 'grade';
    if (ironBtn) ironBtn.hidden = name !== 'iron';
    setMode(name === 'clean' ? 'clean' : name === 'iron' ? 'iron' : 'rotate');
    if (name === 'slab') startMeter();
  }
  function nextStep() {
    var i = steps.indexOf(step);
    if (i < steps.length - 1) setStep(steps[i + 1]);
  }
  var cleanOk = bench.querySelector('[data-gr-clean-ok]');
  if (cleanOk) cleanOk.addEventListener('click', nextStep);

  // Bügeln abschließen: Ergebnis an den Server (nur einmal), der antwortet mit der neuen Obergrenze und den Mängeln
  var ironOk = bench.querySelector('[data-gr-iron-ok]');
  var ironRes = bench.querySelector('[data-gr-iron-result]');
  if (ironOk) {
    ironOk.addEventListener('click', function () {
      var r = ironResult();
      ironOk.disabled = true;
      fetch(job.ironUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf, job: job.id, smooth: String(r.smooth), burns: String(r.burns) }),
        credentials: 'same-origin',
      })
        .then(function (res) { return res.json(); })
        .then(function (res) {
          if (res.error) throw new Error(res.error);
          ironDone = true;
          ironUp();
          if (res.defects) d = res.defects; // für die Auflösung nach dem Benoten
          if (creaseEl) creaseEl.classList.add('is-ironed');
          ironRes.className = 'gr-iron-result ' + (res.burns ? 'gr-bad' : 'gr-ok');
          ironRes.textContent = 'Zu ' + res.smooth + ' % glatt – der Knick begrenzt die Note jetzt auf ' + res.cap + '.' + (res.burns ? ' ' + res.burns + ' Brandfleck' + (res.burns === 1 ? '' : 'e') + ' (je −1).' : '');
          ironRes.hidden = false;
          if (job.own) {
            // eigene Karte: fertig – zurück zur Liste
            // feste Adresse statt eines Werts aus dem DOM (CodeQL js/xss-through-dom)
            if (job.backUrl) setTimeout(function () { window.location.href = '/grading'; }, 2200);
            return;
          }
          setTimeout(nextStep, 1300);
        })
        .catch(function (err) {
          ironOk.disabled = false;
          ironRes.className = 'gr-iron-result gr-bad';
          ironRes.textContent = err.message || 'Das hat nicht geklappt – bitte noch einmal.';
          ironRes.hidden = false;
        });
    });
  }

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
    // Karte eines Mitglieds (#204): keine Auflösung – die Note des Shops kommt auf den Slab, die echte bleibt geheim
    if (grade == null) {
      gradeBtns.forEach(function (x) {
        x.disabled = true;
        x.classList.toggle('is-on', Number(x.getAttribute('data-grade')) === guess);
      });
      gradeOk.hidden = true;
      verdict.className = 'gr-verdict is-close';
      verdict.innerHTML = '';
      el('strong', '', verdict).textContent = 'Note ' + guess + ' vergeben.';
      el('span', '', verdict).textContent = ' Sie kommt auf den Slab für ' + (job.customer || 'den Kunden') + ' – ob sie stimmt, zeigt sich, wenn jemand den Slab aufbricht. Deine Treffsicherheit zählt fürs Rating.';
      verdict.hidden = false;
      gradeNext.hidden = false;
      return;
    }
    gradeBtns.forEach(function (x) {
      var g = Number(x.getAttribute('data-grade'));
      x.disabled = true;
      x.classList.toggle('is-on', g === guess);
      x.classList.toggle('is-right', g === grade);
    });
    gradeOk.hidden = true;
    var diff = Math.abs(guess - grade);
    // Rechenweg wie im Ablauf: 1 Obergrenze (Knick oder Zentrierung) – 2 Mängel abziehen = 3 Note
    var minus = [];
    if ((d.scratches || []).length) minus.push(plural(d.scratches.length, 'Kratzer', 'Kratzer'));
    if ((d.corners || []).length) minus.push(plural(d.corners.length, 'bestoßene Ecke', 'bestoßene Ecken'));
    if ((d.edges || []).length) minus.push(plural(d.edges.length, 'Kantenmacke', 'Kantenmacken'));
    var c = d.centering;
    var worst = c ? c.lr || 50 : 50; // nur links/rechts zählt
    if (worst > 55) card.classList.add('is-offcenter');
    var creaseCap = d.creaseCap || 4; // gebügelt höher (#204)
    var capBy = d.crease && creaseCap <= job.centerCap ? (d.ironed ? 'gebügelter Knick' : 'Knick') : job.centerCap < 10 ? 'Zentrierung ' + worst + '/' + (100 - worst) : '';
    var cap = d.crease ? Math.min(creaseCap, job.centerCap) : job.centerCap;
    var count = (d.scratches || []).length + (d.corners || []).length + (d.edges || []).length;
    var calc = 'Obergrenze ' + cap + (capBy ? ' (' + capBy + ')' : '') + (count ? ' − ' + minus.join(', ') : '') + ' = Note ' + grade;
    verdict.className = 'gr-verdict ' + (diff === 0 ? 'is-right' : diff === 1 ? 'is-close' : 'is-wrong');
    verdict.innerHTML = '';
    el('strong', '', verdict).textContent = diff === 0 ? 'Exakt! Note ' + grade + '.' : diff === 1 ? 'Knapp daneben – richtig ist ' + grade + ' (halber Bonus).' : 'Daneben – richtig ist ' + grade + '.';
    el('span', '', verdict).textContent = capBy || count ? ' ' + calc + ' – Mängel jetzt rot markiert.' : ' Die Karte war makellos.';
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
        body: new URLSearchParams({ _csrf: csrf, job: job.id, grade: String(chosen) }),
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
  // gleiche Bezeichnungen wie GRADE_NAMES in src/grading/condition.js (Etikett der Folien)
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
      // Kürzel des eigenen Shops (#204) statt des Hauses
      var house = ((job.shop && job.shop.code) || 'BfW') + ' GRADING';
      label.innerHTML = '';
      var info = el('div', 'gr-slab-info', label);
      el('strong', '', info).textContent = house;
      el('span', '', info).textContent = job.card ? job.card.name + ' · ' + job.card.rarityLabel : '';
      if (job.cert) el('span', 'gr-slab-certno', info).textContent = job.cert;
      // wie bei PSA: Notenwort über der großen Note
      var score = el('div', 'gr-slab-score', label);
      el('span', 'gr-slab-word', score).textContent = GRADE_NAMES[g] || '';
      el('div', 'gr-slab-grade', score).textContent = g || '–';
      // Rückseite: Zertifikat mit Nummer und Strichcode
      labelBack.innerHTML = '';
      var cert = el('div', 'gr-slab-cert', labelBack);
      el('strong', '', cert).textContent = house;
      if (job.shop && job.shop.name) el('span', '', cert).textContent = job.shop.name;
      el('span', '', cert).textContent = 'Zertifikat Nr. ' + (job.cert || '');
      el('span', '', cert).textContent = 'Note ' + (g || '–') + ' · ' + (GRADE_NAMES[g] || '');
      el('div', 'gr-slab-barcode', labelBack);
      baseZoom = 0.82;
      setZoom(1);
      tweenTo(-6, Math.round(ry / 360) * 360 + 14, 700);
      obj.classList.add('is-slabbed');
      stage.classList.add('is-pressing'); // Presse: kurzer Stoß (nur hier wackelt die Bühne)
      setTimeout(function () { stage.classList.remove('is-pressing'); }, 420);
      sound.seal();
      setTimeout(nextStep, 1300);
    });
  }

  // ---------- Ton (#204) ----------
  // Kurze, selbst erzeugte Töne (WebAudio) – aus, bis man sie einschaltet; die Wahl merkt sich der Browser
  var soundBtn = document.querySelector('[data-gr-sound]');
  var soundOn = false;
  try { soundOn = localStorage.getItem('grading-ton') === '1'; } catch (err) { /* ohne Speicher: aus */ }
  var audio = null;
  function tone(freq, ms, type, vol, slide) {
    if (!soundOn) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var t = audio.currentTime;
      var o = audio.createOscillator();
      var g = audio.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq * (0.97 + Math.random() * 0.06), t); // leicht verschieden, damit es nicht nervt
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + ms / 1000);
      g.gain.setValueAtTime(vol || 0.08, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + ms / 1000 + 0.02);
    } catch (err) { /* kein Ton möglich */ }
  }
  var cleanedCount = 0;
  sound = {
    clean: function () { tone(660 + Math.min(8, cleanedCount++) * 70, 140, 'triangle', 0.07); },
    snap: function () { tone(1400, 40, 'square', 0.03); },
    flat: function () { tone(880, 90, 'sine', 0.05); },
    seal: function () { tone(140, 220, 'sawtooth', 0.09, 60); },
    send: function () { tone(300, 320, 'sine', 0.06, 900); },
    done: function () { tone(784, 160, 'triangle', 0.07); setTimeout(function () { tone(1047, 260, 'triangle', 0.07); }, 140); },
  };
  function renderSoundBtn() {
    if (!soundBtn) return;
    soundBtn.textContent = soundOn ? '🔊 Ton an' : '🔇 Ton aus';
    soundBtn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  }
  if (soundBtn) {
    renderSoundBtn();
    soundBtn.addEventListener('click', function () {
      soundOn = !soundOn;
      try { localStorage.setItem('grading-ton', soundOn ? '1' : '0'); } catch (err) { /* egal */ }
      renderSoundBtn();
      sound.flat();
    });
  }

  // ---------- Abschluss (#204) ----------
  // Nach dem Zurückschicken: Vorher/Nachher, Lohn je Posten, Reputation – und gleich der nächste Auftrag
  var euroFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  var euro = function (c) { return euroFmt.format((c || 0) / 100); };
  /** Kleine Karte für Vorher/Nachher: Bild im Rand, vorher mit Flecken und Knick, nachher sauber (im Slab) */
  function miniCard(parent, before, res) {
    var m = el('div', 'gr-mini' + (job.card ? ' r-' + job.card.rarity : ''), parent);
    if (job.center) m.style.setProperty('--cx', job.center.x);
    var im = el('img', 'gr-mini-img', m);
    im.src = img.src;
    im.alt = '';
    if (before) {
      (job.spots || []).forEach(function (s) {
        if (s.side !== 'f') return;
        var e = el('span', 'gr-spot gr-spot-' + s.kind, m);
        e.style.left = s.x + '%';
        e.style.top = s.y + '%';
        e.style.width = s.r * 1.6 + '%';
      });
      if (d.crease && job.crease) {
        var c = el('span', 'gr-crease', m);
        c.style.top = job.crease.y + '%';
        c.style.transform = 'rotate(' + job.crease.angle + 'deg)';
      }
    } else if (res.guess && job.steps.indexOf('slab') >= 0) {
      var lab = el('div', 'gr-mini-slab', m);
      el('b', '', lab).textContent = res.shopCode || '';
      el('span', '', lab).textContent = res.guess;
    }
    return m;
  }
  function showSummary(res) {
    var box = el('div', 'gr-finish', bench);
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'gr-finish-title');
    var panel = el('div', 'gr-finish-panel', box);
    el('p', 'gr-kicker', panel).textContent = 'Zurück an ' + (res.customer || 'den Kunden');
    var h = el('h2', '', panel);
    h.id = 'gr-finish-title';
    h.textContent = '+' + euro(res.pay);

    var grid = el('div', 'gr-finish-grid', panel);
    // Vorher/Nachher: Schieber legt die saubere Karte über die alte
    var ba = el('div', 'gr-ba', grid);
    var stack = el('div', 'gr-ba-stack', ba);
    miniCard(stack, true, res).classList.add('gr-ba-before');
    miniCard(stack, false, res).classList.add('gr-ba-after');
    var range = el('input', 'gr-ba-range', ba);
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.value = '50';
    range.setAttribute('aria-label', 'Vorher und nachher vergleichen');
    var setCut = function () { stack.style.setProperty('--cut', range.value + '%'); };
    range.addEventListener('input', setCut);
    setCut();
    var cap = el('div', 'gr-ba-cap', ba);
    el('span', '', cap).textContent = 'Vorher';
    el('span', '', cap).textContent = 'Nachher';

    // Posten
    var list = el('dl', 'gr-finish-list', grid);
    var row = function (label, value, cls) {
      el('dt', cls || '', list).textContent = label;
      el('dd', cls || '', list).textContent = value;
    };
    var p = (res.breakdown && res.breakdown.parts) || {};
    if (res.player) {
      var LABELS = { base: 'Annahme & Reinigung', iron: 'Knick bügeln', slab: 'Benoten + Slab', review: 'Zweitprüfung', express: 'Express' };
      Object.keys(LABELS).forEach(function (k) { if (p[k] != null) row(LABELS[k], euro(p[k])); });
    } else {
      if (p.clean != null) row('Reinigung · ' + res.clean + ' % sauber', euro(p.clean));
      if (p.iron != null) row('Bügeln · ' + res.iron + ' % glatt', euro(p.iron));
      if (p.grade != null) row('Note ' + res.guess + (res.grade != null ? (res.guess === res.grade ? ' · exakt' : ' · richtig ' + res.grade) : ''), euro(p.grade));
      if (p.slab != null) row('Versiegeln · ' + res.seal + ' %', euro(p.slab));
      if (res.breakdown && res.breakdown.extra) row('Zuschläge (Seltenheit, Premium)', euro(res.breakdown.extra));
    }
    row('Summe', euro(res.pay), 'is-sum');

    var facts = el('div', 'gr-finish-facts', panel);
    if (res.reputation) el('span', 'gr-finish-rep', facts).textContent = 'Reputation +' + res.reputation;
    if (res.quality != null) el('span', '', facts).textContent = 'Qualität ' + res.quality + ' %';
    if (res.player && res.guess) el('span', '', facts).textContent = 'Slab ' + (res.shopCode || '') + ' · Note ' + res.guess;
    if (res.foilFound) el('span', 'gr-ok', facts).textContent = '+ 1 TCG Sleeve im Inventar';

    var actions = el('div', 'gr-finish-actions', panel);
    if (res.nextJob) {
      // schon angenommen: der nächste liegt bereits auf der Werkbank
      var nx = el('a', 'btn btn-primary btn-lg gr-glow', actions);
      nx.href = '/grading/werkbank';
      nx.textContent = 'Weiter: ' + res.nextJob.name + ' für ' + res.nextJob.customer + (res.nextJob.more ? ' (+' + res.nextJob.more + ')' : '') + ' →';
      setTimeout(function () { nx.focus(); }, 50);
    } else if (res.canNext) {
      var f = el('form', '', actions);
      f.method = 'post';
      f.action = '/grading/auftrag';
      var c = el('input', '', f);
      c.type = 'hidden';
      c.name = '_csrf';
      c.value = csrf;
      var b = el('button', 'btn btn-primary btn-lg gr-glow', f);
      b.type = 'submit';
      b.textContent = res.left && res.left.players ? 'Nächste Karte (Mitglied) →' : 'Nächster Auftrag →';
      setTimeout(function () { b.focus(); }, 50);
    } else {
      el('p', 'muted small', actions).textContent = 'Feierabend – alle Aufträge für heute erledigt.';
    }
    var back = el('a', 'btn btn-ghost', actions);
    back.href = '/grading?neu=1'; // der Schreibtisch spießt den neuen Bon auf
    back.textContent = 'Zum Shop';
    if (!res.canNext && !res.nextJob) setTimeout(function () { back.focus(); }, 50);
    requestAnimationFrame(function () { box.classList.add('is-on'); });
    sound.done();
  }

  // Zurückschicken: Karte fliegt davon, der Server rechnet ab, danach der Abschluss-Bildschirm.
  // Klappt es nicht (z. B. zu schnell geputzt), kommt die Karte zurück auf den Tisch und die Meldung erscheint.
  if (form) form.addEventListener('submit', function (e) {
    if (sent) return;
    e.preventDefault();
    sent = true;
    form.elements.clean.value = String(cleanliness());
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    obj.classList.add('is-sent');
    sound.send();
    var body = new URLSearchParams(new FormData(form));
    var wait = new Promise(function (r) { setTimeout(r, reduceMotion ? 0 : 850); });
    fetch(form.action, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.error) throw new Error(res.error);
        try { sessionStorage.removeItem(SAVE_KEY); } catch (err) { /* egal */ }
        return wait.then(function () { showSummary(res); });
      })
      .catch(function (err) {
        sent = false;
        btn.disabled = false;
        obj.classList.remove('is-sent');
        requestAnimationFrame(loop);
        var msg = form.querySelector('.gr-send-error') || el('p', 'gr-send-error gr-bad', form);
        msg.textContent = err.message || 'Das hat nicht geklappt – bitte noch einmal.';
      });
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

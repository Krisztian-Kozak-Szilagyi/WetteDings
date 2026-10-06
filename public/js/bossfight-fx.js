// Bosskampf-Effekte: eigene Canvas-Ebene über dem ganzen Bildschirm (pointer-events: none).
// Partikel = kleine, vorgerenderte Leuchtpunkte, die im Laufe ihres Lebens eine Farbrampe durchlaufen
// (Feuer: gelb → orange → rot → dunkel). Mit 'lighter' addieren sich überlappende Punkte, der Kern wird hell.
// Dazu einfache Formen (Hiebbogen, Druckwelle, Blitz), Bildschirmwackeln und ein kurzer Hit-Stop.
// Aufruf aus public/js/bossfight-hud.js: bossfightFx.spiel(art, vonElement) → Promise, erfüllt beim Einschlag.
// Zum Ausprobieren in der Konsole: bossfightFx.spiel('feuer'), bossfightFx.spiel('nekro'), bossfightFx.bossAngriff(el, true)
(function () {
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var cv = document.createElement('canvas');
  cv.className = 'bf-fx';
  cv.setAttribute('aria-hidden', 'true');
  document.body.appendChild(cv);
  var ctx = cv.getContext('2d');
  var dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(window.innerWidth * dpr);
    cv.height = Math.round(window.innerHeight * dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  function rand(a, b) { return a + Math.random() * (b - a); }

  // ---------- Farbrampen und vorgerenderte Leuchtpunkte ----------
  var RAMPS = new Map([
    ['feuer', [[255, 252, 225], [255, 214, 100], [255, 145, 40], [225, 65, 20], [110, 25, 10]]],
    ['glut', [[255, 255, 235], [255, 225, 150], [255, 170, 70], [240, 100, 30]]],
    ['nekro', [[225, 255, 215], [140, 255, 120], [70, 200, 95], [115, 55, 170], [45, 15, 70]]],
    ['stahl', [[255, 255, 255], [215, 235, 255], [140, 185, 255], [80, 110, 200]]],
    ['blut', [[255, 220, 210], [255, 90, 70], [200, 30, 30], [90, 10, 15]]],
    ['schild', [[235, 250, 255], [140, 210, 255], [70, 140, 240]]],
    ['rauch', [[70, 62, 66], [48, 42, 50], [30, 26, 34]]],
  ]);
  var STEPS = 12;
  var sprites = new Map(); // "rampe:stufe" → Canvas
  function rampColor(ramp, t) {
    var r = RAMPS.get(ramp);
    var f = Math.min(0.999, Math.max(0, t)) * (r.length - 1);
    var i = Math.floor(f);
    var u = f - i;
    var a = r[i];
    var b = r[Math.min(r.length - 1, i + 1)];
    return [0, 1, 2].map(function (k) { return Math.round(a[k] + (b[k] - a[k]) * u); });
  }
  function sprite(ramp, t) {
    var step = Math.min(STEPS - 1, Math.floor(t * STEPS));
    var key = ramp + ':' + step;
    var s = sprites.get(key);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = s.height = 64;
    var c = s.getContext('2d');
    var col = rampColor(ramp, step / (STEPS - 1)).join(',');
    var g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(' + col + ',1)');
    g.addColorStop(0.35, 'rgba(' + col + ',.55)');
    g.addColorStop(1, 'rgba(' + col + ',0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
    sprites.set(key, s);
    return s;
  }

  // ---------- Partikel, Formen, Zeit ----------
  var teile = [];
  var formen = []; // { alter, leben, draw(t), add }
  var timer = []; // { zeit, fn }
  var zeit = 0;
  var stopp = 0; // Hit-Stop: so lange stehen alle Effekte

  function teil(x, y, o) {
    var p = {
      x: x, y: y, vx: 0, vy: 0, r: 6, r1: 0.3, leben: 0.5, alter: 0,
      grav: 0, reib: 0.9, auf: 0, rampe: 'feuer', add: true, alpha: 1,
      zug: null, // { x, y, kraft } – zieht zu einem Punkt (Nekro-Sog)
    };
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) p[k] = o[k];
    teile.push(p);
    return p;
  }
  function form(leben, draw, add) {
    formen.push({ alter: 0, leben: leben, draw: draw, add: add !== false });
  }
  function spaeter(sek, fn) { timer.push({ zeit: zeit + sek, fn: fn }); }

  function hitStop(sek) {
    if (still) return;
    stopp = Math.max(stopp, sek);
    if (window.bossfightBoss) window.bossfightBoss.stopp(sek);
  }

  var stage = document.querySelector('.bf-stage');
  var wackel = { bis: 0, staerke: 0, dauer: 1 };
  function wackeln(staerke, sek) {
    if (still || !stage) return;
    wackel = { bis: zeit + sek, staerke: staerke, dauer: sek };
  }

  var last = null;
  function loop(now) {
    var dt = last === null ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    if (stopp > 0) { stopp -= dt; dt = 0; }
    zeit += dt;

    for (var ti = timer.length - 1; ti >= 0; ti--) {
      if (timer[ti].zeit <= zeit) {
        var fn = timer[ti].fn;
        timer.splice(ti, 1);
        fn();
      }
    }

    if (stage) {
      var rest = wackel.bis - zeit;
      if (rest > 0) {
        var s = wackel.staerke * (rest / wackel.dauer);
        stage.style.translate = rand(-s, s).toFixed(1) + 'px ' + rand(-s, s).toFixed(1) + 'px';
      } else if (stage.style.translate) {
        stage.style.translate = '';
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    // erst normale (Rauch), dann leuchtende Partikel
    [false, true].forEach(function (add) {
      ctx.globalCompositeOperation = add ? 'lighter' : 'source-over';
      for (var i = teile.length - 1; i >= 0; i--) {
        var p = teile[i];
        if (p.add !== add) continue;
        p.alter += dt;
        var t = p.alter / p.leben;
        if (t >= 1) { teile.splice(i, 1); continue; }
        var f = Math.pow(p.reib, dt * 60);
        p.vx *= f;
        p.vy *= f;
        if (p.zug) {
          var zx = p.zug.x - p.x;
          var zy = p.zug.y - p.y;
          p.vx += zx * p.zug.kraft * dt;
          p.vy += zy * p.zug.kraft * dt;
        }
        p.vy += (p.grav + p.auf) * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        var r = p.r * (1 + (p.r1 - 1) * t);
        ctx.globalAlpha = p.alpha * (add ? 1 - t * t : (1 - t) * 0.8);
        ctx.drawImage(sprite(p.rampe, t), p.x - r, p.y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
      for (var j = formen.length - 1; j >= 0; j--) {
        var fo = formen[j];
        if (fo.add !== add) continue;
        fo.alter += dt;
        var ft = fo.alter / fo.leben;
        if (ft >= 1) { formen.splice(j, 1); continue; }
        ctx.save();
        fo.draw(ft, fo.alter);
        ctx.restore();
      }
    });
    ctx.globalCompositeOperation = 'source-over';
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------- Bausteine ----------
  function mitte(el) {
    var b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }
  function ziel() {
    if (window.bossfightBoss) return window.bossfightBoss.punkt();
    return { x: window.innerWidth / 2, y: window.innerHeight * 0.45, r: 60 };
  }

  // Blitz: großer, kurzer Leuchtfleck
  function blitz(x, y, r, rampe, leben) {
    teil(x, y, { r: r, r1: 1.2, leben: leben || 0.16, rampe: rampe, reib: 1 });
  }

  // Druckwelle: Ring, der sich ausdehnt und dünner wird
  function ring(x, y, r0, r1, farbe, leben, breite) {
    form(leben, function (t) {
      var e = 1 - Math.pow(1 - t, 3);
      ctx.strokeStyle = 'rgba(' + farbe + ',' + (1 - t) * 0.9 + ')';
      ctx.lineWidth = (breite || 14) * (1 - t) + 1;
      ctx.beginPath();
      ctx.ellipse(x, y, r0 + (r1 - r0) * e, (r0 + (r1 - r0) * e) * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
    });
  }

  // Funken: schnelle, kleine Punkte mit Schwerkraft
  function funken(x, y, n, rampe, tempo, o) {
    for (var i = 0; i < n; i++) {
      var w = Math.random() * Math.PI * 2;
      var v = rand(tempo * 0.3, tempo);
      teil(x, y, Object.assign({
        r: rand(3, 7), r1: 0.2, leben: rand(0.35, 0.8), rampe: rampe,
        vx: Math.cos(w) * v, vy: Math.sin(w) * v - tempo * 0.2, grav: 900, reib: 0.93,
      }, o || {}));
    }
  }

  // Wolke: große, weiche Bälle, die langsam aufsteigen
  function wolke(x, y, n, rampe, groesse, o) {
    for (var i = 0; i < n; i++) {
      teil(x + rand(-groesse, groesse) * 0.5, y + rand(-groesse, groesse) * 0.4, Object.assign({
        r: rand(groesse * 0.5, groesse), r1: 1.4, leben: rand(0.5, 1), rampe: rampe,
        vx: rand(-60, 60), vy: rand(-60, 20), auf: -90, reib: 0.95,
      }, o || {}));
    }
  }

  // Geschoss auf einem Bogen von a nach b; jeden Frame ruft es spur(x, y, richtung) auf
  function geschoss(a, b, dauer, bogen, spur) {
    return new Promise(function (fertig) {
      var k = { x: (a.x + b.x) / 2 + rand(-80, 80), y: Math.min(a.y, b.y) - bogen };
      var t0 = zeit;
      var px = a.x;
      var py = a.y;
      (function schritt() {
        var t = Math.min(1, (zeit - t0) / dauer);
        var e = t * t * (1.6 - 0.6 * t); // beschleunigt, kommt mit Wucht an
        var x = (1 - e) * (1 - e) * a.x + 2 * (1 - e) * e * k.x + e * e * b.x;
        var y = (1 - e) * (1 - e) * a.y + 2 * (1 - e) * e * k.y + e * e * b.y;
        // Zwischenpunkte, damit der Schweif bei hohem Tempo nicht abreißt
        var n = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / 12));
        for (var i = 1; i <= n; i++) {
          spur(px + (x - px) * i / n, py + (y - py) * i / n, Math.atan2(y - py, x - px), i === n);
        }
        px = x;
        py = y;
        if (t >= 1) { fertig(b); return; }
        spaeter(0, schritt); // nächster Frame
      })();
    });
  }

  // Hiebbogen: sichelförmiger Lichtstreifen, der schnell über das Ziel fährt
  function hieb(x, y, radius, von, bis, breite, rampe, dauer) {
    var r = RAMPS.get(rampe);
    var kern = r[0].join(',');
    var rand1 = r[2].join(',');
    form(dauer + 0.22, function (_t, alter) {
      var kopf = Math.min(1, alter / dauer);
      var schwanz = Math.max(0, (alter - dauer * 0.55) / (dauer * 1.1));
      if (schwanz >= kopf) return;
      var fade = alter > dauer ? 1 - (alter - dauer) / 0.22 : 1;
      [[1.9, rand1, 0.35], [1, kern, 0.95]].forEach(function (lage) {
        ctx.fillStyle = 'rgba(' + lage[1] + ',' + lage[2] * fade + ')';
        ctx.beginPath();
        var N = 28;
        var i, u, w, a;
        for (i = 0; i <= N; i++) {
          u = schwanz + (kopf - schwanz) * (i / N);
          a = von + (bis - von) * u;
          w = breite * lage[0] * Math.sin(Math.PI * (i / N)) * 0.5;
          ctx.lineTo(x + Math.cos(a) * (radius + w), y + Math.sin(a) * (radius + w) * 0.8);
        }
        for (i = N; i >= 0; i--) {
          u = schwanz + (kopf - schwanz) * (i / N);
          a = von + (bis - von) * u;
          w = breite * lage[0] * Math.sin(Math.PI * (i / N)) * 0.5;
          ctx.lineTo(x + Math.cos(a) * (radius - w), y + Math.sin(a) * (radius - w) * 0.8);
        }
        ctx.closePath();
        ctx.fill();
      });
    });
  }

  // Kralle: gerader, spitz zulaufender Streifen, der von a nach b wächst
  function kralle(ax, ay, bx, by, breite, rampe, dauer) {
    var r = RAMPS.get(rampe);
    var nx = -(by - ay);
    var ny = bx - ax;
    var len = Math.hypot(nx, ny);
    nx /= len;
    ny /= len;
    form(dauer + 0.35, function (_t, alter) {
      var kopf = Math.min(1, alter / dauer);
      var fade = alter > dauer ? 1 - (alter - dauer) / 0.35 : 1;
      [[2.2, r[2], 0.35], [1, r[0], 0.95]].forEach(function (lage) {
        var w = breite * lage[0] * 0.5;
        var mx = ax + (bx - ax) * kopf * 0.45;
        var my = ay + (by - ay) * kopf * 0.45;
        ctx.fillStyle = 'rgba(' + lage[1].join(',') + ',' + lage[2] * fade + ')';
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(mx + nx * w, my + ny * w);
        ctx.lineTo(ax + (bx - ax) * kopf, ay + (by - ay) * kopf);
        ctx.lineTo(mx - nx * w, my - ny * w);
        ctx.closePath();
        ctx.fill();
      });
    });
  }

  function bossTreffer(farbe, staerke) {
    if (window.bossfightBoss) window.bossfightBoss.treffer(farbe, staerke);
  }

  // ---------- Effekte je Karte ----------
  function feuer(von) {
    var a = mitte(von);
    var b = ziel();
    b = { x: b.x + rand(-20, 20), y: b.y + rand(-15, 15), r: b.r };
    return geschoss(a, b, 0.55, 170, function (x, y, rw, letzter) {
      teil(x, y, { r: 34, r1: 0.6, leben: 0.1, rampe: 'feuer', reib: 1 }); // Kern
      if (!letzter) return;
      for (var i = 0; i < 3; i++) {                                         // Schweif
        teil(x + rand(-8, 8), y + rand(-8, 8), {
          r: rand(10, 20), r1: 0.25, leben: rand(0.25, 0.5), rampe: 'feuer',
          vx: -Math.cos(rw) * 60 + rand(-40, 40), vy: -Math.sin(rw) * 60 + rand(-40, 40), auf: -120,
        });
      }
      if (Math.random() < 0.5) teil(x, y, { r: 14, leben: 0.9, rampe: 'rauch', add: false, auf: -60, r1: 2.2, alpha: 0.5 });
    }).then(function (p) {
      hitStop(0.07);
      blitz(p.x, p.y, 190, 'feuer', 0.2);
      ring(p.x, p.y, 20, 210, '255, 170, 80', 0.45, 18);
      funken(p.x, p.y, 55, 'glut', 650);
      wolke(p.x, p.y, 16, 'feuer', 60);
      spaeter(0.15, function () {
        wolke(p.x, p.y - 20, 10, 'rauch', 50, { add: false, alpha: 0.6, leben: 1.6, auf: -50 });
      });
      wackeln(12, 0.3);
      bossTreffer('255, 190, 120', 1);
      return p;
    });
  }

  function nekro(von) {
    var a = mitte(von);
    var b = ziel();
    b = { x: b.x + rand(-20, 20), y: b.y + rand(-15, 15), r: b.r };
    var phase = 0;
    return geschoss(a, b, 0.75, 90, function (x, y, rw, letzter) {
      if (!letzter) return;
      phase += 0.35;
      // dunkler Kern mit grünem Rand, zwei Fäden kreisen herum
      teil(x, y, { r: 30, r1: 0.7, leben: 0.12, rampe: 'nekro', reib: 1 });
      teil(x, y, { r: 26, r1: 0.9, leben: 0.1, rampe: 'rauch', add: false, reib: 1, alpha: 0.9 });
      for (var s = 0; s < 2; s++) {
        var w = phase + s * Math.PI;
        teil(x + Math.cos(w) * 22, y + Math.sin(w) * 22, { r: 9, r1: 0.2, leben: 0.45, rampe: 'nekro', auf: -40 });
      }
      teil(x + rand(-10, 10), y + rand(-10, 10), { r: rand(14, 22), r1: 2, leben: 0.8, rampe: 'rauch', add: false, alpha: 0.45, auf: -30 });
    }).then(function (p) {
      // erst Sog nach innen, dann Ausbruch
      for (var i = 0; i < 36; i++) {
        var w = (i / 36) * Math.PI * 2;
        teil(p.x + Math.cos(w) * 150, p.y + Math.sin(w) * 95, {
          r: 8, r1: 0.4, leben: 0.24, rampe: 'nekro', reib: 1, zug: { x: p.x, y: p.y, kraft: 40 },
        });
      }
      ring(p.x, p.y, 150, 10, '140, 255, 120', 0.24, 6);
      bossTreffer('120, 255, 140', 0.4);
      spaeter(0.24, function () {
        hitStop(0.06);
        blitz(p.x, p.y, 210, 'nekro', 0.26);
        ring(p.x, p.y, 10, 240, '150, 90, 230', 0.55, 20);
        funken(p.x, p.y, 60, 'nekro', 560, { grav: -200, r: 6 });
        wolke(p.x, p.y, 14, 'rauch', 70, { add: false, alpha: 0.7, leben: 1.4 });
        wolke(p.x, p.y, 16, 'nekro', 55, { auf: -160 });
        wackeln(9, 0.28);
        bossTreffer('150, 255, 150', 0.9);
      });
      return new Promise(function (ok) { spaeter(0.25, function () { ok(p); }); });
    });
  }

  function waffe(von, schwer) {
    var p = ziel();
    var x = p.x + rand(-20, 20);
    var y = p.y + rand(-10, 10);
    var dauer = schwer ? 0.16 : 0.11;
    var radius = schwer ? 150 : 120;
    var w0 = rand(-0.4, 0.4);
    hieb(x, y + (schwer ? 30 : 0), radius, Math.PI * 1.05 + w0, Math.PI * 1.95 + w0, schwer ? 46 : 26, 'stahl', dauer);
    if (schwer) hieb(x, y + 30, radius * 0.85, Math.PI * 1.1 + w0, Math.PI * 1.9 + w0, 16, 'glut', dauer * 1.1);
    return new Promise(function (ok) {
      spaeter(dauer * 0.7, function () {
        hitStop(schwer ? 0.09 : 0.05);
        blitz(x, y, schwer ? 150 : 100, 'stahl', 0.14);
        funken(x, y, schwer ? 50 : 30, 'glut', schwer ? 700 : 520);
        funken(x, y, 12, 'blut', 380, { r: rand(4, 8) });
        if (schwer) ring(x, y + 40, 30, 230, '220, 230, 255', 0.4, 12);
        wackeln(schwer ? 16 : 7, schwer ? 0.35 : 0.2);
        bossTreffer('255, 255, 255', schwer ? 1.3 : 0.8);
        ok({ x: x, y: y });
      });
    });
  }

  // Der Boss schlägt zu: drei Krallenspuren über dem Spieler, bei Schild ein blauer Abprall
  function bossAngriff(spielerEl, schild) {
    var m = mitte(spielerEl);
    var b = spielerEl.getBoundingClientRect();
    var l = Math.max(90, b.width * 1.6);
    for (var i = 0; i < 3; i++) {
      (function (i) {
        spaeter(i * 0.045, function () {
          var dx = (i - 1) * l * 0.22;
          kralle(m.x + dx + l * 0.4, m.y - l * 0.5, m.x + dx - l * 0.4, m.y + l * 0.5, 14, 'blut', 0.1);
        });
      })(i);
    }
    spaeter(0.12, function () {
      wackeln(10, 0.3);
      funken(m.x, m.y, 18, 'blut', 400);
      if (schild) {
        ring(m.x, m.y, 30, 130, '140, 210, 255', 0.4, 10);
        funken(m.x, m.y, 26, 'schild', 480, { grav: 400 });
        blitz(m.x, m.y, 90, 'schild', 0.15);
      }
    });
    return new Promise(function (ok) { spaeter(0.14, ok); });
  }

  var ARTEN = new Map([
    ['feuer', feuer],
    ['nekro', nekro],
    ['hieb', function (von) { return waffe(von, false); }],
    ['hieb-schwer', function (von) { return waffe(von, true); }],
  ]);

  // art aus kampf.fx (src/tcg/cardData.js); unbekannt → nach Typ
  function spiel(art, von) {
    var f = ARTEN.get(art) || feuer;
    return f(von || document.querySelector('[data-bf-gear]') || document.body);
  }

  window.bossfightFx = { spiel: spiel, bossAngriff: bossAngriff, wackeln: wackeln };
})();

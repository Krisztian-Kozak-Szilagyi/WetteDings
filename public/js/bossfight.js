// Bosskampf: die Höhlenspinne wird auf das Canvas über dem Bossraum gezeichnet (Weltkoordinaten = Bildpixel 1672×941).
// Bewegung bewusst klein: Körper wiegt und atmet, Beine stehen fest (Knie per IK), ab und zu tippt ein Bein um,
// Kieferklauen und Taster zucken, Augen glimmen. Reine 2D-Zeichnung, später 1:1 nach PixiJS (Graphics) übertragbar.
(function () {
  var canvas = document.querySelector('[data-boss-canvas]');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = 1672;
  var H = 941;
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Fester Zufall, damit Haare und Stacheln bei jedem Laden gleich aussehen
  var seed = 1111;
  function rnd() {
    seed = (seed + 0x6d2b79f5) | 0;
    var r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  }
  function range(a, b) { return a + (b - a) * rnd(); }

  // Farben: fast schwarzes Violett, Licht kommt kühl-blau von oben aus dem Loch
  var C = {
    body: '#1b1521',
    bodyHi: '#3b3550',
    rim: 'rgba(150, 175, 220, .38)',
    fog: '#463d63',
    eye: '#e4f6ff',
    eyeGlow: 'rgba(150, 210, 255, ',
  };

  var HEAD = { x: 836, y: 412 }; // Kopfbruststück in Ruhe

  // Beine: Hüfte relativ zum Kopf, Knie und Fuß in Ruhe (daraus die Längen); depth 0 = vorn, 3 = hinten
  var LEGS = [
    { side: -1, depth: 0, hip: [-30, 26], knee: [640, 300], foot: [540, 775] },
    { side: -1, depth: 1, hip: [-38, 6], knee: [560, 225], foot: [395, 795] },
    { side: -1, depth: 2, hip: [-35, -14], knee: [470, 270], foot: [285, 705] },
    { side: -1, depth: 3, hip: [-24, -30], knee: [705, 190], foot: [640, 668] },
    { side: 1, depth: 0, hip: [30, 26], knee: [1035, 295], foot: [1125, 778] },
    { side: 1, depth: 1, hip: [38, 6], knee: [1115, 222], foot: [1275, 788] },
    { side: 1, depth: 2, hip: [35, -14], knee: [1205, 265], foot: [1390, 708] },
    { side: 1, depth: 3, hip: [24, -30], knee: [968, 175], foot: [1030, 672] },
  ];

  // Stacheln je Beinabschnitt (t = Lage entlang des Abschnitts, s = Seite, len, ang = Neigung Richtung Fuß)
  function makeSpikes(n, maxLen) {
    var list = [];
    for (var i = 0; i < n; i++) {
      list.push({ t: range(0.08, 0.95), s: rnd() < 0.6 ? 1 : -1, len: range(4, maxLen), ang: range(0.5, 1.1) });
    }
    return list;
  }
  LEGS.forEach(function (leg) {
    leg.base = leg.foot.slice();
    leg.cur = leg.foot.slice();
    leg.a = Math.hypot(leg.knee[0] - HEAD.x - leg.hip[0], leg.knee[1] - HEAD.y - leg.hip[1]);
    leg.b = Math.hypot(leg.foot[0] - leg.knee[0], leg.foot[1] - leg.knee[1]);
    leg.w = 21 - leg.depth * 2.4;
    leg.spikesA = makeSpikes(9, 13);
    leg.spikesB = makeSpikes(14, 10);
  });

  // Hinterleib: Haare rundherum, oben ein langer Borstenkamm
  var ABD = { off: [62, -138], rx: 96, ry: 140, rot: 0.42 };
  var abdHair = [];
  for (var i = 0; i < 120; i++) {
    var th = range(0, Math.PI * 2);
    var top = Math.sin(th) < -0.25 && Math.cos(th) > -0.75;
    abdHair.push({ th: th, len: top ? range(14, 46) : range(5, 16), w: top ? range(3, 6) : range(2, 4), lean: range(-0.35, 0.35) });
  }
  var abdFur = [];
  for (var j = 0; j < 90; j++) {
    var r = Math.sqrt(rnd()) * 0.9;
    var a = range(0, Math.PI * 2);
    abdFur.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, len: range(6, 14), ang: range(-0.4, 0.4) });
  }
  var headHair = [];
  for (var k = 0; k < 80; k++) {
    var hth = range(0, Math.PI * 2);
    headHair.push({ th: hth, len: Math.sin(hth) < 0 ? range(8, 24) : range(5, 15), lean: range(-0.4, 0.4) });
  }
  var palpSpikes = makeSpikes(10, 9);

  // Beinschritte: ab und zu hebt ein Bein kurz an und setzt etwas versetzt wieder auf
  var tap = null;
  var nextTap = 2.2;
  function updateTap(t) {
    if (!tap && t > nextTap) {
      var pool = [0, 0, 0, 4, 4, 4, 1, 1, 5, 5, 2, 6, 3, 7]; // vordere Beine tasten öfter
      var leg = LEGS[pool[Math.floor(rnd() * pool.length)]];
      var to = [
        leg.base[0] + range(-18, 18),
        leg.base[1] + range(-5, 5),
      ];
      tap = { leg: leg, start: t, dur: range(0.7, 1.0), from: leg.cur.slice(), to: to, lift: range(18, 34) };
      nextTap = t + range(2.5, 6.5);
    }
    if (!tap) return;
    var p = Math.min(1, (t - tap.start) / tap.dur);
    var e = p * p * (3 - 2 * p);
    tap.leg.cur[0] = tap.from[0] + (tap.to[0] - tap.from[0]) * e;
    tap.leg.cur[1] = tap.from[1] + (tap.to[1] - tap.from[1]) * e - Math.sin(Math.PI * p) * tap.lift;
    if (p >= 1) tap = null;
  }

  // Zwei-Knochen-IK: von den zwei möglichen Knien gilt das, das näher an der Ruhelage liegt
  function knee(hx, hy, fx, fy, a, b, rest) {
    var dx = fx - hx;
    var dy = fy - hy;
    var d = Math.max(Math.abs(a - b) + 1, Math.min(a + b - 1, Math.hypot(dx, dy)));
    var base = Math.atan2(dy, dx);
    var ang = Math.acos((a * a + d * d - b * b) / (2 * a * d));
    var k1x = hx + a * Math.cos(base + ang);
    var k1y = hy + a * Math.sin(base + ang);
    var k2x = hx + a * Math.cos(base - ang);
    var k2y = hy + a * Math.sin(base - ang);
    var d1 = Math.hypot(k1x - rest[0], k1y - rest[1]);
    var d2 = Math.hypot(k2x - rest[0], k2y - rest[1]);
    return d1 < d2 ? [k1x, k1y] : [k2x, k2y];
  }

  function segment(ax, ay, bx, by, wa, wb) {
    var dx = bx - ax;
    var dy = by - ay;
    var l = Math.hypot(dx, dy) || 1;
    var nx = -dy / l;
    var ny = dx / l;
    ctx.beginPath();
    ctx.moveTo(ax + nx * wa / 2, ay + ny * wa / 2);
    ctx.lineTo(bx + nx * wb / 2, by + ny * wb / 2);
    ctx.lineTo(bx - nx * wb / 2, by - ny * wb / 2);
    ctx.lineTo(ax - nx * wa / 2, ay - ny * wa / 2);
    ctx.closePath();
    ctx.fill();
  }

  function spikes(list, ax, ay, bx, by, wa, wb, side) {
    var dx = bx - ax;
    var dy = by - ay;
    var l = Math.hypot(dx, dy) || 1;
    var ux = dx / l;
    var uy = dy / l;
    ctx.beginPath();
    list.forEach(function (s) {
      var sd = s.s * side;
      var w = (wa + (wb - wa) * s.t) / 2;
      var px = ax + dx * s.t - uy * sd * w;
      var py = ay + dy * s.t + ux * sd * w;
      var vx = -uy * sd * Math.cos(s.ang) + ux * Math.sin(s.ang);
      var vy = ux * sd * Math.cos(s.ang) + uy * Math.sin(s.ang);
      ctx.moveTo(px - ux * 1.6, py - uy * 1.6);
      ctx.lineTo(px + vx * s.len, py + vy * s.len);
      ctx.lineTo(px + ux * 1.6, py + uy * 1.6);
    });
    ctx.fill();
  }

  // Beine unten im Nebel: Füllung blendet nach unten in die Nebelfarbe über
  var legFill = null;
  function legPaint(depth) {
    if (!legFill) {
      legFill = [];
      for (var d = 0; d < 4; d++) {
        var g = ctx.createLinearGradient(0, 520, 0, 820);
        g.addColorStop(0, d > 1 ? '#191420' : C.body);
        g.addColorStop(0.65, d > 1 ? '#2a2438' : '#231c2c');
        g.addColorStop(1, C.fog);
        legFill.push(g);
      }
    }
    return legFill[depth];
  }

  function drawLeg(leg, head) {
    var c = Math.cos(head.rot);
    var s = Math.sin(head.rot);
    var hx = head.x + leg.hip[0] * c - leg.hip[1] * s;
    var hy = head.y + leg.hip[0] * s + leg.hip[1] * c;
    var fx = leg.cur[0];
    var fy = leg.cur[1];
    var k = knee(hx, hy, fx, fy, leg.a, leg.b, leg.knee);
    // Gelenk zwischen Schiene und Mittelfuß bei 58 % des Unterschenkels
    var mx = k[0] + (fx - k[0]) * 0.58;
    var my = k[1] + (fy - k[1]) * 0.58;
    var w = leg.w;

    // Lichtkante: dieselbe Form leicht nach oben versetzt, darüber die dunkle Füllung
    ctx.fillStyle = C.rim;
    ctx.globalAlpha = leg.depth > 1 ? 0.45 : 0.9;
    segment(hx, hy - 1.8, k[0], k[1] - 1.8, w, w * 0.8);
    segment(k[0], k[1] - 1.8, mx, my - 1.8, w * 0.72, w * 0.45);
    ctx.globalAlpha = 1;

    ctx.fillStyle = legPaint(leg.depth);
    segment(hx, hy, k[0], k[1], w, w * 0.8);
    segment(k[0], k[1], mx, my, w * 0.72, w * 0.45);
    segment(mx, my, fx, fy, w * 0.42, 2.2);
    ctx.beginPath();
    ctx.arc(k[0], k[1], w * 0.5, 0, Math.PI * 2);
    ctx.arc(mx, my, w * 0.3, 0, Math.PI * 2);
    ctx.fill();
    spikes(leg.spikesA, hx, hy, k[0], k[1], w, w * 0.8, -leg.side);
    spikes(leg.spikesB, k[0], k[1], fx, fy, w * 0.72, 2.2, leg.side);
  }

  function drawAbdomen(head, t) {
    var breath = 1 + 0.022 * Math.sin(t * 1.3);
    ctx.save();
    ctx.translate(head.x + ABD.off[0], head.y + ABD.off[1]);
    ctx.rotate(ABD.rot + 0.025 * Math.sin(t * 0.7));
    ctx.scale(breath, 1 + (breath - 1) * 0.6);

    // Haare zuerst, damit der Körper ihre Wurzeln überdeckt
    ctx.fillStyle = C.body;
    ctx.beginPath();
    abdHair.forEach(function (h, idx) {
      var cx = Math.cos(h.th);
      var cy = Math.sin(h.th);
      var px = ABD.rx * cx;
      var py = ABD.ry * cy;
      var nx = cx / ABD.rx;
      var ny = cy / ABD.ry;
      var nl = Math.hypot(nx, ny);
      nx /= nl;
      ny /= nl;
      var lean = h.lean + 0.05 * Math.sin(t * 1.9 + idx);
      var vx = nx * Math.cos(lean) - ny * Math.sin(lean);
      var vy = nx * Math.sin(lean) + ny * Math.cos(lean);
      ctx.moveTo(px - ny * h.w - nx * 4, py + nx * h.w - ny * 4);
      ctx.lineTo(px + vx * h.len, py + vy * h.len);
      ctx.lineTo(px + ny * h.w - nx * 4, py - nx * h.w - ny * 4);
    });
    ctx.fill();

    var g = ctx.createRadialGradient(-20, -70, 10, 0, 0, ABD.ry * 1.05);
    g.addColorStop(0, C.bodyHi);
    g.addColorStop(0.55, '#231d2d');
    g.addColorStop(1, '#141018');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, ABD.rx, ABD.ry, 0, 0, Math.PI * 2);
    ctx.fill();

    // Fell-Struktur und eine schwache Zeichnung auf dem Rücken
    ctx.strokeStyle = 'rgba(120, 110, 160, .16)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    abdFur.forEach(function (f) {
      var x = f.x * ABD.rx;
      var y = f.y * ABD.ry;
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.sin(f.ang) * f.len, y + Math.cos(f.ang) * f.len);
    });
    ctx.stroke();
    ctx.strokeStyle = 'rgba(10, 8, 14, .55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (var c = 0; c < 4; c++) {
      var y = -70 + c * 40;
      ctx.moveTo(-34 + c * 6, y - 14);
      ctx.lineTo(0, y + 6);
      ctx.lineTo(34 - c * 6, y - 14);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawPalp(side, t) {
    var sw = 0.09 * Math.sin(t * 1.6 + side) + (side < 0 ? 0.03 : -0.02) * Math.sin(t * 3.7);
    ctx.save();
    ctx.translate(side * 40, 34);
    ctx.rotate(sw * side);
    var p1 = [side * -20, 52];
    var p2 = [side * -8, 98];
    ctx.fillStyle = C.body;
    segment(0, 0, p1[0], p1[1], 13, 10);
    segment(p1[0], p1[1], p2[0], p2[1], 10, 6);
    ctx.beginPath();
    ctx.arc(p1[0], p1[1], 5.5, 0, Math.PI * 2);
    ctx.fill();
    spikes(palpSpikes, p1[0], p1[1], p2[0], p2[1], 10, 6, side);
    ctx.restore();
  }

  function drawFang(side, t) {
    // Kieferklauen öffnen und schließen sich ganz leicht
    var open = 0.035 + 0.035 * Math.sin(t * 2.1) + 0.03 * Math.max(0, Math.sin(t * 0.37) - 0.85) * 6;
    ctx.save();
    ctx.translate(side * 16, 30);
    ctx.rotate(side * open);
    var g = ctx.createLinearGradient(0, 0, 0, 120);
    g.addColorStop(0, '#2a2234');
    g.addColorStop(1, '#0e0b12');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(side * -12, -4);
    ctx.quadraticCurveTo(side * 22, 40, side * 6, 82);
    ctx.quadraticCurveTo(side * 2, 104, side * -6, 122);
    ctx.quadraticCurveTo(side * -6, 96, side * -10, 78);
    ctx.quadraticCurveTo(side * -18, 40, side * -12, -4);
    ctx.fill();
    // Lichtkante auf der Klaue
    ctx.strokeStyle = 'rgba(170, 195, 235, .28)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(side * 8, 20);
    ctx.quadraticCurveTo(side * 12, 60, side * 2, 96);
    ctx.stroke();
    ctx.restore();
  }

  function drawHead(head, t) {
    ctx.save();
    ctx.translate(head.x, head.y);
    ctx.rotate(head.rot);

    drawPalp(-1, t);
    drawPalp(1, t);
    drawFang(-1, t);
    drawFang(1, t);

    // Haarkranz um den Kopf
    ctx.fillStyle = C.body;
    ctx.beginPath();
    headHair.forEach(function (h, idx) {
      var cx = Math.cos(h.th);
      var cy = Math.sin(h.th);
      var px = 58 * cx;
      var py = 50 * cy;
      var lean = h.lean + 0.06 * Math.sin(t * 2.2 + idx);
      var vx = cx * Math.cos(lean) - cy * Math.sin(lean);
      var vy = cx * Math.sin(lean) + cy * Math.cos(lean);
      ctx.moveTo(px + cy * 2.5, py - cx * 2.5);
      ctx.lineTo(px + vx * h.len, py + vy * h.len);
      ctx.lineTo(px - cy * 2.5, py + cx * 2.5);
    });
    ctx.fill();

    var g = ctx.createRadialGradient(0, -34, 6, 0, 0, 62);
    g.addColorStop(0, '#3e3854');
    g.addColorStop(0.6, '#211b2a');
    g.addColorStop(1, '#141018');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, 60, 52, 0, 0, Math.PI * 2);
    ctx.fill();

    drawEyes(t);
    ctx.restore();
  }

  // Acht Augen in zwei Reihen, kaltes Glimmen
  var EYES = [
    [-31, -4, 5, 6.5], [-12, -10, 5.5, 7.5], [12, -10, 5.5, 7.5], [31, -4, 5, 6.5],
    [-24, 15, 4.5, 6], [-8, 18, 4.5, 6], [8, 18, 4.5, 6], [24, 15, 4.5, 6],
  ];
  function drawEyes(t) {
    var pulse = 0.8 + 0.2 * Math.sin(t * 1.1) + 0.06 * Math.sin(t * 5.3);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var glow = ctx.createRadialGradient(0, 2, 4, 0, 2, 78);
    glow.addColorStop(0, C.eyeGlow + (0.24 * pulse) + ')');
    glow.addColorStop(1, C.eyeGlow + '0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 2, 78, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    EYES.forEach(function (e) {
      ctx.fillStyle = '#07060a';
      ctx.beginPath();
      ctx.ellipse(e[0], e[1], e[2] + 2, e[3] + 2, 0, 0, Math.PI * 2);
      ctx.fill();
      var eg = ctx.createRadialGradient(e[0] - 1.5, e[1] - 2.5, 0.5, e[0], e[1], e[3]);
      eg.addColorStop(0, '#ffffff');
      eg.addColorStop(0.45, C.eye);
      eg.addColorStop(1, 'rgba(120, 190, 240, ' + (0.65 + 0.3 * pulse) + ')');
      ctx.fillStyle = eg;
      ctx.beginPath();
      ctx.ellipse(e[0], e[1], e[2], e[3], 0, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function drawShadow(head) {
    ctx.save();
    ctx.translate(head.x * 0.6 + W * 0.2, 792);
    ctx.scale(1, 0.12);
    var g = ctx.createRadialGradient(0, 0, 10, 0, 0, 360);
    g.addColorStop(0, 'rgba(4, 2, 8, .55)');
    g.addColorStop(1, 'rgba(4, 2, 8, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 360, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function frame(t) {
    var scale = canvas.width / W;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (!still) updateTap(t);
    // Körper wiegt leicht und hebt/senkt sich, die Füße bleiben stehen
    var head = {
      x: HEAD.x + 4 * Math.sin(t * 0.53) + 1.5 * Math.sin(t * 1.7),
      y: HEAD.y + 7 * Math.sin(t * 0.9) + 1.5 * Math.sin(t * 2.3),
      rot: 0.03 * Math.sin(t * 0.6),
    };

    drawShadow(head);
    LEGS.forEach(function (leg) { if (leg.depth >= 2) drawLeg(leg, head); });
    drawAbdomen(head, t);
    LEGS.forEach(function (leg) { if (leg.depth < 2) drawLeg(leg, head); });
    drawHead(head, t);
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(canvas.clientWidth * dpr);
    var h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      legFill = null; // Verläufe hängen am Kontext
    }
  }

  var t0 = null;
  function loop(now) {
    if (t0 === null) t0 = now;
    resize();
    frame((now - t0) / 1000);
    requestAnimationFrame(loop);
  }

  if (still) {
    resize();
    frame(0);
    window.addEventListener('resize', function () { resize(); frame(0); });
  } else {
    requestAnimationFrame(loop);
  }
})();

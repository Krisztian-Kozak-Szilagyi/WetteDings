// Shop-Demo: leerer Laden bei Nacht in leichter Draufsicht, eine Figur läuft mit WASD/Pfeiltasten (Umschalt = rennen).
// Weltkoordinaten in Pixeln (1240×980), die Kamera folgt der Figur. Wände, Theke usw. sind einfache Rechtecke
// für die Kollision; gezeichnet wird nach Fußlinie sortiert, damit die Figur hinter Theke/Glasfront verschwindet.
// Licht: dunkle Nachtebene, in die Lampen und Fenster „Löcher“ schneiden, darüber ein warmer Schein.
(function () {
  var canvas = document.querySelector('[data-shop-canvas]');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var hint = document.querySelector('.sd-hint');
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var W = 1240;
  var H = 980;

  // Gebäude: Außenkante, Wanddicke, Eingang (Schiebetür) unten in der Mitte
  var B = { x0: 80, y0: 50, x1: 1160, y1: 706 };
  var DOOR = { x0: 560, x1: 680 };

  var C = {
    grass: '#16211e',
    grassDark: '#101815',
    walk: '#383d48',
    walkLine: '#2c3039',
    curb: '#4b515d',
    street: '#191c24',
    lane: '#6b6a4c',
    floor: '#bdb5a5',
    floorAlt: '#b6ae9e',
    floorLine: 'rgba(60, 50, 40, .10)',
    wallFace: '#d9d0bf',
    baseboard: '#6f604f',
    cap: '#2a2a33',
    capEdge: '#141419',
    pillar: '#5a3a2c',
    counterTop: '#ad7f4d',
    counterFace: '#5b3c26',
    door: '#4a3a2e',
    glass: 'rgba(255, 214, 150, .55)',
  };

  // Feste Hindernisse [x0, y0, x1, y1]
  var solids = [
    [80, 50, 1160, 110],          // Rückwand (Mauerkrone + sichtbare Innenseite)
    [80, 50, 94, 706],            // linke Wand mit Fenstern
    [1146, 50, 1160, 706],        // rechte Wand
    [846, 50, 860, 352],          // Lager: Trennwand senkrecht
    [846, 316, 960, 352],         // Lager: Trennwand waagerecht (links der Tür)
    [1030, 316, 1160, 352],       // Lager: Trennwand waagerecht (rechts der Tür)
    [80, 676, DOOR.x0, 706],      // Glasfront links
    [DOOR.x1, 676, 1160, 706],    // Glasfront rechts
    [330, 150, 730, 214],         // Theke
    [330, 110, 366, 214],         // Theke: Seitenteil zur Wand
    [150, 716, 230, 746],         // Pflanzkübel
    [330, 716, 410, 746],
    [790, 716, 870, 746],
    [990, 716, 1070, 746],
    [713, 778, 727, 792],         // Laternenmast
    [880, 878, 1080, 958],        // Auto
    [8, 772, 64, 828],            // Bäume
    [1176, 762, 1232, 818],
  ];
  var doorSolid = [DOOR.x0, 676, DOOR.x1, 706];

  // Lampen an der Rückwand (Fußpunkt des Lichtkegels auf dem Boden)
  var wallLamps = [
    { x: 220, y: 86 },
    { x: 470, y: 86 },
    { x: 640, y: 86 },
    { x: 1000, y: 86 },
  ];
  var post = { x: 720, y: 785, headY: 700 };

  var player = { x: 620, y: 815, dir: 'up', phase: 0, moving: false };
  var door = 0; // 0 = zu, 1 = offen
  var cam = { x: player.x, y: player.y };
  var keys = new Set();
  var view = { w: 0, h: 0, dpr: 1, zoom: 1 };
  var time = 0;
  var hintTimer = null;

  function resize() {
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.w = window.innerWidth;
    view.h = window.innerHeight;
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
    // Möglichst den ganzen Laden zeigen, auf kleinen Bildschirmen aber nicht winzig werden
    view.zoom = Math.max(0.6, Math.min(1.8, Math.min(view.w / 1080, view.h / 820)));
    light.width = canvas.width;
    light.height = canvas.height;
  }
  var light = document.createElement('canvas');
  var lctx = light.getContext('2d');

  // ---------- Bewegung ----------
  var KEYMAP = new Map([
    ['KeyW', 'up'], ['ArrowUp', 'up'],
    ['KeyS', 'down'], ['ArrowDown', 'down'],
    ['KeyA', 'left'], ['ArrowLeft', 'left'],
    ['KeyD', 'right'], ['ArrowRight', 'right'],
  ]);

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (history.length > 1) history.back();
      else location.href = '/';
      return;
    }
    var k = KEYMAP.get(e.code);
    if (k) {
      keys.add(k);
      e.preventDefault();
    }
    if (e.key === 'Shift') keys.add('run');
  });
  window.addEventListener('keyup', function (e) {
    var k = KEYMAP.get(e.code);
    if (k) keys.delete(k);
    if (e.key === 'Shift') keys.delete('run');
  });
  window.addEventListener('blur', function () { keys.clear(); });

  function hits(x, y) {
    var x0 = x - 11, x1 = x + 11, y0 = y - 8, y1 = y + 3;
    if (x0 < 4 || x1 > W - 4 || y0 < 4 || y1 > H - 4) return true;
    var list = door < 0.6 ? solids.concat([doorSolid]) : solids;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (x1 > r[0] && x0 < r[2] && y1 > r[1] && y0 < r[3]) return true;
    }
    return false;
  }

  function update(dt) {
    var dx = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
    var dy = (keys.has('down') ? 1 : 0) - (keys.has('up') ? 1 : 0);
    player.moving = dx !== 0 || dy !== 0;
    if (player.moving) {
      if (hint && !hintTimer) hintTimer = setTimeout(function () { hint.classList.add('is-weg'); }, 2500);
      var len = Math.hypot(dx, dy);
      var speed = keys.has('run') ? 290 : 175;
      var sx = (dx / len) * speed * dt;
      var sy = (dy / len) * speed * dt;
      // Achsen einzeln, damit man an Wänden entlanggleitet
      if (!hits(player.x + sx, player.y)) player.x += sx;
      if (!hits(player.x, player.y + sy)) player.y += sy;
      if (Math.abs(dx) > Math.abs(dy)) player.dir = dx > 0 ? 'right' : 'left';
      else if (dy !== 0) player.dir = dy > 0 ? 'down' : 'up';
      player.phase += dt * (keys.has('run') ? 15 : 10);
    } else {
      player.phase = 0;
    }

    // Schiebetür öffnet, wenn man in der Nähe ist
    var near = Math.hypot(player.x - (DOOR.x0 + DOOR.x1) / 2, player.y - 690) < 120;
    door += ((near ? 1 : 0) - door) * Math.min(1, dt * 7);

    // Kamera folgt weich, bleibt in der Welt
    cam.x += (player.x - cam.x) * Math.min(1, dt * 6);
    cam.y += (player.y - 20 - cam.y) * Math.min(1, dt * 6);
  }

  function camOffset() {
    var vw = view.w / view.zoom;
    var vh = view.h / view.zoom;
    var ox = vw >= W ? (W - vw) / 2 : Math.max(0, Math.min(W - vw, cam.x - vw / 2));
    var oy = vh >= H ? (H - vh) / 2 : Math.max(0, Math.min(H - vh, cam.y - vh / 2));
    return { x: ox, y: oy };
  }

  // ---------- Zeichnen: Boden und Wände ----------
  function rect(c, x0, y0, x1, y1, col) {
    c.fillStyle = col;
    c.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  function drawGround() {
    rect(ctx, -400, -400, W + 400, H + 400, C.grassDark);
    rect(ctx, 0, 0, W, 760, C.grass);
    // Gehweg mit Platten
    rect(ctx, 0, 706, W, 860, C.walk);
    ctx.strokeStyle = C.walkLine;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var x = 0; x <= W; x += 62) { ctx.moveTo(x, 706); ctx.lineTo(x, 860); }
    for (var y = 760; y < 860; y += 52) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    // Seitenwege neben dem Haus
    rect(ctx, 0, 30, 60, 706, '#1d2824');
    rect(ctx, 1180, 30, W, 706, '#1d2824');
    // Bordstein und Straße
    rect(ctx, 0, 860, W, 870, C.curb);
    rect(ctx, 0, 870, W, H, C.street);
    ctx.fillStyle = C.lane;
    for (var lx = 20; lx < W; lx += 120) ctx.fillRect(lx, 962, 60, 5);
    // Fußmatte
    rect(ctx, 580, 712, 660, 760, '#22242b');
    ctx.strokeStyle = '#30333c';
    ctx.strokeRect(584, 716, 72, 40);
  }

  function drawInterior() {
    // Fliesen
    for (var y = 110, row = 0; y < 676; y += 56, row++) {
      for (var x = 94, col = 0; x < 1146; x += 56, col++) {
        rect(ctx, x, y, Math.min(x + 56, 1146), Math.min(y + 56, 676), (row + col) % 2 ? C.floorAlt : C.floor);
      }
    }
    ctx.strokeStyle = C.floorLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var gx = 94; gx < 1146; gx += 56) { ctx.moveTo(gx, 110); ctx.lineTo(gx, 676); }
    for (var gy = 110; gy < 676; gy += 56) { ctx.moveTo(94, gy); ctx.lineTo(1146, gy); }
    ctx.stroke();

    // Innenseite der Rückwand (Haupt- und Lagerraum)
    rect(ctx, 94, 64, 846, 110, C.wallFace);
    rect(ctx, 860, 64, 1146, 110, '#cfc6b4');
    rect(ctx, 94, 104, 846, 110, C.baseboard);
    rect(ctx, 860, 104, 1146, 110, C.baseboard);
    // Türen in der Rückwand
    drawWallDoor(760, 64);
    drawWallDoor(930, 64);
    // kleiner Lichtschalter / Kasten
    rect(ctx, 150, 74, 164, 84, '#a59c8b');

    // Lampenschirme an der Wand
    wallLamps.forEach(function (l) {
      rect(ctx, l.x - 2, 64, l.x + 2, 72, '#2b2b2b');
      ctx.fillStyle = '#2a2a2e';
      ctx.beginPath();
      ctx.moveTo(l.x - 10, 82);
      ctx.lineTo(l.x - 5, 71);
      ctx.lineTo(l.x + 5, 71);
      ctx.lineTo(l.x + 10, 82);
      ctx.closePath();
      ctx.fill();
      rect(ctx, l.x - 7, 82, l.x + 7, 84, '#ffe2a8');
    });

    // Mauerkronen (von oben gesehen)
    rect(ctx, 80, 50, 1160, 64, C.cap);
    rect(ctx, 846, 50, 860, 316, C.cap);
    rect(ctx, 1146, 50, 1160, 706, C.cap);
    // Linke Wand mit großen Fenstern
    rect(ctx, 80, 50, 94, 706, C.cap);
    for (var wy = 140; wy < 640; wy += 120) {
      rect(ctx, 82, wy, 92, wy + 100, '#e8c58c');
      rect(ctx, 82, wy + 48, 92, wy + 52, C.cap);
    }
    // Eckpfeiler
    rect(ctx, 72, 42, 98, 68, C.pillar);
    rect(ctx, 1142, 42, 1168, 68, C.pillar);
    ctx.strokeStyle = C.capEdge;
    ctx.lineWidth = 2;
    ctx.strokeRect(80, 50, 1080, 656);
  }

  function drawWallDoor(x, y) {
    rect(ctx, x - 3, y + 2, x + 45, y + 46, '#3a2e25');
    rect(ctx, x, y + 5, x + 42, y + 46, C.door);
    rect(ctx, x + 33, y + 26, x + 37, y + 29, '#c9a35e');
  }

  // ---------- Dinge mit Tiefe (nach Fußlinie sortiert) ----------
  function sprites() {
    var list = [
      { y: 214, draw: drawCounter },
      { y: 352, draw: drawDivider },
      { y: 706, draw: drawFront },
      { y: 746, draw: drawPlanters },
      { y: 790, draw: drawPost },
      { y: 958, draw: drawCar },
      { y: 830, draw: drawTrees },
      { y: player.y, draw: drawPlayer },
    ];
    list.sort(function (a, b) { return a.y - b.y; });
    list.forEach(function (s) { s.draw(); });
  }

  function drawCounter() {
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.fillRect(334, 214, 400, 8);
    rect(ctx, 330, 190, 730, 214, C.counterFace);
    rect(ctx, 330, 150, 730, 192, C.counterTop);
    rect(ctx, 330, 110, 366, 192, C.counterTop);
    rect(ctx, 330, 150, 730, 153, '#c99b63');
    ctx.strokeStyle = 'rgba(30, 18, 10, .55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(330, 150, 400, 64);
    ctx.strokeRect(330, 110, 36, 82);
    // Kasse
    rect(ctx, 380, 158, 412, 180, '#2c2c30');
    rect(ctx, 384, 161, 408, 170, '#7fb5c9');
  }

  function drawDivider() {
    rect(ctx, 846, 316, 960, 330, C.cap);
    rect(ctx, 1030, 316, 1146, 330, C.cap);
    rect(ctx, 846, 330, 960, 352, '#d3cab8');
    rect(ctx, 1030, 330, 1146, 352, '#d3cab8');
    rect(ctx, 846, 347, 960, 352, C.baseboard);
    rect(ctx, 1030, 347, 1146, 352, C.baseboard);
    ctx.strokeStyle = C.capEdge;
    ctx.lineWidth = 2;
    ctx.strokeRect(846, 316, 114, 36);
    ctx.strokeRect(1030, 316, 116, 36);
  }

  function drawFront() {
    // Glasfront: Rahmen oben, warm leuchtende Scheiben, Pfosten
    function pane(x0, x1) {
      rect(ctx, x0, 676, x1, 684, C.cap);
      var g = ctx.createLinearGradient(0, 684, 0, 704);
      g.addColorStop(0, 'rgba(255, 220, 160, .75)');
      g.addColorStop(1, 'rgba(150, 105, 60, .75)');
      ctx.fillStyle = g;
      ctx.fillRect(x0, 684, x1 - x0, 18);
      rect(ctx, x0, 702, x1, 706, C.cap);
      ctx.fillStyle = C.cap;
      for (var x = x0; x <= x1 - 6; x += 120) ctx.fillRect(x, 676, 6, 30);
      ctx.fillRect(x1 - 6, 676, 6, 30);
    }
    pane(80, DOOR.x0);
    pane(DOOR.x1, 1160);
    // Türrahmen etwas höher
    rect(ctx, DOOR.x0 - 8, 668, DOOR.x0 + 2, 708, '#1c1c22');
    rect(ctx, DOOR.x1 - 2, 668, DOOR.x1 + 8, 708, '#1c1c22');
    rect(ctx, DOOR.x0 - 8, 668, DOOR.x1 + 8, 676, '#1c1c22');
    // Schiebetür: zwei Flügel, die zur Seite fahren
    var half = (DOOR.x1 - DOOR.x0) / 2;
    var shift = door * (half - 6);
    drawDoorWing(DOOR.x0 + 2 - shift, DOOR.x0 + half - shift);
    drawDoorWing(DOOR.x0 + half + shift, DOOR.x1 - 2 + shift);
    // Eckpfeiler vorne
    rect(ctx, 72, 670, 98, 712, C.pillar);
    rect(ctx, 1142, 670, 1168, 712, C.pillar);
  }

  function drawDoorWing(x0, x1) {
    rect(ctx, x0, 678, x1, 704, 'rgba(255, 226, 175, .35)');
    ctx.strokeStyle = '#1c1c22';
    ctx.lineWidth = 3;
    ctx.strokeRect(x0, 678, x1 - x0, 26);
  }

  function drawPlanters() {
    [150, 330, 790, 990].forEach(function (x) {
      rect(ctx, x, 724, x + 80, 746, '#2c3038');
      rect(ctx, x, 716, x + 80, 726, '#3a3f49');
      for (var i = 0; i < 5; i++) {
        var px = x + 10 + i * 15;
        ctx.fillStyle = i % 2 ? '#3f6b3a' : '#4f7d42';
        ctx.beginPath();
        ctx.ellipse(px, 716, 9, 7, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  function drawPost() {
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath();
    ctx.ellipse(post.x, post.y + 3, 12, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    rect(ctx, post.x - 3, post.headY, post.x + 3, post.y, '#1e1f25');
    rect(ctx, post.x - 7, post.y - 6, post.x + 7, post.y + 3, '#25262d');
    rect(ctx, post.x - 3, post.headY - 2, post.x + 22, post.headY + 3, '#1e1f25');
    rect(ctx, post.x + 14, post.headY + 3, post.x + 24, post.headY + 7, '#fff1cf');
  }

  function drawCar() {
    ctx.fillStyle = 'rgba(0,0,0,.4)';
    ctx.fillRect(884, 884, 200, 80);
    ctx.fillStyle = '#2b3140';
    roundRect(880, 878, 200, 80, 16);
    ctx.fill();
    ctx.fillStyle = '#1a1e28';
    roundRect(930, 886, 92, 64, 10);
    ctx.fill();
    ctx.fillStyle = '#3b4356';
    roundRect(940, 892, 72, 52, 6);
    ctx.fill();
    rect(ctx, 1074, 888, 1080, 900, '#d8d2b0');
    rect(ctx, 1074, 936, 1080, 948, '#d8d2b0');
  }

  function drawTrees() {
    [[36, 800], [1204, 790], [-10, 120], [1250, 300]].forEach(function (t) {
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.beginPath();
      ctx.ellipse(t[0] + 6, t[1] + 26, 46, 16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0f1a14';
      ctx.beginPath();
      ctx.arc(t[0], t[1], 48, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#16261c';
      ctx.beginPath();
      ctx.arc(t[0] - 10, t[1] - 12, 30, 0, Math.PI * 2);
      ctx.arc(t[0] + 16, t[1] - 4, 24, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- Figur ----------
  function drawPlayer() {
    var x = player.x;
    var y = player.y;
    var d = player.dir;
    var swing = player.moving ? Math.sin(player.phase) : 0;
    var bob = player.moving ? Math.abs(Math.sin(player.phase)) * 2 : (still ? 0 : Math.sin(time * 2) * 0.6);
    var side = d === 'left' || d === 'right';
    var flip = d === 'left' ? -1 : 1;

    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath();
    ctx.ellipse(x, y + 1, 13, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Beine
    ctx.fillStyle = '#2b2f45';
    if (side) {
      ctx.fillRect(x - 3 + swing * 4, y - 13, 6, 13);
      ctx.fillRect(x - 3 - swing * 4, y - 13, 6, 13);
    } else {
      ctx.fillRect(x - 7, y - 13 - Math.max(0, swing) * 3, 6, 13);
      ctx.fillRect(x + 1, y - 13 - Math.max(0, -swing) * 3, 6, 13);
    }
    // Schuhe
    ctx.fillStyle = '#1a1a1f';
    if (side) {
      ctx.fillRect(x - 3 + swing * 4 + flip * 2, y - 3, 6, 3);
      ctx.fillRect(x - 3 - swing * 4 + flip * 2, y - 3, 6, 3);
    } else {
      ctx.fillRect(x - 7, y - 3 - Math.max(0, swing) * 3, 6, 3);
      ctx.fillRect(x + 1, y - 3 - Math.max(0, -swing) * 3, 6, 3);
    }

    var by = y - 12 - bob;
    // Arme (hinter dem Körper bei Seitenansicht)
    ctx.fillStyle = '#e2b48a';
    if (side) {
      ctx.fillRect(x - 3 - swing * 5, by - 17, 6, 14);
    } else {
      ctx.fillRect(x - 14, by - 17 + swing * 2, 5, 14);
      ctx.fillRect(x + 9, by - 17 - swing * 2, 5, 14);
    }
    // Körper (Hemd)
    ctx.fillStyle = '#2f7f86';
    roundRect(x - (side ? 8 : 10), by - 20, side ? 16 : 20, 20, 5);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.fillRect(x - (side ? 8 : 10), by - 5, side ? 16 : 20, 5);
    if (side) {
      ctx.fillStyle = '#e2b48a';
      ctx.fillRect(x - 3 + swing * 5, by - 17, 6, 13);
    }

    // Kopf
    var hy = by - 30;
    ctx.fillStyle = '#efc69c';
    ctx.beginPath();
    ctx.arc(x, hy, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3b2a20';
    ctx.beginPath();
    if (d === 'up') {
      ctx.arc(x, hy, 11.5, 0, Math.PI * 2);
    } else if (side) {
      ctx.arc(x - flip * 2, hy - 2, 11.5, Math.PI, Math.PI * 2);
      ctx.rect(x - flip * 11 - (flip > 0 ? 0 : 7), hy - 2, 7, 9);
    } else {
      ctx.arc(x, hy - 1, 11.5, Math.PI, Math.PI * 2);
    }
    ctx.fill();
    // Augen
    ctx.fillStyle = '#1b1b22';
    if (d === 'down') {
      ctx.fillRect(x - 5, hy + 1, 3, 4);
      ctx.fillRect(x + 2, hy + 1, 3, 4);
    } else if (side) {
      ctx.fillRect(x + flip * 6 - 1, hy + 1, 3, 4);
    }
  }

  // ---------- Licht ----------
  function glow(c, x, y, r, a, col) {
    var g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, col + a + ')');
    g.addColorStop(1, col + '0)');
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }

  function drawLight(off, flicker) {
    var z = view.zoom * view.dpr;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, light.width, light.height);
    lctx.fillStyle = 'rgba(5, 9, 24, .80)';
    lctx.fillRect(0, 0, light.width, light.height);
    lctx.setTransform(z, 0, 0, z, -off.x * z, -off.y * z);

    // Licht schneidet die Dunkelheit weg
    lctx.globalCompositeOperation = 'destination-out';
    lctx.fillStyle = 'rgba(0,0,0,.62)';
    lctx.fillRect(80, 50, 1080, 660);
    wallLamps.forEach(function (l) { glow(lctx, l.x, l.y + 60, 300, 0.75, 'rgba(0,0,0,'); });
    glow(lctx, 620, 420, 420, 0.5, 'rgba(0,0,0,');
    // Schein durch die Glasfront auf den Gehweg
    var g = lctx.createLinearGradient(0, 700, 0, 850);
    g.addColorStop(0, 'rgba(0,0,0,.55)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    lctx.fillStyle = g;
    lctx.fillRect(90, 700, 1060, 150);
    // Schein aus den Seitenfenstern
    var gl = lctx.createLinearGradient(80, 0, 0, 0);
    gl.addColorStop(0, 'rgba(0,0,0,.45)');
    gl.addColorStop(1, 'rgba(0,0,0,0)');
    lctx.fillStyle = gl;
    lctx.fillRect(0, 130, 80, 520);
    // Straßenlaterne
    glow(lctx, post.x + 19, post.y + 10, 190, 0.85 * flicker, 'rgba(0,0,0,');

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(light, 0, 0);

    // Warmer Schein obendrauf
    ctx.setTransform(z, 0, 0, z, -off.x * z, -off.y * z);
    ctx.globalCompositeOperation = 'lighter';
    wallLamps.forEach(function (l) {
      glow(ctx, l.x, l.y + 40, 230, 0.16, 'rgba(255, 170, 80,');
      glow(ctx, l.x, 80, 26, 0.5, 'rgba(255, 220, 150,');
    });
    glow(ctx, post.x + 19, post.headY + 5, 34, 0.55 * flicker, 'rgba(255, 235, 190,');
    glow(ctx, post.x + 19, post.y + 10, 160, 0.10 * flicker, 'rgba(255, 210, 150,');
    glow(ctx, 620, 740, 260, 0.08, 'rgba(255, 170, 80,');
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------- Schleife ----------
  var last = performance.now();
  function frame(now) {
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    update(dt);

    var off = camOffset();
    var z = view.zoom * view.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.grassDark;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(z, 0, 0, z, -off.x * z, -off.y * z);
    drawGround();
    drawInterior();
    sprites();

    // Laterne flackert ganz leicht
    var flicker = still ? 1 : 0.94 + Math.sin(time * 13) * 0.03 + Math.sin(time * 31) * 0.03;
    drawLight(off, flicker);
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();
  cam.x = player.x;
  cam.y = player.y;
  requestAnimationFrame(frame);
})();

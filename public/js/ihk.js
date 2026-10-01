(function () {
  'use strict';

  // ---------- Vergrößern (Antippen/Klick) mit Auswahl-Knöpfen ----------
  var zoom = document.querySelector('[data-ihk-zoom]');
  var pickFn = null; // pickFn(el, target) – nur vorhanden, wenn eine Auswahl möglich ist
  var zoomEl = null;
  var zoomPick = zoom && zoom.querySelector('[data-ihk-zoom-pick]');
  var zoomBoost = zoom && zoom.querySelector('[data-ihk-zoom-boost]');

  function openZoom(el) {
    if (!zoom || !el || !el.dataset.zoom) return;
    zoom.querySelector('[data-ihk-zoom-img]').src = el.dataset.zoom;
    zoom.querySelector('[data-ihk-zoom-title]').textContent = el.dataset.zoomTitle || '';
    zoom.querySelector('[data-ihk-zoom-text]').textContent = el.dataset.zoomText || '';
    zoomEl = el.dataset.drag && pickFn ? el : null;
    zoomPick.hidden = !zoomEl;
    zoomBoost.hidden = !zoomEl || el.dataset.drag !== 'card' || !el.dataset.boostable;
    if (zoomEl) {
      var type = el.dataset.drag;
      var main = type === 'card' ? 'card' : type === 'boost' ? 'boost' : 'offer';
      var isMain = el.classList.contains('is-selected');
      var isBoost = el.classList.contains('is-boost');
      zoomPick.dataset.target = main;
      zoomPick.textContent = main === 'offer' ? (isMain ? 'Ausgewählt ✓' : 'Diese Quest wählen')
        : main === 'card' ? (isMain ? 'Ausgewählt ✓' : 'Diese Karte wählen')
        : (isBoost ? 'Als Boost gewählt ✓' : 'Als Boost wählen');
      zoomPick.disabled = main === 'boost' ? isBoost : isMain;
      zoomBoost.textContent = isBoost ? 'Als Boost gewählt ✓' : 'Als Boost wählen';
      zoomBoost.disabled = isBoost;
    }
    if (typeof zoom.showModal === 'function') zoom.showModal();
    else zoom.setAttribute('open', '');
  }
  function closeZoom() {
    if (typeof zoom.close === 'function') zoom.close();
    else zoom.removeAttribute('open');
  }
  if (zoom) {
    zoomPick.addEventListener('click', function () { if (zoomEl) pickFn(zoomEl, zoomPick.dataset.target); closeZoom(); });
    zoomBoost.addEventListener('click', function () { if (zoomEl) pickFn(zoomEl, 'boost'); closeZoom(); });
    zoom.querySelector('[data-ihk-zoom-close]').addEventListener('click', closeZoom);
    zoom.addEventListener('click', function (e) { if (e.target === zoom) closeZoom(); });
  }
  // Slots ohne Auswahl (laufende Quest / Ergebnis): Klick vergrößert
  document.querySelectorAll('.ihk-slot[data-zoom]').forEach(function (s) {
    s.addEventListener('click', function () { openZoom(s); });
  });

  // ---------- Auswahl: Karte links, Boost darunter, Quest rechts ----------
  var pick = document.querySelector('[data-ihk-pick]');
  if (pick) {
    var startBtn = pick.querySelector('[data-ihk-start]');
    var slots = { card: pick.querySelector('[data-ihk-drop="card"]'), boost: pick.querySelector('[data-ihk-drop="boost"]'), boost2: pick.querySelector('[data-ihk-drop="boost2"]'), offer: pick.querySelector('[data-ihk-drop="offer"]') };
    var accepts = { card: ['card'], boost: ['card', 'boost'], boost2: ['card', 'boost'], offer: ['offer'] };
    var isBoostSlot = function (k) { return k === 'boost' || k === 'boost2'; };
    // Charakterkarten nur in einen Boost-Slot, wenn ihre Fähigkeit dort wirkt
    var fits = function (slot, el) {
      if (slots[slot].classList.contains('is-disabled') || accepts[slot].indexOf(el.dataset.drag) === -1) return false;
      return !(isBoostSlot(slot) && el.dataset.drag === 'card' && !el.dataset.boostable);
    };
    var input = function (name) { return pick.querySelector('input[name="' + name + '"]'); };

    var fillSlot = function (target, el) {
      var slot = slots[target];
      slot.innerHTML = '';
      if (!el) {
        var empty = document.createElement('span');
        empty.className = 'ihk-slot-empty';
        // Boost 2 ist nur bei Hybrid-Quests aktiv – sonst ausgegraut
        if (isBoostSlot(target)) empty.innerHTML = slot.dataset.emptyLabel + '<br><small>' + (slot.classList.contains('is-disabled') ? 'nur bei Hybrid-Quests' : 'optional') + '</small>';
        else empty.textContent = 'Karte hierher ziehen';
        slot.appendChild(empty);
        delete slot.dataset.zoom;
        return;
      }
      var img = document.createElement('img');
      img.src = el.dataset.image;
      img.alt = '';
      img.draggable = false;
      slot.appendChild(img);
      slot.dataset.zoom = el.dataset.zoom;
      slot.dataset.zoomTitle = el.dataset.zoomTitle || '';
      slot.dataset.zoomText = el.dataset.zoomText || '';
      slot.classList.remove('is-picked');
      void slot.offsetWidth;
      slot.classList.add('is-picked');
    };
    var clear = function (target) { input(target).value = ''; fillSlot(target, null); };

    // Markierungen in der Kartenliste und der zweite Boost-Slot (nur bei Hybrid-Quests) folgen den Eingabefeldern
    var refresh = function () {
      var card = input('card').value, b1 = input('boost').value, b2 = input('boost2').value, offer = input('offer').value;
      var hybrid = false;
      pick.querySelectorAll('[data-drag="offer"]').forEach(function (x) {
        var on = offer !== '' && x.dataset.value === offer;
        x.classList.toggle('is-selected', on);
        if (on && x.dataset.hybrid) hybrid = true;
      });
      // Wechsel auf eine normale Quest: Boost 2 wird wieder grau und gibt seine Karte zurück
      if (slots.boost2.classList.contains('is-disabled') === hybrid) {
        slots.boost2.classList.toggle('is-disabled', !hybrid);
        clear('boost2');
        b2 = '';
      }
      pick.querySelectorAll('[data-drag="card"], [data-drag="boost"]').forEach(function (x) {
        x.classList.toggle('is-selected', x.dataset.drag === 'card' && x.dataset.value === card);
        x.classList.toggle('is-boost', x.dataset.value === b1 || x.dataset.value === b2);
      });
      startBtn.disabled = !(card && offer !== '');
    };

    var assign = function (el, target) {
      target = target || (el.dataset.drag === 'boost' ? 'boost' : el.dataset.drag);
      var value = el.dataset.value;
      if (isBoostSlot(target)) {
        // dieselbe Karte nicht gleichzeitig als Haupt- und Boost-Karte; Charaktere nur mit Boost-Fähigkeit
        if (input('card').value === value || (el.dataset.drag === 'card' && !el.dataset.boostable)) return;
        // "Als Boost wählen": ist der erste Slot belegt, kommt die Karte bei Hybrid-Quests in den zweiten
        if (target === 'boost' && !slots.boost2.classList.contains('is-disabled') && input('boost').value && input('boost').value !== value && !input('boost2').value) target = 'boost2';
        var other = target === 'boost' ? 'boost2' : 'boost';
        if (input(other).value === value) clear(other);
      }
      if (target === 'card') ['boost', 'boost2'].forEach(function (k) { if (input(k).value === value) clear(k); });
      input(target).value = value;
      fillSlot(target, el);
      refresh();
    };
    pickFn = assign;

    Object.keys(slots).forEach(function (k) {
      slots[k].addEventListener('click', function () { if (!drag.active) openZoom(slots[k]); });
    });

    // Ziehen (nur Maus); auf Touch-Geräten: antippen = vergrößern + Knopf
    var drag = { el: null, active: false, ghost: null };
    var targetAt = function (x, y) {
      var hit = document.elementFromPoint(x, y);
      var slot = hit && hit.closest('[data-ihk-drop]');
      return slot && drag.el && fits(slot.dataset.ihkDrop, drag.el) ? slot : null;
    };
    var moveGhost = function (x, y) {
      drag.ghost.style.left = x + 'px';
      drag.ghost.style.top = y + 'px';
      var t = targetAt(x, y);
      Object.keys(slots).forEach(function (k) { slots[k].classList.toggle('is-target', slots[k] === t); });
    };
    var beginDrag = function () {
      drag.active = true;
      drag.ghost = document.createElement('img');
      drag.ghost.src = drag.el.dataset.image;
      drag.ghost.className = 'ihk-ghost';
      document.body.appendChild(drag.ghost);
      drag.el.classList.add('is-dragging');
      document.body.classList.add('ihk-dragging'); // Cursor: zugreifende Hand
      Object.keys(slots).forEach(function (k) { if (fits(k, drag.el)) slots[k].classList.add('is-drop-hint'); });
    };
    var endDrag = function (drop) {
      if (drag.active) {
        var slot = drop ? targetAt(drag.x, drag.y) : null;
        if (slot) assign(drag.el, slot.dataset.ihkDrop);
        drag.ghost.remove();
        drag.el.classList.remove('is-dragging');
        document.body.classList.remove('ihk-dragging');
        Object.keys(slots).forEach(function (k) { slots[k].classList.remove('is-target', 'is-drop-hint'); });
        setTimeout(function () { drag.active = false; }, 0);
      } else if (drop && drag.el) {
        openZoom(drag.el);
      }
      drag.el = null;
    };
    pick.addEventListener('pointerdown', function (e) {
      var el = e.target.closest('[data-drag]');
      if (!el || e.button > 0) return;
      drag.el = el;
      drag.active = false;
      drag.x = drag.sx = e.clientX;
      drag.y = drag.sy = e.clientY;
      drag.touch = e.pointerType !== 'mouse';
    });
    document.addEventListener('pointermove', function (e) {
      if (!drag.el) return;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (!drag.active) {
        if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) <= 8) return;
        if (drag.touch) { drag.el = null; return; } // Wischen = Scrollen
        beginDrag();
      }
      moveGhost(e.clientX, e.clientY);
    });
    document.addEventListener('pointerup', function () { if (drag.el) endDrag(true); });
    document.addEventListener('pointercancel', function () { if (drag.el) endDrag(false); });
    pick.addEventListener('keydown', function (e) {
      var el = e.target.closest('[data-drag]');
      if (!el) return;
      if (e.key === 'Enter') { e.preventDefault(); openZoom(el); }
      if (e.key === ' ') { e.preventDefault(); assign(el); }
    });
  }

  // ---------- Countdown während der Quest, danach neu laden ----------
  var cd = document.querySelector('[data-ihk-countdown]');
  if (cd) {
    var end = Number(cd.getAttribute('data-ihk-countdown'));
    var tick = function () {
      var s = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      cd.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      if (s <= 0) return setTimeout(function () { location.reload(); }, 800);
      setTimeout(tick, 500);
    };
    tick();
  }

  // ---------- Quest abspielen: Fortschritt gegen Deadline (Ergebnis kommt vom Server) ----------
  var fight = document.querySelector('[data-ihk-fight]');
  if (!fight) return;
  var data = JSON.parse(fight.getAttribute('data-ihk-fight'));
  var DURATION = 15000;
  var half = data.workTime / 2;
  var freeze = data.freeze || 0;
  var span = data.workTime + freeze; // Spielzeit inkl. Stillstand
  var progress = fight.querySelector('[data-ihk-progress]');
  var timebar = fight.querySelector('[data-ihk-timebar]');
  var points = fight.querySelector('[data-ihk-points]');
  // Hybrid-Quest: zweiter Balken für die zweite Fachrichtung
  var progress2 = fight.querySelector('[data-ihk-progress2]');
  var points2 = fight.querySelector('[data-ihk-points2]');
  var total2 = 0;
  var timeLabel = fight.querySelector('[data-ihk-time]');
  var floaters = fight.querySelector('[data-ihk-floaters]');
  var result = fight.querySelector('[data-ihk-result]');
  var skip = fight.querySelector('[data-ihk-skip]');
  var player = document.querySelector('.ihk-player .ihk-slot-card');
  var boostSlots = document.querySelectorAll('.ihk-player .ihk-slot-item');
  var enemy = document.querySelector('.ihk-slot-enemy');

  var ticks = data.ticks.filter(function (t) { return !t.ability; });
  var hasAbility = data.ticks.some(function (t) { return t.ability; }) && data.abilities.length;
  var total = 0;
  var i = 0;
  var start = null;
  var done = false;
  var activated = false;
  var last = ticks.length ? ticks[ticks.length - 1].t : 0;
  var endT = data.success ? last : Math.max(span, last);

  // Verstrichene Deadline-Zeit: während Bloodlust steht die Uhr
  function elapsed(t) {
    if (!freeze || t < half) return t;
    return t < half + freeze ? half : t - freeze;
  }
  function render(t) {
    progress.style.width = (Math.min(1, total / data.required) * 100).toFixed(1) + '%';
    points.textContent = total + ' / ' + data.required;
    if (progress2) {
      progress2.style.width = (Math.min(1, total2 / data.required) * 100).toFixed(1) + '%';
      points2.textContent = total2 + ' / ' + data.required;
    }
    var left = Math.max(0, data.workTime - elapsed(t));
    timebar.style.width = ((left / data.workTime) * 100).toFixed(1) + '%';
    timeLabel.textContent = Math.ceil(left) + ' s';
  }
  function bump(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
  function floater(tk) {
    var el = document.createElement('span');
    el.className = 'ihk-floater' + (tk.crit || tk.destroy ? ' is-crit' : '') + (tk.fake ? ' is-fake' : '');
    el.textContent = tk.destroy ? 'ZERSTÖRT!' : (tk.fake ? 'GEFÄLSCHT! ' : tk.crit ? 'KRIT! ' : '+') + tk.p + (progress2 && tk.p2 != null ? ' / +' + tk.p2 : '');
    if (tk.destroy && enemy) enemy.classList.add('fx-frozen');
    el.style.left = (15 + Math.random() * 60) + '%';
    floaters.appendChild(el);
    setTimeout(function () { el.remove(); }, 1200);
    bump(player, 'is-hit');
    bump(enemy, 'is-shake');
  }
  // ---------- Fähigkeits-Effekte (gezeichnet, keine Emojis) ----------
  var SVGNS = 'http://www.w3.org/2000/svg';
  var rnd = function (a, b) { return a + Math.random() * (b - a); };
  // Wiederholt fn für ms Millisekunden im Abstand every
  function repeat(fn, every, ms) {
    var t0 = Date.now();
    var loop = function () { fn(); if (Date.now() - t0 < ms) setTimeout(loop, every); };
    loop();
  }
  function add(slot, el, life) {
    slot.appendChild(el);
    setTimeout(function () { el.remove(); }, life);
    return el;
  }
  function svg(cls) {
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('class', 'fx-svg ' + cls);
    s.setAttribute('viewBox', '0 0 100 140');
    s.setAttribute('preserveAspectRatio', 'none');
    return s;
  }
  var EFFECTS = {
    // Elektrische Entladungen an den Kartenrändern
    bolts: function (slot) {
      repeat(function () {
        var s = svg('fx-bolt');
        var p = document.createElementNS(SVGNS, 'polyline');
        var side = Math.floor(rnd(0, 4));
        var pts = [];
        for (var k = 0; k <= 6; k++) {
          var f = k / 6;
          var x = side === 0 ? f * 100 : side === 1 ? 100 - rnd(0, 12) : side === 2 ? f * 100 : rnd(0, 12);
          var y = side === 0 ? rnd(0, 14) : side === 1 ? f * 140 : side === 2 ? 140 - rnd(0, 14) : f * 140;
          pts.push(x.toFixed(1) + ',' + y.toFixed(1));
        }
        p.setAttribute('points', pts.join(' '));
        s.appendChild(p);
        add(slot, s, 260);
      }, 140, 5000);
    },
    // Steigender Börsenchart
    chart: function (slot) {
      var run = function () {
        var s = svg('fx-chart');
        var pts = [];
        var y = 120;
        for (var k = 0; k <= 10; k++) {
          y = Math.max(20, y - rnd(-6, 16));
          pts.push((k * 10) + ',' + y.toFixed(1));
        }
        var area = document.createElementNS(SVGNS, 'polygon');
        area.setAttribute('points', '0,140 ' + pts.join(' ') + ' 100,140');
        area.setAttribute('class', 'fx-chart-area');
        var line = document.createElementNS(SVGNS, 'polyline');
        line.setAttribute('points', pts.join(' '));
        line.setAttribute('class', 'fx-chart-line');
        s.appendChild(area);
        s.appendChild(line);
        add(slot, s, 2600);
      };
      run();
      setTimeout(run, 2400);
    },
    // Zahl wird "gefälscht": wirbelt und bleibt bei 99 stehen
    scramble: function (slot) {
      var el = add(slot, document.createElement('span'), 3600);
      el.className = 'fx-scramble';
      var n = 0;
      var t = setInterval(function () {
        el.textContent = n < 18 ? String(Math.floor(rnd(10, 99))) : '99';
        if (++n > 18) { clearInterval(t); el.classList.add('is-locked'); }
      }, 70);
    },
    // Funkelnde Sterne
    sparkle: function (slot) {
      repeat(function () {
        var el = document.createElement('span');
        el.className = 'fx-star';
        el.style.left = rnd(6, 90) + '%';
        el.style.top = rnd(6, 90) + '%';
        el.style.width = el.style.height = rnd(10, 20) + 'px';
        add(slot, el, 900);
      }, 160, 5000);
    },
    // Geschwindigkeitslinien
    speed: function (slot) {
      repeat(function () {
        var el = document.createElement('span');
        el.className = 'fx-streak';
        el.style.top = rnd(4, 96) + '%';
        el.style.width = rnd(25, 60) + '%';
        add(slot, el, 500);
      }, 70, 5000);
    },
    // Regen
    rain: function (slot) {
      repeat(function () {
        var el = document.createElement('span');
        el.className = 'fx-rain';
        el.style.left = rnd(0, 100) + '%';
        el.style.animationDuration = rnd(0.45, 0.8) + 's';
        add(slot, el, 900);
      }, 45, 5000);
    },
    // Aufsteigender Kaffeedampf
    steam: function (slot) {
      repeat(function () {
        var el = document.createElement('span');
        el.className = 'fx-steam';
        el.style.left = rnd(15, 75) + '%';
        el.style.animationDuration = rnd(2.2, 3.2) + 's';
        add(slot, el, 3300);
      }, 260, 5000);
    },
    // Herzchen (Krisz + Lili)
    hearts: function (slot) {
      repeat(function () {
        var el = document.createElement('span');
        el.className = 'fx-heart';
        el.textContent = '♥';
        el.style.left = rnd(8, 88) + '%';
        el.style.fontSize = rnd(14, 28) + 'px';
        el.style.animationDuration = rnd(1.6, 2.8) + 's';
        add(slot, el, 3000);
      }, 220, 5000);
    },
  };
  var EFFECT_OF = {
    nachtschicht: 'bolts', 'bfw-energy': 'bolts', lili: 'hearts', simulation: 'chart', faelschung: 'scramble',
    hund: 'sparkle', 'good-boy': 'sparkle', hundekarte: 'sparkle', nvidia: 'speed', amd: 'rain', kaffee: 'steam',
  };
  function playEffect(slot, key) {
    var fn = EFFECTS[EFFECT_OF[key]];
    if (slot && fn) fn(slot);
  }
  function activate() {
    if (activated || !hasAbility) return;
    activated = true;
    data.abilities.forEach(function (a) {
      if (a.fx) player && player.classList.add(a.fx);
      if (a.enemyFx) enemy && enemy.classList.add(a.enemyFx);
      playEffect(player, a.key);
    });
    boostSlots.forEach(function (b) { if (b.querySelector('img')) bump(b, 'fx-flash'); });
  }
  function finish() {
    if (done) return;
    done = true;
    while (i < ticks.length) { total += ticks[i].p; total2 += ticks[i].p2 || 0; i++; }
    if (hasAbility && (data.success ? last >= half : true)) activate();
    render(endT);
    skip.hidden = true;
    result.hidden = false;
  }
  function frame(now) {
    if (done) return;
    if (start === null) start = now;
    var t = ((now - start) / DURATION) * span;
    if (hasAbility && t >= half) activate();
    while (i < ticks.length && ticks[i].t <= t) {
      total += ticks[i].p;
      total2 += ticks[i].p2 || 0;
      floater(ticks[i]);
      i++;
    }
    render(Math.min(t, endT));
    if (t >= endT) return setTimeout(finish, 400);
    requestAnimationFrame(frame);
  }
  skip.addEventListener('click', finish);
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
  else requestAnimationFrame(frame);
})();

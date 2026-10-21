(function () {
  'use strict';

  // ---------- Vergrößern (Klick auf ein belegtes Feld bzw. die Lupe im Auswahlfenster) ----------
  var zoom = document.querySelector('[data-ihk-zoom]');
  var zoomMeta = zoom && zoom.querySelector('[data-ihk-zoom-meta]');

  // Schwierigkeit und – nur bei Hybrid-Quests – der Hinweis "Hybrid" unter dem Quest-Text
  function showMeta(el) {
    zoomMeta.textContent = '';
    zoomMeta.hidden = !el.dataset.zoomLevel;
    if (zoomMeta.hidden) return;
    zoomMeta.appendChild(document.createTextNode('Schwierigkeit: '));
    var level = document.createElement('strong');
    level.className = 'ihk-level r-' + (el.dataset.zoomLevelKey || '');
    level.textContent = el.dataset.zoomLevel;
    zoomMeta.appendChild(level);
    if (el.dataset.zoomHybrid) {
      var hybrid = document.createElement('span');
      hybrid.className = 'ihk-hybrid';
      hybrid.textContent = 'Hybrid';
      zoomMeta.appendChild(document.createTextNode(' '));
      zoomMeta.appendChild(hybrid);
    }
  }

  function openZoom(el) {
    if (!zoom || !el || !el.dataset.zoom) return;
    showMeta(el);
    zoom.querySelector('[data-ihk-zoom-img]').src = el.dataset.zoom;
    zoom.querySelector('[data-ihk-zoom-title]').textContent = el.dataset.zoomTitle || '';
    zoom.querySelector('[data-ihk-zoom-text]').textContent = el.dataset.zoomText || '';
    if (typeof zoom.showModal === 'function') zoom.showModal();
    else zoom.setAttribute('open', '');
  }
  function closeZoom() {
    if (typeof zoom.close === 'function') zoom.close();
    else zoom.removeAttribute('open');
  }
  if (zoom) {
    zoom.querySelector('[data-ihk-zoom-close]').addEventListener('click', closeZoom);
    zoom.addEventListener('click', function (e) { if (e.target === zoom) closeZoom(); });
  }
  // Lupe auf einer Karte im Auswahlfenster: vergrößern, nicht auswählen
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-ihk-zoom-btn]');
    if (!btn) return;
    e.preventDefault();
    openZoom(btn);
  });

  // ---------- Auswahl: Klick auf einen Platz öffnet das Auswahlfenster (wie im Dungeon) ----------
  var pick = document.querySelector('[data-ihk-pick]');
  // Slots ohne Auswahl (laufende Quest / Ergebnis): Klick vergrößert
  if (!pick) {
    document.querySelectorAll('.ihk-slot[data-zoom]').forEach(function (s) {
      s.addEventListener('click', function () { openZoom(s); });
    });
  }
  if (pick) {
    var startBtn = pick.querySelector('[data-ihk-start]');
    var slots = { card: pick.querySelector('[data-ihk-drop="card"]'), boost: pick.querySelector('[data-ihk-drop="boost"]'), boost2: pick.querySelector('[data-ihk-drop="boost2"]'), dog: pick.querySelector('[data-ihk-drop="dog"]'), offer: pick.querySelector('[data-ihk-drop="offer"]') };
    var pickers = Array.prototype.slice.call(document.querySelectorAll('[data-ihk-picker]'));
    var pickerFor = function (k) { return document.querySelector('[data-ihk-picker="' + k + '"]'); };
    var isBoostSlot = function (k) { return k === 'boost' || k === 'boost2' || k === 'dog'; };
    // Karte (Eintrag im Auswahlfenster) zu einer Karten-ID – data-dog = welcher Hund, data-matze = Matze
    var itemOf = function (id) { return id ? document.querySelector('[data-ihk-item][data-value="' + id + '"]') : null; };
    var dogOf = function (k) { var el = itemOf(input(k).value); return el ? el.dataset.dog || '' : ''; };
    var input = function (name) { return pick.querySelector('input[name="' + name + '"]'); };
    var calm = function () { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; };
    var PICK_MS = 380; // so lange hebt sich die gewählte Karte, bevor das Fenster schließt
    var PEEK_PX = 40; // so weit schaut die vierte Kartenreihe hervor, wenn es mehr als drei gibt

    var fillSlot = function (target, el) {
      var slot = slots[target];
      slot.innerHTML = '';
      if (!el) {
        var empty = document.createElement('span');
        empty.className = 'ihk-slot-empty';
        // Boost 2 ist nur bei Hybrid-Quests aktiv – sonst ausgegraut
        if (isBoostSlot(target)) empty.innerHTML = slot.dataset.emptyLabel + '<br><small>' + (target === 'dog' ? 'Yo Dawg: zweiter Hund' : slot.classList.contains('is-disabled') ? 'nur bei Hybrid-Quests' : 'optional') + '</small>';
        else empty.textContent = target === 'offer' ? 'Quest wählen' : 'Karte wählen';
        slot.appendChild(empty);
        return;
      }
      var img = document.createElement('img');
      img.src = el.dataset.image;
      img.alt = '';
      img.draggable = false;
      slot.appendChild(img);
      slot.classList.remove('is-picked');
      void slot.offsetWidth;
      slot.classList.add('is-picked');
    };
    var clear = function (target) { input(target).value = ''; fillSlot(target, null); };

    // Markierungen (Angebote in der Mitte, Häkchen im Auswahlfenster) und der zweite Boost-Slot folgen den Eingabefeldern
    var refresh = function () {
      var offer = input('offer').value;
      var hybrid = false;
      pick.querySelectorAll('[data-drag="offer"]').forEach(function (x) {
        var on = offer !== '' && x.dataset.value === offer;
        x.classList.toggle('is-selected', on);
        if (on && x.dataset.hybrid) hybrid = true;
      });
      // Wechsel auf eine normale Quest: Boost 2 wird wieder grau und gibt seine Karte zurück
      if (slots.boost2.classList.contains('is-disabled') === hybrid) {
        slots.boost2.classList.toggle('is-disabled', !hybrid);
        slots.boost2.setAttribute('aria-disabled', hybrid ? 'false' : 'true');
        clear('boost2');
      }
      // Yo Dawg: Matze mit genau einem Hund im Boost bekommt den Hunde-Slot – für den anderen Hund
      var main = itemOf(input('card').value);
      var dogs = ['boost', 'boost2'].map(dogOf).filter(Boolean);
      var dogSlot = !!(main && main.dataset.matze) && dogs.length === 1;
      // Gruß aus dem Osten: Geld nur für Aleks – bei einer anderen Karte zurück auf 0
      var coins = pick.querySelector('[data-ihk-coins]');
      var aleks = !!(main && main.dataset.aleks);
      if (coins && coins.hidden === aleks) {
        coins.hidden = !aleks;
        if (!aleks) coins.querySelector('input').value = '0';
      }
      if (slots.dog.hidden === dogSlot) {
        slots.dog.hidden = !dogSlot;
        if (!dogSlot) clear('dog');
      }
      if (dogSlot && dogOf('dog') === dogs[0]) clear('dog'); // derselbe Hund steht jetzt im Boost
      var dogPicker = pickerFor('dog');
      if (dogPicker) dogPicker.querySelectorAll('[data-ihk-item]').forEach(function (el) {
        var same = el.dataset.dog === dogs[0];
        el.classList.toggle('is-blocked', same || !!el.dataset.blocked);
        el.querySelector('input').disabled = same || !!el.dataset.blocked;
        el.title = same ? 'Steht schon im Boost-Slot – jede Hundekarte nur einmal' : el.dataset.zoomTitle;
      });
      pickers.forEach(function (dlg) {
        var v = input(dlg.dataset.ihkPicker).value;
        dlg.querySelectorAll('input[type="radio"]').forEach(function (r) { r.checked = r.value === v; });
      });
      startBtn.disabled = !(input('card').value && offer !== '');
    };

    var assign = function (el, target) {
      if (el.dataset.blocked) return; // kein freies Exemplar (Im Dungeon, Im Handel …)
      var value = el.dataset.value;
      if (target === 'dog' && (!el.dataset.dog || ['boost', 'boost2'].some(function (k) { return dogOf(k) === el.dataset.dog; }))) return;
      if (isBoostSlot(target)) {
        // dieselbe Karte nicht gleichzeitig als Haupt- und Boost-Karte; Charaktere nur mit Boost-Fähigkeit
        if (el.dataset.drag === 'card' && !el.dataset.boostable) return;
        // bisher Hauptkarte: wandert in den Boost-Slot, das Hauptfeld wird frei
        if (input('card').value === value) clear('card');
        ['boost', 'boost2', 'dog'].forEach(function (k) { if (k !== target && input(k).value === value) clear(k); });
      }
      if (target === 'card') ['boost', 'boost2', 'dog'].forEach(function (k) { if (input(k).value === value) clear(k); });
      input(target).value = value;
      fillSlot(target, el);
      refresh();
    };

    // ---------- Auswahlfenster ----------
    // Weich ausgeblendet wird nur die Kante, hinter der noch Karten liegen (CSS: .has-above / .has-below)
    var fadeEdges = function (grid) {
      grid.classList.toggle('has-above', grid.scrollTop > 2);
      grid.classList.toggle('has-below', grid.scrollTop + grid.clientHeight < grid.scrollHeight - 2);
    };
    // Höhe: bis drei Reihen wächst das Fenster mit, ab der vierten scrollt das Raster (CSS: --dg-grid-max)
    var sizePicker = function (dlg) {
      var grid = dlg.querySelector('[data-ihk-grid]');
      dlg.style.minHeight = '';
      var first = Array.prototype.find.call(grid.children, function (el) { return !el.hidden && el.matches('[data-ihk-item]'); });
      if (first) {
        var cs = getComputedStyle(grid);
        var gap = parseFloat(cs.rowGap) || 0;
        grid.style.setProperty('--dg-grid-max', Math.ceil(3 * first.offsetHeight + 3 * gap + parseFloat(cs.paddingTop) + PEEK_PX) + 'px');
      }
      dlg.style.minHeight = dlg.offsetHeight + 'px';
    };
    var closePicker = function (dlg) {
      dlg.classList.remove('is-picking');
      if (typeof dlg.close === 'function') dlg.close();
      else dlg.removeAttribute('open');
    };
    var openPicker = function (k) {
      var dlg = pickerFor(k);
      if (!dlg || slots[k].classList.contains('is-disabled')) return;
      refresh();
      dlg.classList.remove('is-opening', 'is-picking');
      dlg.querySelectorAll('img[loading="lazy"]').forEach(function (img) { img.loading = 'eager'; });
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
      sizePicker(dlg);
      var grid = dlg.querySelector('[data-ihk-grid]');
      // Die schon gewählte Karte mittig zeigen
      var chosen = grid.querySelector('input:checked');
      if (chosen && chosen.value !== '') {
        var g = grid.getBoundingClientRect();
        var c = chosen.closest('.dg-pick').getBoundingClientRect();
        grid.scrollTop += c.top - g.top - (g.height - c.height) / 2;
      }
      fadeEdges(grid);
      // Hereinfächern in der Reihenfolge, in der man die Karten sieht
      var top = grid.getBoundingClientRect().top;
      var bottom = top + grid.clientHeight;
      var n = 0;
      Array.prototype.forEach.call(grid.children, function (el) {
        if (el.hidden) return;
        var r = el.getBoundingClientRect();
        el.style.setProperty('--i', r.bottom > top && r.top < bottom ? n++ : 0);
      });
      void dlg.offsetWidth;
      dlg.classList.add('is-opening');
      clearTimeout(dlg.openTimer);
      dlg.openTimer = setTimeout(function () { dlg.classList.remove('is-opening'); }, 850);
      var search = dlg.querySelector('[data-ihk-search]');
      if (search && window.innerWidth >= 720) search.focus({ preventScroll: true });
    };

    Object.keys(slots).forEach(function (k) {
      slots[k].addEventListener('click', function () { openPicker(k); });
      slots[k].addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(k); }
      });
    });
    pickers.forEach(function (dlg) {
      var k = dlg.dataset.ihkPicker;
      dlg.querySelector('[data-ihk-picker-close]').addEventListener('click', function () { closePicker(dlg); });
      dlg.addEventListener('click', function (e) {
        if (e.target === dlg) return closePicker(dlg); // Klick daneben schließt
        // Klick auf die schon gewählte Karte: kein change-Ereignis – Fenster einfach schließen
        var box = e.target.closest('.dg-pick');
        if (!box || e.target.matches('input') || e.target.closest('[data-ihk-zoom-btn]')) return;
        var r = box.querySelector('input');
        if (r && r.checked && !r.disabled) closePicker(dlg);
      });
      // Klick auf eine Karte übernimmt sie sofort; die gewählte hebt sich kurz, dann schließt das Fenster
      dlg.addEventListener('change', function (e) {
        var r = e.target;
        if (r.type !== 'radio') return;
        var item = r.closest('[data-ihk-item]');
        if (item) assign(item, k);
        else { clear(k); refresh(); } // „Ohne Boost“
        var box = r.closest('.dg-pick');
        dlg.classList.remove('is-opening');
        dlg.classList.add('is-picking');
        if (box) box.classList.add('is-picked');
        setTimeout(function () {
          if (box) box.classList.remove('is-picked');
          closePicker(dlg);
        }, calm() ? 0 : PICK_MS);
      });
    });
    window.addEventListener('resize', function () { pickers.forEach(function (dlg) { if (dlg.open) sizePicker(dlg); }); });

    // Angebote in der Mitte: Klick (oder Enter/Leertaste) wählt die Quest direkt
    pick.querySelectorAll('[data-drag="offer"]').forEach(function (el) {
      el.addEventListener('click', function () { assign(el, 'offer'); });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); assign(el, 'offer'); }
      });
    });
    refresh();
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
  var slow = data.slow || []; // Forkbomb: [von, bis, Prozent] – Deadline läuft langsamer
  function overlap(a, b, c, d) { return Math.max(0, Math.min(b, d) - Math.max(a, c)); }
  // durch Forkbomb gewonnene Deadline-Sekunden bis Spielzeit t (wie ihkService.slowGain)
  function slowGain(t) {
    return slow.reduce(function (sum, x) { return sum + ((overlap(x[0], x[1], 0, t) - overlap(x[0], x[1], half, Math.min(half + freeze, t))) * x[2]) / 100; }, 0);
  }
  // Ömer (Mach das Unmögliche möglich): die Deadline läuft schneller – rush [bis zur Halbzeit, danach], end = ihr Ende
  var rush = data.rush || [0, 0];
  var span = data.end || data.workTime + freeze + slowGain(Infinity); // Spielzeit inkl. Stillstand und Verlangsamung
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
  // Treue Seele: Hunde an Matze (data-dog-image = Bild mit +25) – sie greifen bei jedem Schlag mit an (Takt dg)
  var dogSlots = Array.prototype.slice.call(document.querySelectorAll('.ihk-player .ihk-slot-item[data-dog-image]'));
  dogSlots.forEach(function (b) { new Image().src = b.dataset.dogImage; });
  var enemy = document.querySelector('.ihk-slot-enemy');

  var ticks = data.ticks.filter(function (t) { return !t.ability; });

  // ---------- Kartenwerte live: Boost/Debuff schreibt die neuen Werte auf die Karte (nur Rahmen-Karten) ----------
  var playerImg = player ? player.querySelector('img') : null;
  var imgs = data.imgs || {};
  var curStats = data.base;
  Object.keys(imgs).forEach(function (k) { new Image().src = imgs[k]; }); // vorladen, damit der Wechsel sofort sitzt
  var STAT_LABELS = ['Speed', 'FIA', 'FIS', 'BWL'];
  function showStats(st, quiet) {
    if (!st) return;
    var prev = curStats;
    curStats = st;
    if (playerImg && imgs[st.join(',')]) {
      playerImg.src = imgs[st.join(',')];
      player.setAttribute('data-zoom', playerImg.src); // Großansicht zeigt dieselben Werte
    }
    if (!prev || quiet) return;
    // Jede geänderte Eigenschaft steigt als Zahl auf: grün ▲ (Buff) bzw. rot ▼ (Debuff) – auch bei alten Karten
    var up = false;
    var down = false;
    st.forEach(function (v, k) {
      if (v === prev[k]) return;
      if (v > prev[k]) up = true; else down = true;
      var el = document.createElement('span');
      el.className = 'ihk-floater ' + (v > prev[k] ? 'is-stat-up' : 'is-stat-down');
      el.textContent = STAT_LABELS[k] + (v > prev[k] ? ' ▲ ' : ' ▼ ') + v;
      el.style.left = (10 + k * 22) + '%';
      floaters.appendChild(el);
      setTimeout(function () { el.remove(); }, 1800);
    });
    if (up) bump(player, 'fx-stat-up');
    if (down) bump(player, 'fx-stat-down');
  }
  // Werte am Ende: letzter Wechsel bis zum Schluss
  function lastStats() {
    var st = null;
    data.ticks.forEach(function (t) { if (t.st) st = t.st; });
    return st;
  }
  var hasAbility = data.ticks.some(function (t) { return t.ability; }) && data.abilities.length;
  var total = 0;
  var i = 0;
  var start = null;
  var done = false;
  var activated = false;
  var last = ticks.length ? ticks[ticks.length - 1].t : 0;
  var endT = data.success ? last : Math.max(span, last);

  // Verstrichene Deadline-Zeit: während Bloodlust steht die Uhr, bei Forkbomb läuft sie langsamer
  function elapsed(t) {
    var base = t - overlap(half, half + freeze, 0, t) - slowGain(t);
    return Math.min(t, half) * (1 + rush[0]) + Math.max(0, base - half) * (1 + rush[1]); // wie ihkService.rushedUsed
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
    if (tk.coin) coinFloater(tk.coin);
    if (tk.destroy && enemy) enemy.classList.add('fx-frozen');
    el.style.left = (15 + Math.random() * 60) + '%';
    floaters.appendChild(el);
    setTimeout(function () { el.remove(); }, 1200);
    bump(player, 'is-hit');
    bump(enemy, 'is-shake');
    if (tk.dg) dogSlots.forEach(function (b) { bump(b, 'is-hit'); });
  }
  // Mach das Unmögliche möglich: so viele Ömer greifen gerade gemeinsam an (Abzeichen ×2 / ×3 an der Karte)
  function showCopies(tk) {
    if (!tk.om || !player || player.getAttribute('data-copies') === String(tk.om)) return;
    player.setAttribute('data-copies', String(tk.om));
    bump(player, 'fx-stat-up');
  }
  // Gruß aus dem Osten: das mitgegebene Geld sinkt mit jedem Münzwurf (coinBudget, coinCost in Cent)
  var coinLeftEl = document.querySelector('[data-ihk-coin-left]');
  var coinLeft = data.coinBudget || 0;
  var euroText = function (cents) { return (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; };
  function spendCoin(tk) {
    if (!tk.coin || !coinLeftEl) return;
    coinLeft = Math.max(0, coinLeft - (data.coinCost || 0));
    coinLeftEl.textContent = euroText(coinLeft);
  }
  // Gruß aus dem Osten: jeder Münzwurf von Aleks steigt als eigene Zahl auf – Kopf golden mit +10, Zahl grau
  function coinFloater(side) {
    var el = document.createElement('span');
    el.className = 'ihk-floater ihk-coin ' + (side === 'kopf' ? 'is-heads' : 'is-tails');
    el.textContent = side === 'kopf' ? 'KOPF! +' + (data.coinPlus || 10) : 'Zahl';
    el.style.left = (10 + Math.random() * 30) + '%';
    el.style.top = '18%';
    floaters.appendChild(el);
    setTimeout(function () { el.remove(); }, 1400);
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
    nachtschicht: 'bolts', 'bfw-energy': 'bolts', lili: 'hearts', potions: 'sparkle', faelschung: 'scramble', 'gruss-aus-dem-osten': 'scramble', omer: 'sparkle',
    'treue-seele': 'sparkle', 'treue-seele-matze': 'sparkle', nvidia: 'speed', amd: 'rain', kaffee: 'steam',
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
    data.ticks.forEach(function (t) { if (t.ability && t.st) showStats(t.st); });
    boostSlots.forEach(function (b) { if (b.querySelector('img')) bump(b, 'fx-flash'); });
    dogSlots.forEach(function (b) {
      var img = b.querySelector('img');
      if (!img) return;
      img.src = b.dataset.dogImage;
      b.setAttribute('data-zoom', b.dataset.dogImage);
      bump(b, 'fx-stat-up');
    });
  }
  function finish() {
    if (done) return;
    done = true;
    while (i < ticks.length) { total += ticks[i].p; total2 += ticks[i].p2 || 0; spendCoin(ticks[i]); showCopies(ticks[i]); i++; }
    if (hasAbility && (data.success ? last >= half : true)) activate();
    showStats(lastStats(), true);
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
      spendCoin(ticks[i]);
      showCopies(ticks[i]);
      showStats(ticks[i].st);
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

// ---------- Auswahlfenster: Suchen + Seltenheit (partials/mkt-bar) blenden Karten aus, der Rest wird gescrollt ----------
(function () {
  'use strict';
  function fadeEdges(grid) {
    grid.classList.toggle('has-above', grid.scrollTop > 2);
    grid.classList.toggle('has-below', grid.scrollTop + grid.clientHeight < grid.scrollHeight - 2);
  }
  document.querySelectorAll('[data-ihk-picklist]').forEach(function (box) {
    var grid = box.querySelector('[data-ihk-grid]');
    var items = Array.prototype.slice.call(box.querySelectorAll('[data-ihk-item]'));
    var none = box.querySelector('[data-ihk-none]'); // "Ohne Boost" – nur ohne Suche und Filter
    var search = box.querySelector('[data-ihk-search]');
    var opts = Array.prototype.slice.call(box.querySelectorAll('[data-ihk-rar]'));
    var empty = box.querySelector('[data-ihk-empty]');
    // Favoriten stehen fest oben; „Häufig verwendet“ (nur ohne Favoriten) holt die meistgespielten Karten per CSS nach vorn
    var groups = Array.prototype.slice.call(box.querySelectorAll('[data-pick-group]'));
    var freqBtn = box.querySelector('[data-ihk-freq]');
    var hasFavs = !!box.querySelector('[data-fav]');
    var rarity = '';
    var freqOn = false;
    grid.addEventListener('scroll', function () { fadeEdges(grid); }, { passive: true });
    if (!search) return; // Quest-Fenster: ohne Suche
    function apply() {
      var q = search.value.trim().toLowerCase();
      groups.forEach(function (g) {
        var kind = g.getAttribute('data-pick-group');
        g.hidden = !!(q || rarity) || (kind === 'freq' && !freqOn) || (kind === 'rest' && !hasFavs && !freqOn);
      });
      var shown = 0;
      items.forEach(function (it) {
        it.hidden = !((!rarity || it.getAttribute('data-rarity') === rarity) && (!q || (it.getAttribute('data-name') || '').indexOf(q) !== -1));
        if (!it.hidden) shown++;
      });
      if (none) none.hidden = !!(q || rarity);
      if (empty) empty.hidden = shown > 0;
      grid.scrollTop = 0;
      fadeEdges(grid);
    }
    opts.forEach(function (o) {
      o.addEventListener('click', function () {
        rarity = o.getAttribute('data-ihk-rar');
        apply();
      });
    });
    search.addEventListener('input', apply);
    if (freqBtn) {
      freqBtn.addEventListener('click', function () {
        freqOn = !freqOn;
        box.classList.toggle('show-freq', freqOn);
        freqBtn.setAttribute('aria-pressed', freqOn ? 'true' : 'false');
        apply();
      });
    }
  });
})();

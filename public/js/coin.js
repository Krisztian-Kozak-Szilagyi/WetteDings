(function () {
  'use strict';

  var chartEl = document.getElementById('coin-chart');
  if (!chartEl) return;

  var POLL_MS = 5000;
  var HISTORY_REFRESH_MS = 60000;
  var UNITS = 1e8;
  var SPANS = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, all: null };

  var svg = chartEl.querySelector('.chart-svg');
  var tip = chartEl.querySelector('.chart-tip');
  var loading = chartEl.querySelector('.chart-loading');
  var rangeChangeEl = document.querySelector('[data-range-change]');
  var tradeCard = document.querySelector('.trade-card');

  var range = chartEl.getAttribute('data-range') || '24h';
  var points = [];
  var lastPrice = tradeCard ? Number(tradeCard.dataset.price) : null;
  var historyTimer = null;

  // ---------- Formatierung ----------
  function fmtPrice(p) {
    var digits = p >= 1 ? 2 : p >= 0.01 ? 4 : 6;
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(p);
  }
  var euroFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  function fmtEuro(cents) { return euroFmt.format(cents / 100); }
  function fmtPct(x) { return (x > 0 ? '+' : '') + (x * 100).toFixed(2).replace('.', ',') + ' %'; }
  function fmtCoins(units) { return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 6 }).format(units / UNITS) + ' SAM'; }
  function fmtTime(t) {
    var d = new Date(t);
    if (range === '1h' || range === '24h') return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    if (range === 'all') return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  }
  function fmtTip(t) {
    return new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }

  // ---------- Diagramm ----------
  var geom = null;

  function draw() {
    if (points.length < 2) return;
    loading.hidden = true;
    var w = chartEl.clientWidth;
    var h = w < 520 ? 230 : 300;
    var padL = 8, padR = 66, padT = 14, padB = 26;
    var t0 = points[0][0], t1 = points[points.length - 1][0];
    var min = Infinity, max = -Infinity;
    points.forEach(function (p) { if (p[1] < min) min = p[1]; if (p[1] > max) max = p[1]; });
    if (min === max) { min *= 0.99; max *= 1.01; }
    var pad = (max - min) * 0.08;
    min = Math.max(0, min - pad); max += pad;

    var x = function (t) { return padL + ((t - t0) / (t1 - t0 || 1)) * (w - padL - padR); };
    var y = function (v) { return padT + (1 - (v - min) / (max - min)) * (h - padT - padB); };

    var up = points[points.length - 1][1] >= points[0][1];
    chartEl.classList.toggle('chart-up', up);
    chartEl.classList.toggle('chart-down', !up);

    var line = points.map(function (p, i) { return (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); }).join(' ');
    var area = line + ' L' + x(t1).toFixed(1) + ' ' + (h - padB) + ' L' + x(t0).toFixed(1) + ' ' + (h - padB) + ' Z';

    var grid = '';
    for (var i = 0; i <= 4; i++) {
      var v = min + ((max - min) * i) / 4;
      var gy = y(v).toFixed(1);
      grid += '<line class="grid" x1="' + padL + '" x2="' + (w - padR) + '" y1="' + gy + '" y2="' + gy + '"/>';
      grid += '<text class="axis" x="' + (w - padR + 6) + '" y="' + gy + '" dy="4">' + fmtPrice(v) + '</text>';
    }
    var labels = '';
    var n = w < 520 ? 3 : 5;
    for (var k = 0; k < n; k++) {
      var tt = t0 + ((t1 - t0) * k) / (n - 1);
      var anchor = k === 0 ? 'start' : k === n - 1 ? 'end' : 'middle';
      labels += '<text class="axis" x="' + x(tt).toFixed(1) + '" y="' + (h - 6) + '" text-anchor="' + anchor + '">' + fmtTime(tt) + '</text>';
    }
    var last = points[points.length - 1];

    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('height', h);
    svg.innerHTML =
      '<defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" class="fill-top"/><stop offset="1" class="fill-bottom"/></linearGradient></defs>' +
      grid + labels +
      '<path class="area" d="' + area + '"/>' +
      '<path class="line" d="' + line + '"/>' +
      '<line class="cursor" x1="0" x2="0" y1="' + padT + '" y2="' + (h - padB) + '" visibility="hidden"/>' +
      '<circle class="cursor-dot" r="4" visibility="hidden"/>' +
      '<circle class="live-point" cx="' + x(last[0]).toFixed(1) + '" cy="' + y(last[1]).toFixed(1) + '" r="4"/>';

    geom = { x: x, y: y, padL: padL, padR: padR, w: w };

    if (rangeChangeEl) {
      var ch = last[1] / points[0][1] - 1;
      rangeChangeEl.textContent = fmtPct(ch) + ' im Zeitraum';
      rangeChangeEl.className = 'chart-range-change small ' + (ch >= 0 ? 'pos' : 'neg');
    }
  }

  function nearest(clientX) {
    var rect = svg.getBoundingClientRect();
    var px = clientX - rect.left;
    var best = 0, bestD = Infinity;
    for (var i = 0; i < points.length; i++) {
      var d = Math.abs(geom.x(points[i][0]) - px);
      if (d < bestD) { bestD = d; best = i; }
    }
    return points[best];
  }

  function showCursor(clientX) {
    if (!geom || points.length < 2) return;
    var p = nearest(clientX);
    var cx = geom.x(p[0]), cy = geom.y(p[1]);
    var cursor = svg.querySelector('.cursor'), dot = svg.querySelector('.cursor-dot');
    cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.innerHTML = '<strong>' + fmtPrice(p[1]) + '</strong><span>' + fmtTip(p[0]) + '</span>';
    var left = Math.min(Math.max(cx - tip.offsetWidth / 2, 0), geom.w - tip.offsetWidth);
    tip.style.left = left + 'px';
  }
  function hideCursor() {
    tip.hidden = true;
    var c = svg.querySelector('.cursor'), d = svg.querySelector('.cursor-dot');
    if (c) c.setAttribute('visibility', 'hidden');
    if (d) d.setAttribute('visibility', 'hidden');
  }
  svg.addEventListener('mousemove', function (e) { showCursor(e.clientX); });
  svg.addEventListener('mouseleave', hideCursor);
  svg.addEventListener('touchstart', function (e) { showCursor(e.touches[0].clientX); }, { passive: true });
  svg.addEventListener('touchmove', function (e) { showCursor(e.touches[0].clientX); }, { passive: true });
  svg.addEventListener('touchend', hideCursor);

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 120);
  });

  // ---------- Daten laden ----------
  function loadHistory() {
    return fetch('/coin-exchange/api/verlauf?bereich=' + encodeURIComponent(range), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        if (data.range !== range) return;
        points = data.points;
        draw();
      })
      .catch(function () { loading.textContent = 'Kursverlauf konnte nicht geladen werden.'; loading.hidden = false; });
  }

  function addLivePoint(t, price) {
    if (!points.length) return;
    var span = SPANS[range];
    var prev = points[points.length - 2];
    // Für 1 Std. jeden Tick als eigenen Punkt zeigen, sonst nur den letzten Punkt aktualisieren
    if (range === '1h' && prev && t - prev[0] >= 60e3) points.push([t, price]);
    else points[points.length - 1] = [t, price];
    if (span) { var cutoff = t - span; while (points.length > 2 && points[0][0] < cutoff) points.shift(); }
    draw();
  }

  function setText(sel, text, cls) {
    var el = document.querySelector(sel);
    if (!el) return;
    el.textContent = text;
    if (cls !== undefined) el.className = cls;
  }

  function flash(el, up) {
    if (!el) return;
    el.classList.remove('tick-up', 'tick-down');
    void el.offsetWidth;
    el.classList.add(up ? 'tick-up' : 'tick-down');
  }

  function poll() {
    fetch('/coin-exchange/api/kurs', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (s) {
        var priceEl = document.querySelector('[data-live-price]');
        if (lastPrice !== null && s.price !== lastPrice) flash(priceEl, s.price > lastPrice);
        lastPrice = s.price;
        if (priceEl) priceEl.textContent = fmtPrice(s.price);
        var changeEl = document.querySelector('[data-live-change]');
        if (changeEl) {
          changeEl.innerHTML = fmtPct(s.change24h) + ' <span class="muted">24 h</span>';
          changeEl.className = 'coin-change ' + (s.change24h >= 0 ? 'pos' : 'neg');
        }
        setText('[data-live-high]', fmtPrice(s.high24h));
        setText('[data-live-low]', fmtPrice(s.low24h));
        setText('[data-live-ath]', fmtPrice(s.ath));
        updateDepot(s.price);
        updateMinBuy(s.price);
        addLivePoint(s.at, s.price);
        document.title = fmtPrice(s.price) + ' · SAM · BfW Holdings';
      })
      .catch(function () {});
  }

  // Mindestbetrag beim Kauf: 10 % des aktuellen Kurses (mindestens der allgemeine Mindestbetrag)
  function updateMinBuy(price) {
    var input = document.querySelector('[data-min-buy]');
    if (!input) return;
    var min = Math.max(Number(input.dataset.minTrade), Math.ceil(Number((price * 100 * Number(input.dataset.minShare)).toFixed(6))));
    input.min = min / 100;
    setText('[data-min-buy-text]', fmtEuro(min));
  }

  // ---------- Depot & Handel ----------
  function holdingUnits() { return tradeCard ? Number(tradeCard.dataset.units) || 0 : 0; }
  function valueCents(price) { return Math.floor((holdingUnits() / UNITS) * price * 100); }

  function updateDepot(price) {
    if (!tradeCard) return;
    tradeCard.dataset.price = price;
    var units = holdingUnits();
    var value = valueCents(price);
    var pl = value - (Number(tradeCard.dataset.cost) || 0);
    setText('[data-live-value]', fmtEuro(value));
    if (units > 0) setText('[data-live-pl]', (pl > 0 ? '+' : '') + fmtEuro(pl), pl > 0 ? 'pos' : pl < 0 ? 'neg' : '');
    updatePreviews();
  }

  function updatePreviews() {
    if (!tradeCard) return;
    var price = Number(tradeCard.dataset.price);
    tradeCard.querySelectorAll('[data-trade-form]').forEach(function (form) {
      var input = form.querySelector('input[name="amount"]');
      var out = form.querySelector('[data-trade-preview]');
      var all = form.querySelector('input[name="all"]');
      var euros = parseFloat(String(input.value).replace(',', '.')) || 0;
      if (form.getAttribute('data-trade-form') === 'verkaufen' && all && all.value === '1') {
        out.textContent = 'Du verkaufst deinen gesamten Bestand (' + fmtCoins(holdingUnits()) + ') für ca. ' + fmtEuro(valueCents(price)) + '.';
        return;
      }
      if (euros <= 0) { out.textContent = ''; return; }
      var units = (euros / price) * UNITS;
      out.textContent = (form.getAttribute('data-trade-form') === 'kaufen' ? 'Du erhältst ca. ' : 'Du verkaufst ca. ') + fmtCoins(units) + ' zum Kurs ' + fmtPrice(price) + '.';
    });
  }

  if (tradeCard) {
    tradeCard.querySelectorAll('[data-trade-tab]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var name = tab.getAttribute('data-trade-tab');
        tradeCard.querySelectorAll('[data-trade-tab]').forEach(function (t) {
          var on = t === tab;
          t.classList.toggle('active', on);
          t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        tradeCard.querySelectorAll('[data-trade-form]').forEach(function (f) { f.hidden = f.getAttribute('data-trade-form') !== name; });
      });
    });

    tradeCard.querySelectorAll('[data-set-amount]').forEach(function (b) {
      b.addEventListener('click', function () {
        var input = b.closest('form').querySelector('input[name="amount"]');
        input.value = Number(b.getAttribute('data-set-amount')).toFixed(2).replace(/\.00$/, '');
        updatePreviews();
      });
    });

    tradeCard.querySelectorAll('[data-sell-fraction]').forEach(function (b) {
      b.addEventListener('click', function () {
        var form = b.closest('form');
        var fraction = Number(b.getAttribute('data-sell-fraction'));
        var price = Number(tradeCard.dataset.price);
        form.querySelector('input[name="all"]').value = fraction === 1 ? '1' : '0';
        form.querySelector('input[name="amount"]').value = (Math.floor(valueCents(price) * fraction) / 100).toFixed(2);
        updatePreviews();
      });
    });

    tradeCard.querySelectorAll('input[name="amount"]').forEach(function (input) {
      input.addEventListener('input', function () {
        var all = input.form.querySelector('input[name="all"]');
        if (all) all.value = '0';
        updatePreviews();
      });
    });

    // "Alles verkaufen" braucht keinen Betrag
    var sellForm = tradeCard.querySelector('[data-trade-form="verkaufen"]');
    if (sellForm) {
      sellForm.addEventListener('submit', function (e) {
        var all = sellForm.querySelector('input[name="all"]').value === '1';
        var amount = sellForm.querySelector('input[name="amount"]');
        if (!all && !amount.value) { e.preventDefault(); amount.focus(); }
      });
    }
  }

  // ---------- Zeitraum ----------
  document.querySelectorAll('[data-range]').forEach(function (btn) {
    if (btn === chartEl) return;
    btn.addEventListener('click', function () {
      range = btn.getAttribute('data-range');
      document.querySelectorAll('.range-tabs [data-range]').forEach(function (b) {
        var on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      loadHistory();
    });
  });

  loadHistory();
  setInterval(poll, POLL_MS);
  historyTimer = setInterval(loadHistory, HISTORY_REFRESH_MS);
})();

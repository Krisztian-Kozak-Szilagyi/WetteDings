(function () {
  'use strict';

  // Statistik-Seite: Verläufe als SVG (Linie, Balken, gestapelte Balken mit Quellen/Senken) je Tag, Woche oder
  // Monat – mit beschrifteten Markierungen für Einstellungsänderungen und Patchnotes, Hover-Tooltip, Legende
  // und Tabellenansicht.
  var dataEl = document.getElementById('stats-data');
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent);
  var labels = data.labels;
  var longLabels = data.longLabels;
  var NS = 'http://www.w3.org/2000/svg';

  // ---------- Formatierung ----------
  var euroFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  var euroWhole = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  var euroCompact = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1 });
  var numFmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
  function fmt(v, unit, axis) {
    if (v === null || v === undefined) return '–';
    if (unit === 'euro') return axis ? (Math.abs(v) >= 1e8 ? euroCompact : euroWhole).format(v / 100) : euroFmt.format(v / 100);
    if (unit === 'price') {
      var digits = v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
      return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
    }
    if (unit === 'percent') return numFmt.format(v * 100) + ' %';
    if (unit === 'ratio') return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
    return numFmt.format(v);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /** Runde Achsenschritte (1, 2, 5 × 10^n) */
  function niceStep(span, count) {
    var raw = span / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    var norm = raw / mag;
    return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  }

  function el(name, attrs, parent) {
    var node = document.createElementNS(NS, name);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  // Markierungen je Abschnitt
  var markersAt = {};
  (data.markers || []).forEach(function (m) { (markersAt[m.i] = markersAt[m.i] || []).push(m); });

  // ---------- Diagramm ----------
  function render(box, chart) {
    // Farbe folgt der Reihe, nicht ihrer Position: leere Reihen werden ausgelassen, behalten aber ihren Platz
    var series = chart.series
      .map(function (s, idx) { return { name: s.name, values: s.values, cls: 's' + ((idx % 8) + 1) }; })
      .filter(function (s) { return s.values.some(function (v) { return v !== null && v !== 0; }); });
    box.innerHTML = '';
    var n = labels.length;
    var stacked = chart.type === 'stacked';
    var bars = chart.type === 'bars' || stacked;

    // Wertebereich (gestapelt: positive und negative Anteile getrennt aufsummiert)
    var min = 0, max = 0, i;
    for (i = 0; i < n; i++) {
      if (stacked) {
        var pos = 0, neg = 0;
        series.forEach(function (s) { var v = s.values[i] || 0; if (v > 0) pos += v; else neg += v; });
        max = Math.max(max, pos); min = Math.min(min, neg);
      } else {
        series.forEach(function (s) { var v = s.values[i]; if (v !== null) { max = Math.max(max, v); min = Math.min(min, v); } });
      }
    }
    if (chart.type === 'line' && min >= 0) {
      // Linien müssen nicht bei 0 beginnen, wenn alle Werte weit darüber liegen (Geldmenge, Kurs)
      var vals = [];
      series.forEach(function (s) { s.values.forEach(function (v) { if (v !== null) vals.push(v); }); });
      var lo = Math.min.apply(null, vals);
      if (lo > max * 0.5) min = lo - (max - lo) * 0.15;
    }
    if (max === min) max = max ? max * 1.1 : 1;

    var w = box.clientWidth || 600;
    var h = w < 520 ? 210 : 240;
    var padL = 64, padR = 12, padT = 22, padB = 24;
    var step = niceStep(max - min, 4);
    var y0 = Math.floor(min / step) * step;
    var y1 = Math.ceil(max / step) * step;
    var slot = (w - padL - padR) / n;
    var x = function (k) { return padL + slot * (k + 0.5); };
    var y = function (v) { return padT + (1 - (v - y0) / (y1 - y0 || 1)) * (h - padT - padB); };

    var svg = el('svg', { class: 'stats-svg', viewBox: '0 0 ' + w + ' ' + h, height: h, role: 'img', 'aria-label': chart.title });
    box.appendChild(svg);

    // Raster und Achsen (zurückhaltend)
    for (var v = y0; v <= y1 + step / 2; v += step) {
      el('line', { class: Math.abs(v) < step / 1000 ? 'baseline' : 'grid', x1: padL, x2: w - padR, y1: y(v), y2: y(v) }, svg);
      el('text', { class: 'axis', x: padL - 6, y: y(v), dy: 4, 'text-anchor': 'end' }, svg).textContent = fmt(v, chart.unit, true);
    }
    var every = Math.ceil(n / (w < 520 ? 4 : 8));
    for (i = 0; i < n; i++) {
      var lastLabel = i === n - 1;
      if (!lastLabel && (i % every !== 0 || n - 1 - i < every / 2)) continue;
      el('text', { class: 'axis', x: x(i), y: h - 6, 'text-anchor': 'middle' }, svg).textContent = labels[i];
    }

    // Markierungen mit Kurzbeschriftung (TCG, IHK, Patch …)
    Object.keys(markersAt).forEach(function (k) {
      var list = markersAt[k];
      var kind = list.some(function (m) { return m.kind === 'einstellung'; }) ? 'einstellung' : 'patch';
      var shorts = [];
      list.forEach(function (m) { if (shorts.indexOf(m.short) < 0) shorts.push(m.short); });
      el('line', { class: 'marker marker-' + kind, x1: x(+k), x2: x(+k), y1: padT - 4, y2: h - padB }, svg);
      var anchor = x(+k) > w - 40 ? 'end' : x(+k) < padL + 30 ? 'start' : 'middle';
      el('text', { class: 'marker-label marker-' + kind, x: x(+k), y: padT - 8, 'text-anchor': anchor }, svg).textContent = shorts.join(' + ');
    });

    // Daten
    if (bars) {
      var groupW = Math.max(2, Math.min(28, slot - 3));
      var barW = stacked ? groupW : Math.max(1.5, (groupW - (series.length - 1) * 2) / series.length);
      for (i = 0; i < n; i++) {
        var up = 0, down = 0;
        series.forEach(function (s, si) {
          var val = s.values[i] || 0;
          if (!val) return;
          var from, to, bx;
          if (stacked) {
            from = val > 0 ? up : down;
            to = from + val;
            if (val > 0) up = to; else down = to;
            bx = x(i) - groupW / 2;
          } else {
            from = 0; to = val;
            bx = x(i) - groupW / 2 + si * (barW + 2);
          }
          var top = Math.min(y(from), y(to));
          var height = Math.max(1, Math.abs(y(to) - y(from)) - (stacked ? 1 : 0));
          el('rect', { class: 'col ' + s.cls, x: bx.toFixed(1), y: top.toFixed(1), width: barW.toFixed(1), height: height.toFixed(1), rx: Math.min(2, barW / 3) }, svg);
        });
      }
    } else {
      series.forEach(function (s) {
        var path = '';
        var pen = false;
        s.values.forEach(function (val, k) {
          if (val === null) { pen = false; return; }
          path += (pen ? 'L' : 'M') + x(k).toFixed(1) + ' ' + y(val).toFixed(1);
          pen = true;
        });
        el('path', { class: 'line ' + s.cls, d: path }, svg);
        // Wenige Punkte (z. B. erst ein Tag mit Snapshot) wären als Linie kaum sichtbar
        var count = s.values.filter(function (val) { return val !== null; }).length;
        if (count <= 3) s.values.forEach(function (val, k) { if (val !== null) el('circle', { class: 'dot ' + s.cls, cx: x(k), cy: y(val), r: 4 }, svg); });
      });
    }

    // Hover: Fadenkreuz und Tooltip mit allen Werten des Abschnitts
    var cursor = el('line', { class: 'cursor', y1: padT, y2: h - padB, visibility: 'hidden' }, svg);
    var tip = document.createElement('div');
    tip.className = 'stats-tip';
    tip.hidden = true;
    box.appendChild(tip);
    function show(evt) {
      var rect = svg.getBoundingClientRect();
      var px = ((evt.clientX - rect.left) / rect.width) * w;
      var k = Math.max(0, Math.min(n - 1, Math.floor((px - padL) / slot)));
      cursor.setAttribute('x1', x(k));
      cursor.setAttribute('x2', x(k));
      cursor.setAttribute('visibility', 'visible');
      var html = '<strong>' + esc(longLabels[k]) + '</strong>';
      series.forEach(function (s) {
        html += '<span><i class="key ' + s.cls + '"></i>' + esc(s.name) + ': ' + fmt(s.values[k], chart.unit) + '</span>';
      });
      if (stacked && series.length > 1) {
        var sum = series.reduce(function (a, s) { return a + (s.values[k] || 0); }, 0);
        html += '<span class="tip-sum">Summe: ' + fmt(sum, chart.unit) + '</span>';
      }
      (markersAt[k] || []).forEach(function (m) { html += '<span class="tip-marker">◆ ' + esc(m.label) + '</span>'; });
      tip.innerHTML = html;
      tip.hidden = false;
      var left = (x(k) / w) * rect.width;
      tip.style.left = Math.max(0, Math.min(rect.width - tip.offsetWidth, left - tip.offsetWidth / 2)) + 'px';
    }
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', function () { cursor.setAttribute('visibility', 'hidden'); tip.hidden = true; });

    // Legende ab zwei Reihen (Farbe nie allein: der Name steht daneben)
    if (series.length > 1) {
      var legend = document.createElement('ul');
      legend.className = 'stats-legend';
      legend.innerHTML = series.map(function (s) { return '<li><i class="key ' + s.cls + '"></i>' + esc(s.name) + '</li>'; }).join('');
      box.appendChild(legend);
    }

    // Tabellenansicht (neueste zuerst, ohne leere Abschnitte)
    var rows = '';
    for (i = n - 1; i >= 0; i--) {
      var has = series.some(function (s) { return s.values[i] !== null && s.values[i] !== 0; });
      if (has) rows += '<tr><td>' + esc(longLabels[i]) + '</td>' + series.map(function (s) { return '<td class="num">' + fmt(s.values[i], chart.unit) + '</td>'; }).join('') + '</tr>';
    }
    var details = document.createElement('details');
    details.className = 'stats-table-toggle';
    details.innerHTML = '<summary class="small">Als Tabelle</summary><div class="table-wrap"><table class="table"><thead><tr><th>Zeitraum</th>' +
      series.map(function (s) { return '<th class="num">' + esc(s.name) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    box.appendChild(details);
  }

  var boxes = Array.prototype.slice.call(document.querySelectorAll('[data-stats-chart]'));
  function drawAll() {
    boxes.forEach(function (box) {
      var chart = data.charts.filter(function (c) { return c.id === box.getAttribute('data-stats-chart'); })[0];
      if (chart) render(box, chart);
    });
  }
  drawAll();
  var lastWidth = window.innerWidth;
  var timer = null;
  window.addEventListener('resize', function () {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(timer);
    timer = setTimeout(drawAll, 150);
  });
})();

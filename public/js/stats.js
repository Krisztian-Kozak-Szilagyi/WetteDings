(function () {
  'use strict';

  // Statistik-Seite: Verläufe je Tag als SVG (Linie, Balken, gestapelte Balken mit Quellen/Senken),
  // mit Markierungen für Einstellungsänderungen und Patchnotes, Hover-Tooltip, Legende und Tabellenansicht.
  var dataEl = document.getElementById('stats-data');
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent);
  var days = data.days;
  var NS = 'http://www.w3.org/2000/svg';

  // ---------- Formatierung ----------
  var euroFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  var euroAxis = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1 });
  var euroWhole = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  var numFmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
  function fmt(v, unit, axis) {
    if (v === null || v === undefined) return '–';
    if (unit === 'euro') return axis ? (Math.abs(v) >= 1e8 ? euroAxis : euroWhole).format(v / 100) : euroFmt.format(v / 100);
    if (unit === 'price') {
      var digits = v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
      return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
    }
    if (unit === 'percent') return numFmt.format(v * 100) + ' %';
    if (unit === 'ratio') return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
    return numFmt.format(v);
  }
  function dayShort(d) { var p = d.split('-'); return p[2] + '.' + p[1] + '.'; }
  function dayLong(d) { var p = d.split('-'); return p[2] + '.' + p[1] + '.' + p[0]; }
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

  // ---------- Diagramm ----------
  function render(box, chart) {
    var series = chart.series.filter(function (s) { return s.values.some(function (v) { return v !== null && v !== 0; }); });
    box.innerHTML = '';
    if (!series.length) {
      box.innerHTML = '<p class="muted small stats-empty">Keine Daten im Zeitraum.</p>';
      return;
    }
    var stacked = chart.type === 'stacked';
    var bars = chart.type === 'bars' || stacked;

    // Wertebereich (gestapelt: positive und negative Anteile getrennt aufsummiert)
    var min = 0, max = 0;
    days.forEach(function (d, i) {
      if (stacked) {
        var pos = 0, neg = 0;
        series.forEach(function (s) { var v = s.values[i] || 0; if (v > 0) pos += v; else neg += v; });
        max = Math.max(max, pos); min = Math.min(min, neg);
      } else {
        series.forEach(function (s) { var v = s.values[i]; if (v !== null) { max = Math.max(max, v); min = Math.min(min, v); } });
      }
    });
    if (chart.type === 'line' && min >= 0) {
      // Linien: Achse muss nicht bei 0 beginnen, wenn alle Werte weit darüber liegen (z. B. Geldmenge, Kurs)
      var vals = [];
      series.forEach(function (s) { s.values.forEach(function (v) { if (v !== null) vals.push(v); }); });
      var lo = Math.min.apply(null, vals);
      if (lo > max * 0.5) min = lo - (max - lo) * 0.15;
    }
    if (max === min) { max = max ? max * 1.1 : 1; }

    var w = box.clientWidth || 600;
    var h = w < 520 ? 220 : 260;
    var padL = 64, padR = 12, padT = 12, padB = 26;
    var step = niceStep(max - min, 4);
    var y0 = Math.floor(min / step) * step;
    var y1 = Math.ceil(max / step) * step;
    var plotW = w - padL - padR;
    var slot = plotW / days.length;
    var x = function (i) { return padL + slot * (i + 0.5); };
    var y = function (v) { return padT + (1 - (v - y0) / (y1 - y0 || 1)) * (h - padT - padB); };

    var svg = el('svg', { class: 'stats-svg', viewBox: '0 0 ' + w + ' ' + h, height: h, role: 'img', 'aria-label': chart.title });
    box.appendChild(svg);

    // Raster und Achsen (zurückhaltend)
    for (var v = y0; v <= y1 + step / 2; v += step) {
      el('line', { class: v === 0 ? 'baseline' : 'grid', x1: padL, x2: w - padR, y1: y(v), y2: y(v) }, svg);
      var t = el('text', { class: 'axis', x: padL - 6, y: y(v), dy: 4, 'text-anchor': 'end' }, svg);
      t.textContent = fmt(v, chart.unit, true);
    }
    var labelEvery = Math.ceil(days.length / (w < 520 ? 4 : 7));
    days.forEach(function (d, i) {
      if (i % labelEvery !== 0 && i !== days.length - 1) return;
      if (i !== days.length - 1 && days.length - 1 - i < labelEvery / 2) return;
      var t = el('text', { class: 'axis', x: x(i), y: h - 6, 'text-anchor': 'middle' }, svg);
      t.textContent = dayShort(d);
    });

    // Markierungen: Einstellungsänderungen und Patchnotes
    var markersByDay = {};
    (data.markers || []).forEach(function (m) {
      var i = days.indexOf(m.day);
      if (i < 0) return;
      (markersByDay[i] = markersByDay[i] || []).push(m);
    });
    Object.keys(markersByDay).forEach(function (i) {
      var kind = markersByDay[i].some(function (m) { return m.kind === 'einstellung'; }) ? 'einstellung' : 'patch';
      el('line', { class: 'marker marker-' + kind, x1: x(+i), x2: x(+i), y1: padT, y2: h - padB }, svg);
      el('circle', { class: 'marker-dot marker-' + kind, cx: x(+i), cy: padT + 3, r: 3.5 }, svg);
    });

    // Daten
    if (bars) {
      var groupW = Math.max(2, Math.min(28, slot - 2));
      var barW = stacked ? groupW : Math.max(1.5, (groupW - (series.length - 1) * 2) / series.length);
      days.forEach(function (d, i) {
        var pos = 0, neg = 0;
        series.forEach(function (s, si) {
          var val = s.values[i] || 0;
          if (!val) return;
          var from, to, bx;
          if (stacked) {
            from = val > 0 ? pos : neg;
            to = from + val;
            if (val > 0) pos = to; else neg = to;
            bx = x(i) - groupW / 2;
          } else {
            from = 0; to = val;
            bx = x(i) - groupW / 2 + si * (barW + 2);
          }
          var top = Math.min(y(from), y(to));
          var height = Math.max(1, Math.abs(y(to) - y(from)) - (stacked ? 1 : 0));
          el('rect', { class: 'bar s' + ((chart.series.indexOf(s) % 8) + 1), x: bx.toFixed(1), y: top.toFixed(1), width: barW.toFixed(1), height: height.toFixed(1), rx: Math.min(2, barW / 3) }, svg);
        });
      });
    } else {
      series.forEach(function (s) {
        var cls = 's' + ((chart.series.indexOf(s) % 8) + 1);
        var path = '';
        var pen = false;
        s.values.forEach(function (val, i) {
          if (val === null) { pen = false; return; }
          path += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(val).toFixed(1);
          pen = true;
        });
        el('path', { class: 'line ' + cls, d: path }, svg);
        // Einzelne Punkte (z. B. nur ein Tag mit Snapshot) wären als Linie unsichtbar
        var points = s.values.filter(function (v) { return v !== null; }).length;
        if (points <= 2) s.values.forEach(function (val, i) { if (val !== null) el('circle', { class: 'dot ' + cls, cx: x(i), cy: y(val), r: 4 }, svg); });
      });
    }

    // Hover: Fadenkreuz und Tooltip mit allen Werten des Tages
    var cursor = el('line', { class: 'cursor', y1: padT, y2: h - padB, visibility: 'hidden' }, svg);
    var tip = document.createElement('div');
    tip.className = 'stats-tip';
    tip.hidden = true;
    box.appendChild(tip);
    function show(evt) {
      var rect = svg.getBoundingClientRect();
      var px = ((evt.clientX - rect.left) / rect.width) * w;
      var i = Math.max(0, Math.min(days.length - 1, Math.floor((px - padL) / slot)));
      cursor.setAttribute('x1', x(i));
      cursor.setAttribute('x2', x(i));
      cursor.setAttribute('visibility', 'visible');
      var html = '<strong>' + dayLong(days[i]) + '</strong>';
      series.forEach(function (s) {
        html += '<span><i class="key s' + ((chart.series.indexOf(s) % 8) + 1) + '"></i>' + esc(s.name) + ': ' + fmt(s.values[i], chart.unit) + '</span>';
      });
      if (stacked) {
        var sum = series.reduce(function (a, s) { return a + (s.values[i] || 0); }, 0);
        html += '<span class="tip-sum">Summe: ' + fmt(sum, chart.unit) + '</span>';
      }
      (markersByDay[i] || []).forEach(function (m) { html += '<span class="tip-marker">◆ ' + esc(m.label) + '</span>'; });
      tip.innerHTML = html;
      tip.hidden = false;
      var left = (x(i) / w) * rect.width;
      var tw = tip.offsetWidth;
      tip.style.left = Math.max(0, Math.min(rect.width - tw, left - tw / 2)) + 'px';
    }
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', function () { cursor.setAttribute('visibility', 'hidden'); tip.hidden = true; });

    // Legende ab zwei Reihen (Farbe nie allein: Name steht daneben)
    if (series.length > 1) {
      var legend = document.createElement('ul');
      legend.className = 'stats-legend';
      legend.innerHTML = series.map(function (s) {
        return '<li><i class="key s' + ((chart.series.indexOf(s) % 8) + 1) + '"></i>' + esc(s.name) + '</li>';
      }).join('');
      box.appendChild(legend);
    }

    // Tabellenansicht
    var details = document.createElement('details');
    details.className = 'stats-table-toggle';
    var rows = days.map(function (d, i) {
      if (!series.some(function (s) { return s.values[i] !== null && s.values[i] !== 0; })) return '';
      return '<tr><td>' + dayLong(d) + '</td>' + series.map(function (s) { return '<td class="num">' + fmt(s.values[i], chart.unit) + '</td>'; }).join('') + '</tr>';
    }).reverse().join('');
    details.innerHTML = '<summary class="small">Als Tabelle</summary><div class="table-wrap"><table class="table"><thead><tr><th>Tag</th>' +
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

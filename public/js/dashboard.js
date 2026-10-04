// Dashboard: Countdowns im Sekundentakt und Broker-Kurse alle 5 Sekunden (ohne Neuladen der Seite)
(function () {
  var cds = document.querySelectorAll('[data-dash-cd]');
  var pad = function (n) { return String(n).padStart(2, '0'); };
  function tick() {
    cds.forEach(function (el) {
      var s = Math.floor((Number(el.getAttribute('data-dash-cd')) - Date.now()) / 1000);
      if (s <= 0) { el.textContent = 'jetzt'; el.classList.add('is-now'); return; }
      var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
      el.textContent = (d ? d + ' T ' : '') + pad(h) + ':' + pad(m) + ':' + pad(s % 60);
      el.classList.toggle('is-soon', s < 3600);
    });
  }
  if (cds.length) { tick(); setInterval(tick, 1000); }

  var ticks = document.querySelectorAll('[data-dash-tick]');
  if (!ticks.length) return;
  function price(p) {
    var digits = p >= 1 ? 2 : p >= 0.01 ? 4 : 6;
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(p);
  }
  function pct(x) { return (x > 0 ? '+' : '') + (x * 100).toFixed(2).replace('.', ',') + ' %'; }
  function poll() {
    if (document.hidden) return;
    fetch('/broker/api/uebersicht', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (list) {
        if (!Array.isArray(list)) return;
        list.forEach(function (s) {
          var row = document.querySelector('[data-dash-tick="' + s.symbol + '"]');
          if (!row) return;
          var p = row.querySelector('[data-dash-price]');
          var c = row.querySelector('[data-dash-change]');
          var txt = price(s.price);
          if (p && p.textContent !== txt) {
            p.textContent = txt;
            row.classList.remove('is-flash');
            void row.offsetWidth; // Animation neu starten
            row.classList.add('is-flash');
          }
          if (c) { c.textContent = pct(s.change24h); c.className = s.change24h >= 0 ? 'pos' : 'neg'; }
        });
      })
      .catch(function () {});
  }
  setInterval(poll, 5000);
})();

// Favoriten: Karten so groß, dass ihr Boden mit dem der „Heute“-Liste abschließt (nur in der breiten Ansicht).
// Die Spalte wird dafür breiter, „Heute“ behält mindestens 300 px. Ohne JS bleibt das normale Raster.
(function () {
  var row = document.querySelector('[data-dash-favrow]');
  if (!row) return;
  var grid = row.querySelector('.dx-fav-grid');
  var tasks = row.querySelector('.dx-tasks');
  if (!grid || !tasks) return;
  var narrow = window.matchMedia('(max-width: 900px)');
  function fit() {
    row.classList.remove('is-fit');
    var n = grid.children.length;
    if (narrow.matches || !n) return;
    var gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    var colGap = parseFloat(getComputedStyle(row).columnGap) || 0;
    var maxW = (row.clientWidth - colGap - 300 - (n - 1) * gap) / n;
    row.style.setProperty('--fav-n', n);
    // „Heute“ wird schmaler und damit evtl. höher – darum ein paar Runden, bis es passt
    for (var k = 0; k < 4; k++) {
      var h = tasks.getBoundingClientRect().bottom - grid.getBoundingClientRect().top;
      var w = Math.max(0, Math.min((h * 720) / 1008, maxW));
      row.style.setProperty('--fav-w', Math.floor(w) + 'px');
      row.classList.add('is-fit');
    }
  }
  var timer;
  window.addEventListener('resize', function () { clearTimeout(timer); timer = setTimeout(fit, 100); });
  window.addEventListener('load', fit);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  fit();
})();

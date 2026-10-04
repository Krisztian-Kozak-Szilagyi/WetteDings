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

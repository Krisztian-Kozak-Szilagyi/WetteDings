// Broker-Übersicht: Filter (Alle / Mein Depot / Coins / ETFs) und Live-Kurse
(function () {
  'use strict';

  var table = document.querySelector('[data-bx-table]');
  if (!table) return;
  var rows = Array.prototype.slice.call(table.querySelectorAll('[data-bx-row]'));
  var empty = table.querySelector('[data-bx-empty]');

  // ---------- Filter ----------
  var chips = document.querySelectorAll('[data-bx-filter]');
  function applyFilter(name) {
    var shown = 0;
    rows.forEach(function (row) {
      var ok = name === 'alle' || (name === 'depot' ? row.getAttribute('data-owned') === '1' : row.getAttribute('data-kind') === name);
      row.hidden = !ok;
      if (ok) shown++;
    });
    if (empty) empty.hidden = shown > 0;
    chips.forEach(function (c) {
      var on = c.getAttribute('data-bx-filter') === name;
      c.classList.toggle('active', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    try { sessionStorage.setItem('bx-filter', name); } catch (e) { /* egal */ }
  }
  chips.forEach(function (c) {
    c.addEventListener('click', function () { applyFilter(c.getAttribute('data-bx-filter')); });
  });
  try {
    var saved = sessionStorage.getItem('bx-filter');
    if (saved && document.querySelector('[data-bx-filter="' + saved.replace(/[^a-z]/g, '') + '"]')) applyFilter(saved);
  } catch (e) { /* egal */ }

  // ---------- Sortieren (Klick auf eine Spalte; erneuter Klick dreht die Richtung) ----------
  var sortKey = null;
  var sortDir = 1;
  var sortBtns = document.querySelectorAll('[data-bx-sort]');
  function sortRows() {
    if (!sortKey) return;
    var attr = 'data-sort-' + sortKey;
    var sorted = rows.slice().sort(function (a, b) {
      var x = a.getAttribute(attr);
      var y = b.getAttribute(attr);
      var cmp = sortKey === 'name' ? x.localeCompare(y, 'de') : Number(x) - Number(y);
      return cmp * sortDir;
    });
    sorted.forEach(function (row) { table.insertBefore(row, empty); });
  }
  sortBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.getAttribute('data-bx-sort');
      if (sortKey === key) sortDir = -sortDir;
      else {
        sortKey = key;
        sortDir = key === 'name' ? 1 : -1; // Zahlen: zuerst die größten
      }
      sortBtns.forEach(function (b) {
        var on = b === btn;
        b.classList.toggle('sort-asc', on && sortDir === 1);
        b.classList.toggle('sort-desc', on && sortDir === -1);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      sortRows();
    });
  });

  // ---------- Live-Kurse ----------
  function fmtPrice(p) {
    var digits = p >= 1 ? 2 : p >= 0.01 ? 4 : 6;
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(p);
  }
  function fmtPct(x) { return (x > 0 ? '+' : '') + (x * 100).toFixed(2).replace('.', ',') + ' %'; }

  var last = {};
  function poll() {
    if (document.hidden) return;
    fetch('/broker/api/uebersicht', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (list) {
        list.forEach(function (s) {
          var row = rows.find(function (r) { return r.getAttribute('data-symbol') === s.symbol; });
          if (!row) return;
          var priceEl = row.querySelector('[data-bx-price]');
          if (priceEl) {
            if (last[s.symbol] !== undefined && last[s.symbol] !== s.price) {
              priceEl.classList.remove('tick-up', 'tick-down');
              void priceEl.offsetWidth;
              priceEl.classList.add(s.price > last[s.symbol] ? 'tick-up' : 'tick-down');
            }
            priceEl.textContent = fmtPrice(s.price);
          }
          last[s.symbol] = s.price;
          row.setAttribute('data-sort-price', String(s.price));
          row.setAttribute('data-sort-change', String(s.change24h));
          var ch = row.querySelector('[data-bx-change]');
          if (ch) {
            var up = s.change24h >= 0;
            var abs = Math.abs(s.price - s.price / (1 + s.change24h));
            ch.className = 'num bx-change ' + (up ? 'pos' : 'neg');
            ch.querySelector('strong').textContent = (up ? '+' : '−') + fmtPrice(abs);
            ch.querySelector('small').textContent = (up ? '▲ ' : '▼ ') + fmtPct(s.change24h);
          }
        });
      })
      .then(function () { if (sortKey === 'price' || sortKey === 'change') sortRows(); })
      .catch(function () { /* nächster Versuch */ });
  }
  setInterval(poll, 5000);
})();

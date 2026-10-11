// Inventar (views/inventar.ejs): Reiter Inventar | Shop, Kategorie-Filter der Slots und Kaufen mit Anzahl (− / +).
(function () {
  'use strict';
  var fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

  // Reiter: #shop in der Adresse öffnet den Shop (nach dem Kaufen), sonst das Inventar
  var tabs = document.querySelectorAll('[data-bag-tab]');
  function show(key) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-bag-tab') === key;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('[data-bag-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-bag-panel') !== key; });
    try { history.replaceState(null, '', key === 'shop' ? '#shop' : location.pathname); } catch (err) { /* egal */ }
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { show(t.getAttribute('data-bag-tab')); }); });
  document.addEventListener('click', function (e) {
    var go = e.target.closest('[data-bag-goto]');
    if (go) show(go.getAttribute('data-bag-goto'));
  });
  if (location.hash === '#shop') show('shop');
  // Pack öffnen: den Dialog vorher schließen, sonst liegt er über der Öffnungs-Animation
  document.addEventListener('submit', function (e) {
    if (!e.target.matches('[data-tcg-open]')) return;
    var dlg = e.target.closest('dialog');
    if (dlg) dlg.close();
  }, true);

  // Kategorie-Filter: blendet die Slots anderer Kategorien aus
  var bar = document.querySelector('[data-shop-filters]');
  if (bar) {
    var chips = bar.querySelectorAll('[data-shop-filter]');
    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        var key = chip.getAttribute('data-shop-filter');
        chips.forEach(function (c) {
          c.classList.toggle('active', c === chip);
          c.setAttribute('aria-pressed', c === chip ? 'true' : 'false');
        });
        document.querySelectorAll('[data-shop-cat]').forEach(function (card) {
          card.hidden = key !== 'all' && card.getAttribute('data-shop-cat') !== key;
        });
      });
    });
  }

  // Kaufen: Anzahl wählen, Summe anzeigen, Rückfrage nennt die Summe, ohne genug Guthaben ist der Knopf gesperrt
  document.querySelectorAll('[data-shop-buy]').forEach(function (form) {
    var input = form.querySelector('input[name="count"]');
    var total = form.querySelector('[data-shop-total]');
    var submit = form.querySelector('[data-shop-submit]');
    var price = +form.getAttribute('data-price') || 0;
    var balance = +form.getAttribute('data-balance') || 0;
    var label = form.getAttribute('data-label') || 'Stück';
    var max = +input.max || 100;
    function count() { return Math.max(1, Math.min(max, parseInt(input.value, 10) || 1)); }
    function sync() {
      var n = count();
      var cost = price * n;
      total.textContent = fmt.format(cost / 100);
      form.setAttribute('data-confirm', n + '× ' + label + ' für ' + fmt.format(cost / 100) + ' kaufen?');
      submit.disabled = cost > balance;
      submit.title = cost > balance ? 'Dein Guthaben reicht dafür nicht' : '';
    }
    form.querySelectorAll('[data-shop-step]').forEach(function (b) {
      b.addEventListener('click', function () {
        input.value = Math.max(1, Math.min(max, count() + (+b.getAttribute('data-shop-step'))));
        sync();
      });
    });
    input.addEventListener('input', sync);
    input.addEventListener('blur', function () { input.value = count(); sync(); });
    sync();
  });
})();

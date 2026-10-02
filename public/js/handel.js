(function () {
  'use strict';

  // Handelsseite: Karte in der Sammlung antippen -> Dialog mit Markt / Privat / Tauschen
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var modal = $('[data-trade-modal]');
  if (!modal) return;

  var tabs = $all('[data-trade-tab]', modal);
  var panes = $all('[data-trade-pane]', modal);

  function showTab(key) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-trade-tab') === key;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    panes.forEach(function (p) { p.hidden = p.getAttribute('data-trade-pane') !== key; });
    var first = $('[data-trade-pane="' + key + '"] input:not([type="hidden"])', modal);
    if (first) first.focus();
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { showTab(t.getAttribute('data-trade-tab')); });
  });

  document.addEventListener('click', function (e) {
    var slot = e.target.closest('[data-trade-card]');
    if (!slot) return;
    var d = slot.dataset;
    var img = $('[data-trade-img]', modal);
    img.src = d.image;
    img.alt = d.name + ' (' + d.rarityLabel + ')';
    img.className = 'r-' + d.rarity;
    $('[data-trade-name]', modal).textContent = d.name;
    var badge = $('[data-trade-rarity]', modal);
    badge.textContent = d.rarityLabel;
    badge.className = 'tcg-badge r-' + d.rarity;
    $('[data-trade-meta]', modal).textContent = d.free + ' frei · Kartenwert ' + d.sellText;
    // Karte in alle drei Formulare eintragen (Tausch nutzt "karte", weil es per GET zur Auswahlseite geht)
    $all('input[name="card"], input[name="karte"]', modal).forEach(function (input) { input.value = d.tradeCard; });

    if (typeof modal.showModal === 'function') modal.showModal();
    else modal.setAttribute('open', '');
    showTab('markt');
  });

  function closeModal() {
    if (typeof modal.close === 'function') modal.close();
    else modal.removeAttribute('open');
  }
  $('[data-trade-close]', modal).addEventListener('click', closeModal);
  // Klick auf den Hintergrund schließt
  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeModal();
  });
})();

(function () {
  'use strict';

  // Handelsseite: Miniaturen in Angeboten vergrößern; Karte in der Sammlung antippen -> Dialog mit Markt / Privat / Tauschen
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // ---------- Miniaturen in den Angeboten vergrößern ----------
  var zoom = $('[data-zoom-modal]');
  if (zoom) {
    var zoomTilt = $('[data-zoom-tilt]', zoom);
    if (window.tcgBindTilt) window.tcgBindTilt(zoomTilt);
    var closeZoom = function () {
      if (typeof zoom.close === 'function') zoom.close();
      else zoom.removeAttribute('open');
    };
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-zoom-card]');
      if (!btn) return;
      var d = btn.dataset;
      var owned = parseInt(d.owned, 10) || 0;
      zoomTilt.className = 'tcg-zoom r-' + d.rarity; // Seltenheits-Effekte wie im Album
      var img = $('[data-zoom-img]', zoom);
      img.src = d.image;
      img.alt = d.name + ' (' + d.rarityLabel + ')';
      $('[data-zoom-name]', zoom).textContent = d.name;
      var badge = $('[data-zoom-rarity]', zoom);
      badge.textContent = d.rarityLabel;
      badge.className = 'tcg-badge r-' + d.rarity;
      $('[data-zoom-meta]', zoom).textContent = 'Kartenwert ' + d.sellText + ' · ' + (owned ? 'du besitzt ' + owned + ' Stück' : 'fehlt dir noch');
      if (typeof zoom.showModal === 'function') zoom.showModal();
      else zoom.setAttribute('open', '');
    });
    $('[data-zoom-close]', zoom).addEventListener('click', closeZoom);
    zoom.addEventListener('click', function (e) {
      if (e.target === zoom) closeZoom();
    });
  }

  // ---------- Karte aus der Sammlung anbieten ----------
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

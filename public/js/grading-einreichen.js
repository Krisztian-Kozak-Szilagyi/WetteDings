// Karte graden lassen (#204): Bausteine je nach Karte freigeben und bei jedem Shop den Gesamtpreis der Auswahl zeigen
(function () {
  var form = document.querySelector('[data-gs-form]');
  if (!form) return;
  var fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  var euro = function (c) { return fmt.format(c / 100); };
  var box = function (k) { return form.querySelector('[data-gs-svc="' + k + '"]'); };
  var ironBox = box('iron');
  var ironLabel = form.querySelector('[data-gs-iron]');
  var none = form.querySelector('[data-gs-none]');
  var submit = form.querySelector('[data-gs-submit]');
  var summary = form.querySelector('[data-gs-summary]');

  function picked(name) {
    return form.querySelector('input[name="' + name + '"]:checked');
  }

  function update() {
    var card = picked('doc');
    var ironable = !!card && card.getAttribute('data-ironable') === '1';
    ironBox.disabled = !ironable;
    if (!ironable) ironBox.checked = false;
    ironLabel.classList.toggle('is-off', !ironable);
    var want = { iron: ironBox.checked, slab: box('slab').checked, express: box('express').checked };
    none.hidden = want.iron || want.slab;

    var shopTotal = null;
    form.querySelectorAll('[data-prices]').forEach(function (el) {
      var p = JSON.parse(el.getAttribute('data-prices'));
      var total = p.base + (want.iron ? p.iron : 0) + (want.slab ? p.slab : 0) + (want.express ? p.express : 0);
      el.querySelector('[data-gs-total]').textContent = euro(total);
      if (el.querySelector('input[name="shop"]').checked) shopTotal = total;
    });

    var shop = picked('shop');
    var ok = !!card && !!shop && (want.iron || want.slab);
    submit.disabled = !ok;
    summary.textContent = !card ? 'Wähle eine Karte.' : !(want.iron || want.slab) ? 'Wähle, was der Shop tun soll.' : '„' + card.getAttribute('data-name') + '“ bei ' + shop.value + ' für ' + euro(shopTotal) + '.';
    form.setAttribute('data-confirm', ok ? summary.textContent + ' Der Preis wird sofort abgebucht, die Karte ist bis zur Rückgabe gesperrt. Eine Folie geht dabei ab.' : '');
  }

  form.addEventListener('change', update);
  update();
})();

// Karte graden lassen (#204): Bausteine je nach Karte freigeben und bei jedem Shop den Gesamtpreis der Auswahl zeigen.
// Slab gewählt: nur Zweitprüfung (plus Express), der Shop, von dem der Slab stammt, fällt weg. Filter für lange Listen.
(function () {
  var form = document.querySelector('[data-gs-form]');
  if (!form) return;
  var fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  var euro = function (c) { return fmt.format(c / 100); };
  var box = function (k) { return form.querySelector('[data-gs-svc="' + k + '"]'); };
  var ironBox = box('iron');
  var ironLabel = form.querySelector('[data-gs-iron]');
  var reviewInput = form.querySelector('[data-gs-review-input]');
  var reviewLabel = form.querySelector('[data-gs-review]');
  var normal = form.querySelectorAll('[data-gs-normal]');
  var none = form.querySelector('[data-gs-none]');
  var submit = form.querySelector('[data-gs-submit]');
  var summary = form.querySelector('[data-gs-summary]');

  function picked(name) {
    return form.querySelector('input[name="' + name + '"]:checked');
  }

  function update() {
    var card = picked('doc');
    var slabCode = card ? card.getAttribute('data-slab') : '';
    var review = !!slabCode;
    // Slab: nur Zweitprüfung; sonst die normalen Bausteine
    reviewLabel.hidden = !review;
    reviewInput.value = review ? '1' : '';
    normal.forEach(function (n) { n.hidden = review; });
    var ironable = !!card && card.getAttribute('data-ironable') === '1';
    ironBox.disabled = !ironable;
    if (!ironable) ironBox.checked = false;
    ironLabel.classList.toggle('is-off', !ironable);
    var want = { iron: !review && ironBox.checked, slab: !review && box('slab').checked, express: box('express').checked };
    none.hidden = review || want.iron || want.slab;

    // Shops: der Aussteller des Slabs kann ihn nicht selbst nachprüfen
    var shopTotal = null;
    var firstFree = null;
    form.querySelectorAll('[data-prices]').forEach(function (el) {
      var radio = el.querySelector('input[name="shop"]');
      var blocked = review && el.getAttribute('data-code') === slabCode;
      radio.disabled = blocked;
      el.classList.toggle('is-off', blocked);
      if (blocked && radio.checked) radio.checked = false;
      if (!blocked && !firstFree) firstFree = radio;
      var p = JSON.parse(el.getAttribute('data-prices'));
      var total = review ? p.review : p.base + (want.iron ? p.iron : 0) + (want.slab ? p.slab : 0);
      if (want.express) total += p.express;
      el.querySelector('[data-gs-total]').textContent = euro(total);
      if (radio.checked) shopTotal = total;
    });
    if (!picked('shop') && firstFree) {
      firstFree.checked = true;
      return update();
    }

    var shop = picked('shop');
    var ok = !!card && !!shop && (review || want.iron || want.slab);
    submit.disabled = !ok;
    summary.textContent = !card
      ? 'Wähle eine Karte.'
      : !shop
        ? 'Kein anderer Shop frei.'
        : !(review || want.iron || want.slab)
          ? 'Wähle, was der Shop tun soll.'
          : (review ? 'Zweitprüfung für „' : '„') + card.getAttribute('data-name') + '“ bei ' + shop.value + ' für ' + euro(shopTotal) + '.';
    form.setAttribute('data-confirm', ok ? summary.textContent + ' Der Preis wird sofort abgebucht, die Karte ist bis zur Rückgabe gesperrt.' + (review ? '' : ' Eine Folie geht dabei ab.') : '');
  }

  // Filter: alle, mit Spuren, mit Knick, Slabs
  var filters = form.querySelectorAll('[data-gs-filter]');
  filters.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var k = btn.getAttribute('data-gs-filter');
      filters.forEach(function (b) {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      form.querySelectorAll('.gs-card[data-kind]').forEach(function (c) {
        c.hidden = k !== 'alle' && (' ' + c.getAttribute('data-kind') + ' ').indexOf(' ' + k + ' ') < 0;
      });
    });
  });

  form.addEventListener('change', update);
  update();
})();

// Bewerten (#204): nach den Sternen erscheinen passende Schnell-Tags – 4–5 Sterne Lob, 1–3 Kritik, höchstens data-max
(function () {
  document.querySelectorAll('.gs-rate').forEach(function (form) {
    var box = form.querySelector('[data-gs-tags]');
    if (!box) return;
    var max = +box.getAttribute('data-max') || 3;
    function sync() {
      var star = form.querySelector('input[name="stars"]:checked');
      box.hidden = !star;
      if (!star) return;
      var good = +star.value >= 4;
      box.querySelectorAll('.gs-tag').forEach(function (l) {
        var fits = l.classList.contains('is-good') === good;
        l.hidden = !fits;
        if (!fits) l.querySelector('input').checked = false;
      });
      var n = box.querySelectorAll('input:checked').length;
      box.querySelectorAll('input').forEach(function (i) { i.disabled = !i.checked && n >= max; });
    }
    form.addEventListener('change', sync);
    sync();
  });
})();

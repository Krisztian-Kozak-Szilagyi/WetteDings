(function () {
  'use strict';

  // Folierte Karte umdrehen: Rückseite mit dem Foliendatum
  Array.prototype.forEach.call(document.querySelectorAll('[data-foil-flip]'), function (btn) {
    btn.addEventListener('click', function () {
      btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    });
  });

  // Gerade folierte Karte ins Bild holen
  var fresh = document.querySelector('.foil-item.is-new');
  if (fresh) fresh.scrollIntoView({ block: 'center' });
})();

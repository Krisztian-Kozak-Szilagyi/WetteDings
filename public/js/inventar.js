(function () {
  'use strict';

  // Folierte Karte groß ansehen: Klick auf die kleine Karte öffnet den Dialog, dort dreht ein Klick sie um
  var modal = document.querySelector('[data-foil-modal]');
  var stage = modal && modal.querySelector('[data-foil-stage]');
  if (modal && stage && modal.showModal) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-foil-zoom]'), function (small) {
      small.addEventListener('click', function () {
        var big = small.cloneNode(true);
        big.removeAttribute('data-foil-zoom');
        big.classList.add('foil-card-big');
        big.setAttribute('aria-pressed', 'false');
        big.setAttribute('aria-label', 'Karte umdrehen');
        big.addEventListener('click', function () {
          big.setAttribute('aria-pressed', big.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
        });
        // Rarität für Rahmenfarbe mitnehmen
        var item = small.closest('.foil-item');
        stage.className = 'foil-modal-stage ' + (item ? Array.prototype.filter.call(item.classList, function (c) { return c.indexOf('r-') === 0; }).join(' ') : '');
        stage.innerHTML = '';
        stage.appendChild(big);
        modal.showModal();
        big.focus();
      });
    });
    modal.querySelector('[data-foil-close]').addEventListener('click', function () { modal.close(); });
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.close(); });
  }

  // Gerade folierte Karte ins Bild holen
  var fresh = document.querySelector('.foil-item.is-new');
  if (fresh) fresh.scrollIntoView({ block: 'center' });
})();

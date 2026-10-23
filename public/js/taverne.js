// Seiten im Taverne-Stil (Fenster über der Taverne, partials/head.ejs): Wiederholt die erste Überschrift der Seite nur den
// Fensterkopf (Titel oder aktiver Reiter, z. B. „Handel“, „Forum“), wird sie ausgeblendet – für Screenreader bleibt sie.
(function () {
  'use strict';
  var win = document.querySelector('.tv-window[data-tv-names]');
  if (!win) return;
  var norm = function (s) { return String(s || '').replace(/[^a-z0-9äöüß]+/gi, '').toLowerCase(); };
  var names = win.getAttribute('data-tv-names').split('|').map(norm);
  var h1 = win.querySelector('main h1');
  if (h1 && names.indexOf(norm(h1.textContent)) >= 0) h1.classList.add('tv-dup-title');
})();

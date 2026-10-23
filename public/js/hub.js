// Taverne (Startseite, views/hub.ejs): Countdowns im Sekundentakt und die Fenster (PVE, Gambling, mobil: Handel,
// Vermögen, Heute). Bell und Profil-Menü steuert app.js wie überall.
(function () {
  'use strict';
  var hub = document.querySelector('[data-hub]');
  if (!hub) return;

  // ---------- Countdowns: Zielzeit vom Server (data-hub-at), Tage nur bei mehr als einem Tag ----------
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var timers = Array.prototype.slice.call(hub.querySelectorAll('[data-hub-at]')).map(function (el) {
    return { el: el, at: Date.parse(el.getAttribute('data-hub-at')) };
  });
  function tick() {
    var now = Date.now();
    timers.forEach(function (t) {
      var s = Math.max(0, Math.floor((t.at - now) / 1000));
      var d = Math.floor(s / 86400);
      var text = (d ? pad(d) + 'T ' : '') + pad(Math.floor((s % 86400) / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
      if (t.el.textContent !== text) t.el.textContent = text;
    });
  }
  if (timers.length) {
    tick();
    setInterval(tick, 1000);
  }

  // ---------- Fenster ----------
  var opener = null;
  function open(id) {
    var dlg = document.getElementById('hub-' + id);
    if (!dlg || typeof dlg.showModal !== 'function') return;
    opener = document.activeElement;
    dlg.showModal();
  }
  hub.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-hub-open]');
    if (btn) {
      e.preventDefault();
      open(btn.getAttribute('data-hub-open'));
      return;
    }
    if (e.target.closest('[data-hub-close]')) e.target.closest('dialog').close();
  });
  Array.prototype.forEach.call(hub.querySelectorAll('dialog.hub-dlg'), function (dlg) {
    // Klick auf den abgedunkelten Rand (außerhalb des Fensters) schließt
    dlg.addEventListener('click', function (e) {
      if (e.target !== dlg) return;
      var r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    });
    dlg.addEventListener('close', function () {
      if (opener && typeof opener.focus === 'function') opener.focus();
      opener = null;
    });
  });

})();

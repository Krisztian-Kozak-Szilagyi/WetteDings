// Taverne (Startseite, views/hub.ejs): Countdowns im Sekundentakt, Fenster (Weltkarte, Gambling, mobil: Handel,
// Vermögen, Heute) und die Auswahl der Orte auf der Weltkarte. Bell und Profil-Menü steuert app.js wie überall.
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
  function open(id, place) {
    var dlg = document.getElementById('hub-' + id);
    if (!dlg || typeof dlg.showModal !== 'function') return;
    if (place) pick(dlg, place);
    opener = document.activeElement;
    dlg.showModal();
  }
  hub.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-hub-open]');
    if (btn) {
      e.preventDefault();
      open(btn.getAttribute('data-hub-open'), btn.getAttribute('data-hub-place'));
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

  // ---------- Weltkarte: Ort wählen, Beschreibung und „Betreten“ wechseln ----------
  function pick(dlg, key) {
    var found = false;
    Array.prototype.forEach.call(dlg.querySelectorAll('[data-hub-pin]'), function (pin) {
      var on = pin.getAttribute('data-hub-pin') === key;
      if (on) found = true;
      pin.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (!found) return;
    Array.prototype.forEach.call(dlg.querySelectorAll('[data-hub-place-info]'), function (info) {
      info.hidden = info.getAttribute('data-hub-place-info') !== key;
    });
  }
  hub.addEventListener('click', function (e) {
    var pin = e.target.closest('[data-hub-pin]');
    if (pin) pick(pin.closest('dialog'), pin.getAttribute('data-hub-pin'));
  });
})();

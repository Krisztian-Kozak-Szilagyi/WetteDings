// Grading-Schreibtisch (#204): Objekte auf dem Tisch öffnen Fenster (<dialog data-gd-sheet>) – als Blatt von unten,
// auf breiten Bildschirmen seitlich. ?reiter=<key> öffnet beim Laden (Rückweg nach Formularen); die Zurück-Taste
// schließt das Fenster wieder. Hinweise (Flash) nach einem Formular wandern ins geöffnete Fenster.
(function () {
  'use strict';
  var desk = document.querySelector('[data-gd-desk]');
  if (!desk) return;
  var sheets = {};
  document.querySelectorAll('[data-gd-sheet]').forEach(function (d) { sheets[d.getAttribute('data-gd-sheet')] = d; });
  var base = location.pathname;
  var pushed = false; // Fenster per Klick geöffnet → Schließen geht in der History zurück

  function current() {
    for (var k in sheets) if (sheets[k].open) return k;
    return null;
  }

  function open(key, push) {
    var d = sheets[key];
    if (!d) return false;
    var cur = current();
    if (cur === key) return true;
    if (cur) sheets[cur].close();
    d.showModal();
    if (push) {
      history.pushState({ gd: key }, '', base + '?reiter=' + key);
      pushed = true;
    } else {
      history.replaceState({ gd: key }, '', base + '?reiter=' + key);
    }
    d.dispatchEvent(new CustomEvent('gd:open'));
    return true;
  }

  Object.keys(sheets).forEach(function (key) {
    var d = sheets[key];
    // close kommt verzögert: nur reagieren, wenn die Adresse noch dieses Fenster zeigt (nicht nach Zurück/Wechsel)
    d.addEventListener('close', function () {
      if (!history.state || history.state.gd !== key) return;
      if (pushed) {
        pushed = false;
        history.back();
      } else {
        history.replaceState(null, '', base);
      }
    });
    // Tippen neben das Fenster schließt
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
    d.querySelectorAll('[data-gd-close]').forEach(function (b) { b.addEventListener('click', function () { d.close(); }); });
    // Am Griff nach unten wischen schließt (Handy)
    var head = d.querySelector('.gd-sheet-head');
    if (head) {
      var startY = null;
      head.addEventListener('pointerdown', function (e) {
        if (e.target.closest('button')) return;
        startY = e.clientY;
        head.setPointerCapture(e.pointerId);
      });
      head.addEventListener('pointermove', function (e) {
        if (startY === null) return;
        var dy = Math.max(0, e.clientY - startY);
        d.style.transform = dy ? 'translateY(' + dy + 'px)' : '';
      });
      var end = function (e) {
        if (startY === null) return;
        var dy = e.clientY - startY;
        startY = null;
        d.style.transform = '';
        if (dy > 80) d.close();
      };
      head.addEventListener('pointerup', end);
      head.addEventListener('pointercancel', end);
    }
  });

  window.addEventListener('popstate', function (e) {
    var key = e.state && e.state.gd;
    var cur = current();
    if (cur && cur !== key) sheets[cur].close();
    if (key && sheets[key] && !sheets[key].open) sheets[key].showModal();
    pushed = !!key;
  });

  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-gd-open]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (open(a.getAttribute('data-gd-open'), true)) e.preventDefault();
  });

  // Rückweg nach einem Formular: Fenster öffnen und den Hinweis hineinholen
  var start = desk.getAttribute('data-gd-start');
  if (start && open(start, false)) {
    var flash = document.querySelector('[data-flash-area] .flash');
    var body = sheets[start].querySelector('.gd-sheet-body');
    if (flash && body) body.insertBefore(flash, body.firstChild);
  }

  // Vitrine einräumen: höchstens max Slabs ankreuzbar
  var drawer = document.querySelector('[data-gd-drawer]');
  if (drawer) {
    var max = +drawer.getAttribute('data-max');
    var sync = function () {
      var boxes = drawer.querySelectorAll('input[name="doc"]');
      var n = drawer.querySelectorAll('input[name="doc"]:checked').length;
      boxes.forEach(function (b) {
        if (b.closest('.is-locked')) return;
        b.disabled = !b.checked && n >= max;
      });
      var head = drawer.closest('dialog').querySelector('h2 .gr-dim');
      if (head) head.textContent = n + ' / ' + max;
    };
    drawer.addEventListener('change', sync);
    sync();
  }
})();

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

  // Zurück von der Werkbank (?neu=1): der neue Bon fällt auf den Spieß, der Münzstapel hüpft
  if (/[?&]neu=1/.test(location.search)) {
    var bonsOnSpike = desk.querySelectorAll('.gd-spike-bon');
    var fresh = bonsOnSpike[bonsOnSpike.length - 1];
    if (fresh) fresh.classList.add('is-new');
    var coins = desk.querySelector('[data-gd-coins]');
    if (coins) setTimeout(function () { coins.classList.add('is-bump'); }, 350);
    if (!start) history.replaceState(null, '', base);
  }

  // Handy geöffnet: neue Bewertungen gelten als gesehen
  var reviewBadge = document.querySelector('[data-gd-new-reviews]');
  if (reviewBadge && sheets.bewertungen) {
    sheets.bewertungen.addEventListener('gd:open', function () {
      var token = document.querySelector('input[name="_csrf"]');
      if (!token || !reviewBadge.isConnected) return;
      fetch('/grading/gesehen', { method: 'POST', body: new URLSearchParams({ _csrf: token.value }), credentials: 'same-origin' }).then(function (res) {
        if (res.ok) reviewBadge.remove();
      }).catch(function () {});
    });
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

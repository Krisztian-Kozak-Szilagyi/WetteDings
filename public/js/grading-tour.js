// Tour über den Grading-Schreibtisch (#204): dunkelt den Tisch ab, ein Spotlight wandert von Objekt zu Objekt
// (data-tour="<key>"), daneben eine Sprechblase mit 1–2 Sätzen. Startet beim ersten Besuch von selbst
// (data-gd-tour-auto), danach über den ?-Knopf am Namensschild. Der ?-Knopf in einem Fenster (data-tour-info)
// zeigt den Text seiner Station oben im Fenster. Texte: <script data-gd-tour> in views/grading.ejs.
(function () {
  'use strict';
  var desk = document.querySelector('[data-gd-desk]');
  var data = document.querySelector('[data-gd-tour]');
  if (!desk || !data) return;
  var steps;
  try { steps = JSON.parse(data.textContent); } catch (e) { return; }
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var root = null;
  var spot = null;
  var bubble = null;
  var list = [];
  var at = 0;
  var auto = false;

  function el(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  var targetOf = function (s) {
    var t = desk.querySelector('[data-tour="' + s.key + '"]');
    return t && t.getClientRects().length ? t : null;
  };

  function place() {
    if (!root) return;
    var t = targetOf(list[at]);
    if (!t) return;
    var r = t.getBoundingClientRect();
    var pad = 8;
    spot.style.left = r.left - pad + 'px';
    spot.style.top = r.top - pad + 'px';
    spot.style.width = r.width + pad * 2 + 'px';
    spot.style.height = r.height + pad * 2 + 'px';
    var vw = document.documentElement.clientWidth;
    var vh = window.innerHeight;
    var bw = bubble.offsetWidth;
    var bh = bubble.offsetHeight;
    var below = r.bottom + pad + 14 + bh <= vh;
    var above = r.top - pad - 14 - bh >= 0;
    var top = below || !above ? Math.min(r.bottom + pad + 14, vh - bh - 12) : r.top - pad - 14 - bh;
    var left = Math.max(12, Math.min(vw - bw - 12, r.left + r.width / 2 - bw / 2));
    bubble.style.top = Math.max(12, top) + 'px';
    bubble.style.left = left + 'px';
    bubble.classList.toggle('is-above', !(below || !above));
  }

  function show(i) {
    at = i;
    var s = list[at];
    bubble.innerHTML = '';
    el('p', 'gd-tour-count', bubble, at + 1 + ' / ' + list.length);
    el('h3', '', bubble, s.title);
    el('p', '', bubble, s.text);
    var row = el('div', 'gd-tour-actions', bubble);
    var skip = el('button', 'btn btn-ghost btn-sm', row, at === list.length - 1 ? '' : 'Überspringen');
    skip.type = 'button';
    skip.hidden = at === list.length - 1;
    skip.addEventListener('click', end);
    if (at > 0) {
      var back = el('button', 'btn btn-ghost btn-sm', row, '← Zurück');
      back.type = 'button';
      back.addEventListener('click', function () { show(at - 1); });
    }
    var next = el('button', 'btn btn-primary btn-sm', row, at === list.length - 1 ? 'Los geht’s!' : 'Weiter →');
    next.type = 'button';
    next.addEventListener('click', function () { if (at < list.length - 1) show(at + 1); else end(); });
    var t = targetOf(s);
    t.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    place();
    setTimeout(place, reduce ? 0 : 380);
    next.focus({ preventScroll: true });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); end(); }
    if (e.key === 'ArrowRight' && at < list.length - 1) show(at + 1);
    if (e.key === 'ArrowLeft' && at > 0) show(at - 1);
  }

  function start(isAuto) {
    if (root) return;
    list = steps.filter(targetOf);
    if (!list.length) return;
    auto = !!isAuto;
    root = el('div', 'gd-tour' + (reduce ? ' is-still' : ''), document.body);
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Tour durch deinen Shop');
    spot = el('div', 'gd-tour-spot', root);
    bubble = el('div', 'gd-tour-bubble', root);
    bubble.setAttribute('aria-live', 'polite');
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { passive: true });
    show(0);
  }

  function end() {
    if (!root) return;
    root.remove();
    root = null;
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place);
    var help = desk.querySelector('[data-tour-start]');
    if (help) help.focus({ preventScroll: true });
    // erste Tour gesehen: startet nicht mehr von selbst
    if (auto) {
      var token = document.querySelector('input[name="_csrf"]');
      if (token) fetch('/grading/tour', { method: 'POST', body: new URLSearchParams({ _csrf: token.value }), credentials: 'same-origin' }).catch(function () {});
      desk.removeAttribute('data-gd-tour-auto');
    }
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-tour-start]')) { start(false); return; }
    // ?-Knopf im Fenster: Text der Station oben im Fenster ein- und ausblenden
    var info = e.target.closest('[data-tour-info]');
    if (!info) return;
    var key = info.getAttribute('data-tour-info');
    var s = steps.filter(function (x) { return x.sheet === key; })[0];
    var body = info.closest('dialog').querySelector('.gd-sheet-body');
    if (!s || !body) return;
    var box = body.querySelector('.gd-info');
    if (box) { box.remove(); info.setAttribute('aria-expanded', 'false'); return; }
    box = el('p', 'gd-info');
    box.textContent = s.text;
    body.insertBefore(box, body.firstChild);
    info.setAttribute('aria-expanded', 'true');
  });

  // Erster Besuch: Tour von selbst – nicht, wenn gerade ein Fenster aufgeht (Rückweg nach einem Formular)
  if (desk.hasAttribute('data-gd-tour-auto') && !desk.hasAttribute('data-gd-start')) setTimeout(function () { start(true); }, 600);
})();

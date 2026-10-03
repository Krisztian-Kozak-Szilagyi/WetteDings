(function () {
  'use strict';

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  // ---------- Folierte Karte groß: in 3D drehen (ziehen), antippen dreht sie um ----------
  var modal = document.querySelector('[data-foil-modal]');
  var stage = modal && modal.querySelector('[data-foil-stage]');
  var view = null; // { el, inner, rx, ry, vx, vy, tween }
  var drag = null;

  function render() {
    view.inner.style.transform = 'rotateX(' + view.rx.toFixed(2) + 'deg) rotateY(' + view.ry.toFixed(2) + 'deg)';
    // Lichtpunkt der Folie wandert mit
    view.el.style.setProperty('--gx', (50 + (((view.ry % 360) + 540) % 360 - 180) * 0.8).toFixed(1) + '%');
    view.el.style.setProperty('--gy', (50 + view.rx * 1.2).toFixed(1) + '%');
  }

  function loop(now) {
    if (!view || !modal.open) return;
    var t = view.tween;
    if (t) {
      var k = clamp((now - t.start) / t.ms, 0, 1);
      var e = 1 - Math.pow(1 - k, 3);
      view.rx = t.fx + (t.tx - t.fx) * e;
      view.ry = t.fy + (t.ty - t.fy) * e;
      if (k >= 1) view.tween = null;
    } else if (!drag && (Math.abs(view.vx) > 0.01 || Math.abs(view.vy) > 0.01)) {
      view.ry += view.vy;
      view.rx = clamp(view.rx + view.vx, -60, 60);
      view.vx *= 0.9;
      view.vy *= 0.9;
    }
    render();
    requestAnimationFrame(loop);
  }

  function flip() {
    // zur nächsten Seite drehen, gerade ausrichten
    var target = (Math.round(view.ry / 180) + 1) * 180;
    view.tween = { fx: view.rx, fy: view.ry, tx: 0, ty: target, start: performance.now(), ms: reduceMotion ? 1 : 650 };
    view.vx = view.vy = 0;
  }

  function open(small, foiling) {
    var big = small.cloneNode(true);
    big.removeAttribute('data-foil-zoom');
    big.className = 'foil-card foil-card-big' + (foiling ? ' is-foiling' : '');
    big.setAttribute('aria-label', 'Karte umdrehen (ziehen zum Drehen)');
    var item = small.closest('.foil-item');
    stage.className = 'foil-modal-stage ' + (item ? Array.prototype.filter.call(item.classList, function (c) { return c.indexOf('r-') === 0; }).join(' ') : '');
    stage.innerHTML = '';
    stage.appendChild(big);
    view = { el: big, inner: big.querySelector('.foil-inner'), rx: foiling ? 0 : -8, ry: foiling ? 0 : 14, vx: 0, vy: 0, tween: null };
    modal.showModal();
    big.focus();
    requestAnimationFrame(loop);

    big.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, y: e.clientY, moved: 0, id: e.pointerId };
      view.tween = null;
      big.setPointerCapture(e.pointerId);
      e.preventDefault(); // keine Textauswahl beim Ziehen
    });
    big.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      view.vy = dx * 0.5;
      view.vx = -dy * 0.4;
      view.ry += view.vy;
      view.rx = clamp(view.rx + view.vx, -60, 60);
    });
    function end(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var tap = drag.moved < 6;
      drag = null;
      if (tap) flip();
    }
    big.addEventListener('pointerup', end);
    big.addEventListener('pointercancel', end);
    big.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
    });
  }

  if (modal && stage && modal.showModal) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-foil-zoom]'), function (small) {
      small.addEventListener('click', function () { open(small, false); });
    });
    modal.querySelector('[data-foil-close]').addEventListener('click', function () { modal.close(); });
    // Klick neben die Karte schließt
    modal.addEventListener('click', function (e) { if (e.target === modal || e.target === stage) modal.close(); });

    // Gerade folierte Karte: groß zeigen, wie die Folie aufgezogen wird
    var fresh = document.querySelector('.foil-item.is-new [data-foil-zoom]');
    if (fresh) {
      fresh.closest('.foil-item').scrollIntoView({ block: 'center' });
      open(fresh, !reduceMotion);
    }
  }
})();

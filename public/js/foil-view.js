(function () {
  'use strict';

  // Folierte Karte groß ansehen (Inventar, Album, Profil, Handel): Auslöser ist ein Element mit data-foil-view
  // (data-image, data-name, data-rarity, data-rarity-label, data-date; im Album zusätzlich data-fav/data-fav-on,
  // in fremden Sammlungen data-trade-href).
  // Ziehen dreht die Karte in 3D, antippen dreht sie um. Dialog: views/partials/foil-modal.ejs
  var modal = document.querySelector('[data-foil-modal]');
  if (!modal || !modal.showModal) return;
  var stage = modal.querySelector('[data-foil-stage]');
  var favForm = modal.querySelector('[data-foil-fav]');
  var tradeBox = modal.querySelector('[data-foil-trade]');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var view = null;
  var drag = null;

  function el(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  /** Große Karte: vorne Bild + Grading-Etikett (Name, Seltenheit, Note 10), hinten BfW-Rückseite + Zertifikat mit Foliendatum */
  function build(d, foiling) {
    var card = el('div', 'foil-card foil-card-big' + (foiling ? ' is-foiling' : '') + (d.season ? ' season-' + d.season : '')); // Rückseite je Season
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', d.name + ' – ziehen zum Drehen, antippen zum Umdrehen');
    var inner = el('span', 'foil-inner', card);
    var front = el('span', 'foil-face foil-front', inner);
    var img = el('img', '', front);
    img.src = d.image;
    img.alt = '';
    img.draggable = false;
    el('span', 'foil-sheen', front);
    // Etikett wie beim Grading-Slab: folierte Karten haben immer Note 10
    var t = el('span', 'foil-ticket', front);
    var info = el('span', 'gr-slab-info', t);
    el('strong', '', info, 'BfW GRADING');
    el('span', '', info, d.name + ' · ' + d.rarityLabel);
    el('span', 'gr-slab-word', info, 'GEM MINT');
    el('span', 'gr-slab-grade', t, '10');
    var back = el('span', 'foil-face foil-back', inner);
    el('span', 'foil-back-art', back);
    el('span', 'foil-sheen', back);
    // Rückseite: Zertifikat mit Foliendatum und Strichcode
    var tb = el('span', 'foil-ticket', back);
    var cert = el('span', 'gr-slab-cert', tb);
    el('strong', '', cert, 'BfW GRADING');
    el('span', '', cert, 'Foliert am ' + d.date);
    el('span', '', cert, 'Note 10 · GEM MINT');
    el('span', 'gr-slab-barcode', tb);
    return card;
  }

  function render() {
    view.inner.style.transform = 'rotateX(' + view.rx.toFixed(2) + 'deg) rotateY(' + view.ry.toFixed(2) + 'deg)';
    view.card.style.setProperty('--gx', (50 + ((((view.ry % 360) + 540) % 360) - 180) * 0.8).toFixed(1) + '%');
    view.card.style.setProperty('--gy', (50 + view.rx * 1.2).toFixed(1) + '%');
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
    view.tween = { fx: view.rx, fy: view.ry, tx: 0, ty: (Math.round(view.ry / 180) + 1) * 180, start: performance.now(), ms: reduceMotion ? 1 : 650 };
    view.vx = view.vy = 0;
  }

  function open(trigger, foiling) {
    var d = trigger.dataset;
    var card = build(d, foiling);
    stage.className = 'foil-modal-stage r-' + (d.rarity || '');
    stage.innerHTML = '';
    stage.appendChild(card);
    view = { card: card, inner: card.querySelector('.foil-inner'), rx: foiling ? 0 : -8, ry: foiling ? 0 : 14, vx: 0, vy: 0, tween: null };

    // Album: als Favorit zeigen / entfernen
    if (favForm) {
      favForm.hidden = !d.fav;
      if (d.fav) {
        favForm.querySelector('input[name="card"]').value = d.fav;
        favForm.querySelector('button').textContent = d.favOn === '1' ? '★ Favorit entfernen' : '☆ Als Favorit zeigen';
      }
    }
    // Fremde Sammlung: Tausch für dieses Exemplar vorschlagen
    if (tradeBox) {
      tradeBox.hidden = !d.tradeHref;
      if (d.tradeHref) tradeBox.querySelector('a').href = d.tradeHref;
    }

    card.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, y: e.clientY, moved: 0, id: e.pointerId };
      view.tween = null;
      card.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    card.addEventListener('pointermove', function (e) {
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
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
    });

    modal.showModal();
    card.focus();
    requestAnimationFrame(loop);
  }

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-foil-view]');
    if (!trigger || modal.contains(trigger)) return;
    e.preventDefault();
    e.stopPropagation();
    open(trigger, false);
  }, true);
  modal.querySelector('[data-foil-close]').addEventListener('click', function () { modal.close(); });
  modal.addEventListener('click', function (e) { if (e.target === modal || e.target === stage) modal.close(); });

  // Inventar: gerade folierte Karte groß zeigen, wie die Folie aufgezogen wird
  var fresh = document.querySelector('.foil-item.is-new [data-foil-view]');
  if (fresh) {
    fresh.closest('.foil-item').scrollIntoView({ block: 'center' });
    open(fresh, !reduceMotion);
  }
})();

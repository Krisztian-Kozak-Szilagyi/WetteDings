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
  // Album-Menü (views/partials/foil-modal.ejs mit favForm): Wert, Favorit, „Im Handel anbieten“ (die Bank kauft folierte Karten nicht).
  // Auf Dashboard und TCG-Seite (Favoriten) nur der Favorit – Wert und Handel gibt es nur im Album (data-album-foil).
  var menu = modal.querySelector('[data-foil-menu]');
  var sellLink = modal.querySelector('[data-foil-sell]');
  var statusEl = modal.querySelector('[data-foil-status]');
  var noteEl = modal.querySelector('[data-foil-note]');
  var tradeBox = modal.querySelector('[data-foil-trade]');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var view = null;
  var drag = null;
  var certLink = null; // Link zum Zertifikat eines Slabs (#204), beim ersten Öffnen angelegt
  // Galerie (#204, Vitrine): Auslöser mit data-foil-group blättern per Wischen, ‹ › und Pfeiltasten durch ihre Gruppe;
  // dazu Showroom-Licht und ein Messingschild (Name, Note, Population aus data-pop)
  var gallery = null; // { list, idx }
  var nav = null;
  var plaque = null;
  var swiped = false;

  function el(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  /**
   * Große Karte. Slab (data-slab-code, #204): vorne Bild + Etikett (Kürzel, Name, Seltenheit, Zertifikat, Note), hinten
   * Zertifikat und Strichcode. Sleeve (Folie ohne Slab): nur die Schutzhülle – keine Note, hinten die Kartenrückseite.
   */
  /** Kratzer und Knick eines unfolierten Exemplars (data-marks, #204) – dezent, man sieht sie beim genauen Hinschauen */
  function marks(front, json) {
    var m;
    try { m = JSON.parse(json || '{}'); } catch (err) { return; }
    var box = el('span', 'cm-marks', front);
    (m.s || []).forEach(function (s) {
      var e = el('span', 'cm-scratch', box);
      e.style.left = s[0] + '%';
      e.style.top = s[1] + '%';
      e.style.width = s[2] + '%';
      e.style.transform = 'rotate(' + s[3] + 'deg)';
    });
    if (m.c) {
      var c = el('span', 'cm-crease' + (m.i ? ' is-ironed' : ''), box);
      c.style.top = m.c.y + '%';
      c.style.transform = 'rotate(' + m.c.angle + 'deg)';
    }
  }

  function build(d, foiling) {
    var slab = !!d.slabCode;
    var bare = 'bare' in d; // unfoliertes Exemplar: keine Hülle, dafür sichtbare Spuren
    var card = el('div', 'foil-card foil-card-big' + (foiling ? ' is-foiling' : '') + (d.season ? ' season-' + d.season : '')); // Rückseite je Season
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', d.name + ' – ziehen zum Drehen, antippen zum Umdrehen');
    var inner = el('span', 'foil-inner ' + (bare ? 'is-bare' : slab ? 'is-slab' : 'is-sleeve'), card);
    // Versatz aus der Zentrierung (data-cx/-cy): der Rand um das Kartenbild ist ungleich breit
    if (d.cx) inner.style.setProperty('--cx', d.cx);
    if (d.cy) inner.style.setProperty('--cy', d.cy);
    var front = el('span', 'foil-face foil-front', inner);
    var img = el('img', '', front);
    img.src = d.image;
    img.alt = '';
    img.draggable = false;
    if (bare) marks(front, d.marks);
    el('span', 'foil-sheen', front);
    var back = el('span', 'foil-face foil-back', inner);
    el('span', 'foil-back-art', back);
    el('span', 'foil-sheen', back);
    if (!slab) return card; // Schutzhülle: die Note bleibt geheim
    // Etikett des Slabs: Kürzel des Shops, Karte, Zertifikatsnummer, Notenwort und Note
    var t = el('span', 'foil-ticket', front);
    var info = el('span', 'gr-slab-info', t);
    el('strong', '', info, d.slabCode);
    el('span', '', info, d.name + ' · ' + d.rarityLabel);
    if (d.cert || d.sealed) el('span', 'gr-slab-certno', info, [d.cert, d.sealed].filter(Boolean).join(' · ')); // Nr. und Versiegelungsdatum teilen sich die dritte Zeile
    var score = el('span', 'gr-slab-score', t);
    el('span', 'gr-slab-word', score, d.gradeWord || '');
    el('span', 'gr-slab-grade', score, d.grade || '–');
    // Rückseite: Zertifikat und Strichcode
    var tb = el('span', 'foil-ticket', back);
    var cert = el('span', 'gr-slab-cert', tb);
    el('strong', '', cert, d.slabCode + ' GRADING');
    if (d.cert) el('span', '', cert, 'Zertifikat Nr. ' + d.cert);
    el('span', '', cert, d.grade ? 'Note ' + d.grade + ' · ' + d.gradeWord : 'Note –');
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

  function step(dir) {
    if (!gallery || gallery.list.length < 2) return;
    var n = gallery.list.length;
    open(gallery.list[(gallery.idx + dir + n) % n], false);
  }

  /** Galerie, Showroom-Licht und Messingschild für den Auslöser einrichten */
  function setupGallery(trigger, d) {
    var group = d.foilGroup;
    gallery = null;
    if (group) {
      var list = Array.prototype.filter.call(document.querySelectorAll('[data-foil-group="' + group + '"]'), function (t) { return !modal.contains(t); });
      gallery = { list: list, idx: list.indexOf(trigger) };
    }
    modal.classList.toggle('is-showroom', !!group);
    if (!nav) {
      nav = el('div', 'foil-nav', modal);
      var prev = el('button', 'foil-nav-btn is-prev', nav, '‹');
      var next = el('button', 'foil-nav-btn is-next', nav, '›');
      prev.type = next.type = 'button';
      prev.setAttribute('aria-label', 'Vorheriger Slab');
      next.setAttribute('aria-label', 'Nächster Slab');
      prev.addEventListener('click', function () { step(-1); });
      next.addEventListener('click', function () { step(1); });
      plaque = el('div', 'foil-plaque');
      stage.insertAdjacentElement('afterend', plaque); // direkt unter der Karte, vor „Zertifikat ansehen“
    }
    nav.hidden = !gallery || gallery.list.length < 2;
    plaque.hidden = !group;
    if (group) fillPlaque(d);
  }

  /**
   * Messingschild im Showroom – aufgebaut wie das Etikett der Grading-Vitrine im Album (partials/grade-stats): Kopf mit
   * Kürzel, Karte und Note groß, dazu die Seltenheit in dieser Note (data-pop-stats aus tcg/population.gradeRarity):
   * Stufe, Notenspiegel der Karte mit dieser Note hervorgehoben und „x von y Exemplaren“.
   */
  function fillPlaque(d) {
    plaque.innerHTML = '';
    var grade = +d.grade || 0;
    plaque.className = 'foil-plaque' + (grade === 10 ? ' is-gem' : '');
    el('span', 'fp-head', plaque, (d.slabCode || 'BfW') + ' GRADING');
    var main = el('span', 'fp-main', plaque);
    var name = el('span', 'fp-name', main);
    el('strong', '', name, d.name);
    el('small', '', name, d.rarityLabel || '');
    var score = el('span', 'fp-score', main);
    el('span', 'fp-word', score, d.gradeWord || '');
    el('span', 'fp-grade', score, d.grade || '–');

    var st = null;
    try { st = d.popStats ? JSON.parse(d.popStats) : null; } catch (err) { st = null; }
    if (st) {
      var pop = el('span', 'fp-pop', plaque);
      var head = el('span', 'fp-pop-head', pop);
      el('span', 'fp-tier is-' + st.tier.key, head, st.tier.label);
      el('small', '', head, 'in Note ' + st.grade);
      var most = Math.max.apply(null, st.dist) || 1;
      var bars = el('span', 'fp-bars', pop);
      bars.setAttribute('aria-hidden', 'true');
      st.dist.forEach(function (n, i) {
        var b = el('span', 'fp-bar' + (n ? ' has' : '') + (i + 1 === st.grade ? ' is-this' : ''), bars);
        b.style.setProperty('--h', n ? Math.max(0.18, n / most).toFixed(3) : 0);
        el('i', '', b);
        el('b', '', b, String(i + 1));
      });
      var parts = [st.at + ' von ' + st.copies + (st.copies === 1 ? ' Exemplar' : ' Exemplaren') + ' mit Note ' + st.grade];
      parts.push(st.higher ? st.higher + ' besser benotet' : st.grade === 10 ? 'höchste Note' : 'keins besser benotet');
      el('small', 'fp-pop-text', pop, parts.join(' · '));
    } else if (d.pop) {
      el('small', 'fp-pop-text', plaque, d.pop);
    }
    if (gallery && gallery.list.length > 1) el('small', 'fp-count', plaque, (gallery.idx + 1) + ' / ' + gallery.list.length);
  }

  function open(trigger, foiling) {
    var d = trigger.dataset;
    var card = build(d, foiling);
    stage.className = 'foil-modal-stage r-' + (d.rarity || '');
    stage.innerHTML = '';
    stage.appendChild(card);
    view = { card: card, inner: card.querySelector('.foil-inner'), rx: foiling ? 0 : -8, ry: foiling ? 0 : 14, vx: 0, vy: 0, tween: null };

    // Album (und Favoriten): als Favorit zeigen / entfernen
    if (favForm) {
      favForm.hidden = !d.fav;
      if (d.fav) {
        favForm.querySelector('input[name="card"]').value = d.fav;
        favForm.querySelector('button').textContent = d.favOn === '1' ? '★ Favorit entfernen' : '☆ Als Favorit zeigen';
      }
    }
    if (menu) {
      // Exemplar mit Spuren (#204): eigener Link ins Handelsfenster, kein Favorit
      var copy = !!d.offerHref;
      menu.hidden = !d.fav && !copy;
      var album = 'albumFoil' in d || copy;
      sellLink.hidden = !album || !!d.sellOff;
      statusEl.hidden = !album;
      if (copy) {
        statusEl.textContent = d.rarityLabel + (d.copyNote ? ' · ' + d.copyNote : '');
        sellLink.href = d.offerHref;
      } else if (album) {
        // wie bei normalen Karten: Seltenheit und Wert (Folienwert, normaler Preis zum Vergleich)
        statusEl.textContent = d.rarityLabel + (d.slabCode ? ' · Slab ' + d.slabCode : ' · in Folie') + ' · Händlerpreis ' + d.sellText + (d.baseText && d.baseText !== d.sellText ? ' (ohne Slab ' + d.baseText + ')' : '');
        sellLink.href = '/handel/neu?gib=' + encodeURIComponent(d.fav);
      }
      noteEl.hidden = !album || !d.sellOff;
      noteEl.textContent = d.sellOff || '';
    }
    // Fremde Sammlung: Tausch für dieses Exemplar vorschlagen
    if (tradeBox) {
      tradeBox.hidden = !d.tradeHref;
      if (d.tradeHref) tradeBox.querySelector('a').href = d.tradeHref;
    }
    // Slab (#204): Link zum Zertifikat (Note, Shop, Zweitprüfungen, Population, Verkäufe)
    if (!certLink) {
      certLink = el('a', 'foil-cert-link', modal, 'Zertifikat ansehen →');
    }
    if (d.cert) certLink.href = '/slab/' + encodeURIComponent(d.cert);
    certLink.hidden = !(d.slabCode && d.cert) || location.pathname === certLink.pathname; // nicht auf der Zertifikatsseite selbst
    setupGallery(trigger, d);

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

    if (!modal.open) modal.showModal();
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
  modal.addEventListener('click', function (e) {
    if (swiped) { swiped = false; return; }
    if (e.target === modal || e.target === stage) modal.close();
  });
  modal.addEventListener('keydown', function (e) {
    if (!gallery) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });
  // Wischen neben der Karte blättert (auf der Karte selbst dreht Ziehen sie)
  var swipe = null;
  stage.addEventListener('pointerdown', function (e) {
    if (e.target !== stage || !gallery) return;
    swipe = { x: e.clientX, y: e.clientY };
  });
  stage.addEventListener('pointerup', function (e) {
    if (!swipe) return;
    var dx = e.clientX - swipe.x;
    var dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      swiped = true;
      step(dx < 0 ? 1 : -1);
    }
  });
  modal.addEventListener('close', function () { gallery = null; });

  // Inventar: gerade folierte Karte groß zeigen, wie die Folie aufgezogen wird
  var fresh = document.querySelector('.foil-item.is-new [data-foil-view]');
  if (fresh) {
    fresh.closest('.foil-item').scrollIntoView({ block: 'center' });
    open(fresh, !reduceMotion);
  }
})();

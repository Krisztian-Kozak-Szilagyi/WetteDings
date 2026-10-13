(function () {
  'use strict';

  // Karte im Sleeve, im Slab oder als einzelnes Exemplar groß ansehen (Album, Profil, Handel, Vitrine): Auslöser ist ein
  // Element mit data-foil-view (data-image, data-name, data-rarity, data-rarity-label, data-date, data-no; im Album
  // zusätzlich data-fav/data-fav-on, in fremden Sammlungen data-trade-href).
  // Aufbau wie die reguläre Großansicht der Karten (partials/card-zoom, public/js/tcg.js): Karte links, rechts Seltenheit,
  // Name, Status und Aktionen; die Karte neigt sich mit der Maus (bindTilt), antippen dreht sie um.
  // Dialog: views/partials/foil-modal.ejs
  var modal = document.querySelector('[data-foil-modal]');
  if (!modal || !modal.showModal) return;
  var stage = modal.querySelector('[data-foil-stage]');
  var body = modal.querySelector('.foil-modal-body');
  var dotEl = modal.querySelector('[data-foil-dot]');
  var rarityEl = modal.querySelector('[data-foil-rarity]');
  var nameEl = modal.querySelector('[data-foil-name]');
  var statusEl = modal.querySelector('[data-foil-status]');
  var noteEl = modal.querySelector('[data-foil-note]');
  var favForm = modal.querySelector('[data-foil-fav]'); // nur mit favForm (Album, Dashboard)
  var sellLink = modal.querySelector('[data-foil-sell]'); // nur im Album: „Im Handel anbieten“
  var unwrapForm = modal.querySelector('[data-foil-unwrap]'); // nur im Album: Sleeve abziehen / Slab aufbrechen
  var tradeLink = modal.querySelector('[data-foil-trade]'); // nur in fremden Sammlungen: „Angebot machen“
  var certBtn = modal.querySelector('[data-foil-cert]'); // Zertifikat eines Slabs
  var vitBtns = Array.prototype.slice.call(modal.querySelectorAll('[data-foil-vit]')); // nur am Grading-Schreibtisch: Austauschen / Entfernen
  var reduceMotion =window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var view = null;
  var certLink = null; // Showroom (Vitrine): Link zum Zertifikat unter dem Messingschild, beim ersten Öffnen angelegt
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
    card.setAttribute('aria-label', d.name + ' – antippen zum Umdrehen');
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

  // Neigung bei Mouse-over – dieselben Winkel wie bei den regulären Karten (tcg.js bindTilt); die Umdrehung (base) kommt dazu
  function setTilt(rx, ry, mx, my, live) {
    view.inner.style.transition = live ? 'transform .06s linear' : 'transform .35s ease';
    view.inner.style.transform = 'rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + (view.base + ry).toFixed(2) + 'deg)';
    view.card.style.setProperty('--gx', mx.toFixed(1) + '%');
    view.card.style.setProperty('--gy', my.toFixed(1) + '%');
  }

  function flip() {
    view.base += 180;
    view.flipUntil = performance.now() + (reduceMotion ? 0 : 650);
    view.inner.style.transition = reduceMotion ? 'none' : 'transform .65s cubic-bezier(.3, .7, .2, 1)';
    view.inner.style.transform = 'rotateX(0deg) rotateY(' + view.base + 'deg)';
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

  /**
   * Panel rechts wie bei der regulären Großansicht: Seltenheit · Nummer, Name, Status und die Aktionen der Variante
   * (Sleeve, Slab oder einzelnes Exemplar) – im Album Favorit, Handeln und Abziehen, in fremden Sammlungen Angebot machen.
   */
  function fillInfo(d) {
    var copy = !!d.offerHref; // Exemplar mit Spuren (#204): eigener Link ins Handelsfenster, kein Favorit
    var album = 'albumFoil' in d || copy;
    dotEl.className = 'tcg-dot r-' + (d.rarity || '');
    rarityEl.textContent = (d.rarityLabel || '') + (d.no ? ' · #' + d.no : '');
    nameEl.textContent = d.name || '';
    noteEl.hidden = true;
    var state = d.slabCode ? 'Slab ' + d.slabCode + ' · Note ' + d.grade + (d.gradeWord ? ' (' + d.gradeWord + ')' : '') : copy ? '' : 'bare' in d ? 'Exemplar' : 'Im Sleeve';
    if (copy) {
      statusEl.textContent = d.copyNote || 'Exemplar';
    } else if (album) {
      // wie bei normalen Karten: Status und Händlerpreis (Folienwert, normaler Preis zum Vergleich)
      statusEl.textContent = state + ' · Händlerpreis ' + d.sellText + (d.baseText && d.baseText !== d.sellText ? ' (ohne Slab ' + d.baseText + ')' : '');
    } else {
      statusEl.textContent = state + (d.date && !d.slabCode ? ' seit ' + d.date : d.sealed ? ' · versiegelt ' + d.sealed : '');
    }
    // Album (und Favoriten): als Favorit zeigen / entfernen
    if (favForm) {
      favForm.hidden = !d.fav;
      if (d.fav) {
        favForm.querySelector('input[name="card"]').value = d.fav;
        favForm.querySelector('button').textContent = d.favOn === '1' ? '★ Favorit entfernen' : '☆ Als Favorit zeigen';
      }
    }
    if (sellLink) {
      sellLink.hidden = !album || !!d.sellOff;
      if (copy) sellLink.href = d.offerHref;
      else if (album && d.fav) sellLink.href = '/handel/neu?gib=' + encodeURIComponent(d.fav);
    }
    if (album && d.sellOff) {
      noteEl.hidden = false;
      noteEl.textContent = d.sellOff;
    }
    // Sleeve abziehen / Slab aufbrechen: nur für das eigene Exemplar im Album (fav = "f:<Exemplar>")
    if (unwrapForm) {
      var mine = album && !copy && d.fav && d.fav.indexOf('f:') === 0;
      unwrapForm.hidden = !mine;
      if (mine) {
        unwrapForm.querySelector('input[name="copy"]').value = d.fav.slice(2);
        unwrapForm.querySelector('button').textContent = d.slabCode ? 'Slab aufbrechen' : 'Sleeve abziehen';
        unwrapForm.setAttribute('data-confirm', d.slabCode
          ? 'Slab von ' + d.name + ' aufbrechen? Kürzel ' + d.slabCode + ', Note ' + d.grade + (d.slabCode === 'BfW' ? ' und die Wertsteigerung' : '') + ' sind danach weg, das Gehäuse ist zerstört – die Note ist wieder geheim. Du kannst die Karte neu graden lassen.'
          : 'TCG Sleeve von ' + d.name + ' abziehen? Der Sleeve kommt zurück ins Inventar. Die Karte ist danach wieder ungeschützt.');
      }
    }
    // Vitrine am Schreibtisch: tauschen / entfernen (nur für Slabs mit data-vit-id)
    vitBtns.forEach(function (b) { b.hidden = !d.vitId; });
    // Fremde Sammlung: Tausch für dieses Exemplar vorschlagen
    if (tradeLink) {
      tradeLink.hidden = !d.tradeHref;
      if (d.tradeHref) tradeLink.href = d.tradeHref;
    }
  }

  function open(trigger, foiling) {
    var d = trigger.dataset;
    current = trigger;
    var card = build(d, foiling);
    stage.className = 'foil-modal-stage r-' + (d.rarity || '');
    stage.innerHTML = '';
    stage.appendChild(card);
    view = { card: card, inner: card.querySelector('.foil-inner'), base: 0, flipUntil: 0 };
    fillInfo(d);
    // Slab (#204): Link zum Zertifikat (Note, Shop, Zweitprüfungen, Population, Verkäufe) – nicht auf der Zertifikatsseite selbst
    var certHref = d.slabCode && d.cert ? '/slab/' + encodeURIComponent(d.cert) : '';
    var showCert = !!certHref && location.pathname !== certHref;
    if (certBtn) {
      certBtn.hidden = !showCert;
      if (certHref) certBtn.href = certHref;
    }
    if (!certLink) certLink = el('a', 'foil-cert-link', body, 'Zertifikat ansehen →');
    if (certHref) certLink.href = certHref;
    certLink.hidden = !showCert;
    setupGallery(trigger, d);

    card.addEventListener('pointermove', function (e) {
      if (performance.now() < view.flipUntil) return; // wie bei den regulären Karten (tcg.js bindTilt) unabhängig von „Bewegung reduzieren“
      var r = card.getBoundingClientRect();
      var x = clamp((e.clientX - r.left) / r.width, 0, 1);
      var y = clamp((e.clientY - r.top) / r.height, 0, 1);
      setTilt((0.5 - y) * 18, (x - 0.5) * 22, x * 100, y * 100, true);
    });
    card.addEventListener('pointerleave', function () {
      if (performance.now() < view.flipUntil) return;
      setTilt(0, 0, 50, 50, false);
    });
    card.addEventListener('click', flip);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
    });

    if (!modal.open) modal.showModal();
    card.focus();
  }

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-foil-view]');
    if (!trigger || modal.contains(trigger)) return;
    e.preventDefault();
    e.stopPropagation();
    open(trigger, false);
  }, true);
  modal.querySelector('[data-foil-close]').addEventListener('click', function () { modal.close(); });
  var current = null; // Auslöser der geöffneten Ansicht
  vitBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      var id = current && current.dataset.vitId;
      modal.close();
      if (id) document.dispatchEvent(new CustomEvent('vit:act', { detail: { act: b.getAttribute('data-foil-vit'), id: id } }));
    });
  });
  modal.addEventListener('click', function (e) {
    if (swiped) { swiped = false; return; }
    if (e.target === modal || e.target === stage || e.target === body) modal.close();
  });
  modal.addEventListener('keydown', function (e) {
    if (!gallery) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });
  // Wischen neben der Karte blättert
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

  // Album: gerade in den Sleeve gesteckte Karte groß zeigen, wie die Hülle aufgezogen wird
  var fresh = document.querySelector('[data-foil-view].is-new');
  if (fresh) {
    fresh.scrollIntoView({ block: 'center' });
    open(fresh, !reduceMotion);
  }
})();

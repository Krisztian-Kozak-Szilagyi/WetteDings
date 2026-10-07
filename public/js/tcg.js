(function () {
  'use strict';

  var RARE_RANK = 3; // ab Holo gibt es den großen Auftritt

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function showFlash(type, message) {
    var area = $('[data-flash-area]');
    if (!area) return window.alert(message);
    area.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'flash flash-' + type;
    div.setAttribute('role', 'status');
    var span = document.createElement('span');
    span.textContent = message;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'flash-close';
    close.setAttribute('aria-label', 'Hinweis schließen');
    close.textContent = '×';
    div.appendChild(span);
    div.appendChild(close);
    area.appendChild(div);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- Filter der Sammlung ----------
  // Jeder Filter wirkt nur auf das Raster in seiner .card bzw. [data-filter-scope] (die Tauschseite hat zwei Raster)
  // Suchknopf (partials/tcg-filter → mkt-bar): Seltenheit und Kartenname zusammen; ohne Namen (z. B. "?") passt keine Suche
  var filterScope = function (scope) {
    var active = $('[data-tcg-filter].active', scope);
    var key = active ? active.getAttribute('data-tcg-filter') : 'all';
    var search = $('[data-tcg-search]', scope);
    var q = search ? search.value.trim().toLowerCase() : '';
    $all('.tcg-grid .tcg-slot', scope).forEach(function (slot) {
      var name = (slot.getAttribute('data-name') || '').toLowerCase();
      var hide = (key !== 'all' && slot.getAttribute('data-rarity') !== key) || (q && name.indexOf(q) === -1);
      (slot.closest('.tcg-pick-multi') || slot).hidden = !!hide;
    });
  };
  var scopeOf = function (el) { return el.closest('.card, [data-filter-scope]') || document; };
  $all('[data-tcg-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var scope = scopeOf(btn);
      $all('[data-tcg-filter]', scope).forEach(function (b) {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      filterScope(scope);
    });
  });
  $all('[data-tcg-search]').forEach(function (input) {
    input.addEventListener('input', function () { filterScope(scopeOf(input)); });
  });

  // ---------- Season-Filter im Album: blendet ganze Season-Sektionen aus ----------
  $all('[data-album-season]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.getAttribute('data-album-season');
      $all('[data-album-season]').forEach(function (b) {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      $all('[data-album-season-section]').forEach(function (sec) {
        sec.hidden = key !== 'all' && sec.getAttribute('data-album-season-section') !== key;
      });
    });
  });

  // ---------- Anzahl Packs im Shop ----------
  var qty = $('[data-tcg-qty]');
  if (qty) {
    var qtyInput = $('input[name="count"]', qty);
    var qtySubmit = $('[data-qty-submit]');
    var price = parseInt(qty.getAttribute('data-price'), 10) || 0;
    var maxQty = parseInt(qty.getAttribute('data-max'), 10) || 1;
    var money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
    var setQty = function (n) {
      n = Math.max(1, Math.min(maxQty, parseInt(n, 10) || 1));
      qtyInput.value = n;
      qtySubmit.textContent = (n === 1 ? 'Pack kaufen' : n + ' Packs kaufen') + ' · ' + money.format((n * price) / 100);
    };
    $all('[data-qty-step]', qty).forEach(function (b) {
      b.addEventListener('click', function () { setQty((parseInt(qtyInput.value, 10) || 1) + parseInt(b.getAttribute('data-qty-step'), 10)); });
    });
    $('[data-qty-max]', qty).addEventListener('click', function () { setQty(maxQty); });
    qtyInput.addEventListener('input', function () {
      var n = parseInt(qtyInput.value, 10);
      if (n >= 1) setQty(n); // leeres Feld beim Tippen stehen lassen
    });
    qtyInput.addEventListener('blur', function () { setQty(qtyInput.value); });
  }

  // ---------- 3D-Neigung (Zoom-Ansicht) ----------
  function bindTilt(el) {
    if (!el) return;
    el.addEventListener('pointermove', function (e) {
      var r = el.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width;
      var y = (e.clientY - r.top) / r.height;
      el.style.setProperty('--rx', ((0.5 - y) * 18).toFixed(2) + 'deg');
      el.style.setProperty('--ry', ((x - 0.5) * 22).toFixed(2) + 'deg');
      el.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
      el.style.setProperty('--my', (y * 100).toFixed(1) + '%');
      el.classList.add('tilting');
    });
    el.addEventListener('pointerleave', function () {
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
      el.classList.remove('tilting');
    });
  }
  window.tcgBindTilt = bindTilt; // auch für den Zoom auf der Handelsseite (public/js/handel.js)

  // ---------- Karte vergrößern + verkaufen ----------
  var modal = $('[data-tcg-modal]');
  if (modal) {
    var tilt = $('[data-tcg-tilt]', modal);
    bindTilt(tilt);

    var sellOne = $('[data-tcg-sell-one]', modal);
    var sellDupes = $('[data-tcg-sell-dupes]', modal);
    var protectForm = $('[data-tcg-protect]', modal);
    var favoriteForm = $('[data-tcg-favorite]', modal);
    var protectNote = $('[data-tcg-protect-note]', modal);

    document.addEventListener('click', function (e) {
      var slot = e.target.closest('[data-tcg-card]');
      if (!slot) return;
      var d = slot.dataset;
      var count = parseInt(d.count, 10) || 0;
      var rank = parseInt(d.rank, 10) || 0;
      var sell = parseInt(d.sell, 10) || 0;
      var noBank = d.noBank === '1'; // Boss-Karten: die Bank kauft sie nicht, Schutz vor dem Duplikat-Verkauf ist überflüssig

      var former = d.former === '1';
      var note = $('[data-tcg-modal-note]', modal);
      if (note) note.hidden = true; // Meldung gilt nur direkt nach einer Aktion (siehe unten, #131)
      tilt.className = 'tcg-zoom r-' + d.rarity + (former ? ' is-former' : '');
      $('[data-tcg-modal-img]', modal).src = d.image;
      $('[data-tcg-modal-img]', modal).alt = d.name + ' (' + d.rarityLabel + ')';
      $('[data-tcg-modal-name]', modal).textContent = d.name;
      $('[data-tcg-modal-dot]', modal).className = 'tcg-dot r-' + d.rarity;
      $('[data-tcg-modal-rarity]', modal).textContent = d.rarityLabel + (d.no ? ' · #' + d.no : '');
      var foiled = parseInt(d.foiled, 10) || 0;
      $('[data-tcg-modal-count]', modal).textContent = former ? 'Früher besessen – aktuell nicht in deiner Sammlung.'
        : (count ? (count === 1 ? '1× im Besitz' : count + '× im Besitz') : '') + (foiled ? (count ? ' · ' : '') + foiled + '× foliert' : '') + (d.protected === '1' ? ' · geschützt' : '')
        + (noBank ? ' · Wert ' + d.sellText + ' (nur Handel, die Bank kauft sie nicht)' : '');
      $('[data-tcg-owned-actions]', modal).hidden = former;
      $('[data-tcg-former-action]', modal).hidden = !former;
      if (former) {
        if (typeof modal.showModal === 'function') modal.showModal();
        else modal.setAttribute('open', '');
        return;
      }

      sellOne.hidden = count < 1 || noBank; // nur folierte Exemplare: die Bank kauft sie nicht
      sellOne.querySelector('input[name="card"]').value = d.tcgCard;
      $('[data-tcg-sell-text]', sellOne).textContent = d.sellText;
      if (rank >= RARE_RANK) {
        sellOne.setAttribute('data-confirm', d.name + ' (' + d.rarityLabel + ') wirklich für ' + d.sellText + ' verkaufen?');
      } else {
        sellOne.removeAttribute('data-confirm');
      }

      // Schutz vor dem Duplikat-Verkauf und Favorit
      var isProtected = d.protected === '1';
      protectForm.querySelector('input[name="card"]').value = d.tcgCard;
      protectForm.querySelector('button').textContent = isProtected ? 'Schutz aufheben' : 'Schützen (Schloss)';
      protectNote.hidden = !isProtected || noBank;
      protectForm.hidden = noBank;
      favoriteForm.querySelector('input[name="card"]').value = d.tcgCard;
      favoriteForm.querySelector('button').textContent = d.favorite === '1' ? '★ Favorit entfernen' : '☆ Als Favorit zeigen';

      sellDupes.hidden = count < 2 || isProtected || noBank;
      if (count > 1 && !isProtected && !noBank) {
        var total = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(((count - 1) * sell) / 100);
        sellDupes.querySelector('input[name="card"]').value = d.tcgCard;
        sellDupes.querySelector('button').textContent = 'Duplikate verkaufen (' + (count - 1) + '×) · ' + total;
        sellDupes.setAttribute('data-confirm', (count - 1) + '× ' + d.name + ' verkaufen und eine behalten?');
      }

      if (typeof modal.showModal === 'function') modal.showModal();
      else modal.setAttribute('open', '');
    });

    function closeModal() {
      if (typeof modal.close === 'function') modal.close();
      else modal.removeAttribute('open');
    }
    $('[data-tcg-close]', modal).addEventListener('click', closeModal);
    // Klick auf den Hintergrund schließt
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal();
    });
  }

  // ---------- Album: nach Favorit, Schützen oder Verkaufen an derselben Stelle weiter (#131) ----------
  // Die Aktionen sind Formulare und laden das Album neu – vorher merken wir uns Scroll-Position und Karte.
  // Danach: gleiche Stelle, das Kartenfenster wieder offen und die Meldung darin (sonst unten als kurzer Hinweis).
  if (window.location.pathname === '/tcg/album') {
    var BACK_KEY = 'tcg-album-back';
    var session = {
      get: function () { try { return JSON.parse(sessionStorage.getItem(BACK_KEY)); } catch (e) { return null; } },
      set: function (v) { try { sessionStorage.setItem(BACK_KEY, JSON.stringify(v)); } catch (e) { /* ohne Speicher: wie bisher */ } },
      clear: function () { try { sessionStorage.removeItem(BACK_KEY); } catch (e) { /* egal */ } },
    };
    // app.js fragt vorher nach (data-confirm) – wer abbricht, bleibt einfach hier
    document.addEventListener('submit', function (e) {
      var f = e.target;
      if (e.defaultPrevented || !/^\/tcg\/(favorit|schuetzen|verkaufen)$/.test(new URL(f.action, window.location.href).pathname)) return;
      var input = f.closest('[data-tcg-modal]') && f.querySelector('input[name="card"]');
      session.set({ y: window.scrollY, card: input ? input.value : null, at: Date.now() });
    });

    var back = session.get();
    session.clear();
    if (back && Date.now() - back.at < 30000) {
      // Erfolg zeigt die Seite selbst (grüne Meldungen nur für Admins, middleware/flash) – ein Fehler kommt als Meldung.
      // Sie verlässt zuerst ihren Platz oben, sonst verschöbe sie die Seite nach dem Zurückscrollen um ihre Höhe.
      var flash = $('[data-flash-area] .flash');
      var slot = back.card && modal && $('[data-tcg-card="' + back.card.replace(/["\\]/g, '') + '"]');
      var message = flash ? { text: $('span', flash).textContent, error: flash.classList.contains('flash-error') } : null;
      if (flash && slot) flash.remove();
      else if (flash) {
        flash.classList.add('flash-toast');
        setTimeout(function () { flash.classList.add('is-gone'); }, 4500);
        setTimeout(function () { flash.remove(); }, 5000);
      }
      if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
      window.scrollTo(0, back.y);
      if (slot) {
        slot.click(); // öffnet das Kartenfenster mit dem neuen Stand
        var note = $('[data-tcg-modal-note]', modal);
        if (message && note) {
          note.textContent = message.text;
          note.className = 'tcg-modal-note ' + (message.error ? 'is-error' : 'is-success');
          note.hidden = false;
        }
      }
    }
  }

  // ---------- Direkt zu einer Karte springen und sie aufleuchten lassen ----------
  // Album: #karte-<id> („Im Album ansehen“ im Dashboard). TCG-Seite: #favorit-<key> (gerade als Favorit gewählt –
  // zeigt die Karte an ihrem neuen Platz). Weich hinscrollen, dann leuchtet die Karte kurz in der Farbe ihrer
  // Seltenheit auf (CSS: .is-spotlight).
  var JUMPS = { '/tcg/album': [/^#karte-(.+)$/, 'data-album-card'], '/tcg': [/^#favorit-(.+)$/, 'data-fav-key'] };
  var jumpRule = JUMPS[window.location.pathname];
  var jump = jumpRule && jumpRule[0].exec(window.location.hash);
  if (jump) {
    var target = $('[' + jumpRule[1] + '="' + decodeURIComponent(jump[1]).replace(/["\\]/g, '') + '"]');
    if (target) {
      history.replaceState(null, '', window.location.pathname + window.location.search); // Neuladen springt nicht erneut
      var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var glow = function () {
        target.classList.remove('is-spotlight');
        void target.offsetWidth; // Animation neu starten
        target.classList.add('is-spotlight');
        setTimeout(function () { target.classList.remove('is-spotlight'); }, 2200);
      };
      requestAnimationFrame(function () {
        var startY = window.scrollY;
        target.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
        if (calm) return glow();
        // Aufleuchten, sobald das Scrollen steht: scrollend, sonst warten, bis sich die Position nicht mehr ändert
        // (muss gar nicht gescrollt werden, gleich)
        var done = false;
        var once = function () { if (!done) { done = true; glow(); } };
        if ('onscrollend' in window) window.addEventListener('scrollend', once, { once: true });
        var lastY = startY;
        var settle = function () {
          if (done) return;
          if (window.scrollY === lastY) return once();
          lastY = window.scrollY;
          setTimeout(settle, 120);
        };
        setTimeout(settle, 150);
      });
    }
  }

  // ---------- Pack öffnen ----------
  // Ein Formular pro Pack-Art im Inventar; form = das zuletzt benutzte (für "Nächstes Pack öffnen")
  var forms = $all('[data-tcg-open]');
  var form = null;
  var reveal = $('[data-tcg-reveal]');
  if (!forms.length || !reveal || !window.fetch) return;

  var packBtn = $('[data-tcg-pack]', reveal);
  var cardsBox = $('[data-tcg-cards]', reveal);
  var actions = $('[data-tcg-actions]', reveal);
  var hint = $('[data-tcg-hint]', reveal);
  var flipAllBtn = $('[data-tcg-flip-all]', reveal);
  var againBtn = $('[data-tcg-again]', reveal);
  var doneBtn = $('[data-tcg-done]', reveal);

  var state = { busy: false, cards: null, flipped: 0, packsLeft: 0, opened: false };

  function resetStage() {
    reveal.classList.remove('all-flipped');
    packBtn.hidden = false;
    packBtn.className = 'tcg-reveal-pack';
    packBtn.disabled = true;
    cardsBox.innerHTML = '';
    actions.hidden = true;
    state.cards = null;
    state.flipped = 0;
    state.opened = false;
  }

  function openPack() {
    if (state.busy) return;
    state.busy = true;
    resetStage();
    reveal.hidden = false;
    document.body.classList.add('tcg-noscroll');
    hint.textContent = 'Pack wird geöffnet …';
    var packImg = packBtn.querySelector('img');
    // nur eigene Bilder (Pfad unter /img/) übernehmen
    var packSrc = form.getAttribute('data-image') || '';
    if (packImg && /^\/img\/[\w./?=%-]+$/.test(packSrc)) packImg.src = packSrc;

    fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(new FormData(form)).toString(),
      credentials: 'same-origin',
    })
      .then(function (res) {
        return res.json().catch(function () { return { error: 'Das hat nicht geklappt. Bitte lade die Seite neu.' }; });
      })
      .then(function (data) {
        state.busy = false;
        if (data.error) {
          closeReveal(false);
          showFlash('error', data.error);
          return;
        }
        state.packsLeft = data.packsLeft;
        // Reihenfolge wie gezogen (zufällig) – die Seltenheit verrät sich nicht durch den Platz
        state.cards = data.cards.slice();
        packBtn.disabled = false;
        packBtn.classList.add('ready');
        hint.textContent = 'Tippe auf das Pack, um es aufzureißen';
        packBtn.focus();
      })
      .catch(function () {
        state.busy = false;
        closeReveal(false);
        showFlash('error', 'Keine Verbindung. Bitte versuche es erneut.');
      });
  }

  function tearPack() {
    if (!state.cards || state.opened) return;
    state.opened = true;
    packBtn.classList.remove('ready');
    packBtn.classList.add('torn');
    hint.textContent = '';
    setTimeout(function () {
      packBtn.hidden = true;
      dealCards();
    }, 650);
  }

  function dealCards() {
    state.cards.forEach(function (c, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tcg-flip r-' + c.rarity;
      btn.style.animationDelay = i * 140 + 'ms';
      btn.setAttribute('aria-label', 'Karte ' + (i + 1) + ' aufdecken');
      btn.innerHTML =
        '<span class="tcg-aura" aria-hidden="true"></span>' +
        '<span class="tcg-flip-inner">' +
          '<span class="tcg-face tcg-back season-' + (c.season || 'pre-season') + '"></span>' + // Rückseite je Season
          '<span class="tcg-face tcg-front"><img alt="" width="720" height="1008"><span class="tcg-shine"></span></span>' +
        '</span>' +
        '<span class="tcg-flip-label"><span class="tcg-dot"></span><span></span></span>';
      var img = btn.querySelector('img');
      img.src = c.image;
      img.alt = c.name + ' (' + c.rarityLabel + ')';
      btn.querySelector('.tcg-flip-label span:last-child').textContent = c.rarityLabel + ' · ' + c.sell;
      // noch nie besessen: "Neu"-Marke unter der Karte (sichtbar, sobald die Karte aufgedeckt ist)
      if (c.isNew) {
        var neu = document.createElement('span');
        neu.className = 'tcg-new-badge';
        neu.textContent = 'Neu';
        btn.querySelector('.tcg-flip-label').appendChild(neu);
      }
      if (c.rarity === 'glitch') addMatrix(btn);
      btn.addEventListener('click', function () { flip(btn, c); });
      cardsBox.appendChild(btn);
    });
    hint.textContent = 'Tippe die Karten an, um sie aufzudecken';
    actions.hidden = false;
    flipAllBtn.hidden = false;
    againBtn.hidden = true;
    doneBtn.hidden = true;
    var first = cardsBox.querySelector('.tcg-flip');
    if (first) first.focus();
  }

  // Glitch: grüne Ziffernspalten über der Kartenkante (einzelne schwach auf der Karte);
  // bei Hover fallen sie, die Ziffern wechseln und manche Spalten flackern
  function randomDigits(n) {
    var s = '';
    for (var i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
    return s;
  }
  // [links in %, Schriftgröße in px, Deckkraft, auf der Karte]
  var MATRIX_COLS = [
    [-13, 11, 0.9], [-7, 15, 1], [-1, 12, 0.85], [4, 9, 0.6], [22, 10, 0.3, true], [47, 14, 0.22, true],
    [71, 10, 0.3, true], [90, 9, 0.55], [95, 13, 0.85], [101, 15, 1], [108, 11, 0.9],
  ];
  function addMatrix(btn) {
    var layer = document.createElement('span');
    layer.className = 'tcg-matrix';
    layer.setAttribute('aria-hidden', 'true');
    var spans = [];
    MATRIX_COLS.forEach(function (spec) {
      var col = document.createElement('span');
      col.className = 'tcg-matrix-col' + (spec[3] ? ' in' : '') + (Math.random() < 0.35 ? ' flicker' : '');
      col.style.left = spec[0] + '%';
      col.style.fontSize = spec[1] + Math.round(Math.random() * 2 - 1) + 'px';
      col.style.opacity = spec[2];
      col.style.setProperty('--op', spec[2]);
      col.style.setProperty('--delay', (-Math.random() * 2).toFixed(2) + 's');
      var inner = document.createElement('span');
      inner.textContent = randomDigits(80);
      inner.style.setProperty('--dur', (1.2 + Math.random() * 1.8).toFixed(2) + 's');
      inner.style.setProperty('--delay', (-Math.random() * 2).toFixed(2) + 's');
      col.appendChild(inner);
      layer.appendChild(col);
      spans.push(inner);
    });
    btn.insertBefore(layer, btn.querySelector('.tcg-flip-label'));
    var timer = null;
    btn.addEventListener('mouseenter', function () {
      if (timer) return;
      timer = setInterval(function () {
        spans.forEach(function (sp) {
          var t = sp.textContent.split('');
          for (var k = 0; k < 6; k++) t[Math.floor(Math.random() * t.length)] = Math.floor(Math.random() * 10);
          sp.textContent = t.join('');
        });
      }, 90);
    });
    btn.addEventListener('mouseleave', function () {
      clearInterval(timer);
      timer = null;
    });
  }

  function flip(btn, c) {
    if (btn.classList.contains('flipped')) return;
    btn.classList.add('flipped');
    btn.setAttribute('aria-label', c.name + ' (' + c.rarityLabel + ')');
    if (c.rank >= RARE_RANK) {
      btn.classList.add('tcg-burst');
      reveal.classList.add('flash-' + c.rarity);
      setTimeout(function () { reveal.classList.remove('flash-' + c.rarity); }, 900);
    }
    state.flipped++;
    if (state.flipped === state.cards.length) finish();
  }

  function finish() {
    reveal.classList.add('all-flipped');
    var best = state.cards.reduce(function (b, c) { return c.rank > b.rank ? c : b; });
    hint.textContent = best.rank >= RARE_RANK ? 'Wow – ' + best.name + ' (' + best.rarityLabel + ')!' : 'Alle Karten sind in deiner Sammlung.';
    flipAllBtn.hidden = true;
    againBtn.hidden = !state.packsLeft;
    againBtn.textContent = 'Nächstes Pack öffnen (' + state.packsLeft + ' übrig)';
    doneBtn.hidden = false;
    doneBtn.focus();
  }

  function flipAll() {
    $all('.tcg-flip', cardsBox).forEach(function (btn, i) {
      setTimeout(function () { btn.click(); }, i * 220);
    });
  }

  function closeReveal(reload) {
    if (reload) {
      window.location.href = '/tcg/album';
      return;
    }
    reveal.hidden = true;
    document.body.classList.remove('tcg-noscroll');
  }

  forms.forEach(function (f) {
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      form = f;
      openPack();
    });
  });
  packBtn.addEventListener('click', tearPack);
  flipAllBtn.addEventListener('click', flipAll);
  againBtn.addEventListener('click', openPack);
  doneBtn.addEventListener('click', function () { closeReveal(true); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !reveal.hidden && reveal.classList.contains('all-flipped')) closeReveal(true);
  });
})();

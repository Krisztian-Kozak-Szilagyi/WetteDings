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
    var ownedOnly = $('[data-album-owned]', scope);
    var gradeBtn = $('[data-slab-grade].active', scope);
    var grade = gradeBtn ? gradeBtn.getAttribute('data-slab-grade') : 'all';
    var q = search ? search.value.trim().toLowerCase() : '';
    $all('.tcg-grid .tcg-slot', scope).forEach(function (slot) {
      var name = (slot.getAttribute('data-name') || '').toLowerCase();
      var hide = (key !== 'all' && slot.getAttribute('data-rarity') !== key) || (q && name.indexOf(q) === -1);
      // Album: nur Karten im Besitz (Kacheln eigener Karten tragen data-album-card; Slabs im Regal sind immer eigene)
      var shelf = slot.closest('.tcg-slab-shelf');
      if (ownedOnly && ownedOnly.checked && !shelf && !slot.hasAttribute('data-album-card')) hide = true;
      if (shelf && grade !== 'all' && slot.getAttribute('data-grade') !== grade) hide = true;
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

  // Album: „Nur Karten im Besitz zeigen“ – die Wahl bleibt erhalten
  var ownedBox = $('[data-album-owned]');
  if (ownedBox) {
    try { ownedBox.checked = localStorage.getItem('album-owned') === '1'; } catch (err) { /* egal */ }
    ownedBox.addEventListener('change', function () {
      try { localStorage.setItem('album-owned', ownedBox.checked ? '1' : '0'); } catch (err) { /* egal */ }
      filterScope(document);
    });
    if (ownedBox.checked) filterScope(document);
  }

  // Album: wer sucht, sucht in der ganzen Sammlung – nicht nur in der gerade offenen Season
  $all('[data-tcg-search]').forEach(function (input) {
    input.addEventListener('input', function () {
      var all = input.value.trim() && $('[data-album-season="all"]');
      if (all && !all.classList.contains('active')) all.click();
    });
  });

  // ---------- Slab-Regal im Album: nach Note filtern ----------
  $all('[data-slab-grade]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var g = btn.getAttribute('data-slab-grade');
      $all('[data-slab-grade]').forEach(function (b) {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      filterScope(document);
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
    var shredOne = $('[data-tcg-shred-one]', modal);
    var shredDupes = $('[data-tcg-shred-dupes]', modal);
    var konfettiName = shredOne ? shredOne.getAttribute('data-konfetti-name') : 'Konfetti';

    document.addEventListener('click', function (e) {
      var slot = e.target.closest('[data-tcg-card]');
      if (!slot) return;
      var d = slot.dataset;
      var count = parseInt(d.count, 10) || 0;
      var rank = parseInt(d.rank, 10) || 0;
      var sell = parseInt(d.sell, 10) || 0;
      var noBank = d.noBank === '1'; // Boss-Karten: die Bank kauft sie nicht, Schutz vor dem Duplikat-Verkauf ist überflüssig
      // #204: Exemplare mit ungebügeltem Knick gehen zuerst weg und bringen die Hälfte (tcgService.bankPrice)
      var creased = Math.min(parseInt(d.creased, 10) || 0, count);
      var half = Math.floor(sell / 2);
      var euroFmt = function (cents) { return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100); };
      var worth = function (n, f) { var k = Math.min(creased, n); return k * f(half) + (n - k) * f(sell); };

      modal.setAttribute('data-card', d.tcgCard);
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
      // gesperrte Exemplare (Quest, Dungeon, Handel, Duell) zählen zum Besitz, lassen sich aber nicht verkaufen
      var locked = parseInt(d.locked, 10) || 0;
      var owned = count + locked;
      $('[data-tcg-modal-count]', modal).textContent = former ? 'Früher besessen – aktuell nicht in deiner Sammlung.'
        : (owned ? owned + '× im Besitz' : '') + (locked ? ' · ' + locked + '× ' + d.lockLabel : '') + (foiled ? (owned ? ' · ' : '') + foiled + '× foliert' : '') + (d.protected === '1' ? ' · geschützt' : '')
        + (noBank ? ' · Grundwert ' + d.sellText + ' (nur Handel, kein Händlerpreis)' : ' · Händlerpreis ' + d.sellText);
      // Album: alle Exemplare der Karte nach Wertung (Slabs, Sleeves, früher bewertet) – jede Zeile öffnet die 3D-Ansicht
      var copyBox = $('[data-tcg-copylist]', modal);
      if (copyBox) {
        var src = former ? null : $('[data-tcg-copies="' + d.tcgCard + '"]');
        var list = $('[data-tcg-copyrows]', copyBox);
        list.innerHTML = '';
        if (src) $all('.tcg-copy', src).forEach(function (row) { list.appendChild(row.cloneNode(true)); });
        copyBox.hidden = !list.children.length;
      }
      $('[data-tcg-owned-actions]', modal).hidden = former;
      $('[data-tcg-former-action]', modal).hidden = !former;
      if (former) {
        if (!modal.open) { if (typeof modal.showModal === 'function') modal.showModal(); else modal.setAttribute('open', ''); }
        return;
      }

      sellOne.hidden = count < 1 || noBank; // nur folierte Exemplare: die Bank kauft sie nicht
      sellOne.querySelector('input[name="card"]').value = d.tcgCard;
      var oneText = creased ? euroFmt(half) + ' (mit Knick)' : d.sellText;
      $('[data-tcg-sell-text]', sellOne).textContent = oneText;
      if (rank >= RARE_RANK) {
        sellOne.setAttribute('data-confirm', d.name + ' (' + d.rarityLabel + ') wirklich für ' + oneText + ' verkaufen?');
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
        var total = euroFmt(worth(count - 1, function (v) { return v; }));
        sellDupes.querySelector('input[name="card"]').value = d.tcgCard;
        sellDupes.querySelector('button').textContent = 'Duplikate verkaufen (' + (count - 1) + '×) · ' + total;
        sellDupes.setAttribute('data-confirm', (count - 1) + '× ' + d.name + ' verkaufen und eine behalten?');
      }

      // Zerkleinern: Konfetti = Bankwert in ganzen Euro; Boss-Karten auch (nur nicht folierte Exemplare)
      var konfetti = Math.floor(sell / 100);
      var kText = function (n) { return '+' + worth(n, function (v) { return Math.floor(v / 100); }).toLocaleString('de-DE') + ' ' + konfettiName; };
      shredOne.hidden = count < 1 || konfetti < 1;
      shredOne.querySelector('input[name="card"]').value = d.tcgCard;
      shredOne.querySelector('button').textContent = '1 zerkleinern · ' + kText(1);
      if (rank >= RARE_RANK || noBank) shredOne.setAttribute('data-confirm', d.name + ' (' + d.rarityLabel + ') wirklich zu ' + worth(1, function (v) { return Math.floor(v / 100); }).toLocaleString('de-DE') + ' ' + konfettiName + ' zerkleinern? Die Karte ist danach weg.');
      else shredOne.removeAttribute('data-confirm');
      shredDupes.hidden = count < 2 || isProtected || konfetti < 1;
      if (!shredDupes.hidden) {
        shredDupes.querySelector('input[name="card"]').value = d.tcgCard;
        shredDupes.querySelector('button').textContent = 'Duplikate zerkleinern (' + (count - 1) + '×) · ' + kText(count - 1);
        shredDupes.setAttribute('data-confirm', (count - 1) + '× ' + d.name + ' zerkleinern und eine behalten?');
      }

      if (!modal.open) { if (typeof modal.showModal === 'function') modal.showModal(); else modal.setAttribute('open', ''); }
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

  // ---------- Album: Aktionen ohne Neuladen (#131) ----------
  // Favorit, Schützen, Verkaufen, Zerkleinern, Sleeve abziehen / Slab aufbrechen und die Duplikat-Knöpfe gehen per fetch an
  // den Server; danach tauscht die Seite nur die Bereiche (Seasons, Slab-Regal, Kopf, Duplikat-Leiste) gegen den neuen Stand.
  // Scroll-Position, offener Reiter, Suche, „Nur Karten im Besitz“ und das Kartenfenster bleiben, wo sie sind.
  if (window.location.pathname === '/tcg/album') {
    var ALBUM_ACTION = /^\/tcg\/(favorit|schuetzen|verkaufen|zerkleinern|huelle-abziehen|duplikate-verkaufen|duplikate-zerkleinern)$|^\/grading\/vitrine\/entfernen$/;
    var albumBusy = false;
    var toast = function (text, error) {
      var area = $('[data-flash-area]');
      if (!area || !text) return;
      var div = document.createElement('div');
      div.className = 'flash flash-' + (error ? 'error' : 'success') + ' flash-toast';
      div.setAttribute('role', 'status');
      var span = document.createElement('span');
      span.textContent = text;
      div.appendChild(span);
      area.appendChild(div);
      setTimeout(function () { div.classList.add('is-gone'); }, 4500);
      setTimeout(function () { div.remove(); }, 5000);
    };
    var sectionKeys = function (root) {
      return $all('[data-album-season-section]', root).map(function (s) { return s.getAttribute('data-album-season-section'); }).join(',');
    };
    // neuen Stand einsetzen; { reload: true } = Aufbau hat sich geändert (z. B. erster Slab), dann hilft nur Neuladen
    var applyAlbum = function (html) {
      var next = new DOMParser().parseFromString(html, 'text/html');
      var flash = $('[data-flash-area] .flash', next);
      var message = flash ? { text: $('span', flash).textContent, error: flash.classList.contains('flash-error') } : null;
      if (!$('.album-body', next) || sectionKeys(next) !== sectionKeys(document)) return { reload: true };
      $all('[data-album-season-section]', next).forEach(function (sec) {
        var old = $('[data-album-season-section="' + sec.getAttribute('data-album-season-section') + '"]');
        var fresh = document.importNode(sec, true);
        fresh.hidden = old.hidden; // der offene Reiter bleibt offen
        old.replaceWith(fresh);
      });
      ['.album-head', '.album-dupes'].forEach(function (sel) {
        var a = $(sel);
        var b = $(sel, next);
        if (a && b) a.replaceWith(document.importNode(b, true));
      });
      $all('[data-album-season]').forEach(function (tab) {
        var cnt = $('.hb-tab-count', tab);
        var again = $('[data-album-season="' + tab.getAttribute('data-album-season') + '"] .hb-tab-count', next);
        if (cnt && again) cnt.textContent = again.textContent;
      });
      // die gewählte Note im Slab-Regal bleibt gewählt (das Regal ist neu aufgebaut)
      var gradeBtn = $('[data-slab-grade].active');
      var grade = gradeBtn ? gradeBtn.getAttribute('data-slab-grade') : 'all';
      if (grade !== 'all') {
        var again = $('[data-slab-grade="' + grade + '"]');
        $all('[data-slab-grade]').forEach(function (b) { b.classList.toggle('active', b === again); });
      }
      filterScope(document); // Suche, Seltenheit, Note und „Nur Karten im Besitz“ gelten auch für die neuen Kacheln
      return { message: message };
    };
    var finish = function (result, cardId) {
      if (result.reload) { window.location.reload(); return; }
      var note = modal && $('[data-tcg-modal-note]', modal);
      var slot = cardId && modal && modal.open && $('[data-tcg-card="' + cardId.replace(/["\\]/g, '') + '"][data-album-card]');
      if (modal && modal.open && !slot) modal.close(); // die Karte ist nicht mehr da (z. B. letztes Exemplar verkauft)
      if (slot) {
        slot.click(); // Kartenfenster mit dem neuen Stand (Exemplar-Liste, Zähler, Knöpfe)
        if (result.message && note) {
          note.textContent = result.message.text;
          note.className = 'tcg-modal-note ' + (result.message.error ? 'is-error' : 'is-success');
          note.hidden = false;
          return;
        }
      }
      if (result.message) toast(result.message.text, result.message.error);
    };
    // app.js fragt vorher nach (data-confirm) – wer abbricht, bleibt einfach hier
    document.addEventListener('submit', function (e) {
      var f = e.target;
      if (e.defaultPrevented || !ALBUM_ACTION.test(new URL(f.action, window.location.href).pathname)) return;
      e.preventDefault();
      if (albumBusy) return;
      albumBusy = true;
      var inFoil = !!f.closest('[data-foil-modal]');
      var cardId = modal && modal.open ? modal.getAttribute('data-card') : null; // das Kartenfenster darunter bleibt offen
      var refresh = function () {
        return fetch('/tcg/album', { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
          .then(function (r) { return r.text(); })
          .then(applyAlbum);
      };
      fetch(f.action, { method: 'POST', body: new URLSearchParams(new FormData(f)), credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch', Accept: 'application/json, text/html' } })
        .then(function (r) {
          var json = /json/.test(r.headers.get('Content-Type') || '');
          if (json) {
            // Favorit: JSON statt Weiterleitung – danach den Stand holen
            return r.json().then(function (j) {
              return refresh().then(function (res) { if (!j.ok) res.message = { text: j.error, error: true }; return res; });
            });
          }
          if (!r.ok) throw new Error('fetch');
          if (!/\/tcg\/album$/.test(new URL(r.url).pathname)) { window.location.href = r.url; return null; } // z. B. Anmeldung abgelaufen
          return r.text().then(applyAlbum);
        })
        .then(function (result) {
          albumBusy = false;
          if (!result) return;
          if (inFoil) {
            var fm = $('[data-foil-modal]');
            if (fm && fm.open) fm.close();
          }
          finish(result, cardId);
        })
        .catch(function () { albumBusy = false; f.submit(); }); // ohne fetch wie früher: normale Weiterleitung
    });
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

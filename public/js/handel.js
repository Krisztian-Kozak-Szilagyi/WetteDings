(function () {
  'use strict';

  // Handel: Reiter, Markt filtern und sortieren, Karten in Angeboten vergrößern, Nachrichten der Verhandlung live nachladen
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // ---------- Black Market: nach einem Kauf (#blackmarket) aufgeklappt zeigen ----------
  var bm = $('details#blackmarket');
  if (bm && window.location.hash === '#blackmarket') bm.open = true;

  // ---------- Miniaturen in den Angeboten vergrößern ----------
  var zoom = $('[data-zoom-modal]');
  if (zoom) {
    var zoomTilt = $('[data-zoom-tilt]', zoom);
    if (window.tcgBindTilt) window.tcgBindTilt(zoomTilt);
    var closeZoom = function () {
      if (typeof zoom.close === 'function') zoom.close();
      else zoom.removeAttribute('open');
    };
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-zoom-card]');
      if (!btn) return;
      var d = btn.dataset;
      var owned = parseInt(d.owned, 10) || 0;
      zoomTilt.className = 'tcg-zoom r-' + d.rarity; // Seltenheits-Effekte wie im Album
      var img = $('[data-zoom-img]', zoom);
      img.src = d.image;
      img.alt = d.name + ' (' + d.rarityLabel + ')';
      $('[data-zoom-name]', zoom).textContent = d.name;
      var badge = $('[data-zoom-rarity]', zoom);
      badge.textContent = d.rarityLabel;
      badge.className = 'tcg-badge r-' + d.rarity;
      $('[data-zoom-meta]', zoom).textContent = 'Kartenwert ' + d.sellText + ' · ' + (owned ? 'du besitzt ' + owned + ' Stück' : 'fehlt dir noch');
      // Fremde Sammlung: von hier aus einen Tausch für diese Karte vorschlagen
      var tradeLink = $('[data-zoom-trade]', zoom);
      if (tradeLink) {
        tradeLink.hidden = !d.tradeHref;
        if (d.tradeHref) tradeLink.href = d.tradeHref;
        else tradeLink.removeAttribute('href');
      }
      if (typeof zoom.showModal === 'function') zoom.showModal();
      else zoom.setAttribute('open', '');
    });
    $('[data-zoom-close]', zoom).addEventListener('click', closeZoom);
    zoom.addEventListener('click', function (e) {
      if (e.target === zoom) closeZoom();
    });
  }

  // ---------- Reiter: ohne Neuladen umschalten, Adresse mitführen ----------
  var tabBar = $('[data-hx-tabs]');
  if (tabBar) {
    var showPane = function (key, push) {
      var found = false;
      $all('[data-hx-tab]', tabBar).forEach(function (a) {
        var on = a.getAttribute('data-hx-tab') === key;
        if (on) found = true;
        a.classList.toggle('active', on);
        a.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (!found) return;
      $all('[data-hx-pane]').forEach(function (p) { p.hidden = p.getAttribute('data-hx-pane') !== key; });
      if (push) history.replaceState(null, '', '/handel?reiter=' + key);
    };
    $all('[data-hx-tab]', tabBar).forEach(function (a) {
      a.addEventListener('click', function (e) {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        showPane(a.getAttribute('data-hx-tab'), true);
      });
    });
    // alte Sprungmarken (#markt, #eingang …) auf die Reiter abbilden
    var legacy = { '#markt': 'markt', '#eingang': 'an-mich', '#neu': 'verlauf', '#sammlung': 'meine' };
    if (legacy[window.location.hash]) showPane(legacy[window.location.hash], true);
  }

  // ---------- Markt: suchen, nach Seltenheit filtern, sortieren ----------
  var grid = $('[data-mk-grid]');
  if (grid) {
    var tools = $('[data-mk-tools]');
    var search = $('[data-mk-search]', tools);
    var sort = $('[data-mk-sort]', tools);
    var missing = $('[data-mk-missing]', tools);
    var foiled = $('[data-mk-foil]', tools);
    var afford = $('[data-mk-afford]', tools);
    var empty = $('[data-mk-empty]');
    var rarity = 'all';
    var tiles = $all('[data-mk]', grid);
    var num = function (el, key) { return parseFloat(el.getAttribute('data-' + key)) || 0; };
    var sorters = {
      neu: function (a, b) { return num(b, 'created') - num(a, 'created'); },
      'preis-auf': function (a, b) { return num(a, 'price') - num(b, 'price'); },
      'preis-ab': function (a, b) { return num(b, 'price') - num(a, 'price'); },
      selten: function (a, b) { return num(b, 'rank') - num(a, 'rank') || num(a, 'price') - num(b, 'price'); },
      ablauf: function (a, b) { return num(a, 'expires') - num(b, 'expires'); },
    };
    var buyBtn = function (li) { return $('form button[type="submit"]', li); };
    var apply = function () {
      var q = (search.value || '').trim().toLowerCase();
      var shown = 0;
      tiles.forEach(function (li) {
        var btn = buyBtn(li);
        var ok = (rarity === 'all' || li.getAttribute('data-rarity') === rarity) &&
          (!q || li.getAttribute('data-name').indexOf(q) !== -1) &&
          (!missing.checked || li.getAttribute('data-missing') === '1') &&
          (!foiled.checked || li.getAttribute('data-foil') === '1') &&
          (!afford.checked || (btn && !btn.disabled));
        li.hidden = !ok;
        if (ok) shown++;
      });
      empty.hidden = shown > 0;
    };
    var reorder = function () {
      tiles.slice().sort(sorters[sort.value] || sorters.neu).forEach(function (li) { grid.appendChild(li); });
    };
    $all('[data-mk-rarity]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        rarity = btn.getAttribute('data-mk-rarity');
        $all('[data-mk-rarity]').forEach(function (b) {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
        });
        apply();
      });
    });
    search.addEventListener('input', apply);
    [missing, foiled, afford].forEach(function (c) { c.addEventListener('change', apply); });
    sort.addEventListener('change', reorder);
  }

  // ---------- Verhandlung: Nachrichten live nachladen ----------
  var chat = $('[data-chat]');
  if (chat) {
    var since = chat.getAttribute('data-since');
    var version = chat.getAttribute('data-version');
    var meRole = chat.getAttribute('data-me');
    var names = { seller: chat.getAttribute('data-seller-name'), to: chat.getAttribute('data-to-name') };
    var changed = $('[data-chat-changed]');
    var empty = $('[data-chat-empty]');
    var textarea = $('.nego-send textarea');

    var scrollDown = function () { chat.scrollTop = chat.scrollHeight; };
    var append = function (m) {
      var li = document.createElement('li');
      var time = document.createElement('time');
      time.className = 'muted small';
      time.textContent = 'gerade eben';
      if (m.from === 'system') {
        li.className = 'nego-msg nego-msg-system';
        var s = document.createElement('span');
        s.textContent = m.text;
        li.appendChild(s);
        li.appendChild(document.createTextNode(' '));
        li.appendChild(time);
      } else {
        li.className = 'nego-msg' + (m.from === meRole ? ' nego-msg-me' : '');
        var head = document.createElement('span');
        head.className = 'nego-msg-head';
        var who = document.createElement('strong');
        who.textContent = names[m.from] || '';
        head.appendChild(who);
        head.appendChild(document.createTextNode(' '));
        head.appendChild(time);
        var text = document.createElement('span');
        text.className = 'nego-msg-text';
        text.textContent = m.text;
        li.appendChild(head);
        li.appendChild(text);
      }
      chat.appendChild(li);
      if (empty) empty.hidden = true;
    };
    scrollDown();

    var poll = function () {
      if (document.hidden) return;
      fetch(chat.getAttribute('data-url') + '?seit=' + encodeURIComponent(since || ''), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (!data) return;
          if (data.messages.length) {
            data.messages.forEach(append);
            since = data.messages[data.messages.length - 1].at;
            scrollDown();
          }
          // Neue Bedingungen oder Abschluss: Hinweis statt Neuladen, damit eine angefangene Nachricht nicht verloren geht
          if (String(data.version) !== String(version) || data.status !== 'offen') {
            if (textarea && !textarea.value.trim()) window.location.reload();
            else if (changed) changed.hidden = false;
          }
        })
        .catch(function () { /* nächster Versuch beim nächsten Intervall */ });
    };
    if (chat.getAttribute('data-open') === '1') setInterval(poll, 5000);

    // Enter sendet, Umschalt+Enter macht eine neue Zeile
    if (textarea) {
      textarea.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && textarea.value.trim()) {
          e.preventDefault();
          textarea.form.requestSubmit ? textarea.form.requestSubmit() : textarea.form.submit();
        }
      });
      if (window.location.hash === '#chat') textarea.focus();
    }
  }
})();

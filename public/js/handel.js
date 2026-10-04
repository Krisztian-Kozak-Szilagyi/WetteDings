(function () {
  'use strict';

  // Handelsseite: Miniaturen in Angeboten vergrößern; Karte in der Sammlung antippen -> Dialog mit Markt / Privat / Tauschen
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
      if (typeof zoom.showModal === 'function') zoom.showModal();
      else zoom.setAttribute('open', '');
    });
    $('[data-zoom-close]', zoom).addEventListener('click', closeZoom);
    zoom.addEventListener('click', function (e) {
      if (e.target === zoom) closeZoom();
    });
  }

  // ---------- Markt: nach Seltenheit und Kartenname filtern ----------
  var marketBox = $('[data-market]');
  if (marketBox && $('[data-market-item]', marketBox)) {
    var marketSearch = $('[data-market-search]', marketBox);
    var marketEmpty = $('[data-market-empty]', marketBox);
    var marketRarity = 'all';
    var filterMarket = function () {
      var q = (marketSearch.value || '').trim().toLowerCase();
      var shown = 0;
      $all('[data-market-item]', marketBox).forEach(function (li) {
        var ok = (marketRarity === 'all' || li.getAttribute('data-rarity') === marketRarity) && (!q || li.getAttribute('data-name').indexOf(q) !== -1);
        li.hidden = !ok;
        if (ok) shown++;
      });
      marketEmpty.hidden = shown > 0;
    };
    $all('[data-market-rarity]', marketBox).forEach(function (btn) {
      btn.addEventListener('click', function () {
        marketRarity = btn.getAttribute('data-market-rarity');
        $all('[data-market-rarity]', marketBox).forEach(function (b) {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
        });
        filterMarket();
      });
    });
    marketSearch.addEventListener('input', filterMarket);
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

  // ---------- Karte aus der Sammlung anbieten ----------
  var modal = $('[data-trade-modal]');
  if (!modal) return;

  var tabs = $all('[data-trade-tab]', modal);
  var panes = $all('[data-trade-pane]', modal);

  function showTab(key) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-trade-tab') === key;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    panes.forEach(function (p) { p.hidden = p.getAttribute('data-trade-pane') !== key; });
    var first = $('[data-trade-pane="' + key + '"] input:not([type="hidden"])', modal);
    if (first) first.focus();
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { showTab(t.getAttribute('data-trade-tab')); });
  });

  function openFor(slot, tab) {
    var d = slot.dataset;
    var img = $('[data-trade-img]', modal);
    img.src = d.image;
    img.alt = d.name + ' (' + d.rarityLabel + ')';
    img.className = 'r-' + d.rarity;
    $('[data-trade-name]', modal).textContent = d.name;
    var badge = $('[data-trade-rarity]', modal);
    badge.textContent = d.rarityLabel;
    badge.className = 'tcg-badge r-' + d.rarity;
    var copy = d.tradeCopy || '';
    $('[data-trade-meta]', modal).textContent = copy ? 'Foliert am ' + d.foilDate + ' · Wert ' + d.sellText : d.free + ' frei · Kartenwert ' + d.sellText;
    $('[data-trade-art]', modal).classList.toggle('is-foiled', !!copy);
    // Karte in alle drei Formulare eintragen (Tausch nutzt "karte", weil es per GET zur Auswahlseite geht);
    // ein foliertes Exemplar wird über "copy" bzw. "f:<Exemplar>" genau bestimmt
    $all('input[name="card"]', modal).forEach(function (input) { input.value = d.tradeCard; });
    $all('input[name="copy"]', modal).forEach(function (input) { input.value = copy; });
    $all('input[name="karte"]', modal).forEach(function (input) { input.value = copy ? 'f:' + copy : d.tradeCard; });

    if (typeof modal.showModal === 'function') modal.showModal();
    else modal.setAttribute('open', '');
    showTab(tab || 'markt');
  }

  document.addEventListener('click', function (e) {
    var slot = e.target.closest('[data-trade-card]');
    if (slot) openFor(slot);
  });

  // Weiter zur Tausch-Auswahl: diese Seite so im Verlauf ablegen, dass "Zurück" wieder im Dialog landet
  var swapForm = $('[data-trade-pane="tausch"]', modal);
  swapForm.addEventListener('submit', function () {
    var params = new URLSearchParams({ karte: swapForm.elements.karte.value, reiter: 'tausch', an: swapForm.elements.an.value.trim() });
    history.replaceState(null, '', '/handel?' + params + '#sammlung');
  });

  // Rückweg von der Tausch-Auswahl (?karte=…&reiter=tausch&an=…): Dialog derselben Karte wieder öffnen
  var query = new URLSearchParams(window.location.search);
  var backCard = query.get('karte');
  if (backCard) {
    var backSlot = $all('[data-trade-card]').filter(function (s) {
      return backCard.indexOf('f:') === 0 ? s.dataset.tradeCopy === backCard.slice(2) : s.dataset.tradeCard === backCard && !s.dataset.tradeCopy;
    })[0];
    if (backSlot) {
      openFor(backSlot, query.get('reiter') || 'markt');
      if (query.get('an')) {
        swapForm.elements.an.value = query.get('an');
        swapForm.elements.an.select();
      }
    }
    // Parameter entfernen, damit ein Neuladen den Dialog nicht erneut öffnet
    history.replaceState(null, '', '/handel' + window.location.hash);
  }

  function closeModal() {
    if (typeof modal.close === 'function') modal.close();
    else modal.removeAttribute('open');
  }
  $('[data-trade-close]', modal).addEventListener('click', closeModal);
  // Klick auf den Hintergrund schließt
  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeModal();
  });
})();

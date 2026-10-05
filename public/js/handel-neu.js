(function () {
  'use strict';

  // Handelsfenster (/handel/neu und Gegenangebote): Karten antippen legt sie in die Ablage oben, "−" nimmt eine weg.
  // Geld fließt nur in eine Richtung; Zusammenfassung mit Kartenwert, Wertvergleich und Steuer.
  // Ohne JS gehen die Zahlenfelder unter den Karten direkt.
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var root = $('[data-hb]');
  if (!root) return;
  root.classList.add('hb-js');
  var isMarket = root.getAttribute('data-market') === '1';
  var isListing = root.getAttribute('data-listing') === '1';
  var maxLines = parseInt(root.getAttribute('data-max-lines'), 10) || 10;
  var balance = parseInt(root.getAttribute('data-balance'), 10) || 0;
  var tax = {
    markt: parseFloat(root.getAttribute('data-tax-markt')) || 0,
    privat: parseFloat(root.getAttribute('data-tax-privat')) || 0,
    tausch: parseFloat(root.getAttribute('data-tax-tausch')) || 0,
  };
  var fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  var euro = function (cents) { return fmt.format((cents || 0) / 100); };
  var cents = function (text) {
    var s = String(text || '').trim().replace(/[\s€]/g, '');
    if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, '');
    if (!/^\d{1,9}([.,]\d{1,2})?$/.test(s)) return 0;
    var parts = s.split(/[.,]/);
    return parseInt(parts[0], 10) * 100 + parseInt(((parts[1] || '') + '00').slice(0, 2), 10);
  };
  var cardsWord = function (n) { return n + (n === 1 ? ' Karte' : ' Karten'); };

  // ---------- Reiter: eine Sammlung zur Zeit ----------
  var tabs = $all('[data-hb-tab]', root);
  function showPane(side) {
    if (!tabs.length) return;
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-hb-tab') === side;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $all('[data-hb-pane]', root).forEach(function (p) { p.hidden = p.getAttribute('data-hb-pane') !== side; });
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { showPane(t.getAttribute('data-hb-tab')); }); });
  // Klick auf eine Seite im Handelsfenster öffnet die passende Sammlung
  $all('[data-hb-open]', root).forEach(function (btn) {
    btn.addEventListener('click', function () {
      var side = btn.getAttribute('data-hb-open');
      showPane(side);
      var pane = $('[data-hb-pane="' + side + '"]', root);
      if (pane) pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  showPane('gib');

  // ---------- Mengen ----------
  var qtyInput = function (slot) { return $('input[type="number"]', slot); };
  var qty = function (slot) {
    var input = qtyInput(slot);
    var box = $('input[type="checkbox"]', slot);
    return input ? parseInt(input.value, 10) || 0 : box && box.checked ? 1 : 0;
  };
  var refresh = function (slot) {
    var n = qty(slot);
    var input = qtyInput(slot);
    var badge = $('[data-hb-badge]', slot);
    if (badge) {
      badge.hidden = !n;
      badge.textContent = '×' + n;
    }
    slot.classList.toggle('is-picked', n > 0);
    slot.classList.toggle('is-full', !!input && n >= (parseInt(input.max, 10) || 0));
  };
  var setQty = function (slot, n) {
    var input = qtyInput(slot);
    if (input) input.value = String(Math.max(0, Math.min(parseInt(input.max, 10) || 0, n)));
    refresh(slot);
  };
  var slots = $all('[data-hb-slot]', root);
  slots.forEach(function (slot) {
    refresh(slot);
    var input = qtyInput(slot);
    if (input) input.addEventListener('input', function () { refresh(slot); update(); });
    $all('[data-hb-step]', slot).forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        setQty(slot, qty(slot) + parseInt(btn.getAttribute('data-hb-step'), 10));
        update();
      });
    });
    var box = $('input[type="checkbox"]', slot);
    if (box) box.addEventListener('change', function () { refresh(slot); update(); });
  });

  // ---------- Suche je Sammlung (die Seltenheit filtert public/js/tcg.js über hidden) ----------
  $all('[data-hb-search]', root).forEach(function (input) {
    var picker = input.closest('.hb-picker');
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      $all('[data-hb-slot]', picker).forEach(function (slot) {
        var ok = !q || slot.getAttribute('data-name').indexOf(q) !== -1;
        slot.classList.toggle('is-search-hidden', !ok);
        if (ok) shown++;
      });
      var none = $('[data-hb-none]', picker);
      if (none) none.hidden = shown > 0;
    });
  });

  // ---------- Geld fließt nur in eine Richtung ----------
  var moneyGive = $('[data-hb-money="gib"]', root);
  var moneyGet = $('[data-hb-money="will"]', root);
  [[moneyGive, moneyGet], [moneyGet, moneyGive]].forEach(function (pair) {
    if (!pair[0]) return;
    pair[0].addEventListener('input', function () {
      if (pair[1] && cents(pair[0].value) > 0) pair[1].value = '';
      update();
    });
  });

  // ---------- Auswahl einer Seite ----------
  function picked(side) {
    var out = { items: [], count: 0, value: 0 };
    var pane = $('[data-hb-pane="' + side + '"]', root);
    if (pane) {
      $all('[data-hb-slot]', pane).forEach(function (slot) {
        var n = qty(slot);
        if (!n) return;
        out.items.push({ slot: slot, n: n, label: slot.getAttribute('data-label'), image: slot.getAttribute('data-image'), foil: slot.hasAttribute('data-foil'), item: slot.classList.contains('is-item') });
        out.count += n;
        out.value += (parseInt(slot.getAttribute('data-value'), 10) || 0) * n;
      });
    }
    var fixed = $('[data-hb-fixed="' + side + '"]', root);
    if (fixed) {
      out.count += parseInt(fixed.getAttribute('data-count'), 10) || 0;
      out.value += parseInt(fixed.getAttribute('data-value'), 10) || 0;
    }
    return out;
  }

  // ---------- Ablage: gewählte Karten als Mini-Karten im Handelsfenster ----------
  function renderTray(side, sel) {
    var tray = $('[data-hb-tray="' + side + '"]', root);
    if (!tray) return;
    $all('.hb-mini', tray).forEach(function (li) { li.remove(); });
    sel.items.forEach(function (it) {
      var li = document.createElement('li');
      li.className = 'hb-mini' + (it.foil ? ' is-foil' : '') + (it.item ? ' is-item' : '');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.title = it.label + ' – antippen zum Entfernen';
      btn.setAttribute('aria-label', (it.n > 1 ? it.n + '× ' : '') + it.label + ' entfernen');
      var img = document.createElement('img');
      img.src = it.image;
      img.alt = '';
      btn.appendChild(img);
      if (it.n > 1) {
        var n = document.createElement('span');
        n.className = 'hb-mini-n';
        n.textContent = '×' + it.n;
        btn.appendChild(n);
      }
      var x = document.createElement('span');
      x.className = 'hb-mini-x';
      x.textContent = '×';
      btn.appendChild(x);
      btn.addEventListener('click', function () {
        var box = $('input[type="checkbox"]', it.slot);
        if (box) {
          box.checked = false;
          refresh(it.slot);
        } else setQty(it.slot, qty(it.slot) - 1);
        update();
      });
      li.appendChild(btn);
      tray.appendChild(li);
    });
    tray.classList.toggle('is-empty', !sel.items.length);
  }

  // ---------- Zusammenfassung ----------
  var summary = $('[data-hb-summary]', root);
  var note = $('[data-hb-note]', root);
  var submit = $('[data-hb-submit]', root);
  var balanceBox = $('[data-hb-balance]', root);
  var baseNote = note ? note.textContent.trim() : '';

  function sideText(sel, money) {
    var parts = [];
    if (sel.count) parts.push(cardsWord(sel.count));
    if (money) parts.push(euro(money));
    return parts.join(' + ') || 'nichts';
  }

  function update() {
    var give = picked('gib');
    var get = picked('will');
    var pay = moneyGive ? cents(moneyGive.value) : 0;
    var receive = moneyGet ? cents(moneyGet.value) : 0;
    renderTray('gib', give);
    renderTray('will', get);
    $all('[data-hb-sum]', root).forEach(function (el) {
      var side = el.getAttribute('data-hb-sum');
      var sel = side === 'gib' ? give : get;
      el.textContent = sel.count ? 'Wert ' + euro(sel.value) : '';
    });
    // Wertvergleich: was ich bekomme minus was ich gebe (Kartenwert + Geld)
    if (balanceBox) {
      var diff = get.value + receive - give.value - pay;
      var any = give.count || get.count;
      balanceBox.hidden = !any;
      balanceBox.textContent = !diff ? 'gleicher Wert' : (diff > 0 ? '+' : '−') + euro(Math.abs(diff));
      balanceBox.className = 'hb-balance' + (diff > 0 ? ' is-pos' : diff < 0 ? ' is-neg' : '');
      balanceBox.title = diff > 0 ? 'Du bekommst mehr Kartenwert, als du gibst' : diff < 0 ? 'Du gibst mehr Kartenwert, als du bekommst' : '';
    }

    var kind = give.count && get.count ? 'tausch' : isMarket || isListing ? 'markt' : 'privat';
    var problems = [];
    if (!give.count && !get.count) problems.push(isMarket ? 'Wähle unten Karten aus deiner Sammlung – oder Wunschkarten für ein Gesuch.' : 'Wähle Karten – auf einer der beiden Seiten.');
    if (give.count > maxLines || get.count > maxLines) problems.push('Höchstens ' + maxLines + ' Karten je Seite.');
    if (give.count && !get.count && !receive) problems.push(isMarket ? 'Gib einen Preis an – oder wähle Wunschkarten, dann wird getauscht.' : 'Ohne Karten zurück: Gib an, wie viel du dafür bekommst.');
    if (!give.count && get.count && !pay) problems.push('Ohne eigene Karten: Gib an, wie viel du dafür zahlst.');
    if (!give.count && receive) problems.push('Wer keine Karte gibt, muss zahlen – trag das Geld bei „Du gibst“ ein.');
    if (!get.count && pay && give.count) problems.push('Wer keine Karte gibt, muss zahlen – trag das Geld bei „Du bekommst“ ein.');
    if (pay > balance) problems.push('Dein Guthaben reicht dafür nicht (' + euro(balance) + ').');

    var nothing = !give.count && !get.count;
    if (summary) {
      summary.textContent = nothing ? problems[0] : 'Du gibst ' + sideText(give, pay) + ' · du bekommst ' + sideText(get, receive);
      summary.classList.toggle('is-empty', nothing);
    }
    if (note) {
      var rate = tax[kind];
      var t = receive && rate ? Math.floor(receive * rate / 100) : 0;
      var shown = nothing ? [] : problems;
      note.textContent = shown.length ? shown.join(' ') : [t ? 'Nach ' + String(rate).replace('.', ',') + ' % Steuer erhältst du ' + euro(receive - t) + '.' : '', baseNote].filter(Boolean).join(' ');
      note.classList.toggle('is-problem', shown.length > 0);
    }
    if (submit) submit.disabled = nothing || problems.length > 0;
  }
  update();

  // ---------- Handelsfenster klebt oben: dann kompakter ----------
  var win = $('[data-hb-window]', root);
  var sentinel = $('[data-hb-sentinel]', root);
  if (win && sentinel && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      win.classList.toggle('is-stuck', !entries[0].isIntersecting);
    }, { rootMargin: '-72px 0px 0px 0px' }).observe(sentinel);
  }
  // Nach dem Antippen einer Karte ist das Fenster sichtbar – auf dem Handy kurz anstupsen, dass sich oben etwas getan hat
  if (win) {
    root.addEventListener('click', function (e) {
      if (!e.target.closest('[data-hb-pane] [data-hb-step]')) return;
      win.classList.remove('is-bumped');
      void win.offsetWidth;
      win.classList.add('is-bumped');
    });
  }

  // ---------- Ziel wechseln: eigene Auswahl mitnehmen ----------
  var target = $('[data-hb-target]');
  if (target) {
    var carry = function () {
      $all('[data-hb-carry]', target).forEach(function (el) { el.remove(); });
      var add = function (value) {
        var input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'gib';
        input.value = value;
        input.setAttribute('data-hb-carry', '');
        target.appendChild(input);
      };
      picked('gib').items.forEach(function (it) {
        var box = $('input[type="checkbox"]', it.slot);
        if (box) add(box.value);
        else for (var i = 0; i < it.n; i++) add(qtyInput(it.slot).name.slice(4));
      });
      return $all('[data-hb-carry]', target).map(function (el) { return 'gib=' + encodeURIComponent(el.value); }).join('&');
    };
    target.addEventListener('submit', carry);
    var toMarket = $('[data-hb-to-market]', target);
    if (toMarket) {
      toMarket.addEventListener('click', function (e) {
        e.preventDefault();
        var q = carry();
        window.location.href = '/handel/neu' + (q ? '?' + q : '');
      });
    }
  }
})();

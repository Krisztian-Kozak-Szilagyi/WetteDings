(function () {
  'use strict';

  // Handelsfenster (/handel/neu und Gegenangebote): Mengen per Knopf, Ablage der gewählten Karten,
  // Geld nur in eine Richtung, Zusammenfassung mit Kartenwert und Steuer. Ohne JS gehen die Zahlenfelder direkt.
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var root = $('[data-hb]');
  if (!root) return;
  var isMarket = root.getAttribute('data-market') === '1';
  var isListing = root.getAttribute('data-listing') === '1';
  var maxLines = parseInt(root.getAttribute('data-max-lines'), 10) || 10;
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

  // ---------- Mengen ----------
  var qtyInput = function (slot) { return $('input[type="number"]', slot); };
  var setQty = function (slot, n) {
    var input = qtyInput(slot);
    if (!input) return;
    var max = parseInt(input.max, 10) || 0;
    input.value = String(Math.max(0, Math.min(max, n)));
    var badge = $('[data-hb-badge]', slot);
    var v = parseInt(input.value, 10) || 0;
    if (badge) {
      badge.hidden = !v;
      badge.textContent = '×' + v;
    }
    slot.classList.toggle('is-picked', v > 0);
  };
  $all('[data-hb-slot]', root).forEach(function (slot) {
    var input = qtyInput(slot);
    if (input) {
      setQty(slot, parseInt(input.value, 10) || 0);
      input.addEventListener('input', function () { setQty(slot, parseInt(input.value, 10) || 0); update(); });
    }
    $all('[data-hb-step]', slot).forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        setQty(slot, (parseInt(qtyInput(slot).value, 10) || 0) + parseInt(btn.getAttribute('data-hb-step'), 10));
        update();
      });
    });
    var box = $('input[type="checkbox"]', slot);
    if (box) {
      slot.classList.toggle('is-picked', box.checked);
      box.addEventListener('change', function () { slot.classList.toggle('is-picked', box.checked); update(); });
    }
  });

  // ---------- Suche je Seite (die Seltenheit filtert public/js/tcg.js über hidden) ----------
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

  // ---------- Auswahl einer Seite lesen ----------
  function picked(side) {
    var col = $('[data-hb-side="' + side + '"]', root);
    var out = { items: [], count: 0, value: 0 };
    if (!col) return out;
    $all('[data-hb-slot]', col).forEach(function (slot) {
      var input = qtyInput(slot);
      var box = $('input[type="checkbox"]', slot);
      var n = input ? parseInt(input.value, 10) || 0 : box && box.checked ? 1 : 0;
      if (!n) return;
      var value = parseInt(slot.getAttribute('data-value'), 10) || 0;
      out.items.push({ slot: slot, n: n, label: slot.getAttribute('data-label'), image: slot.getAttribute('data-image'), foil: slot.hasAttribute('data-foil') });
      out.count += n;
      out.value += value * n;
    });
    var fixed = $('[data-hb-fixed-value]', col);
    if (fixed) {
      out.count += parseInt(fixed.getAttribute('data-hb-fixed-count'), 10) || 0;
      out.value += parseInt(fixed.getAttribute('data-hb-fixed-value'), 10) || 0;
      out.fixed = true;
    }
    return out;
  }

  // ---------- Ablage: gewählte Karten oben in der Spalte ----------
  function renderTray(side, sel) {
    var tray = $('[data-hb-tray="' + side + '"]', root);
    if (!tray) return;
    var empty = $('.hb-tray-empty', tray);
    $all('.hb-chip', tray).forEach(function (li) { li.remove(); });
    sel.items.forEach(function (it) {
      var li = document.createElement('li');
      li.className = 'hb-chip' + (it.foil ? ' is-foil' : '');
      var img = document.createElement('img');
      img.src = it.image;
      img.alt = '';
      img.width = 36;
      img.height = 50;
      var label = document.createElement('span');
      label.textContent = (it.n > 1 ? it.n + '× ' : '') + it.label;
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'hb-chip-x';
      x.setAttribute('aria-label', it.label + ' entfernen');
      x.textContent = '×';
      x.addEventListener('click', function () {
        var box = $('input[type="checkbox"]', it.slot);
        if (box) box.checked = false;
        else setQty(it.slot, (parseInt(qtyInput(it.slot).value, 10) || 0) - 1);
        it.slot.classList.toggle('is-picked', box ? false : (parseInt(qtyInput(it.slot).value, 10) || 0) > 0);
        update();
      });
      li.appendChild(img);
      li.appendChild(label);
      li.appendChild(x);
      tray.appendChild(li);
    });
    if (empty) empty.hidden = sel.items.length > 0;
  }

  // ---------- Zusammenfassung ----------
  var summary = $('[data-hb-summary]', root);
  var note = $('[data-hb-note]', root);
  var submit = $('[data-hb-submit]', root);
  var sumGive = $('[data-hb-sum="gib"]', root);
  var sumGet = $('[data-hb-sum="will"]', root);
  var baseNote = note ? note.textContent.trim() : '';

  function sideText(sel, money) {
    var parts = [];
    if (sel.count) parts.push(cardsWord(sel.count) + ' (Wert ' + euro(sel.value) + ')');
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
    if (sumGive) sumGive.textContent = give.count || pay ? sideText(give, pay) : '';
    if (sumGet) sumGet.textContent = get.count || receive ? sideText(get, receive) : '';

    var kind = give.count && get.count ? 'tausch' : isMarket || isListing ? 'markt' : 'privat';
    var problems = [];
    if (!give.count && !get.count) problems.push(isMarket ? 'Wähle mindestens eine Karte.' : 'Wähle mindestens eine Karte – auf einer der beiden Seiten.');
    if (give.count > maxLines || get.count > maxLines) problems.push('Höchstens ' + maxLines + ' Karten je Seite.');
    if (isMarket && give.count && !receive) problems.push('Gib einen Preis an.');
    if (!isMarket && give.count && !get.count && !receive) problems.push('Ohne Karten zurück: Gib an, wie viel du dafür bekommst.');
    if (!isMarket && !give.count && get.count && !pay) problems.push('Ohne eigene Karten: Gib an, wie viel du dafür zahlst.');
    if (!isMarket && !give.count && receive) problems.push('Wer keine Karte gibt, muss zahlen – trag das Geld bei „Du gibst“ ein.');
    if (!isMarket && !get.count && pay && give.count) problems.push('Wer keine Karte gibt, muss zahlen – trag das Geld bei „Du bekommst“ ein.');
    var balance = parseInt(root.getAttribute('data-balance'), 10) || 0;
    if (pay > balance) problems.push('Dein Guthaben reicht dafür gerade nicht (' + euro(balance) + ').');

    // Noch nichts gewählt: nur der Hinweis oben; sonst oben das Angebot, darunter Probleme (rot) oder Steuer und Laufzeit
    var nothing = !give.count && !get.count;
    if (summary) {
      summary.textContent = nothing ? problems[0] : 'Du gibst ' + sideText(give, pay) + ' · Du bekommst ' + sideText(get, receive);
      summary.classList.toggle('is-problem', nothing);
    }
    if (note) {
      var rate = tax[kind];
      var t = receive && rate ? Math.floor(receive * rate / 100) : 0;
      var shown = nothing ? [] : problems;
      note.textContent = shown.length ? shown.join(' ') : [t ? 'Nach ' + String(rate).replace('.', ',') + ' % Steuer erhältst du ' + euro(receive - t) + '.' : '', baseNote].filter(Boolean).join(' ');
      note.classList.toggle('neg', shown.length > 0);
    }
    if (submit) submit.disabled = !give.count && !get.count;
  }
  update();

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

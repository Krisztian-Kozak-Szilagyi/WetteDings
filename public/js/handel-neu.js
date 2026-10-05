(function () {
  'use strict';

  // Handelsfenster (/handel/neu und Gegenangebote): Karten antippen oder ins Fenster ziehen legt sie in die Ablage
  // oben, "−" oder Herausziehen nimmt eine weg.
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
    $all('[data-hb-pane]:not([data-hb-store])', root).forEach(function (p) { p.hidden = p.getAttribute('data-hb-pane') !== side; });
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { showPane(t.getAttribute('data-hb-tab')); }); });
  // Klick auf eine Seite im Handelsfenster öffnet die passende Sammlung
  $all('[data-hb-open]', root).forEach(function (btn) {
    btn.addEventListener('click', function () {
      var side = btn.getAttribute('data-hb-open');
      // Markt: Wunschkarten kommen aus der Suche im Fenster
      var wishField = side === 'will' && $('[data-hb-wish-input]', root);
      if (wishField) return wishField.focus();
      showPane(side);
      var pane = $('[data-hb-pane="' + side + '"]:not([data-hb-store])', root);
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
  slots.forEach(function (slot, i) { slot.setAttribute('data-hb-id', String(i)); });
  // Kartenflächen sind <span role="button"> (ziehbar auch in Firefox): Enter und Leertaste wie ein Klick
  $all('.hb-art[role="button"]', root).forEach(function (el) {
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el.click();
      }
    });
  });
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
  // Gegenangebot: Abstand zum verlangten bzw. bisherigen Betrag ("5,00 € weniger")
  var deltas = function () {
    [moneyGive, moneyGet].forEach(function (input) {
      if (!input) return;
      var box = $('[data-hb-ref="' + input.getAttribute('data-hb-money') + '"] [data-hb-delta]', root);
      if (!box) return;
      var ref = parseInt(input.getAttribute('data-ref'), 10) || 0;
      var d = cents(input.value) - ref;
      box.textContent = !ref && !d ? '' : !d ? '· gleich' : '· ' + euro(Math.abs(d)) + (d < 0 ? ' weniger' : ' mehr');
      box.className = 'hb-ref-delta' + (d < 0 ? ' is-less' : d > 0 ? ' is-more' : '');
    });
  };
  [[moneyGive, moneyGet], [moneyGet, moneyGive]].forEach(function (pair) {
    if (!pair[0]) return;
    pair[0].addEventListener('input', function () {
      if (pair[1] && cents(pair[0].value) > 0) pair[1].value = '';
      deltas();
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

  // Eine Karte dazu bzw. weg (Antippen, Ziehen, Mini-Karte)
  function addOne(slot) {
    var box = $('input[type="checkbox"]', slot);
    if (box) {
      box.checked = true;
      refresh(slot);
    } else setQty(slot, qty(slot) + 1);
    update();
  }
  function removeOne(slot) {
    var box = $('input[type="checkbox"]', slot);
    if (box) {
      box.checked = false;
      refresh(slot);
    } else setQty(slot, qty(slot) - 1);
    update();
  }

  // ---------- Ablage: gewählte Karten als aufgefächerte Hand im Handelsfenster ----------
  // Jede Karte behält ihr Element (nur neue fliegen herein); gleiche Karten liegen als Stapel mit Zähler.
  var rarityOf = function (slot) { var m = /(?:^|\s)(r-[a-z]+)/.exec(slot.className); return m ? m[1] : ''; };
  function miniFor(it) {
    var li = document.createElement('li');
    li.className = 'hb-mini is-new ' + rarityOf(it.slot) + (it.foil ? ' is-foil' : '') + (it.item ? ' is-item' : '');
    li.setAttribute('data-hb-key', it.slot.getAttribute('data-hb-id'));
    var card = document.createElement('span');
    card.className = 'hb-mini-card';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.draggable = true;
    card.setAttribute('data-hb-out', it.slot.getAttribute('data-hb-id'));
    var img = document.createElement('img');
    img.src = it.image;
    img.alt = '';
    img.draggable = false;
    card.appendChild(img);
    if (it.foil) {
      var sheen = document.createElement('span');
      sheen.className = 'hb-mini-sheen';
      card.appendChild(sheen);
    }
    var x = document.createElement('span');
    x.className = 'hb-mini-x';
    x.setAttribute('aria-hidden', 'true');
    x.textContent = '×';
    card.appendChild(x);
    var n = document.createElement('span');
    n.className = 'hb-mini-n';
    card.appendChild(n);
    var tip = document.createElement('span');
    tip.className = 'hb-mini-tip';
    tip.setAttribute('aria-hidden', 'true');
    li.appendChild(card);
    li.appendChild(tip);
    card.addEventListener('click', function () { removeOne(it.slot); });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeOne(it.slot);
      }
    });
    li.addEventListener('animationend', function () { li.classList.remove('is-new'); });
    return li;
  }
  function renderTray(side, sel) {
    var tray = $('[data-hb-tray="' + side + '"]', root);
    if (!tray) return;
    var have = {};
    $all('.hb-mini', tray).forEach(function (li) { have[li.getAttribute('data-hb-key')] = li; });
    var keep = {};
    sel.items.forEach(function (it, i) {
      var key = it.slot.getAttribute('data-hb-id');
      var li = have[key] || miniFor(it);
      keep[key] = true;
      tray.appendChild(li); // Reihenfolge wie in der Sammlung
      li.style.setProperty('--i', String(i));
      li.classList.toggle('is-stack', it.n > 1);
      li.classList.toggle('is-stack-3', it.n > 2);
      $('.hb-mini-n', li).textContent = it.n > 1 ? '×' + it.n : '';
      var value = (parseInt(it.slot.getAttribute('data-value'), 10) || 0) * it.n;
      $('.hb-mini-tip', li).textContent = (it.n > 1 ? it.n + '× ' : '') + it.label + ' · ' + euro(value);
      var card = $('.hb-mini-card', li);
      card.title = it.label + ' – antippen oder herausziehen zum Entfernen';
      card.setAttribute('aria-label', (it.n > 1 ? it.n + '× ' : '') + it.label + ' entfernen');
    });
    Object.keys(have).forEach(function (key) { if (!keep[key]) have[key].remove(); });
    tray.style.setProperty('--n', String(Math.max(1, sel.items.length)));
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
  deltas();

  // ---------- Wunschkarten (Markt): Suche mit Vorschlägen direkt im Fenster ----------
  // Alle passenden Karten, fehlende zuerst, dann von häufig nach selten; Chips filtern nach Seltenheit.
  // Ausgewählt wird der unsichtbare Platz der Karte,
  // so laufen Ablage, Zähler und Formular wie bei allen anderen Karten.
  var wish = $('[data-hb-wish]', root);
  if (wish) {
    var wishInput = $('[data-hb-wish-input]', wish);
    var wishList = $('[data-hb-wish-list]', wish);
    var wishPop = $('[data-hb-wish-pop]', wish);
    var wishChips = $('[data-hb-wish-chips]', wish);
    var wishRarity = 'all';
    var store = $all('[data-hb-store] [data-hb-slot]', root);
    var wishActive = -1;
    var shown = [];
    var owned = function (slot) { return parseInt(slot.getAttribute('data-owned'), 10) || 0; };
    var rank = function (slot) { return parseInt(slot.getAttribute('data-rank'), 10) || 0; };
    var closeWish = function () {
      wishPop.hidden = true;
      wishInput.setAttribute('aria-expanded', 'false');
      wishActive = -1;
    };
    var mark = function (i) {
      wishActive = i;
      $all('.hb-wish-opt', wishList).forEach(function (li, k) {
        li.classList.toggle('is-active', k === i);
        li.setAttribute('aria-selected', k === i ? 'true' : 'false');
        if (k === i) li.scrollIntoView({ block: 'nearest' });
      });
    };
    var pick = function (slot) {
      if (!canPick(slot)) return;
      addOne(slot);
      wishInput.value = '';
      fill();
      wishInput.focus();
      var w = $('[data-hb-window]', root);
      if (w) {
        w.classList.remove('is-bumped');
        void w.offsetWidth;
        w.classList.add('is-bumped');
      }
    };
    var canPick = function (slot) { return !slot.classList.contains('is-full'); };
    var fill = function () {
      var q = wishInput.value.trim().toLowerCase();
      shown = store
        .filter(function (s) { return !q || s.getAttribute('data-name').indexOf(q) !== -1; })
        .filter(function (s) { return wishRarity === 'all' || s.getAttribute('data-rarity') === wishRarity; })
        .sort(function (a, b) { return (owned(a) > 0) - (owned(b) > 0) || rank(a) - rank(b) || a.getAttribute('data-label').localeCompare(b.getAttribute('data-label'), 'de'); });
      wishList.textContent = '';
      if (!shown.length) {
        var none = document.createElement('li');
        none.className = 'hb-wish-none';
        none.textContent = 'Keine Karte gefunden.';
        wishList.appendChild(none);
      }
      shown.forEach(function (slot, i) {
        var li = document.createElement('li');
        var m = /(?:^|\s)(r-[a-z]+)/.exec(slot.className);
        li.className = 'hb-wish-opt ' + (m ? m[1] : '') + (canPick(slot) ? '' : ' is-full');
        li.setAttribute('role', 'option');
        li.id = 'hb-wish-' + i;
        var img = document.createElement('img');
        img.src = slot.getAttribute('data-image');
        img.alt = '';
        var name = document.createElement('span');
        name.className = 'hb-wish-name';
        name.textContent = slot.getAttribute('data-label').replace(/ \([^)]*\)$/, '');
        var meta = document.createElement('span');
        meta.className = 'hb-wish-meta';
        meta.innerHTML = '<span class="tcg-dot"></span>';
        meta.appendChild(document.createTextNode(slot.getAttribute('data-rarity-label') + ' · ' + euro(parseInt(slot.getAttribute('data-value'), 10) || 0)));
        var tag = document.createElement('span');
        var n = owned(slot);
        tag.className = 'hb-wish-tag' + (n ? '' : ' is-missing');
        tag.textContent = qty(slot) ? '×' + qty(slot) + ' gewählt' : n ? 'du hast ' + n : 'fehlt dir';
        li.appendChild(img);
        li.appendChild(name);
        li.appendChild(meta);
        li.appendChild(tag);
        li.addEventListener('mousedown', function (e) { e.preventDefault(); }); // Fokus bleibt im Feld
        li.addEventListener('click', function () { pick(slot); });
        wishList.appendChild(li);
      });
      wishPop.hidden = false;
      wishInput.setAttribute('aria-expanded', 'true');
      mark(shown.length ? 0 : -1);
    };
    var rarities = [];
    store.forEach(function (s) {
      var key = s.getAttribute('data-rarity');
      if (!rarities.some(function (r) { return r.key === key; })) rarities.push({ key: key, label: s.getAttribute('data-rarity-label'), rank: rank(s) });
    });
    rarities.sort(function (a, b) { return a.rank - b.rank; });
    [{ key: 'all', label: 'Alle' }].concat(rarities).forEach(function (r) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'hb-wish-chip' + (r.key === 'all' ? ' active' : ' r-' + r.key);
      chip.setAttribute('aria-pressed', r.key === 'all' ? 'true' : 'false');
      chip.innerHTML = r.key === 'all' ? '' : '<span class="tcg-dot"></span>';
      chip.appendChild(document.createTextNode(r.label));
      chip.addEventListener('mousedown', function (e) { e.preventDefault(); }); // Fokus bleibt im Feld
      chip.addEventListener('click', function () {
        wishRarity = r.key;
        $all('.hb-wish-chip', wishChips).forEach(function (c) {
          c.classList.toggle('active', c === chip);
          c.setAttribute('aria-pressed', c === chip ? 'true' : 'false');
        });
        fill();
        wishInput.focus();
      });
      wishChips.appendChild(chip);
    });
    wishInput.addEventListener('focus', fill);
    wishInput.addEventListener('input', fill);
    wishInput.addEventListener('blur', function () { setTimeout(closeWish, 120); });
    wishInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (wishPop.hidden) fill();
        if (shown.length) mark((wishActive + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
      } else if (e.key === 'Enter') {
        e.preventDefault(); // kein Absenden des Formulars
        if (shown[wishActive]) pick(shown[wishActive]);
      } else if (e.key === 'Escape') {
        closeWish();
      }
    });
  }

  // ---------- Drag & Drop: Karten ins Fenster ziehen, Mini-Karten wieder herausziehen ----------
  // Nur mit Maus o. Ä. – auf Touch-Geräten bleibt es beim Antippen.
  var fine = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (fine) {
    var drag = null; // { kind: 'in' | 'out', side, slot }
    var sideBox = function (side) { return $('[data-hb-side-box="' + side + '"]', root); };
    var paneOf = function (el) { var p = el.closest('[data-hb-pane]'); return p ? p.getAttribute('data-hb-pane') : null; };
    var slotById = function (id) { return $('[data-hb-id="' + id + '"]', root); };
    var bump = function () {
      var w = $('[data-hb-window]', root);
      if (!w) return;
      w.classList.remove('is-bumped');
      void w.offsetWidth;
      w.classList.add('is-bumped');
    };
    var endDrag = function () {
      drag = null;
      root.classList.remove('hb-dragging', 'hb-dragging-out');
      $all('.is-target, .is-over, .is-source', root).forEach(function (el) { el.classList.remove('is-target', 'is-over', 'is-source'); });
    };
    // Vorschau beim Ziehen: kleine Karte statt des Bildes selbst – ein <img> würde der Browser in voller
    // Auflösung (720 × 1008) zeigen. Das Element muss kurz im Dokument stehen, damit es gezeichnet wird.
    var image = function (e, el) {
      var img = $('img', el);
      if (!img || !e.dataTransfer.setDragImage) return;
      var ghost = document.createElement('div');
      ghost.className = 'hb-ghost' + (el.closest('.is-item') ? ' is-item' : '');
      var pic = document.createElement('img');
      pic.src = img.currentSrc || img.src;
      pic.alt = '';
      ghost.appendChild(pic);
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 42, 59);
      setTimeout(function () { ghost.remove(); }, 0);
    };

    // Karte aus der Sammlung aufnehmen
    slots.forEach(function (slot) {
      var side = paneOf(slot);
      if (!side || !$('[data-hb-tray="' + side + '"]', root)) return;
      slot.setAttribute('draggable', 'true');
      slot.addEventListener('dragstart', function (e) {
        var box = $('input[type="checkbox"]', slot);
        if ((box && box.checked) || slot.classList.contains('is-full')) {
          e.preventDefault();
          return;
        }
        drag = { kind: 'in', side: side, slot: slot };
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', slot.getAttribute('data-label') || ''); // Firefox braucht Daten
        image(e, slot);
        root.classList.add('hb-dragging');
        sideBox(side).classList.add('is-target');
      });
      slot.addEventListener('dragend', endDrag);
    });

    // Ablegen auf der passenden Seite des Fensters
    ['gib', 'will'].forEach(function (side) {
      var box = sideBox(side);
      if (!box) return;
      box.addEventListener('dragover', function (e) {
        if (!drag || drag.kind !== 'in' || drag.side !== side) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        box.classList.add('is-over');
      });
      box.addEventListener('dragleave', function (e) {
        if (!box.contains(e.relatedTarget)) box.classList.remove('is-over');
      });
      box.addEventListener('drop', function (e) {
        if (!drag || drag.kind !== 'in' || drag.side !== side) return;
        e.preventDefault();
        var slot = drag.slot;
        endDrag();
        addOne(slot);
        bump();
      });
    });

    // Mini-Karte aus dem Fenster ziehen: irgendwo außerhalb ihrer Seite fallen lassen = eine weniger
    root.addEventListener('dragstart', function (e) {
      var mini = e.target.closest && e.target.closest('[data-hb-out]');
      if (!mini) return;
      var slot = slotById(mini.getAttribute('data-hb-out'));
      if (!slot) return;
      drag = { kind: 'out', side: paneOf(slot), slot: slot };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', slot.getAttribute('data-label') || '');
      image(e, mini);
      root.classList.add('hb-dragging-out');
      sideBox(drag.side).classList.add('is-source');
    });
    document.addEventListener('dragover', function (e) {
      if (!drag || drag.kind !== 'out' || sideBox(drag.side).contains(e.target)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    document.addEventListener('drop', function (e) {
      if (!drag || drag.kind !== 'out' || sideBox(drag.side).contains(e.target)) return;
      e.preventDefault();
      var slot = drag.slot;
      endDrag();
      removeOne(slot);
    });
    document.addEventListener('dragend', function () { if (drag && drag.kind === 'out') endDrag(); });
  }

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

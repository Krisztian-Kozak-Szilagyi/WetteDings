// Karte graden lassen (#204): Bausteine je nach Karte freigeben und bei jedem Shop den Gesamtpreis der Auswahl zeigen.
// Slab gewählt: nur Zweitprüfung (plus Express), der Shop, von dem der Slab stammt, fällt weg. Filter für lange Listen.
(function () {
  var form = document.querySelector('[data-gs-form]');
  if (!form) return;
  var fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  var euro = function (c) { return fmt.format(c / 100); };
  var box = function (k) { return form.querySelector('[data-gs-svc="' + k + '"]'); };
  var ironBox = box('iron');
  var slabBox = box('slab');
  var reviewInput = form.querySelector('[data-gs-review-input]');
  var pkgs = form.querySelectorAll('[data-pkg]');
  var submit = form.querySelector('[data-gs-submit]');
  var summary = form.querySelector('[data-gs-summary]');
  var shopsBox = form.querySelector('[data-ge-shops]');
  var sortKey = 'rep';
  var ticket = {
    preview: form.querySelector('[data-ge-preview]'),
    name: form.querySelector('[data-ge-name]'),
    lines: form.querySelector('[data-ge-lines]'),
    shop: form.querySelector('[data-ge-shopname]'),
    sum: form.querySelector('[data-ge-sum]'),
    note: form.querySelector('[data-ge-note]')
  };
  var shownCard = null;
  var panes = form.querySelectorAll('[data-ge-pane]');
  var stepNo = 0;
  var stepOk = [false, false, false]; // Schritt jeweils vollständig?

  function picked(name) {
    return form.querySelector('input[name="' + name + '"]:checked');
  }

  // Reihenfolge: 1 Shop, 2 Karte, 3 Paket. Der Zettel rechts baut sich in dieser Reihenfolge auf.
  var cardRadios = form.querySelectorAll('input[name="doc"]');
  var eligible = function (radio, k, code) {
    var slab = radio.getAttribute('data-slab');
    if (k === 'review') return !!slab && slab !== code; // der Aussteller kann seinen eigenen Slab nicht nachprüfen
    return !slab && (k === 'grade' || radio.getAttribute('data-ironable') === '1');
  };
  var anyCard = function (k, code) { return Array.prototype.some.call(cardRadios, function (r) { return eligible(r, k, code); }); };
  var keysOf = function (p) { return p.getAttribute('data-keys').split(','); };
  var sumOf = function (keys, prices) { return keys.reduce(function (s, key) { return s + prices[key]; }, 0); };
  // Paket beim Shop möglich? Slab-Pakete brauchen leere Slabs im Lager, und die Karten müssen es hergeben
  var offered = function (p, shopEl) {
    var k = p.getAttribute('data-pkg').replace('-x', '');
    return !(keysOf(p).indexOf('slab') >= 0 && +shopEl.getAttribute('data-slabs') < 1) && anyCard(k, shopEl.getAttribute('data-code'));
  };

  function update() {
    // Schritt 1 – Shops: gesperrt, wenn er für keine deiner Karten ein Paket anbieten kann; „ab“ = sein günstigstes Paket
    form.querySelectorAll('[data-prices]').forEach(function (el) {
      var radio = el.querySelector('input[name="shop"]');
      var p = JSON.parse(el.getAttribute('data-prices'));
      var from = null;
      Array.prototype.forEach.call(pkgs, function (pk) {
        if (/-x$/.test(pk.getAttribute('data-pkg')) || !offered(pk, el)) return;
        var t = sumOf(keysOf(pk), p);
        if (from === null || t < from) from = t;
      });
      radio.disabled = from === null;
      el.classList.toggle('is-off', from === null);
      if (from === null && radio.checked) radio.checked = false;
      el.querySelector('[data-gs-total]').textContent = from === null ? '–' : 'ab ' + euro(from);
      el.setAttribute('data-total', from === null ? 99999999 : from);
    });
    // Preisvergleich: „ab“-Preis jedes freien Shops gegen den Durchschnitt aller freien Shops (±5 % gilt als Durchschnitt)
    var open = Array.prototype.filter.call(form.querySelectorAll('[data-prices]'), function (el) { return !el.classList.contains('is-off'); });
    var avg = open.length ? open.reduce(function (s, el) { return s + +el.getAttribute('data-total'); }, 0) / open.length : 0;
    form.querySelectorAll('[data-prices]').forEach(function (el) {
      var flag = el.querySelector('[data-ge-flag]');
      var off = el.classList.contains('is-off') || open.length < 2;
      flag.hidden = off;
      if (off) return;
      var diff = (+el.getAttribute('data-total') - avg) / avg;
      var kind = diff > 0.05 ? 'high' : diff < -0.05 ? 'low' : 'mid';
      flag.className = 'ge-flag is-' + kind;
      flag.textContent = kind === 'mid' ? '≈ Durchschnittspreis' : (kind === 'high' ? '▲ ' : '▼ ') + Math.round(Math.abs(diff) * 100) + ' % ' + (kind === 'high' ? 'über' : 'unter') + ' Ø';
      flag.title = 'Durchschnitt der freien Shops für deine Karten: ' + euro(Math.round(avg));
    });
    var shop = picked('shop');
    var shopEl = shop ? shop.closest('[data-prices]') : null;
    var shopPrices = shopEl ? JSON.parse(shopEl.getAttribute('data-prices')) : null;
    var code = shop ? shop.value : '';

    // Schritt 2 – nur Karten, die dieser Shop annehmen kann (Slab: nicht vom Shop selbst; sonst Slab-Lager oder Knick nötig)
    var shopSlabs = shopEl ? +shopEl.getAttribute('data-slabs') : 0;
    cardList.forEach(function (c) {
      var isSlab = !!c.radio.getAttribute('data-slab');
      c.ok = !!shopEl && (isSlab ? c.radio.getAttribute('data-slab') !== code : shopSlabs >= 1 || c.radio.getAttribute('data-ironable') === '1');
      if (!c.ok && c.radio.checked) c.radio.checked = false;
    });
    var card = picked('doc');
    if (grid) showPage();

    // Schritt 3 – Pakete für diese Karte bei diesem Shop, mit seinen Preisen
    pkgs.forEach(function (p) {
      var k = p.getAttribute('data-pkg').replace('-x', '');
      p.hidden = !shopEl || !card || !eligible(card, k, code) || (keysOf(p).indexOf('slab') >= 0 && shopSlabs < 1);
      if (shopPrices) p.querySelector('[data-pkg-price]').textContent = euro(sumOf(keysOf(p), shopPrices));
    });
    var pkgInput = picked('pkg');
    if (pkgInput && pkgInput.closest('[data-pkg]').hidden) { pkgInput.checked = false; pkgInput = null; }
    var fast = !!pkgInput && /-x$/.test(pkgInput.value);
    var pkgKey = pkgInput ? pkgInput.value.replace('-x', '') : '';
    var review = pkgKey === 'review';
    reviewInput.value = review ? '1' : '';
    box('express').checked = fast;
    ironBox.checked = pkgKey === 'full' || pkgKey === 'iron';
    slabBox.checked = pkgKey === 'full' || pkgKey === 'grade';
    var want = { iron: ironBox.checked, slab: slabBox.checked, express: fast };
    var total = null;
    if (shopPrices && pkgInput) total = sumOf(keysOf(pkgInput.closest('[data-pkg]')), shopPrices);

    var ok = !!shop && !!card && !!pkgInput;
    stepOk = [!!shop, !!shop && !!card, ok];
    // Einreichen erst im letzten Schritt
    submit.disabled = !ok || stepNo < 2;
    syncWizard();
    summary.textContent = !shop
      ? 'Wähle einen Shop.'
      : !card
        ? 'Wähle eine Karte.'
        : !pkgInput
          ? 'Wähle ein Paket.'
          : (review ? 'Zweitprüfung für „' : '„') + card.getAttribute('data-name') + '“ bei ' + shop.value + ' für ' + euro(total) + '.';
    renderTicket(card, shop, shopPrices, total, review, want, !!pkgInput);
    markSteps({ shop: !!shop, card: !!shop && !!card, svc: ok });
    sortShops();
    form.setAttribute('data-confirm', ok ? summary.textContent + ' Der Preis wird sofort abgebucht, die Karte ist bis zur Rückgabe gesperrt.' + (review ? '' : card.getAttribute('data-sleeve') === '1' ? ' Dein TCG Sleeve bleibt beim Shop (er schützt die Karte beim Versand).' : ' Ohne TCG Sleeve besteht beim Versand ein kleines Risiko für Kratzer oder einen Knick.') : '');
  }

  // Auftragszettel: baut sich Schritt für Schritt auf – Shop, Karte, Posten des Pakets, Summe
  function renderTicket(card, shop, p, total, review, want, hasPkg) {
    if (card !== shownCard) {
      shownCard = card;
      ticket.preview.textContent = '';
      if (card) {
        var img = document.createElement('img');
        img.src = card.getAttribute('data-image');
        img.alt = '';
        img.width = 720;
        img.height = 1008;
        ticket.preview.appendChild(img);
      } else {
        var empty = document.createElement('span');
        empty.className = 'ge-ticket-empty';
        empty.textContent = 'Karte folgt';
        ticket.preview.appendChild(empty);
      }
    }
    ticket.name.textContent = card ? card.getAttribute('data-name') : '';
    ticket.name.hidden = !card;
    ticket.lines.textContent = '';
    if (shop && p && hasPkg) {
      var rows = review ? [['Zweitprüfung', p.review]] : [['Annahme & Reinigung', p.base]];
      if (want.iron) rows.push(['Knick bügeln', p.iron]);
      if (want.slab) rows.push(['Benoten + Slab', p.slab]);
      if (want.express) rows.push(['Express-Zuschlag', p.express]);
      rows.forEach(function (r) {
        var li = document.createElement('li');
        var a = document.createElement('span');
        var b = document.createElement('b');
        a.textContent = r[0];
        b.textContent = euro(r[1]);
        li.appendChild(a);
        li.appendChild(b);
        ticket.lines.appendChild(li);
      });
    }
    var head = shop ? shop.closest('.gs-shop').querySelector('.ge-shop-name') : null;
    ticket.shop.hidden = !head;
    ticket.shop.textContent = head ? head.textContent + ' (' + shop.value + ')' : '';
    ticket.sum.textContent = total != null ? euro(total) : '–';
    ticket.note.textContent = !card || review ? '' : card.getAttribute('data-sleeve') === '1'
      ? '🛡️ Dein TCG Sleeve bleibt beim Shop und schützt die Karte beim Versand.'
      : '⚠️ Ohne TCG Sleeve besteht beim Versand ein kleines Risiko für Kratzer oder einen Knick.';
  }

  // Wizard: ein Schritt nach dem anderen; Weiter erst, wenn der Schritt vollständig ist, Sprung nur zu erreichten Schritten
  function reachable(i) {
    for (var k = 0; k < i; k++) if (!stepOk[k]) return false;
    return true;
  }
  function syncWizard() {
    panes.forEach(function (p, i) { p.hidden = i !== stepNo; });
    form.querySelectorAll('[data-ge-go]').forEach(function (b) {
      var i = +b.getAttribute('data-ge-go');
      b.disabled = !reachable(i);
      if (i === stepNo) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.parentNode.classList.toggle('is-now', i === stepNo);
    });
    // eine Hauptaktion je Schritt: Weiter, im letzten Schritt Einreichen
    form.querySelectorAll('[data-ge-next]').forEach(function (b) { b.hidden = stepNo === 2; b.disabled = !stepOk[stepNo]; });
    submit.hidden = stepNo < 2;
    form.querySelectorAll('[data-ge-back]').forEach(function (b) { b.disabled = stepNo === 0; });
  }
  function goTo(i) {
    if (i < 0 || i > 2 || !reachable(i) || i === stepNo) return;
    stepNo = i;
    update();
    var top = form.getBoundingClientRect().top;
    if (top < 0) window.scrollBy({ top: top - 16, behavior: 'smooth' });
  }
  form.querySelectorAll('[data-ge-go]').forEach(function (b) { b.addEventListener('click', function () { goTo(+b.getAttribute('data-ge-go')); }); });
  form.querySelectorAll('[data-ge-next]').forEach(function (b) { b.addEventListener('click', function () { goTo(stepNo + 1); }); });
  form.querySelectorAll('[data-ge-back]').forEach(function (b) { b.addEventListener('click', function () { goTo(stepNo - 1); }); });

  // Fortschritt oben: erledigte Schritte bekommen ein Häkchen
  function markSteps(done) {
    form.querySelectorAll('[data-ge-step]').forEach(function (li) {
      li.classList.toggle('is-done', !!done[li.getAttribute('data-ge-step')]);
    });
  }

  // Shops sortieren: Reputation (Standard), Gesamtpreis der Auswahl, Warteschlange – gesperrte Shops immer ans Ende
  function sortShops() {
    if (!shopsBox) return;
    var els = Array.prototype.slice.call(shopsBox.children);
    var val = function (el) {
      return sortKey === 'price' ? +el.getAttribute('data-total') : sortKey === 'queue' ? +el.getAttribute('data-queue') : -el.getAttribute('data-rep');
    };
    els.sort(function (a, b) {
      var off = a.classList.contains('is-off') - b.classList.contains('is-off');
      return off || val(a) - val(b) || a.getAttribute('data-order') - b.getAttribute('data-order');
    });
    if (els.some(function (el, i) { return shopsBox.children[i] !== el; })) els.forEach(function (el) { shopsBox.appendChild(el); });
  }
  var sortSel = form.querySelector('[data-ge-sort]');
  if (sortSel) sortSel.addEventListener('change', function () { sortKey = sortSel.value; sortShops(); });

  // Karten seitenweise (eine Reihe pro Seite, damit sie groß bleiben) und durchsuchbar mit Vorschlägen
  var grid = form.querySelector('.ge-cards');
  var pager = form.querySelector('[data-ge-pager]');
  var q = form.querySelector('[data-ge-q]');
  var suggest = form.querySelector('[data-ge-suggest]');
  var noneMsg = form.querySelector('[data-ge-none]');
  var pageNo = 0;
  var query = '';
  var active = -1;
  var norm = function (t) { return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); };
  var cardList = grid ? Array.prototype.map.call(grid.querySelectorAll('.gs-card'), function (el) {
    var radio = el.querySelector('input');
    var label = el.querySelector('.tcg-slot-label');
    var img = el.querySelector('img');
    var name = radio.getAttribute('data-name');
    return { el: el, radio: radio, name: name, extra: label ? label.textContent.replace(name, '').replace(/^[\s·]+/, '') : '', img: img ? img.src : '', key: norm(name), ok: false };
  }) : [];
  function colCount() {
    return getComputedStyle(grid).gridTemplateColumns.split(' ').length || 1;
  }
  function matches() {
    var n = norm(query.trim());
    return cardList.filter(function (c) { return c.ok && (!n || c.key.indexOf(n) >= 0); });
  }
  function showPage() {
    var cols = colCount();
    var hit = matches();
    var count = Math.max(1, Math.ceil(hit.length / cols));
    pageNo = Math.min(pageNo, count - 1);
    cardList.forEach(function (c) {
      var i = hit.indexOf(c);
      c.el.hidden = i < 0 || Math.floor(i / cols) !== pageNo;
    });
    noneMsg.hidden = hit.length > 0;
    pager.hidden = count < 2;
    pager.querySelector('[data-ge-page]').textContent = (pageNo + 1) + ' / ' + count;
    pager.querySelector('[data-ge-prev]').disabled = pageNo === 0;
    pager.querySelector('[data-ge-nextpage]').disabled = pageNo >= count - 1;
  }
  function closeSuggest() {
    suggest.hidden = true;
    active = -1;
    q.setAttribute('aria-expanded', 'false');
  }
  function setActive(i) {
    var items = suggest.children;
    active = i;
    for (var k = 0; k < items.length; k++) items[k].classList.toggle('is-active', k === i);
    if (i >= 0) q.setAttribute('aria-activedescendant', items[i].id); else q.removeAttribute('aria-activedescendant');
  }
  // Vorschlag gewählt: Karte auswählen, Suche leeren und zur Seite der Karte springen
  function pick(c) {
    c.radio.checked = true;
    c.radio.dispatchEvent(new Event('change', { bubbles: true }));
    query = '';
    q.value = '';
    closeSuggest();
    pageNo = Math.floor(cardList.indexOf(c) / colCount());
    showPage();
  }
  function renderSuggest() {
    suggest.textContent = '';
    var list = norm(query.trim()) ? matches().slice(0, 6) : [];
    if (!list.length) return closeSuggest();
    list.forEach(function (c, i) {
      var li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.id = 'ge-sg-' + i;
      if (c.img) {
        var im = document.createElement('img');
        im.src = c.img;
        im.alt = '';
        im.width = 28;
        im.height = 39;
        li.appendChild(im);
      }
      var t = document.createElement('span');
      var b = document.createElement('b');
      b.textContent = c.name;
      t.appendChild(b);
      if (c.extra) {
        var sm = document.createElement('small');
        sm.textContent = c.extra;
        t.appendChild(sm);
      }
      li.appendChild(t);
      // mousedown statt click: das Eingabefeld darf seinen Fokus nicht vorher verlieren
      li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(c); });
      suggest.appendChild(li);
    });
    suggest.hidden = false;
    q.setAttribute('aria-expanded', 'true');
    setActive(-1);
  }
  if (grid && pager && q) {
    pager.querySelector('[data-ge-prev]').addEventListener('click', function () { pageNo--; showPage(); });
    pager.querySelector('[data-ge-nextpage]').addEventListener('click', function () { pageNo++; showPage(); });
    window.addEventListener('resize', showPage);
    q.addEventListener('input', function () { query = q.value; pageNo = 0; showPage(); renderSuggest(); });
    q.addEventListener('focus', renderSuggest);
    q.addEventListener('blur', closeSuggest);
    q.addEventListener('keydown', function (e) {
      var n = suggest.children.length;
      if (e.key === 'ArrowDown' && n) { e.preventDefault(); setActive((active + 1) % n); }
      else if (e.key === 'ArrowUp' && n) { e.preventDefault(); setActive((active - 1 + n) % n); }
      else if (e.key === 'Enter') {
        e.preventDefault(); // nie das Formular abschicken
        var list = matches();
        if (active >= 0) pick(list[active]);
        else if (list.length === 1) pick(list[0]);
      } else if (e.key === 'Escape') closeSuggest();
    });
    showPage();
  }

  form.addEventListener('change', update);
  // Shop schon gewählt (Link vom Profil): gleich bei der Karte beginnen
  if (picked('shop')) stepNo = 1;
  update();
  if (stepNo > 0 && !stepOk[stepNo - 1]) {
    stepNo = 0;
    update();
  }
})();

// Bewerten (#204): nach den Sternen erscheinen passende Schnell-Tags – 4–5 Sterne Lob, 1–3 Kritik, höchstens data-max
(function () {
  document.querySelectorAll('.gs-rate').forEach(function (form) {
    var box = form.querySelector('[data-gs-tags]');
    if (!box) return;
    var max = +box.getAttribute('data-max') || 3;
    function sync() {
      var star = form.querySelector('input[name="stars"]:checked');
      box.hidden = !star;
      if (!star) return;
      var good = +star.value >= 4;
      box.querySelectorAll('.gs-tag').forEach(function (l) {
        var fits = l.classList.contains('is-good') === good;
        l.hidden = !fits;
        if (!fits) l.querySelector('input').checked = false;
      });
      var n = box.querySelectorAll('input:checked').length;
      box.querySelectorAll('input').forEach(function (i) { i.disabled = !i.checked && n >= max; });
    }
    form.addEventListener('change', sync);
    sync();
  });
})();

// ?-Erklärungen: Klick öffnet (auch am Handy), am Desktop reicht Mouseover; Klick daneben oder Escape schließt
(function () {
  var tips = document.querySelectorAll('.ge-desk .help-tip');
  if (!tips.length) return;
  var hover = window.matchMedia && window.matchMedia('(hover: hover)').matches;
  tips.forEach(function (t) {
    if (!hover) return;
    t.addEventListener('mouseenter', function () { t.open = true; });
    t.addEventListener('mouseleave', function () { t.open = false; });
  });
  document.addEventListener('click', function (e) {
    tips.forEach(function (t) { if (t.open && !t.contains(e.target)) t.open = false; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') tips.forEach(function (t) { t.open = false; });
  });
})();

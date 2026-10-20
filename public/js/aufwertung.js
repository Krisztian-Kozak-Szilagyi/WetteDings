// Kartenaufwertung (views/tcg-aufwertung.ejs): Seltenheit wählen, Exemplare in den Vertrag legen, verschmelzen.
// Entschieden wird auf dem Server (POST /tcg/aufwertung, src/tcg/upgrade.js) – hier nur Auswahl und die Walze, die wie
// beim Kistenöffnen an der gezogenen Karte stehen bleibt.
(function () {
  var page = document.querySelector('[data-upgrade]');
  if (!page) return;
  var data = JSON.parse(page.getAttribute('data-upgrade'));
  var csrf = page.getAttribute('data-csrf');
  var COUNT = data.count;
  var $ = function (sel) { return page.querySelector(sel); };
  var grid = $('[data-up-grid]');
  var slotsEl = $('[data-up-slots]');
  var goBtn = $('[data-up-go]');
  var tier = null; // gewählte Seltenheit
  var picked = []; // [{ doc, card }] im Vertrag

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function img(card, cls) {
    var i = el('img', cls);
    i.src = card.image;
    i.alt = card.name;
    i.width = 720;
    i.height = 1008;
    i.loading = 'lazy';
    i.draggable = false;
    return i;
  }
  // freie Exemplare einer Karte, die noch nicht im Vertrag liegen
  function freeDocs(card) {
    var used = new Set(picked.map(function (p) { return p.doc; }));
    return card.docs.filter(function (d) { return !used.has(d); });
  }

  function chooseTier(key) {
    if (tier && tier.key === key) return;
    tier = data.tiers.filter(function (t) { return t.key === key; })[0];
    picked = [];
    page.querySelectorAll('[data-up-tab]').forEach(function (b) { b.setAttribute('aria-selected', b.getAttribute('data-up-tab') === key ? 'true' : 'false'); });
    $('[data-up-pick-title]').textContent = 'Deine ' + tier.label + '-Karten';
    var chanceBox = $('[data-up-chance]');
    chanceBox.className = 'up-chance r-' + tier.next;
    $('[data-up-next]').textContent = tier.nextLabel;
    $('[data-up-chance-value]').textContent = tier.chanceText;
    $('[data-up-else]').textContent = tier.chance >= 1
      ? 'Gelingt sicher: eine zufällige ' + tier.nextLabel + '-Karte.'
      : 'Sonst bekommst du eine zufällige ' + tier.label + '-Karte zurück.';
    drawPool();
    draw();
  }

  function draw() {
    // Auswahl
    grid.innerHTML = '';
    tier.cards.forEach(function (c) {
      var left = freeDocs(c).length;
      var b = el('button', 'up-card r-' + c.rarity);
      b.type = 'button';
      b.title = c.name + ' – ' + left + ' frei' + (c.dupes ? ', davon ' + c.dupes + ' doppelt' : '');
      b.appendChild(img(c));
      var badge = el('span', 'up-card-count', '×' + left);
      b.appendChild(badge);
      if (c.dupes) b.appendChild(el('span', 'up-card-dupe', c.dupes + ' doppelt'));
      b.disabled = !left || picked.length >= COUNT;
      b.addEventListener('click', function () { add(c); });
      grid.appendChild(b);
    });
    $('[data-up-empty]').hidden = tier.cards.length > 0;
    // Vertrag: COUNT Plätze, Klick auf eine Karte nimmt sie wieder heraus
    slotsEl.innerHTML = '';
    for (var i = 0; i < COUNT; i++) {
      var p = picked[i];
      var s = el('button', 'up-slot' + (p ? ' is-full r-' + tier.key : ''));
      s.type = 'button';
      if (p) {
        s.appendChild(img(p.card));
        s.title = p.card.name + ' wieder herausnehmen';
        s.addEventListener('click', remove.bind(null, i));
      } else {
        s.disabled = true;
        s.setAttribute('aria-label', 'freier Platz');
      }
      slotsEl.appendChild(s);
    }
    $('[data-up-filled]').textContent = picked.length + ' / ' + COUNT;
    goBtn.disabled = picked.length !== COUNT;
    goBtn.textContent = picked.length === COUNT ? 'Aufwerten' : 'Noch ' + (COUNT - picked.length) + ' ' + (COUNT - picked.length === 1 ? 'Karte' : 'Karten');
    $('[data-up-fill]').disabled = picked.length >= COUNT || !tier.cards.some(function (c) { return dupesLeft(c) > 0; });
    $('[data-up-clear]').disabled = !picked.length;
  }

  function add(card) {
    if (picked.length >= COUNT) return;
    var d = freeDocs(card)[0];
    if (!d) return;
    picked.push({ doc: d, card: card });
    draw();
  }
  function remove(i) {
    picked.splice(i, 1);
    draw();
  }
  // Duplikate, die noch nicht im Vertrag liegen (von jeder Karte bleibt eine – wie beim Verkauf an die Bank)
  function dupesLeft(c) {
    var inside = picked.filter(function (p) { return p.card.id === c.id; }).length;
    return Math.max(0, c.dupes - inside);
  }
  // Auffüllen: zuerst Karten mit den meisten Duplikaten, so bleibt die Sammlung möglichst vollständig
  function fill() {
    var list = tier.cards.slice().sort(function (a, b) { return dupesLeft(b) - dupesLeft(a); });
    var changed = true;
    while (picked.length < COUNT && changed) {
      changed = false;
      for (var i = 0; i < list.length && picked.length < COUNT; i++) {
        if (dupesLeft(list[i]) > 0 && freeDocs(list[i]).length) {
          picked.push({ doc: freeDocs(list[i])[0], card: list[i] });
          changed = true;
        }
      }
    }
    draw();
  }

  // Mögliche Ergebnisse mit Anteil; fehlende Karten markiert
  function drawPool() {
    var box = $('[data-up-pool]');
    box.innerHTML = '';
    var groups = [[tier.chance > 0 ? tier.nextLabel + ' (bei Erfolg)' : null, tier.odds.up], [tier.chance < 1 ? tier.label + ' (sonst)' : null, tier.odds.same]];
    groups.forEach(function (g) {
      if (!g[0]) return;
      box.appendChild(el('h3', 'up-pool-head', g[0]));
      var ul = el('ul', 'up-pool-list');
      g[1].forEach(function (o) {
        var li = el('li', o.missing ? 'is-missing' : '');
        li.appendChild(img(o));
        li.appendChild(el('span', 'up-pool-name', o.name));
        if (o.missing) li.appendChild(el('span', 'up-pool-tag', 'fehlt'));
        li.appendChild(el('span', 'up-pool-p', o.p));
        ul.appendChild(li);
      });
      box.appendChild(ul);
    });
  }

  // ---------- Verschmelzen ----------
  var reveal = document.querySelector('[data-up-reveal]');
  var reel = document.querySelector('[data-up-reel]');
  var result = document.querySelector('[data-up-result]');
  function go() {
    if (picked.length !== COUNT) return;
    goBtn.disabled = true;
    goBtn.textContent = 'Wird verschmolzen …';
    var body = new URLSearchParams({ _csrf: csrf });
    picked.forEach(function (p) { body.append('doc', p.doc); });
    fetch('/tcg/aufwertung', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: body })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.error) throw new Error(res.error);
        spin(res);
      })
      .catch(function (err) {
        goBtn.disabled = false;
        goBtn.textContent = 'Aufwerten';
        alertBox(err.message || 'Das hat nicht geklappt – bitte lade die Seite neu.');
      });
  }
  function alertBox(text) {
    var p = $('[data-up-error]') || el('p', 'up-error');
    p.setAttribute('data-up-error', '');
    p.setAttribute('role', 'alert');
    p.textContent = text;
    goBtn.insertAdjacentElement('afterend', p);
  }

  // Walze: Karten nebeneinander, die gezogene an Position res.stop; sie läuft aus und hält unter der Markierung
  function spin(res) {
    reel.innerHTML = '';
    var items = res.reel.slice();
    items[res.stop] = res.card;
    items.forEach(function (c, i) {
      var it = el('div', 'up-reel-item r-' + c.rarity + (i === res.stop ? ' is-win' : ''));
      it.appendChild(img(c));
      reel.appendChild(it);
    });
    result.hidden = true;
    reveal.hidden = false;
    document.body.classList.add('up-open');
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(function () {
      var item = reel.children[res.stop];
      var win = reel.parentNode.getBoundingClientRect().width;
      // leicht versetzt auf der Karte stehen bleiben, damit es nicht wie abgezählt wirkt
      var jitter = (Math.random() - 0.5) * item.offsetWidth * 0.6;
      var x = item.offsetLeft + item.offsetWidth / 2 - win / 2 + jitter;
      reel.style.transition = 'none';
      reel.style.transform = 'translateX(0)';
      void reel.offsetWidth;
      reel.style.transition = still ? 'none' : 'transform 5.2s cubic-bezier(.12, .7, .1, 1)';
      reel.style.transform = 'translateX(' + -x + 'px)';
      setTimeout(function () { done(res); }, still ? 50 : 5400);
    });
  }
  function done(res) {
    reel.children[res.stop].classList.add('is-shown');
    var c = res.card;
    document.querySelector('[data-up-result-img]').src = c.image;
    document.querySelector('[data-up-result-img]').alt = c.name;
    document.querySelector('[data-up-result-kicker]').textContent = res.success ? 'Aufgewertet! · ' + c.rarityLabel : 'Gleiche Seltenheit · ' + c.rarityLabel;
    document.querySelector('[data-up-result-title]').textContent = c.name + (c.missing ? ' – neu für dein Album!' : '');
    document.querySelector('[data-up-result-text]').textContent = res.success
      ? 'Deine ' + COUNT + ' Karten sind zu einer ' + c.rarityLabel + '-Karte verschmolzen.'
      : 'Diesmal hat es nicht gereicht (Chance ' + res.chance + ') – dafür bekommst du eine ' + c.rarityLabel + '-Karte zurück.';
    result.className = 'up-result r-' + c.rarity + (res.success ? ' is-up' : ' is-same');
    result.hidden = false;
    document.querySelector('[data-up-again]').focus();
  }
  // neu laden: Auswahl und Verlauf kommen frisch vom Server
  document.querySelector('[data-up-again]').addEventListener('click', function () { location.reload(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !reveal.hidden && !result.hidden) location.reload();
  });

  page.querySelectorAll('[data-up-tab]').forEach(function (b) {
    b.addEventListener('click', function () { chooseTier(b.getAttribute('data-up-tab')); });
  });
  $('[data-up-fill]').addEventListener('click', fill);
  $('[data-up-clear]').addEventListener('click', function () { picked = []; draw(); });
  goBtn.addEventListener('click', go);

  // Start: erste Seltenheit, in der man genug freie Karten hat – sonst die erste
  var start = data.tiers.filter(function (t) { return t.free >= COUNT; })[0] || data.tiers[0];
  if (start) chooseTier(start.key);
})();

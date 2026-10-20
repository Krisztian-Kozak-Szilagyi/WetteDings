// Kartenaufwertung (views/tcg-aufwertung.ejs): Karten in den Vertrag legen (Seltenheiten gemischt), verschmelzen.
// Die Chance rechnet window.AufwertungRegeln (public/js/aufwertung-regeln.js) – dieselbe Rechnung wie auf dem Server.
// Entschieden wird auf dem Server (POST /tcg/aufwertung, src/tcg/upgrade.js); hier nur Auswahl und die Walze, die wie
// beim Kistenöffnen an der gezogenen Karte stehen bleibt.
(function () {
  var page = document.querySelector('[data-upgrade]');
  var R = window.AufwertungRegeln;
  if (!page || !R) return;
  var data = JSON.parse(page.getAttribute('data-upgrade'));
  var csrf = page.getAttribute('data-csrf');
  var rules = data.rules;
  var COUNT = rules.count;
  var $ = function (sel) { return page.querySelector(sel); };
  var grid = $('[data-up-grid]');
  var slotsEl = $('[data-up-slots]');
  var goBtn = $('[data-up-go]');
  var label = {};
  data.ladder.forEach(function (r) { label[r.key] = r.label; });
  var tier = null; // angezeigte Seltenheit (Filter der Auswahl)
  var picked = []; // [{ doc, card }] im Vertrag – Seltenheiten gemischt

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
  function pct(p) {
    var v = p >= 0.01 ? Math.round(p * 1000) / 10 : Math.round(p * 100000) / 1000;
    return String(v).replace('.', ',') + ' %';
  }
  // freie Exemplare einer Karte, die noch nicht im Vertrag liegen
  function freeDocs(card) {
    var used = new Set(picked.map(function (p) { return p.doc; }));
    return card.docs.filter(function (d) { return !used.has(d); });
  }

  function chooseTier(key) {
    tier = data.tiers.filter(function (t) { return t.key === key; })[0];
    page.querySelectorAll('[data-up-tab]').forEach(function (b) { b.setAttribute('aria-selected', b.getAttribute('data-up-tab') === key ? 'true' : 'false'); });
    $('[data-up-pick-title]').textContent = 'Deine ' + tier.label + '-Karten';
    draw();
  }

  function draw() {
    // Auswahl der gerade gezeigten Seltenheit
    grid.innerHTML = '';
    tier.cards.forEach(function (c) {
      var left = freeDocs(c).length;
      var b = el('button', 'up-card r-' + c.rarity);
      b.type = 'button';
      b.title = c.name + ' – ' + left + ' frei' + (c.dupes ? ', davon ' + c.dupes + ' doppelt' : '');
      b.appendChild(img(c));
      b.appendChild(el('span', 'up-card-count', '×' + left));
      if (c.dupes) b.appendChild(el('span', 'up-card-dupe', c.dupes + ' doppelt'));
      b.disabled = !left || picked.length >= COUNT;
      b.addEventListener('click', function () { add(c); });
      grid.appendChild(b);
    });
    $('[data-up-empty]').hidden = tier.cards.length > 0;
    // Vertrag: COUNT Plätze, seltenste zuerst; Klick auf eine Karte nimmt sie wieder heraus
    var rank = function (k) { return data.ladder.map(function (r) { return r.key; }).indexOf(k); };
    picked.sort(function (a, b) { return rank(b.card.rarity) - rank(a.card.rarity); });
    slotsEl.innerHTML = '';
    for (var i = 0; i < COUNT; i++) {
      var p = picked[i];
      var s = el('button', 'up-slot' + (p ? ' is-full r-' + p.card.rarity : ''));
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
    drawChance();
  }

  // Chance und Ausgänge des Vertrags (erst mit allen COUNT Karten – die Chance hängt vom ganzen Einsatz ab)
  function drawChance() {
    var box = $('[data-up-chance]');
    var keys = picked.map(function (p) { return p.card.rarity; });
    var v = keys.length ? R.vertrag(keys, data.ladder, rules) : null;
    if (!v) {
      box.className = 'up-chance';
      $('[data-up-next]').textContent = '–';
      $('[data-up-chance-value]').textContent = '–';
      $('[data-up-else]').textContent = 'Lege ' + COUNT + ' Karten in den Vertrag – das Ziel ist die Seltenheit über deiner seltensten Karte.';
      $('[data-up-extra]').textContent = '';
      drawPool(null, keys);
      return;
    }
    box.className = 'up-chance r-' + v.target;
    $('[data-up-next]').textContent = label[v.target];
    var full = keys.length === COUNT;
    $('[data-up-chance-value]').textContent = full ? pct(v.chance) : '…';
    // Fehlschlag: Seltenheit einer zufällig gewählten eingesetzten Karte
    var share = {};
    keys.forEach(function (k) { share[k] = (share[k] || 0) + 1; });
    var parts = Object.keys(share).map(function (k) { return (Object.keys(share).length > 1 ? pct(share[k] / keys.length) + ' ' : '') + label[k]; });
    var elseText;
    if (!full) elseText = 'Die Chance steht fest, sobald ' + COUNT + ' Karten im Vertrag liegen.' + (v.q < 1 ? ' Gemischt ist sie kleiner.' : '');
    else if (v.chance >= 1) elseText = 'Gelingt sicher: eine zufällige ' + label[v.target] + '-Karte.';
    else elseText = 'Sonst eine Karte aus: ' + parts.join(', ') + '.' + (v.q < 1 ? ' Gemischter Einsatz: ' + pct(v.q) + ' einer vollen ' + label[v.top] + '-Runde.' : '');
    $('[data-up-else]').textContent = elseText;
    var extra = [];
    if (v.pBonus) extra.push('Glückstreffer ' + pct(v.pBonus) + ' → ' + label[v.bonus || v.target]);
    if (v.pJackpot && v.jackpot.length) extra.push('Jackpot ' + pct(v.pJackpot) + ' → ' + v.jackpot.map(function (j) { return label[j.key]; }).join(' oder '));
    $('[data-up-extra]').textContent = extra.join(' · ');
    drawPool(v, keys);
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
  // Auffüllen mit Duplikaten der gezeigten Seltenheit: zuerst Karten mit den meisten, so bleibt die Sammlung vollständig
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

  // Mögliche Ergebnisse mit Anteil innerhalb ihrer Seltenheit; fehlende Karten markiert
  function drawPool(v, keys) {
    var box = $('[data-up-pool]');
    box.innerHTML = '';
    if (!v) {
      box.appendChild(el('p', 'muted small', 'Erst mit Karten im Vertrag.'));
      return;
    }
    var groups = [];
    if (v.chance > 0) groups.push([label[v.target] + ' (bei Erfolg)', v.target]);
    if (v.chance < 1 || keys.length < COUNT) {
      keys.filter(function (k, i) { return keys.indexOf(k) === i; }).forEach(function (k) { groups.push([label[k] + ' (sonst)', k]); });
    }
    groups.forEach(function (g) {
      box.appendChild(el('h3', 'up-pool-head', g[0]));
      var ul = el('ul', 'up-pool-list');
      (data.pools[g[1]] || []).forEach(function (o) {
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
  var KICKER = { jackpot: 'JACKPOT!', bonus: 'Glückstreffer!', erfolg: 'Aufgewertet!', fehlschlag: 'Nicht aufgewertet' };
  function done(res) {
    reel.children[res.stop].classList.add('is-shown');
    var c = res.card;
    document.querySelector('[data-up-result-img]').src = c.image;
    document.querySelector('[data-up-result-img]').alt = c.name;
    document.querySelector('[data-up-result-kicker]').textContent = (KICKER[res.kind] || '') + ' · ' + c.rarityLabel;
    document.querySelector('[data-up-result-title]').textContent = c.name + (c.missing ? ' – neu für dein Album!' : '');
    var text = {
      jackpot: 'Der Jackpot! Aus deinen ' + COUNT + ' Karten ist eine ' + c.rarityLabel + '-Karte geworden.',
      bonus: 'Ein Glückstreffer: sogar eine Stufe höher als erhofft – eine ' + c.rarityLabel + '-Karte.',
      erfolg: 'Deine ' + COUNT + ' Karten sind zu einer ' + c.rarityLabel + '-Karte verschmolzen.',
      fehlschlag: 'Diesmal hat es nicht gereicht (Chance ' + res.chance + ') – dafür bekommst du eine ' + c.rarityLabel + '-Karte.',
    };
    document.querySelector('[data-up-result-text]').textContent = text[res.kind] || text.erfolg;
    result.className = 'up-result r-' + c.rarity + (res.success ? ' is-up' : ' is-same') + (res.kind === 'jackpot' || res.kind === 'bonus' ? ' is-lucky' : '');
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

  // Start: erste Seltenheit, in der man genug freie Karten hat – sonst die erste mit Karten
  var start = data.tiers.filter(function (t) { return t.free >= COUNT; })[0] || data.tiers.filter(function (t) { return t.free; })[0] || data.tiers[0];
  if (start) chooseTier(start.key);
})();

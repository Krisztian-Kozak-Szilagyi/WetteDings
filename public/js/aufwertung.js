// Kartenaufwertung (views/tcg-aufwertung.ejs): Karten in den Vertrag legen (Seltenheiten gemischt), verschmelzen.
// Die Chance rechnet window.AufwertungRegeln (public/js/aufwertung-regeln.js) – dieselbe Rechnung wie auf dem Server.
// Entschieden wird auf dem Server (POST /tcg/aufwertung, src/tcg/upgrade.js); hier nur Auswahl und die Verschmelzung:
// Karten fliegen auf einer Spirale zusammen, das Leuchten steigt durch die Seltenheiten bis zur gezogenen Karte.
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
  // Kartenbilder kommen fertig vom Server (<template data-up-images>) und werden nur geklont
  var images = page.querySelector('[data-up-images]');
  function img(card, cls) {
    var found = images && Array.prototype.find.call(images.content.querySelectorAll('[data-up-img]'), function (x) { return x.getAttribute('data-up-img') === card.id; });
    var i = found ? found.cloneNode(false) : el('img');
    if (cls) i.className = cls;
    i.alt = card.name;
    return i;
  }
  var euro = function (c) { return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(c / 100); };
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
      $('[data-up-back]').textContent = '';
      drawPool(null, keys);
      return;
    }
    box.className = 'up-chance r-' + v.target;
    $('[data-up-next]').textContent = label[v.target];
    var full = keys.length === COUNT;
    $('[data-up-chance-value]').textContent = full ? pct(v.chance) : '…';
    // Fehlschlag: eine Karte der seltensten eingesetzten Seltenheit
    var elseText;
    if (!full) elseText = 'Die Chance steht fest, sobald ' + COUNT + ' Karten im Vertrag liegen.' + (v.q < 1 ? ' Gemischt ist sie kleiner.' : '');
    else if (v.chance >= 1) elseText = 'Gelingt sicher: eine zufällige ' + label[v.target] + '-Karte.';
    else if (v.chance < 0.02) elseText = 'Kaum Chance auf ' + label[v.target] + ': Fast der ganze Wert steckt in deiner ' + label[v.top] + '-Karte – du bekommst eine ' + label[v.top] + '-Karte (gern eine, die dir fehlt). Für eine echte Chance nimm mehr ' + label[v.top] + '-Karten.';
    else elseText = 'Sonst bekommst du eine ' + label[v.top] + '-Karte.' + (v.q < 1 ? ' Gemischter Einsatz: ' + pct(v.q) + ' einer vollen ' + label[v.top] + '-Runde – mehr ' + label[v.top] + '-Karten erhöhen die Chance.' : '');
    $('[data-up-else]').textContent = elseText;
    // Rückgabe: mindestens (Karte + Wertausgleich) und im Schnitt, gemessen am Bankwert des Einsatzes
    $('[data-up-back]').textContent = full
      ? 'Einsatz ' + euro(v.value) + ' · du bekommst mindestens ' + euro(v.floor) + ' zurück (Karte + Wertausgleich), im Schnitt ' + pct(v.ev / v.value) + '.'
      : '';
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
    if (v.chance < 1) groups.push([label[v.top] + ' (sonst)', v.top]);
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
  // Ablauf: Karten fliegen auf einer Spirale in die Mitte → der Kern leuchtet in Crumpled auf und steigt Stufe um Stufe
  // durch die Seltenheiten, bis er bei der Seltenheit der gezogenen Karte hält → Lichtblitz → die Karte erscheint.
  // Die Anfrage läuft schon während des Flugs; erst mit der Antwort steht fest, wo das Leuchten anhält.
  var reveal = document.querySelector('[data-up-reveal]');
  var fuse = document.querySelector('[data-up-fuse]');
  var core = document.querySelector('[data-up-core]');
  var fuseLabel = document.querySelector('[data-up-fuse-label]');
  var result = document.querySelector('[data-up-result]');
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var css = getComputedStyle(document.documentElement);
  var colorOf = function (k) { return (css.getPropertyValue('--r-' + k) || '#ffffff').trim(); };
  var wait = function (ms) { return new Promise(function (ok) { setTimeout(ok, still ? 0 : ms); }); };

  function go() {
    if (picked.length !== COUNT) return;
    goBtn.disabled = true;
    goBtn.textContent = 'Wird verschmolzen …';
    var body = new URLSearchParams({ _csrf: csrf });
    picked.forEach(function (p) { body.append('doc', p.doc); });
    var request = fetch('/tcg/aufwertung', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: body })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.error) throw new Error(res.error);
        return res;
      });
    var flight = spiral();
    Promise.all([request, flight])
      .then(function (both) { return glow(both[0]).then(function () { done(both[0]); }); })
      .catch(function (err) {
        closeFuse();
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

  // Karten aus den Vertragsplätzen fliegen auf einer Spirale (2 Umdrehungen, enger werdend) in den Kern
  function spiral() {
    var from = Array.prototype.slice.call(slotsEl.querySelectorAll('.up-slot.is-full img')).map(function (im) { return { src: im.src, rect: im.getBoundingClientRect() }; });
    result.hidden = true;
    core.className = 'up-core';
    core.style.setProperty('--lvl', 0);
    fuseLabel.textContent = '';
    fuse.hidden = false;
    reveal.hidden = false;
    document.body.classList.add('up-open');
    slotsEl.classList.add('is-fusing');
    var c = core.getBoundingClientRect();
    var cx = c.left + c.width / 2;
    var cy = c.top + c.height / 2;
    if (still || !Element.prototype.animate) return Promise.resolve();
    var flights = from.map(function (f, i) {
      var fly = el('img', 'up-fly');
      fly.src = f.src;
      fly.alt = '';
      fly.style.width = f.rect.width + 'px';
      fly.style.left = cx - f.rect.width / 2 + 'px';
      fly.style.top = cy - f.rect.height / 2 + 'px';
      reveal.appendChild(fly);
      var dx = f.rect.left + f.rect.width / 2 - cx;
      var dy = f.rect.top + f.rect.height / 2 - cy;
      var r0 = Math.sqrt(dx * dx + dy * dy);
      var a0 = Math.atan2(dy, dx);
      var frames = [];
      for (var s = 0; s <= 24; s++) {
        var t = s / 24;
        var e = t * t * (3 - 2 * t); // sanft an- und auslaufen
        var a = a0 + e * Math.PI * 4; // zwei Umdrehungen
        var r = r0 * (1 - e);
        frames.push({
          transform: 'translate(' + (Math.cos(a) * r).toFixed(1) + 'px, ' + (Math.sin(a) * r).toFixed(1) + 'px) rotate(' + (e * 540).toFixed(0) + 'deg) scale(' + (1 - e * 0.8).toFixed(3) + ')',
          opacity: t > 0.85 ? (1 - (t - 0.85) / 0.15).toFixed(2) : 1,
          filter: 'brightness(' + (1 + e * 1.6).toFixed(2) + ')',
          offset: t,
        });
      }
      return fly.animate(frames, { duration: 1700, delay: i * 70, easing: 'linear', fill: 'forwards' }).finished.then(function () { fly.remove(); });
    });
    // der Kern wird sichtbar, während die ersten Karten ankommen
    setTimeout(function () { core.classList.add('is-on'); }, 900);
    return Promise.all(flights);
  }

  // Leuchten: in Crumpled anfangen, Stufe für Stufe heller und strahlender bis zur Seltenheit der neuen Karte
  function glow(res) {
    var keys = data.ladder.map(function (r) { return r.key; });
    var end = Math.max(0, keys.indexOf(res.card.rarity));
    core.classList.add('is-on');
    var step = function (i) {
      if (i > end) return Promise.resolve();
      var k = keys[i];
      core.style.setProperty('--c', colorOf(k));
      core.style.setProperty('--lvl', i);
      core.classList.toggle('is-crumpled', i === 0); // Crumpled: zerknittertes Flackern, danach immer heller
      core.classList.remove('is-step');
      void core.offsetWidth;
      core.classList.add('is-step');
      fuseLabel.textContent = label[k] + (i === end ? '!' : ' …');
      fuseLabel.style.color = colorOf(k);
      // je höher, desto länger bleibt die Stufe stehen – die Spannung steigt
      return wait(i === end ? 900 : 420 + i * 70).then(function () { return step(i + 1); });
    };
    return step(0).then(function () {
      core.classList.add('is-burst');
      return wait(450);
    });
  }

  var KICKER = { jackpot: 'JACKPOT!', bonus: 'Glückstreffer!', erfolg: 'Aufgewertet!', fehlschlag: 'Nicht aufgewertet' };
  function done(res) {
    fuse.hidden = true;
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
    var pay = document.querySelector('[data-up-result-payout]');
    pay.textContent = res.payout ? '+ ' + res.payoutText + ' Wertausgleich – auf deinem Konto gutgeschrieben.' : '';
    pay.hidden = !res.payout;
    result.className = 'up-result r-' + c.rarity + (res.success ? ' is-up' : ' is-same') + (res.kind === 'jackpot' || res.kind === 'bonus' ? ' is-lucky' : '');
    result.hidden = false;
    document.querySelector('[data-up-again]').focus();
  }
  function closeFuse() {
    reveal.hidden = true;
    document.body.classList.remove('up-open');
    slotsEl.classList.remove('is-fusing');
    reveal.querySelectorAll('.up-fly').forEach(function (f) { f.remove(); });
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

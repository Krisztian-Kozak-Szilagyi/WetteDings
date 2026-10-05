// Deckbau: Karten mit der Maus (oder lange gedrückt auf dem Handy) ins Deck ziehen, aus dem Deck herausziehen = entfernen.
// Anklicken geht weiterhin: Sammlung -> ins Deck, Deckzeile -> eine heraus. Daten über /api/deck.
(function () {
  var app = document.querySelector('[data-deck-app]');
  if (!app) return;
  var form = app.querySelector('[data-deck-form]');
  var poolEl = app.querySelector('[data-deck-pool]');
  var listEl = app.querySelector('[data-deck-list]');
  var dropEl = app.querySelector('[data-deck-drop]');
  var countEl = app.querySelector('[data-deck-count]');
  var meterEl = app.querySelector('[data-deck-meter]');
  var hintEl = app.querySelector('[data-deck-hint]');
  var nameEl = app.querySelector('[data-deck-name]');
  var saveBtn = app.querySelector('[data-deck-save]');
  var errEl = app.querySelector('[data-deck-error]');
  var emptyEl = app.querySelector('[data-deck-empty]');
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var rules = { deckSize: 30 };
  var pool = []; // [{ id, name, rarity, image, owned, limit }]
  var byId = {};
  var deck = {}; // { cardId: Anzahl }
  var order = []; // Reihenfolge im Deck
  var dirty = false;
  var busy = false;
  var flash = null; // zuletzt hinzugefügte Karte (Zeile leuchtet kurz)

  var size = function () { return order.reduce(function (s, id) { return s + deck[id]; }, 0); };
  var max = function (c) { return Math.min(c.limit, c.owned); };
  var canAdd = function (id) { var c = byId[id]; return !!c && (deck[id] || 0) < max(c) && size() < rules.deckSize; };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function showError(msg) {
    errEl.textContent = msg || '';
    errEl.hidden = !msg;
  }

  function render() {
    var n = size();
    countEl.querySelector('b').textContent = n;
    countEl.querySelector('small').textContent = '/ ' + rules.deckSize;
    countEl.classList.toggle('is-full', n === rules.deckSize);
    meterEl.style.width = Math.min(100, (n / rules.deckSize) * 100) + '%';
    hintEl.hidden = n > 0;
    poolEl.textContent = '';
    emptyEl.hidden = pool.length > 0;
    pool.forEach(function (c) {
      var inDeck = deck[c.id] || 0;
      var li = el('li', 'dk-card r-' + c.rarity);
      li.dataset.card = c.id;
      if (!canAdd(c.id)) li.classList.add('is-spent');
      var img = el('img');
      img.src = c.image;
      img.alt = c.name;
      img.loading = 'lazy';
      img.draggable = false;
      li.appendChild(img);
      li.appendChild(el('span', 'dk-card-n', inDeck + ' / ' + max(c)));
      li.title = c.name;
      li.tabIndex = 0;
      grab(li, c.id, 'pool');
      poolEl.appendChild(li);
    });
    listEl.textContent = '';
    order.forEach(function (id) {
      var c = byId[id] || { name: id, rarity: '', image: '' };
      var li = el('li', 'dk-row r-' + c.rarity);
      li.dataset.card = id;
      li.title = 'Herausziehen oder anklicken: eine heraus';
      li.tabIndex = 0;
      if (c.image) li.style.setProperty('--art', 'url("' + c.image + '")');
      li.appendChild(el('span', 'dk-row-name', c.name));
      li.appendChild(el('span', 'dk-row-n', '×' + deck[id]));
      if (!byId[id] || deck[id] > byId[id].owned) li.classList.add('is-missing');
      if (id === flash) li.classList.add('is-new');
      grab(li, id, 'deck');
      listEl.appendChild(li);
    });
    flash = null;
    saveBtn.disabled = busy || !dirty;
    saveBtn.textContent = dirty ? 'Speichern' : 'Gespeichert';
  }

  function add(id) {
    if (!canAdd(id)) return false;
    if (!deck[id]) order.push(id);
    deck[id] = (deck[id] || 0) + 1;
    flash = id;
    changed();
    return true;
  }

  function remove(id) {
    if (!deck[id]) return;
    deck[id] -= 1;
    if (!deck[id]) {
      delete deck[id];
      order = order.filter(function (x) { return x !== id; });
    }
    changed();
  }

  function changed() {
    dirty = true;
    showError('');
    render();
    if (!calm) {
      countEl.classList.remove('is-bump');
      void countEl.offsetWidth; // Animation neu starten
      countEl.classList.add('is-bump');
    }
  }

  // ---------- Ziehen ----------
  var drag = null;

  function inside(rect, x, y) { return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom; }

  /** Element wird greifbar: kurz klicken = Aktion, ziehen = Karte in der Hand */
  function grab(node, id, from) {
    node.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || drag || busy) return;
      var start = { x: e.clientX, y: e.clientY };
      var touch = e.pointerType !== 'mouse';
      var timer = null;
      var pending = true;
      var moved = false;
      function begin(ev) {
        pending = false;
        startDrag(node, id, from, ev || e);
      }
      // Auf dem Handy erst nach kurzem Halten greifen, damit man die Liste weiter scrollen kann
      if (touch) timer = setTimeout(function () { begin(); }, 220);
      function onMove(ev) {
        if (!pending) return;
        var far = Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 6;
        if (!far) return;
        moved = true;
        if (touch) return cleanup(); // gescrollt, nicht gegriffen
        begin(ev);
      }
      function onUp() {
        var click = pending && !moved;
        cleanup();
        if (!click) return;
        if (from === 'pool') {
          if (!add(id)) shake(app.querySelector('.dk-card[data-card="' + id + '"]'));
        } else remove(id);
      }
      function cleanup() {
        clearTimeout(timer);
        pending = false;
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerup', onUp);
        node.removeEventListener('pointercancel', cleanup);
      }
      try { node.setPointerCapture(e.pointerId); } catch (x) { /* egal */ }
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
      node.addEventListener('pointercancel', cleanup);
    });
    node.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (from === 'pool') add(id);
      else remove(id);
    });
  }

  function startDrag(node, id, from, e) {
    var c = byId[id];
    if (!c) return;
    var rect = node.getBoundingClientRect();
    var w = from === 'pool' ? rect.width : Math.min(150, poolCardWidth());
    var h = w * 1.4;
    var ghost = el('div', 'dk-ghost r-' + c.rarity);
    var img = el('img');
    img.src = c.image;
    img.alt = '';
    img.draggable = false;
    ghost.appendChild(img);
    ghost.style.width = w + 'px';
    ghost.style.height = h + 'px';
    document.body.appendChild(ghost);
    // Griffpunkt: aus der Sammlung dort, wo man die Karte gefasst hat; aus dem Deck mittig
    var ox = from === 'pool' ? e.clientX - rect.left : w / 2;
    var oy = from === 'pool' ? e.clientY - rect.top : h * 0.35;
    drag = {
      id: id, from: from, node: node, ghost: ghost, w: w, h: h, ox: ox, oy: oy,
      x: e.clientX - ox, y: e.clientY - oy, // aktuelle Lage (gefedert)
      tx: e.clientX - ox, ty: e.clientY - oy, // Ziel = Mauszeiger
      tilt: 0, raf: 0, over: false, pointer: e.pointerId,
    };
    node.classList.add('is-held');
    document.documentElement.classList.add('dk-dragging');
    if (from === 'deck') dropEl.classList.add('is-source');
    place();
    drag.raf = requestAnimationFrame(tick);
    node.addEventListener('pointermove', dragMove);
    node.addEventListener('pointerup', dragEnd);
    node.addEventListener('pointercancel', dragCancel);
    document.addEventListener('keydown', escCancel);
  }

  function poolCardWidth() {
    var any = poolEl.querySelector('.dk-card');
    return any ? any.getBoundingClientRect().width : 130;
  }

  function place() {
    var d = drag;
    var lift = d.over && d.from === 'pool' ? 0.92 : 1.08;
    d.ghost.style.transform = 'translate3d(' + d.x + 'px,' + d.y + 'px,0) rotate(' + d.tilt + 'deg) scale(' + lift + ')';
  }

  function tick() {
    var d = drag;
    if (!d) return;
    var k = calm ? 1 : 0.35;
    var vx = (d.tx - d.x) * k;
    d.x += vx;
    d.y += (d.ty - d.y) * k;
    // Neigung folgt der Bewegung, federt zurück, wenn die Maus stillsteht
    var want = calm ? 0 : Math.max(-22, Math.min(22, vx * 0.9));
    d.tilt += (want - d.tilt) * 0.25;
    place();
    d.raf = requestAnimationFrame(tick);
  }

  function dragMove(e) {
    var d = drag;
    if (!d || e.pointerId !== d.pointer) return;
    d.tx = e.clientX - d.ox;
    d.ty = e.clientY - d.oy;
    var over = inside(dropEl.getBoundingClientRect(), e.clientX, e.clientY);
    if (over !== d.over) {
      d.over = over;
      var ok = d.from === 'deck' || canAdd(d.id);
      dropEl.classList.toggle('is-over', over && d.from === 'pool' && ok);
      dropEl.classList.toggle('is-blocked', over && d.from === 'pool' && !ok);
      d.ghost.classList.toggle('is-out', d.from === 'deck' && !over);
    }
  }

  function finish() {
    var d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    d.node.removeEventListener('pointermove', dragMove);
    d.node.removeEventListener('pointerup', dragEnd);
    d.node.removeEventListener('pointercancel', dragCancel);
    document.removeEventListener('keydown', escCancel);
    document.documentElement.classList.remove('dk-dragging');
    dropEl.classList.remove('is-over', 'is-blocked', 'is-source');
    d.node.classList.remove('is-held');
    return d;
  }

  /** Karte fliegt von ihrer jetzigen Lage zu rect (verkleinert/verblasst), danach then() */
  function fly(d, rect, opts, then) {
    var from = d.ghost.style.transform;
    var sx = rect.width / d.w;
    var to = 'translate3d(' + (rect.left + (rect.width - d.w) / 2) + 'px,' + (rect.top + (rect.height - d.h) / 2) + 'px,0) rotate(0deg) scale(' + (opts.scale || sx) + ')';
    if (calm || !d.ghost.animate) {
      d.ghost.remove();
      return then && then();
    }
    var a = d.ghost.animate([{ transform: from, opacity: 1 }, { transform: to, opacity: opts.fade ? 0 : 1 }], { duration: opts.ms || 260, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'forwards' });
    a.onfinish = function () {
      d.ghost.remove();
      if (then) then();
    };
  }

  function dragEnd(e) {
    var d = drag;
    if (!d || e.pointerId !== d.pointer) return;
    var over = inside(dropEl.getBoundingClientRect(), e.clientX, e.clientY);
    finish();
    if (d.from === 'pool') {
      if (over && canAdd(d.id)) {
        var row = listEl.querySelector('.dk-row[data-card="' + d.id + '"]');
        var target = row ? row.getBoundingClientRect() : listEl.getBoundingClientRect();
        if (!row) target = { left: target.left, top: target.bottom, width: target.width, height: 40 };
        // Erst ins Deck legen, dann landet die Karte sichtbar in ihrer Zeile
        fly(d, target, { scale: 0.35, fade: true, ms: 240 });
        add(d.id);
        return;
      }
      if (over) shake(dropEl);
      return back(d);
    }
    // aus dem Deck gezogen: außerhalb losgelassen = eine heraus, Karte fliegt zurück in die Sammlung
    if (!over) {
      var home = poolEl.querySelector('.dk-card[data-card="' + d.id + '"]');
      remove(d.id);
      if (home) return fly(d, home.getBoundingClientRect(), { ms: 300 });
      return fly(d, d.ghost.getBoundingClientRect(), { scale: 0.6, fade: true });
    }
    fly(d, d.node.getBoundingClientRect(), { scale: 0.35, fade: true, ms: 200 });
  }

  /** Zurück an den Ursprung (ungültig losgelassen oder abgebrochen) */
  function back(d) {
    var origin = d.from === 'pool' ? poolEl.querySelector('.dk-card[data-card="' + d.id + '"]') : d.node;
    fly(d, (origin || d.node).getBoundingClientRect(), { ms: 320, scale: d.from === 'pool' ? 1 : 0.35, fade: d.from !== 'pool' });
  }

  function dragCancel(e) {
    if (!drag || (e && e.pointerId !== drag.pointer)) return;
    back(finish());
  }

  function escCancel(e) {
    if (e.key === 'Escape') dragCancel();
  }

  function shake(node) {
    if (!node || calm) return;
    node.classList.remove('is-shake');
    void node.offsetWidth;
    node.classList.add('is-shake');
  }

  // Auf dem Handy während des Ziehens nicht scrollen
  document.addEventListener('touchmove', function (e) { if (drag) e.preventDefault(); }, { passive: false });

  // ---------- Laden und Speichern ----------
  function load(d) {
    deck = {};
    order = [];
    form.elements.id.value = d ? d.id : '';
    nameEl.value = d ? d.name : '';
    (d ? d.cards : []).forEach(function (e) {
      deck[e.card] = e.n;
      order.push(e.card);
    });
  }

  nameEl.addEventListener('input', function () {
    dirty = true;
    render();
  });

  saveBtn.addEventListener('click', function () {
    if (busy) return;
    busy = true;
    render();
    var ids = [];
    order.forEach(function (id) { for (var i = 0; i < deck[id]; i++) ids.push(id); });
    form.elements.karten.value = ids.join(',');
    var body = new URLSearchParams(new FormData(form));
    body.set('name', nameEl.value);
    fetch(form.action, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: body })
      .then(function (r) { return r.json().then(function (res) { return { ok: r.ok, res: res }; }); })
      .then(function (x) {
        if (!x.ok) throw new Error(x.res && x.res.error);
        load(x.res.deck);
        dirty = false;
      })
      .catch(function (e) { showError((e && e.message) || 'Speichern hat nicht geklappt. Lade die Seite neu.'); })
      .then(function () {
        busy = false;
        render();
      });
  });

  fetch('/api/deck', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
    .then(function (data) {
      rules = data.rules;
      pool = data.pool;
      byId = {};
      pool.forEach(function (c) { byId[c.id] = c; });
      load(data.decks[0] || null); // vorerst ein Deck pro Spieler
      dirty = false;
      render();
    })
    .catch(function () { showError('Das Deck konnte nicht geladen werden. Lade die Seite neu.'); });
})();

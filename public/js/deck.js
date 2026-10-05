// Deckbau: Karten links anklicken = ins Deck, im Deck anklicken = eine herausnehmen. Daten über /api/deck.
(function () {
  var app = document.querySelector('[data-deck-app]');
  if (!app) return;
  var form = app.querySelector('[data-deck-form]');
  var poolEl = app.querySelector('[data-deck-pool]');
  var listEl = app.querySelector('[data-deck-list]');
  var countEl = app.querySelector('[data-deck-count]');
  var nameEl = app.querySelector('[data-deck-name]');
  var saveBtn = app.querySelector('[data-deck-save]');
  var errEl = app.querySelector('[data-deck-error]');
  var emptyEl = app.querySelector('[data-deck-empty]');

  var rules = { deckSize: 30 };
  var pool = []; // [{ id, name, rarity, image, owned, limit }]
  var byId = {};
  var deck = {}; // { cardId: Anzahl }
  var order = []; // Reihenfolge im Deck
  var dirty = false;
  var busy = false;

  var size = function () { return order.reduce(function (s, id) { return s + deck[id]; }, 0); };
  var max = function (c) { return Math.min(c.limit, c.owned); };

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
    countEl.textContent = n + ' / ' + rules.deckSize;
    countEl.classList.toggle('is-full', n === rules.deckSize);
    poolEl.textContent = '';
    emptyEl.hidden = pool.length > 0;
    pool.forEach(function (c) {
      var inDeck = deck[c.id] || 0;
      var li = el('li', 'dk-card r-' + c.rarity);
      var b = el('button', 'dk-card-btn');
      b.type = 'button';
      b.disabled = inDeck >= max(c) || n >= rules.deckSize;
      b.title = c.name;
      var img = el('img');
      img.src = c.image;
      img.alt = c.name;
      img.loading = 'lazy';
      b.appendChild(img);
      b.appendChild(el('span', 'dk-card-n', inDeck + ' / ' + max(c)));
      b.addEventListener('click', function () { add(c.id); });
      li.appendChild(b);
      poolEl.appendChild(li);
    });
    listEl.textContent = '';
    order.forEach(function (id) {
      var c = byId[id] || { name: id, rarity: '' };
      var li = el('li', 'dk-row r-' + c.rarity);
      var b = el('button', 'dk-row-btn');
      b.type = 'button';
      b.title = 'Eine herausnehmen';
      b.appendChild(el('span', 'dk-row-n', deck[id] + '×'));
      b.appendChild(el('span', 'dk-row-name', c.name));
      if (!byId[id] || deck[id] > byId[id].owned) li.classList.add('is-missing');
      b.addEventListener('click', function () { remove(id); });
      li.appendChild(b);
      listEl.appendChild(li);
    });
    saveBtn.disabled = busy || !dirty;
    saveBtn.textContent = dirty ? 'Speichern' : 'Gespeichert';
  }

  function add(id) {
    var c = byId[id];
    if (!c || (deck[id] || 0) >= max(c) || size() >= rules.deckSize) return;
    if (!deck[id]) order.push(id);
    deck[id] = (deck[id] || 0) + 1;
    dirty = true;
    showError('');
    render();
  }

  function remove(id) {
    if (!deck[id]) return;
    deck[id] -= 1;
    if (!deck[id]) {
      delete deck[id];
      order = order.filter(function (x) { return x !== id; });
    }
    dirty = true;
    showError('');
    render();
  }

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

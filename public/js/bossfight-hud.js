// Bosskampf-Oberfläche: Lebensbalken (Boss 200, Spieler 100), eigenes Deck rechts (zuletzt geändertes aus /api/deck),
// beim Start 5 Karten in die Hand.
// Zum Ausprobieren in der Konsole: bossfight.boss.damage(30), bossfight.player.damage(10), bossfight.player.heal(5), bossfight.draw(1)
(function () {
  var hand = document.querySelector('[data-bf-hand]');
  var deckEl = document.querySelector('[data-bf-deck]');
  if (!hand || !deckEl) return;
  var deckCount = deckEl.querySelector('[data-bf-deck-count]');

  // ---------- Lebensbalken ----------
  function HpBar(el) {
    var max = Number(el.getAttribute('data-max')) || 100;
    var fill = el.querySelector('.bf-hp-fill');
    var lag = el.querySelector('.bf-hp-lag');
    var text = el.querySelector('.bf-hp-text');
    var hp = max;
    var bar = {
      get hp() { return hp; },
      max: max,
      set: function (v) {
        var next = Math.max(0, Math.min(max, Math.round(v)));
        var lost = next < hp;
        hp = next;
        var pct = (hp / max) * 100 + '%';
        fill.style.width = pct;
        // Spur läuft nur beim Schaden langsam nach; beim Heilen sofort mit
        lag.style.transitionDelay = lost ? '' : '0s';
        lag.style.width = pct;
        text.textContent = hp + ' / ' + max;
        if (lost) {
          el.classList.remove('bf-hit');
          void el.offsetWidth; // Animation neu starten
          el.classList.add('bf-hit');
        }
        el.setAttribute('aria-valuenow', hp);
        return hp;
      },
      damage: function (n) { return bar.set(hp - n); },
      heal: function (n) { return bar.set(hp + n); },
    };
    el.setAttribute('role', 'progressbar');
    el.setAttribute('aria-valuemin', 0);
    el.setAttribute('aria-valuemax', max);
    bar.set(max);
    return bar;
  }
  var boss = HpBar(document.querySelector('[data-bf-hp="boss"]'));
  var player = HpBar(document.querySelector('[data-bf-hp="player"]'));

  // ---------- Deck ----------
  var deck = []; // Karten als { id, name, image }, oben = Ende
  function shuffle(list) {
    for (var j = list.length - 1; j > 0; j--) {
      var r = Math.floor(Math.random() * (j + 1));
      var tmp = list[j];
      list[j] = list[r];
      list[r] = tmp;
    }
    return list;
  }
  function hint(html) {
    var p = document.createElement('p');
    p.className = 'bf-hand-hint';
    p.innerHTML = html;
    hand.appendChild(p);
  }
  var cards = []; // Karten in der Hand (DOM)

  function updateDeck() {
    deckCount.textContent = deck.length;
    if (deck.length) deckEl.removeAttribute('data-leer');
    else deckEl.setAttribute('data-leer', '');
  }

  function makeCard(c) {
    var el = document.createElement('div');
    el.className = 'bf-card bf-flipped';
    el.innerHTML =
      '<div class="bf-card-inner">' +
      '<div class="bf-card-face bf-card-front"><img alt="" draggable="false"></div>' +
      '<div class="bf-card-face bf-card-back"></div></div>';
    var img = el.querySelector('img');
    img.src = c.image;
    img.alt = c.name;
    el.title = c.name;
    return el;
  }

  // Fächer unten in der Mitte: leicht gedreht, äußere Karten etwas tiefer
  function layout() {
    var n = cards.length;
    if (!n) return;
    var cw = cards[0].offsetWidth;
    var ch = cards[0].offsetHeight;
    var gap = Math.min(cw * 0.8, (window.innerWidth * 0.5) / Math.max(1, n - 1));
    var baseY = window.innerHeight - ch - 18;
    cards.forEach(function (el, idx) {
      var off = idx - (n - 1) / 2;
      var x = window.innerWidth / 2 - cw / 2 + off * gap;
      var y = baseY + off * off * 5;
      el.style.zIndex = idx + 1;
      el.style.transform = 'translate(' + x + 'px, ' + y + 'px) rotate(' + off * 5 + 'deg)';
    });
  }

  function deckPos() {
    var rc = deckEl.getBoundingClientRect();
    return 'translate(' + rc.left + 'px, ' + rc.top + 'px) rotate(0deg)';
  }

  // Karten nacheinander vom Deck in die Hand ziehen
  function draw(n) {
    var k = 0;
    (function next() {
      if (k >= n || !deck.length) return;
      k++;
      var el = makeCard(deck.pop());
      updateDeck();
      el.style.transition = 'none';
      el.style.transform = deckPos();
      hand.appendChild(el);
      cards.push(el);
      void el.offsetWidth;
      el.style.transition = '';
      el.classList.remove('bf-flipped');
      layout();
      setTimeout(next, 180);
    })();
  }

  window.addEventListener('resize', layout);
  updateDeck();

  // Zuletzt geändertes Deck laden, Karten nach Anzahl auffächern und mischen
  fetch('/api/deck', { headers: { Accept: 'application/json' } })
    .then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then(function (data) {
      var byId = new Map(data.pool.map(function (c) { return [c.id, c]; }));
      var decks = data.decks.slice().sort(function (a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
      var d = decks[0];
      if (!d || !d.cards.length) {
        hint('Du hast noch kein Deck. <a href="/deck">Deck bauen</a>');
        return;
      }
      d.cards.forEach(function (e) {
        var c = byId.get(e.card);
        if (!c) return;
        for (var k = 0; k < e.n; k++) deck.push(c);
      });
      shuffle(deck);
      updateDeck();
      setTimeout(function () { draw(5); }, 300);
    })
    .catch(function () {
      hint('Das Deck konnte nicht geladen werden.');
    });

  window.bossfight = { boss: boss, player: player, draw: draw };
})();

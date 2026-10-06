// Bosskampf-Oberfläche und Test-Spielablauf:
//   Lebensbalken (Boss 200, Spieler 100), eigenes Deck rechts (zuletzt geändertes aus /api/deck), Start mit 5 Karten.
//   Item-Karten (kampf-Werte aus src/tcg/cardData.js) per Klick aus der Hand ausrüsten: sie erscheinen rechts neben dem
//   Avatar. Zwei Hände – was keinen Platz mehr hat, fliegt raus und ist weg (nicht zurück in die Hand).
//   Waffen und Zauber: Klick = Schaden am Boss, einmal pro Runde. Schilde: dauerhaft 10 % weniger Schaden,
//   der Holzschild zerbricht nach 4 Treffern. „Runde beenden“: der Boss schlägt zu, dann eine neue Karte.
// Zum Ausprobieren in der Konsole: bossfight.boss.damage(30), bossfight.player.heal(5), bossfight.draw(1)
(function () {
  var hand = document.querySelector('[data-bf-hand]');
  var deckEl = document.querySelector('[data-bf-deck]');
  var gearEl = document.querySelector('[data-bf-gear]');
  var endBtn = document.querySelector('[data-bf-end]');
  var roundEl = document.querySelector('[data-bf-round]');
  var resultEl = document.querySelector('[data-bf-result]');
  if (!hand || !deckEl || !gearEl) return;
  var deckCount = deckEl.querySelector('[data-bf-deck-count]');

  var HANDS = 2;
  var HAND_MAX = 8;
  var BOSS_HIT = [8, 14]; // Schaden des Bosses pro Runde (von – bis)

  // ---------- Lebensbalken ----------
  var over = false;
  function HpBar(el) {
    var max = Number(el.getAttribute('data-max')) || 100;
    var fill = el.querySelector('.bf-hp-fill');
    var lag = el.querySelector('.bf-hp-lag');
    var text = el.querySelector('.bf-hp-text');
    var hp = max;
    var bar = {
      el: el,
      max: max,
      get hp() { return hp; },
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
        checkEnd();
        return hp;
      },
      damage: function (n) { return bar.set(hp - n); },
      heal: function (n) { return bar.set(hp + n); },
    };
    el.setAttribute('role', 'progressbar');
    el.setAttribute('aria-valuemin', 0);
    el.setAttribute('aria-valuemax', max);
    return bar;
  }
  var boss = HpBar(document.querySelector('[data-bf-hp="boss"]'));
  var player = HpBar(document.querySelector('[data-bf-hp="player"]'));
  boss.set(boss.max);
  player.set(player.max);

  // Schadenszahl, die kurz über einem Element aufsteigt
  function popup(target, text, cls) {
    var rc = target.getBoundingClientRect();
    var p = document.createElement('span');
    p.className = 'bf-pop ' + (cls || '');
    p.textContent = text;
    p.style.left = rc.left + rc.width / 2 + 'px';
    p.style.top = rc.top + 'px';
    document.body.appendChild(p);
    setTimeout(function () { p.remove(); }, 1100);
  }

  function checkEnd() {
    if (over || !resultEl || !boss || !player) return;
    if (boss.hp > 0 && player.hp > 0) return;
    over = true;
    resultEl.textContent = boss.hp <= 0 ? 'Sieg!' : 'Niederlage';
    resultEl.hidden = false;
    if (endBtn) endBtn.disabled = true;
    document.body.classList.add('bf-over');
  }

  // ---------- Deck und Hand ----------
  var deck = []; // Karten als { id, name, image, kampf }, oben = Ende
  var cards = []; // Karten in der Hand (DOM, el.card = Karte)
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
    el.title = c.kampf ? c.name : c.name + ' (kann hier nicht gespielt werden)';
    el.card = c;
    if (c.kampf) el.classList.add('bf-playable');
    el.addEventListener('click', function () { play(el); });
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
      if (k >= n || !deck.length || cards.length >= HAND_MAX) return;
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

  // ---------- Ausrüstung (rechts neben dem Avatar) ----------
  var gear = []; // { card, el, used, hits }

  function gearHands() {
    return gear.reduce(function (s, g) { return s + (g.card.kampf.haende || 1); }, 0);
  }

  // Was muss für ein neues Item weichen? Erst ein Item derselben Art (Schild für Schild, sonst Waffe/Zauber),
  // dann das älteste – so lange, bis genug Hände frei sind.
  function makeRoom(k) {
    var need = Math.min(HANDS, k.haende || 1);
    var shield = k.typ === 'schild';
    while (gear.length && HANDS - gearHands() < need) {
      var same = gear.filter(function (g) { return (g.card.kampf.typ === 'schild') === shield; });
      unequip(same[0] || gear[0], 'bf-gear-out');
    }
  }

  function unequip(g, cls) {
    gear.splice(gear.indexOf(g), 1);
    g.el.classList.add(cls);
    g.el.disabled = true;
    setTimeout(function () { g.el.remove(); }, 500);
  }

  function gearLabel(g) {
    var k = g.card.kampf;
    var badge = g.el.querySelector('.bf-gear-badge');
    if (k.typ === 'schild') {
      badge.textContent = '−' + (k.schutz || 0) + ' %' + (k.haltbarkeit ? ' · ' + (k.haltbarkeit - g.hits) + '/' + k.haltbarkeit : '');
    } else {
      badge.textContent = (k.schaden || 0) + ' Schaden';
    }
    g.el.classList.toggle('bf-used', !!g.used);
  }

  // Karte aus der Hand spielen: fliegt an ihren Platz neben dem Avatar
  function play(el) {
    if (over) return;
    var c = el.card;
    if (!c.kampf) {
      el.classList.remove('bf-nope');
      void el.offsetWidth;
      el.classList.add('bf-nope');
      return;
    }
    var from = el.getBoundingClientRect();
    cards.splice(cards.indexOf(el), 1);
    el.remove();
    layout();
    makeRoom(c.kampf);

    var g = { card: c, used: false, hits: 0 };
    g.el = document.createElement('button');
    g.el.type = 'button';
    g.el.className = 'bf-gear-card bf-gear-' + c.kampf.typ;
    g.el.title = c.name;
    g.el.innerHTML = '<img alt="" draggable="false"><span class="bf-gear-badge"></span>';
    g.el.querySelector('img').src = c.image;
    g.el.querySelector('img').alt = c.name;
    g.el.addEventListener('click', function () { use(g); });
    gearEl.appendChild(g.el);
    gear.push(g);
    gearLabel(g);

    // FLIP: von der Handposition an den neuen Platz gleiten
    var to = g.el.getBoundingClientRect();
    g.el.style.transition = 'none';
    g.el.style.transform = 'translate(' + (from.left - to.left) + 'px, ' + (from.top - to.top) + 'px) scale(' + from.width / to.width + ')';
    void g.el.offsetWidth;
    g.el.style.transition = '';
    g.el.style.transform = '';
  }

  // Waffe/Zauber einsetzen: einmal pro Runde
  function use(g) {
    if (over || g.card.kampf.typ === 'schild' || g.used) return;
    g.used = true;
    gearLabel(g);
    var dmg = g.card.kampf.schaden || 0;
    boss.damage(dmg);
    popup(boss.el, '−' + dmg, 'bf-pop-boss');
  }

  // ---------- Runden ----------
  var round = 1;
  function endRound() {
    if (over) return;
    endBtn.disabled = true;
    // Boss schlägt zu; jeder Schild nimmt seinen Anteil weg und zählt einen Treffer
    var hit = BOSS_HIT[0] + Math.floor(Math.random() * (BOSS_HIT[1] - BOSS_HIT[0] + 1));
    var shields = gear.filter(function (g) { return g.card.kampf.typ === 'schild'; });
    var pct = Math.min(90, shields.reduce(function (s, g) { return s + (g.card.kampf.schutz || 0); }, 0));
    var dmg = Math.round((hit * (100 - pct)) / 100);
    document.body.classList.add('bf-boss-attack');
    setTimeout(function () {
      document.body.classList.remove('bf-boss-attack');
      player.damage(dmg);
      popup(player.el, '−' + dmg + (pct ? ' (' + hit + ' − ' + pct + ' %)' : ''), 'bf-pop-player');
      shields.forEach(function (g) {
        var max = g.card.kampf.haltbarkeit;
        if (!max) return;
        g.hits++;
        if (g.hits >= max) unequip(g, 'bf-gear-broken');
        else gearLabel(g);
      });
      if (over) return;
      round++;
      if (roundEl) roundEl.textContent = 'Runde ' + round;
      gear.forEach(function (g) {
        g.used = false;
        gearLabel(g);
      });
      draw(1);
      endBtn.disabled = false;
    }, 450);
  }
  if (endBtn) endBtn.addEventListener('click', endRound);

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

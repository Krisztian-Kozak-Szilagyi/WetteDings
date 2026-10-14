// Bosskampf-Oberfläche: zeichnet und animiert, was die Regeln (public/js/bossfight-regeln.js, window.BossRegeln)
// entscheiden. Jede Aktion liefert eine Ereignisliste, die hier der Reihe nach abgespielt wird (Ziehen, Effekte,
// Schaden, Boss-Angriff …); danach wird alles Übrige (Energie, Effekte, Ankündigung) aus dem Zustand neu gezeichnet.
//   Hand unten: Klick = spielen; Druiden fragen danach nach einer Zielkarte (Esc/Rechtsklick = abbrechen).
//   Ausrüstung rechts neben dem Avatar: Waffe/Zauber anklicken = angreifen (einmal pro Runde).
//   Über dem Avatar laufende Effekte (Ring = verbleibende Runden), unter dem Boss-Leben seine Ankündigung.
//   Spielfeld über der Hand (nur Raid, [data-bf-feld]): permanente Karten mit eigenem Leben; Dios Ziel leuchtet rot.
//   Karte anklicken und dann einen Platz im Feld anklicken – oder direkt aufs Feld ziehen. Oben ist vorne (nah an Dio,
//   wird öfter angegriffen); hinter der gestrichelten Linie erreicht er Karten nur mit der Armbrust. Effektkarten wirken
//   dort einmal; was das Feld verlässt, fliegt ins Exil (Stapel links neben dem Deck, [data-bf-exil]).
//   Karte 0,5 s unter der Maus = große Vorschau.
// Zum Ausprobieren in der Konsole: bossfight.zustand() zeigt den Zustand.
// Raid (body data-raid="1", views/raid-kampf.ejs): entschieden wird auf dem Server – jeder Zug geht an /raid/aktion,
// zurück kommen die Ereignisse und der neue Zustand (src/raid/raidService.js). Gezeichnet wird genauso wie im Bosskampf.
(function () {
  var R = window.BossRegeln;
  var hand = document.querySelector('[data-bf-hand]');
  var deckEl = document.querySelector('[data-bf-deck]');
  var gearEl = document.querySelector('[data-bf-gear]');
  var endBtn = document.querySelector('[data-bf-end]');
  var roundEl = document.querySelector('[data-bf-round]');
  var resultEl = document.querySelector('[data-bf-result]');
  var energieEl = document.querySelector('[data-bf-energy]');
  var effekteEl = document.querySelector('[data-bf-effects]');
  var absichtEl = document.querySelector('[data-bf-intent]');
  var feldEl = document.querySelector('[data-bf-feld]');
  var exilEl = document.querySelector('[data-bf-exil]');
  var exilZahl = 0; // während der Animation mitgezählt, danach aus dem Zustand
  if (!R || !hand || !deckEl || !gearEl) return;
  var deckCount = deckEl.querySelector('[data-bf-deck-count]');
  var avatar = document.querySelector('.bf-avatar');

  var s = null; // Zustand aus BossRegeln.neu
  var laufend = false; // Ereignisse werden gerade abgespielt – solange keine Eingaben
  var handEls = new Map(); // uid -> Element in der Hand
  var gearEls = new Map(); // uid -> Element der Ausrüstung
  var feldEls = new Map(); // uid -> Element einer permanenten Karte auf dem Spielfeld
  var ziel = null; // Druide, der gerade ein Ziel sucht: { uid, el }
  var platzWahl = null; // permanente Karte, die gerade einen Platz auf dem Spielfeld sucht: { uid }
  var raid = document.body.getAttribute('data-raid') === '1';
  var csrf = document.body.getAttribute('data-csrf') || '';
  var raidEnde = null; // { sieg, reward } vom Server, sobald der Raid vorbei ist

  // ---------- Lebensbalken ----------
  function HpBar(el) {
    var max = Number(el.getAttribute('data-max')) || 100;
    var fill = el.querySelector('.bf-hp-fill');
    var lag = el.querySelector('.bf-hp-lag');
    var text = el.querySelector('.bf-hp-text');
    var hp = max;
    el.setAttribute('role', 'progressbar');
    el.setAttribute('aria-valuemin', 0);
    return {
      el: el,
      setMax: function (m) {
        max = m;
        el.setAttribute('aria-valuemax', max);
      },
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
      },
    };
  }
  var bossBar = HpBar(document.querySelector('[data-bf-hp="boss"]'));
  var spielerBar = HpBar(document.querySelector('[data-bf-hp="player"]'));

  // ---------- kleine Helfer ----------
  function warte(ms) {
    return new Promise(function (ok) { setTimeout(ok, ms); });
  }
  // Effekte laufen über requestAnimationFrame – in einem verdeckten Tab stehen sie still, darum mit Zeitlimit
  function fx(art, von) {
    if (!window.bossfightFx) return Promise.resolve(null);
    return Promise.race([window.bossfightFx.spiel(art, von), warte(1600).then(function () { return null; })]);
  }
  function popup(target, text, cls) {
    var rc = target.getBoundingClientRect();
    popupAt(rc.left + rc.width / 2, rc.top, text, cls);
  }
  function popupAt(x, y, text, cls) {
    var p = document.createElement('span');
    p.className = 'bf-pop ' + (cls || '');
    p.textContent = text;
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    document.body.appendChild(p);
    setTimeout(function () { p.remove(); }, 1100);
  }
  function nope(el) {
    if (!el) return;
    el.classList.remove('bf-nope');
    void el.offsetWidth;
    el.classList.add('bf-nope');
  }
  function hint(html) {
    var p = document.createElement('p');
    p.className = 'bf-hand-hint';
    p.innerHTML = html;
    hand.appendChild(p);
  }
  function rechteck(el) {
    return el && el.isConnected ? el.getBoundingClientRect() : null;
  }
  // FLIP: Element von einer alten Position (Rechteck) an seinen neuen Platz gleiten lassen
  function gleiten(el, von) {
    if (!von) return;
    var to = el.getBoundingClientRect();
    el.style.transition = 'none';
    el.style.transform = 'translate(' + (von.left - to.left) + 'px, ' + (von.top - to.top) + 'px) scale(' + von.width / to.width + ')';
    void el.offsetWidth;
    el.style.transition = '';
    el.style.transform = '';
  }

  // ---------- Vorschau: Karte 0,5 s unter der Maus groß in der Bildschirmmitte ----------
  var preview = document.createElement('div');
  preview.className = 'bf-preview';
  preview.hidden = true;
  preview.innerHTML = '<img alt=""><p class="bf-preview-info"></p>';
  document.body.appendChild(preview);
  var previewTimer = null;
  function hidePreview() {
    clearTimeout(previewTimer);
    previewTimer = null;
    preview.hidden = true;
  }
  function vorschauText(inst, c) {
    var k = c.kampf;
    if (!k) return 'Kann im Bosskampf nicht gespielt werden.';
    var teile = [];
    if (inst && s) teile.push('Kosten: ' + R.kosten(s, inst) + ' Energie');
    if (R.istPermanent(k)) teile.push('permanent: bleibt auf dem Spielfeld (' + (k.leben || 1) + ' Leben) und wirkt jede Runde erneut');
    else if (k.typ === 'held') teile.push(k.dauer === 'effekt' ? 'Effektkarte: wirkt einmal, dann Ablagestapel' : 'wirkt sofort');
    else if (k.typ === 'schild') teile.push('Schild, bleibt liegen');
    else teile.push('bleibt liegen, einmal pro Runde einsetzbar');
    if (inst && inst.buffs && inst.buffs.length) teile.push('gestärkt: ' + buffText(inst));
    return teile.join(' – ');
  }
  function previewOn(el, c, inst) {
    el.addEventListener('mouseenter', function () {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(function () {
        if (!el.isConnected) return;
        preview.querySelector('img').src = c.image;
        preview.querySelector('img').alt = c.name;
        preview.querySelector('.bf-preview-info').textContent = vorschauText(inst, c);
        preview.hidden = false;
      }, 500);
    });
    el.addEventListener('mouseleave', hidePreview);
    el.addEventListener('mousedown', hidePreview);
  }

  // ---------- Hand ----------
  function buffText(inst) {
    var ang = R.buffSumme(inst, 'ang');
    var sch = R.buffSumme(inst, 'sch');
    var k = R.buffSumme(inst, 'kosten');
    var t = [];
    if (ang) t.push('+' + ang + ' ANG');
    if (sch) t.push('+' + sch + ' SCH');
    if (k) t.push('−' + k + ' ⚡');
    return t.join(' · ');
  }

  function handKarte(inst) {
    var c = inst.card;
    var el = document.createElement('div');
    el.className = 'bf-card bf-flipped';
    el.innerHTML =
      '<div class="bf-card-inner">' +
      '<div class="bf-card-face bf-card-front"><img alt="" draggable="false"><span class="bf-card-buff" hidden></span></div>' +
      '<div class="bf-card-face bf-card-back"></div></div>';
    var img = el.querySelector('img');
    img.src = c.image;
    img.alt = c.name;
    el.title = c.kampf ? c.name : c.name + ' (kann hier nicht gespielt werden)';
    if (c.kampf) el.classList.add('bf-playable');
    // mit Spielfeld (Raid) lassen sich Karten direkt aufs Feld ziehen
    if (feldEl && c.kampf && c.kampf.typ === 'held') {
      el.draggable = true;
      el.addEventListener('dragstart', function (e) {
        if (!s || laufend || s.vorbei || !R.spielbar(s, inst.uid).ok) return e.preventDefault();
        hidePreview();
        e.dataTransfer.setData('text/plain', String(inst.uid));
        e.dataTransfer.effectAllowed = 'move';
        var bild = el.querySelector('img');
        e.dataTransfer.setDragImage(bild, bild.offsetWidth / 2, bild.offsetHeight / 2);
        platzStart(inst.uid, true);
      });
      el.addEventListener('dragend', function () { if (platzWahl) platzEnde(); });
    }
    el.addEventListener('click', function () { klickHand(inst.uid); });
    el.addEventListener('contextmenu', function (e) {
      if (!ziel) return;
      e.preventDefault();
      zielEnde();
    });
    previewOn(el, c, inst);
    handEls.set(inst.uid, el);
    return el;
  }

  // Fächer unten in der Mitte: leicht gedreht, äußere Karten etwas tiefer
  function layout() {
    if (!s) return;
    var els = s.hand.map(function (i) { return handEls.get(i.uid); }).filter(Boolean);
    var n = els.length;
    if (!n) return;
    var cw = els[0].offsetWidth;
    var ch = els[0].offsetHeight;
    var gap = Math.min(cw * 0.8, (window.innerWidth * 0.5) / Math.max(1, n - 1));
    var baseY = window.innerHeight - ch - 18;
    els.forEach(function (el, idx) {
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

  // ---------- Ausrüstung ----------
  function gearKarte(g) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'bf-gear-card bf-gear-' + g.card.kampf.typ;
    el.title = g.card.name;
    el.innerHTML = '<img alt="" draggable="false"><span class="bf-gear-badge"></span>';
    el.querySelector('img').src = g.card.image;
    el.querySelector('img').alt = g.card.name;
    el.addEventListener('click', function () { klickGear(g.uid); });
    previewOn(el, g.card, null);
    gearEls.set(g.uid, el);
    return el;
  }
  function gearWeg(g, cls) {
    var el = gearEls.get(g.uid);
    gearEls.delete(g.uid);
    if (!el) return;
    el.classList.add(cls);
    el.disabled = true;
    setTimeout(function () { el.remove(); }, 500);
  }

  // ---------- Spielfeld: permanente Karten mit Lebensbalken ----------
  function feldKarte(f) {
    var el = document.createElement('div');
    el.className = 'bf-feld-card';
    el.innerHTML = '<img alt="" draggable="false"><span class="bf-feld-hp"><span class="bf-feld-hp-fill"></span><b class="bf-feld-hp-text"></b></span>';
    el.style.setProperty('--x', f.x == null ? 50 : f.x);
    el.style.setProperty('--y', f.y == null ? 50 : f.y);
    el.style.zIndex = 200 - (f.y || 0); // vorne liegende Karten liegen oben
    el.querySelector('img').src = f.card.image;
    el.querySelector('img').alt = f.card.name;
    el.title = f.card.name;
    previewOn(el, f.card, null);
    feldEls.set(f.uid, el);
    (feldEl || gearEl).appendChild(el);
    return el;
  }
  function feldHp(el, hp, max) {
    el.dataset.max = max;
    el.querySelector('.bf-feld-hp-fill').style.width = Math.max(0, (hp / max) * 100) + '%';
    el.querySelector('.bf-feld-hp-text').textContent = hp + ' / ' + max;
    el.title = el.querySelector('img').alt + ' – ' + hp + ' / ' + max + ' Leben';
  }
  function anstossen(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
  function zeichnenFeld() {
    if (!s) return;
    var feld = s.feld || [];
    var da = new Set(feld.map(function (f) { return f.uid; }));
    feldEls.forEach(function (el, uid) {
      if (da.has(uid)) return;
      feldEls.delete(uid);
      el.remove();
    });
    var zielUid = s.absicht && s.absicht.ziel ? s.absicht.ziel.uid : null;
    feld.forEach(function (f) {
      var el = feldEls.get(f.uid) || feldKarte(f);
      feldHp(el, f.hp, f.max);
      el.classList.toggle('bf-feld-ziel', f.uid === zielUid && !s.vorbei);
    });
    if (feldEl) {
      // Reichweite von Dios Nahkampf: dahinter trifft er nur mit der Armbrust
      var weit = s.bd && s.bd.nahReichweite != null ? s.bd.nahReichweite : 1;
      feldEl.style.setProperty('--reichweite', Math.round(weit * 100));
      feldEl.toggleAttribute('data-ohne-linie', weit >= 1);
      feldEl.toggleAttribute('data-leer', !feld.length);
      feldEl.setAttribute('data-plaetze', feld.length + (feld.length === 1 ? ' Karte' : ' Karten'));
    }
  }

  // Effektkarte erscheint an ihrem Platz auf dem Feld (sie wirkt von dort) und fliegt danach ins Exil ('exil')
  function effektAufFeld(c, pos, von) {
    var el = document.createElement('div');
    el.className = 'bf-feld-card bf-feld-effekt';
    el.innerHTML = '<img alt="" draggable="false">';
    el.querySelector('img').src = c.image;
    el.querySelector('img').alt = c.name;
    el.style.setProperty('--x', pos.x);
    el.style.setProperty('--y', pos.y);
    el.style.zIndex = 260;
    feldEl.appendChild(el);
    gleiten(el, von);
    return el;
  }
  // Karte fliegt zum Exil-Stapel und verschwindet dort
  function insExil(el, c) {
    var ziel = exilEl ? exilEl.getBoundingClientRect() : null;
    var rc = el.getBoundingClientRect();
    if (ziel) {
      el.style.transition = 'transform .55s cubic-bezier(.5, 0, .75, .4), opacity .55s';
      el.style.transform = 'translate(' + (ziel.left + ziel.width / 2 - rc.left - rc.width / 2) + 'px, ' + (ziel.top + ziel.height / 2 - rc.top - rc.height / 2) + 'px) scale(.6) rotate(8deg)';
      el.style.opacity = '.2';
    } else el.classList.add('bf-feld-weg');
    setTimeout(function () {
      el.remove();
      exilOben(c, 1);
    }, 560);
  }
  // Exil-Stapel: oberste Karte und Anzahl (plus = gerade hinzugekommen)
  function exilOben(c, plus) {
    if (!exilEl) return;
    // nie mehr als im Zustand (Animationen können nach dem Neuzeichnen enden)
    exilZahl = Math.min(exilZahl + (plus || 0), s && s.exil ? s.exil.length : Infinity);
    var img = exilEl.querySelector('img');
    if (c) {
      img.src = c.image;
      img.alt = c.name;
    }
    img.hidden = !exilZahl;
    exilEl.querySelector('[data-bf-exil-count]').textContent = exilZahl;
    exilEl.toggleAttribute('data-leer', !exilZahl);
    exilEl.title = 'Exil: ' + exilZahl + (exilZahl === 1 ? ' Karte' : ' Karten') + ' aus dem Spiel genommen';
    if (plus) anstossen(exilEl, 'bf-exil-neu');
  }

  // Held-Karte leuchtet kurz neben der Ausrüstung auf und verschwindet
  function aufblitzen(c, von) {
    var flash = document.createElement('div');
    flash.className = 'bf-held-flash';
    flash.innerHTML = '<img alt="" draggable="false">';
    flash.querySelector('img').src = c.image;
    flash.querySelector('img').alt = c.name;
    gearEl.appendChild(flash);
    gleiten(flash, von);
    setTimeout(function () { flash.classList.add('bf-held-weg'); }, 1300);
    setTimeout(function () { flash.remove(); }, 1800);
    return flash;
  }

  // ---------- Ereignisse abspielen ----------
  var letzteQuelle = new Map(); // uid der gespielten Karte -> Element, von dem ihr Effekt ausgeht
  function abspielen(ev) {
    laufend = true;
    if (endBtn) endBtn.disabled = true;
    hidePreview();
    var kette = Promise.resolve();
    ev.forEach(function (e) {
      kette = kette.then(function () { return schritt(e); });
    });
    return kette.then(function () {
      laufend = false;
      zeichnen();
    }, function (err) {
      laufend = false;
      zeichnen();
      console.error(err);
    });
  }

  function schritt(e) {
    switch (e.t) {
      case 'ziehen': {
        var el = handKarte(e.inst);
        el.style.transition = 'none';
        el.style.transform = deckPos();
        hand.appendChild(el);
        void el.offsetWidth;
        el.style.transition = '';
        el.classList.remove('bf-flipped');
        deckCount.textContent = s.deck.length;
        layout();
        return warte(160);
      }
      case 'gespielt': {
        var hel = handEls.get(e.inst.uid);
        var von = rechteck(hel);
        handEls.delete(e.inst.uid);
        if (hel) hel.remove();
        layout();
        if (e.permanent) letzteQuelle.set(e.inst.uid, von); // gleitet gleich aufs Spielfeld ('feld')
        else if (e.pos && feldEl) letzteQuelle.set(e.inst.uid, effektAufFeld(e.inst.card, e.pos, von)); // wirkt an ihrem Platz, dann Exil
        else if (e.inst.card.kampf.typ === 'held') letzteQuelle.set(e.inst.uid, aufblitzen(e.inst.card, von));
        else letzteQuelle.set(e.inst.uid, von);
        return warte(e.inst.card.kampf.typ === 'held' && !e.permanent ? 350 : 0);
      }
      case 'feld': {
        var fel = feldEls.get(e.f.uid) || feldKarte(e.f);
        feldHp(fel, e.f.hp, e.f.max);
        gleiten(fel, letzteQuelle.get(e.f.uid));
        letzteQuelle.set(e.f.uid, fel);
        if (feldEl) feldEl.removeAttribute('data-leer');
        return warte(380);
      }
      case 'feldwirkt':
        anstossen(feldEls.get(e.uid), 'bf-feld-wirkt');
        return warte(260);
      case 'feldschaden': {
        var tel = feldEls.get(e.uid);
        if (tel) {
          feldHp(tel, e.hp, Number(tel.dataset.max) || e.hp);
          anstossen(tel, 'bf-feld-treffer');
          popup(tel, '−' + e.wert + (e.text ? ' ' + e.text : ''), 'bf-pop-player');
        }
        return warte(300);
      }
      case 'exil': {
        // Effektkarte hat gewirkt: vom Feld ins Exil
        var xel = letzteQuelle.get(e.uid);
        if (xel instanceof Element && xel.classList.contains('bf-feld-effekt')) insExil(xel, e.card);
        else exilOben(e.card, 1);
        return warte(250);
      }
      case 'verlassen': {
        var vel = feldEls.get(e.uid);
        feldEls.delete(e.uid);
        if (vel) {
          popup(vel, e.grund === 'zerstoert' ? e.card.name + ' zerstört' : e.card.name + ' verlässt das Feld', 'bf-pop-info');
          if (e.grund === 'zerstoert') {
            vel.classList.add('bf-feld-zerstoert');
            setTimeout(function () { vel.remove(); exilOben(e.card, 1); }, 600);
          } else insExil(vel, e.card);
        }
        return warte(450);
      }
      case 'ausgeruestet': {
        e.weg.forEach(function (g) { gearWeg(g, 'bf-gear-out'); });
        var gel = gearKarte(e.g);
        gearEl.appendChild(gel);
        gleiten(gel, letzteQuelle.get(e.g.uid));
        return warte(300);
      }
      case 'eingesetzt':
        zeichnenGear();
        return null;
      case 'boss': {
        var quelle = (e.uid && (gearEls.get(e.uid) || feldEls.get(e.uid) || letzteQuelle.get(e.uid))) || effekteEl || gearEl;
        if (!(quelle instanceof Element)) quelle = gearEl;
        return fx(e.fx, quelle).then(function (p) {
          bossBar.set(e.hp);
          if (p) popupAt(p.x, p.y - 40, '−' + e.wert, 'bf-pop-boss bf-pop-gross');
          else popup(bossBar.el, '−' + e.wert, 'bf-pop-boss');
        });
      }
      case 'spieler':
        spielerBar.set(e.hp);
        popup(spielerBar.el, '−' + e.wert + (e.text ? ' ' + e.text : ''), 'bf-pop-player');
        return warte(250);
      case 'heil':
        spielerBar.set(e.hp);
        popup(spielerBar.el, '+' + e.wert, 'bf-pop-heal');
        return warte(200);
      case 'info':
        popup(e.wo === 'boss' ? bossBar.el : e.wo === 'energie' && energieEl ? energieEl : spielerBar.el, e.text, 'bf-pop-info');
        return warte(150);
      case 'buff': {
        var zel = handEls.get(e.ziel.uid);
        if (zel) {
          zel.classList.remove('bf-buffed');
          void zel.offsetWidth;
          zel.classList.add('bf-buffed');
        }
        return warte(250);
      }
      case 'bossangriff': {
        document.body.classList.add('bf-boss-attack');
        // trifft er eine Karte auf dem Spielfeld, fliegt der Angriff dorthin statt zum Avatar
        var getroffen = (e.ziel && feldEls.get(e.ziel)) || avatar;
        var angriff = e.aus || !window.bossfightFx || !getroffen
          ? warte(250)
          : Promise.race([window.bossfightFx.bossAngriff(getroffen, e.schild), warte(800)]);
        return angriff.then(function () {
          document.body.classList.remove('bf-boss-attack');
          var bei = (e.ziel && feldEls.get(e.ziel)) || spielerBar.el;
          if (e.aus) popup(bei, e.absicht.name + ': ausgesetzt', 'bf-pop-info');
          else if (e.details.length) popup(bei, e.absicht.name + ' ' + e.roh + ' → ' + e.wert + ' (' + e.details.join(', ') + ')', 'bf-pop-info');
          return warte(200);
        });
      }
      case 'zerbrochen':
        gearWeg(e.g, 'bf-gear-broken');
        return warte(200);
      case 'runde':
        if (roundEl) roundEl.textContent = 'Runde ' + e.nr;
        if (e.netz) popup(energieEl || spielerBar.el, (raid ? 'Rauch' : 'Netz') + ': −' + e.netz + ' Energie', 'bf-pop-info');
        zeichnenGear();
        return warte(200);
      case 'absicht':
        zeichnenAbsicht();
        zeichnenFeld();
        return null;
      case 'zusatz':
        // Krit-Lotterie (Lucky Dio): Zusatztreffer aus dem Münzwurf nach seinem Angriff
        popup((e.ziel && feldEls.get(e.ziel)) || spielerBar.el, (e.seite === 'kopf' ? 'Kopf! Armbrust-Krit ' : 'Zahl · Dolch ') + e.wert + (e.seite === 'zahl' ? ' · Glücks-Token ' + e.tokens : ''), e.seite === 'kopf' ? 'bf-pop-schwer' : 'bf-pop-info');
        return warte(450);
      case 'muenze':
        // Münzwurf-Angriff: Kopf trifft mehrfach, Zahl gibt dem Boss einen Glücks-Token (stärkt seine Angriffe)
        popup(bossBar.el, e.seite === 'kopf' ? 'Kopf! Voller Glückstreffer' : 'Zahl – Glücks-Token ' + e.tokens, e.seite === 'kopf' ? 'bf-pop-schwer' : 'bf-pop-info');
        return warte(650);
      case 'ende':
        if (resultEl) {
          if (raid) ergebnisRaid(e);
          else resultEl.textContent = e.sieg ? 'Sieg!' : 'Niederlage';
          resultEl.hidden = false;
        }
        document.body.classList.add('bf-over');
        return null;
      case 'nein':
        nope(handEls.get(e.uid));
        popup(energieEl && /Energie/.test(e.grund) ? energieEl : spielerBar.el, e.grund, 'bf-pop-info');
        return null;
      default:
        return null;
    }
  }

  // ---------- Zeichnen aus dem Zustand ----------
  function zeichnen() {
    if (!s) return;
    if (energieEl) energieEl.textContent = '⚡ ' + s.energie + ' / ' + (s.maxEnergie || s.sp.energie);
    if (exilEl && s.exil) {
      exilZahl = s.exil.length;
      exilOben(s.exil.length ? s.exil[s.exil.length - 1].card : null, 0);
    }
    if (endBtn) endBtn.disabled = laufend || !!s.vorbei;
    deckCount.textContent = s.deck.length;
    if (s.deck.length) deckEl.removeAttribute('data-leer');
    else deckEl.setAttribute('data-leer', '');
    s.hand.forEach(function (inst) {
      var el = handEls.get(inst.uid);
      if (!el) return;
      var badge = el.querySelector('.bf-card-buff');
      var t = buffText(inst);
      badge.textContent = t;
      badge.hidden = !t;
      el.classList.toggle('bf-zu-teuer', !!inst.card.kampf && R.kosten(s, inst) > s.energie);
    });
    zeichnenGear();
    zeichnenFeld();
    zeichnenEffekte();
    zeichnenAbsicht();
    layout();
  }

  function zeichnenGear() {
    if (!s) return;
    s.gear.forEach(function (g) {
      var el = gearEls.get(g.uid);
      if (!el) return;
      var k = g.card.kampf;
      var badge = el.querySelector('.bf-gear-badge');
      if (k.typ === 'schild') badge.textContent = '−' + (k.schutz || 0) + ' %' + (k.haltbarkeit ? ' · ' + (k.haltbarkeit - g.hits) + '/' + k.haltbarkeit : '');
      else badge.textContent = (k.schaden || 0) + (g.bonus || 0) + ' Schaden';
      el.classList.toggle('bf-used', !!g.used);
    });
  }

  // Ankündigung des Bosses unter seinem Lebensbalken: Angriff, Schaden und was davon nach Abwehr übrig bleibt
  function zeichnenAbsicht() {
    if (!absichtEl || !s || !s.absicht) return;
    var a = s.absicht;
    var v = R.vorschau(s);
    var muenze = a.muenze && s.bd && s.bd.muenze ? ' · Münzwurf: Kopf ×' + String(s.bd.muenze.kopfFaktor).replace('.', ',') + ', Zahl = Glücks-Token' : '';
    // Krit-Lotterie: danach immer ein Zusatztreffer aus dem Münzwurf
    var lot = s.bd && s.bd.lotterie;
    if (lot) muenze += ' · danach Münzwurf: ' + lot.zusatz[0] + '–' + lot.zusatz[1] + ' (Kopf ×' + String(lot.kritFaktor).replace('.', ',') + ')';
    // Reichweite: Nahkampf erreicht nur Karten bis zur Linie, die Armbrust das ganze Feld
    if (s.feld && s.feld.length && s.bd && s.bd.feldZiel) muenze += a.fern ? ' · Armbrust: erreicht das ganze Feld' : ' · Nahkampf: nur bis zur Linie';
    var extra = (a.gift ? ' + Gift ' + a.gift.schaden + '×' + a.gift.runden : a.netz ? ' + ' + (raid ? 'Rauch' : 'Netz') + ' (−' + a.netz + ' Energie)' : '') + muenze;
    var zielKarte = R.angriffsZiel(s);
    var wen = zielKarte ? zielKarte.card.name : 'dich';
    var trifft = v.aus ? 'ausgesetzt' : v.wert !== a.schaden || zielKarte ? 'trifft ' + wen + ' mit ' + v.wert : '';
    absichtEl.innerHTML = '';
    var b = document.createElement('b');
    b.textContent = a.name + ' ' + a.schaden;
    absichtEl.appendChild(document.createTextNode('Nächster Angriff: '));
    absichtEl.appendChild(b);
    absichtEl.appendChild(document.createTextNode(extra + (trifft ? ' – ' + trifft : '')));
    absichtEl.classList.toggle('bf-intent-schwer', a.schwer);
    absichtEl.classList.toggle('bf-intent-wut', a.wut);
    var lotK = s.bd && s.bd.lotterie;
    var tok = lotK ? ' Krit-Chance seiner Angriffe: ' + Math.round((lotK.grundKrit + (s.boss.tokens || 0) * lotK.tokenKrit) * 100) + ' % (' + (s.boss.tokens || 0) + ' Glücks-Tokens).' : '';
    absichtEl.title = (a.wut ? ((s.bd && s.bd.name) || 'Der Boss') + ' ist wütend: seine Angriffe sind stärker.' : '') + tok;
  }

  // Laufende Effekte über dem Avatar: Kartenbild im Kreis (Boss-Effekte mit Symbol), Ring = verbleibende Runden
  var effektEls = new Map();
  var EFFEKT_TEXT = {
    block: function (e) { return 'Block ' + e.wert + ' gegen den nächsten Boss-Angriff'; },
    schwach: function (e) { return 'Nächster Boss-Angriff ' + e.wert + ' % schwächer'; },
    betaeubt: function () { return 'Der Boss setzt seinen nächsten Angriff aus'; },
    dot: function (e) { return e.name + ': ' + e.wert + ' Schaden pro Runde, noch ' + e.runden + ' Runde(n)'; },
    nachladen: function (e) { return e.wert + ' Schaden zu Beginn der nächsten Runde'; },
    gift: function (e) { return 'Gift: du verlierst ' + e.wert + ' Leben pro Runde, noch ' + e.runden + ' Runde(n)'; },
    netz: function (e) { return 'Netz: nächste Runde ' + e.wert + ' Energie weniger'; },
  };
  var EFFEKT_SYMBOL = { gift: '☠', netz: '🕸' };
  function zeichnenEffekte() {
    if (!effekteEl || !s) return;
    var keep = new Set(s.effekte.map(function (e) { return e.key; }));
    effektEls.forEach(function (el, key) {
      if (keep.has(key)) return;
      effektEls.delete(key);
      el.classList.add('bf-eff-weg');
      setTimeout(function () { el.remove(); }, 400);
    });
    s.effekte.forEach(function (e) {
      var el = effektEls.get(e.key);
      if (!el) {
        el = document.createElement('span');
        el.className = 'bf-eff' + (e.card ? '' : ' bf-eff-boss');
        el.innerHTML = '<span class="bf-eff-bild"></span><b class="bf-eff-zahl"></b>';
        var bild = el.querySelector('.bf-eff-bild');
        if (e.card) bild.style.backgroundImage = 'url("' + e.card.image + '")';
        else bild.textContent = EFFEKT_SYMBOL[e.art] || '!';
        effekteEl.appendChild(el);
        effektEls.set(e.key, el);
        el.style.setProperty('--p', 1);
      }
      var text = (e.card ? e.card.name + ': ' : '') + (EFFEKT_TEXT[e.art] ? EFFEKT_TEXT[e.art](e) : e.name);
      el.title = text;
      el.setAttribute('aria-label', text);
      el.querySelector('.bf-eff-zahl').textContent = e.runden;
      void el.offsetWidth;
      el.style.setProperty('--p', e.max ? e.runden / e.max : 1);
    });
  }

  // ---------- Eingaben ----------
  function klickHand(uid) {
    if (!s || laufend || s.vorbei) return;
    hidePreview();
    if (ziel) {
      if (uid === ziel.uid) return zielEnde();
      if (R.ziele(s, ziel.uid).indexOf(uid) < 0) return nope(handEls.get(uid));
      var druide = ziel.uid;
      zielEnde();
      return zug(function () { return R.spielen(s, druide, uid); }, { a: 'spielen', uid: druide, ziel: uid });
    }
    var ok = R.spielbar(s, uid);
    if (!ok.ok) return abspielen([{ t: 'nein', uid: uid, grund: ok.grund }]);
    if (ok.ziel) return zielStart(uid);
    var inst = s.hand.filter(function (i) { return i.uid === uid; })[0];
    if (feldEl && inst && inst.card.kampf.typ === 'held') {
      if (platzWahl && platzWahl.uid === uid) return platzEnde();
      return platzStart(uid);
    }
    zug(function () { return R.spielen(s, uid); }, { a: 'spielen', uid: uid });
  }

  // ---------- Platz auf dem Spielfeld wählen ----------
  var geist = null; // durchsichtige Vorschau der Karte unter der Maus
  function platzStart(uid, ziehen) {
    platzEnde();
    platzWahl = { uid: uid };
    document.body.classList.add('bf-platzwahl');
    var hel = handEls.get(uid);
    if (hel) hel.classList.add('bf-ziel-quelle');
    if (!ziehen) {
      var inst = s.hand.filter(function (i) { return i.uid === uid; })[0];
      geist = document.createElement('div');
      geist.className = 'bf-feld-card bf-feld-geist';
      geist.innerHTML = '<img alt="" draggable="false">';
      geist.querySelector('img').src = inst.card.image;
      geist.hidden = true;
      feldEl.appendChild(geist);
      popup(feldEl, 'Klicke auf einen Platz im Spielfeld – vorne wird öfter angegriffen', 'bf-pop-info');
    }
  }
  function platzEnde() {
    platzWahl = null;
    document.body.classList.remove('bf-platzwahl');
    handEls.forEach(function (el) { el.classList.remove('bf-ziel-quelle'); });
    if (geist) geist.remove();
    geist = null;
  }
  // Mausposition → Platz (0–100): die Karte liegt ganz im Feld, Mitte der Karte unter der Maus
  function platzVon(e) {
    var rc = feldEl.getBoundingClientRect();
    var probe = feldEl.querySelector('.bf-feld-card');
    var cw = probe ? probe.offsetWidth : rc.width * 0.1;
    var ch = probe ? probe.offsetHeight : rc.height * 0.4;
    var stil = getComputedStyle(feldEl);
    var pl = parseFloat(stil.paddingLeft) || 0;
    var pt = parseFloat(stil.paddingTop) || 0;
    var w = rc.width - pl - (parseFloat(stil.paddingRight) || 0) - cw;
    var h = rc.height - pt - (parseFloat(stil.paddingBottom) || 0) - ch;
    var clamp = function (v) { return Math.max(0, Math.min(100, Math.round(v))); };
    return { x: clamp(((e.clientX - rc.left - pl - cw / 2) / Math.max(1, w)) * 100), y: clamp(((e.clientY - rc.top - pt - ch / 2) / Math.max(1, h)) * 100) };
  }
  function legen(uid, pos) {
    platzEnde();
    zug(function () { return R.spielen(s, uid, undefined, pos); }, { a: 'spielen', uid: uid, x: pos.x, y: pos.y });
  }
  if (feldEl) {
    feldEl.addEventListener('mousemove', function (e) {
      if (!platzWahl || !geist) return;
      var p = platzVon(e);
      geist.hidden = false;
      geist.style.setProperty('--x', p.x);
      geist.style.setProperty('--y', p.y);
    });
    feldEl.addEventListener('click', function (e) {
      if (!platzWahl || laufend) return;
      legen(platzWahl.uid, platzVon(e));
    });
    feldEl.addEventListener('contextmenu', function (e) {
      if (!platzWahl) return;
      e.preventDefault();
      platzEnde();
    });
    feldEl.addEventListener('dragover', function (e) {
      if (!platzWahl) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    feldEl.addEventListener('drop', function (e) {
      if (!platzWahl) return;
      e.preventDefault();
      var uid = Number(e.dataTransfer.getData('text/plain')) || platzWahl.uid;
      legen(uid, platzVon(e));
    });
  }
  function klickGear(uid) {
    if (!s || laufend || s.vorbei || ziel) return;
    if (raid) return zug(null, { a: 'einsetzen', uid: uid });
    var ev = R.einsetzen(s, uid);
    if (ev.length) abspielen(ev);
  }

  // Ein Zug: im Bosskampf direkt mit den Regeln, im Raid über den Server (der entscheidet und würfelt)
  function zug(lokal, aktion) {
    if (!raid) return abspielen(lokal());
    laufend = true;
    if (endBtn) endBtn.disabled = true;
    var body = new URLSearchParams({ _csrf: csrf, a: aktion.a });
    if (aktion.uid != null) body.set('uid', aktion.uid);
    if (aktion.ziel != null) body.set('ziel', aktion.ziel);
    if (aktion.x != null) {
      body.set('x', aktion.x);
      body.set('y', aktion.y);
    }
    return fetch('/raid/aktion', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: body })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.error) throw new Error(res.error);
        s = vomServer(res.state);
        if (res.ende) raidEnde = res.ende;
        laufend = false;
        return abspielen(res.ev);
      })
      .catch(function (err) {
        laufend = false;
        zeichnen();
        popup(spielerBar.el, err.message || 'Der Zug kam nicht an – bitte die Seite neu laden.', 'bf-pop-info');
      });
  }
  // Zustand vom Server: der Nachziehstapel kommt nur als Anzahl (die Reihenfolge bleibt geheim)
  function vomServer(st) {
    st.deck = new Array(st.deck || 0);
    return st;
  }
  // Ende im Raid: Ergebnis und Belohnung, zurück zur Raid-Seite
  function ergebnisRaid(e) {
    var r = (raidEnde && raidEnde.reward) || {};
    resultEl.innerHTML = '';
    var h = document.createElement('div');
    h.className = 'bf-result-titel';
    h.textContent = e.sieg ? 'Lucky Dio besiegt!' : e.flucht ? 'Lucky Dio ist entkommen' : 'Niederlage';
    resultEl.appendChild(h);
    var p = document.createElement('div');
    p.className = 'bf-result-text';
    var euro = function (c) { return (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }); };
    p.textContent = e.sieg ? (r.geld ? euro(r.geld) + ' Beute' : 'Sieg') + (r.dio ? ' – und er hat seine Karte fallen lassen: Dio Schattenpfeil ist jetzt in deinem Album!' : ' – seine Karte hat er diesmal behalten.') : 'Versuch es mit einem anderen Deck oder einem besseren Plan noch einmal.';
    resultEl.appendChild(p);
    var a = document.createElement('a');
    a.className = 'bf-result-link';
    a.href = '/raid';
    a.textContent = 'Zurück zum Raid';
    resultEl.appendChild(a);
    if (r.dio) document.body.classList.add('bf-dio-drop');
  }

  // Druide: Zielkarte wählen (gültige Ziele leuchten, die anderen werden blass)
  function zielStart(uid) {
    ziel = { uid: uid };
    var ok = R.ziele(s, uid);
    document.body.classList.add('bf-zielwahl');
    handEls.forEach(function (el, id) {
      el.classList.toggle('bf-ziel', ok.indexOf(id) >= 0);
      el.classList.toggle('bf-ziel-quelle', id === uid);
    });
    popup(handEls.get(uid), 'Wähle eine Karte zum Stärken', 'bf-pop-info');
  }
  function zielEnde() {
    ziel = null;
    document.body.classList.remove('bf-zielwahl');
    handEls.forEach(function (el) {
      el.classList.remove('bf-ziel');
      el.classList.remove('bf-ziel-quelle');
    });
  }
  // Esc bricht die Zielwahl ab (statt die Seite zu verlassen – das macht bossfight.js sonst mit Esc)
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && (ziel || platzWahl)) {
      e.stopImmediatePropagation();
      e.preventDefault();
      zielEnde();
      platzEnde();
    }
  }, true);

  if (endBtn) {
    endBtn.addEventListener('click', function () {
      if (!s || laufend || s.vorbei) return;
      zielEnde();
      platzEnde();
      zug(function () { return R.rundeEnde(s); }, { a: 'ende' });
    });
  }
  window.addEventListener('resize', layout);

  // ---------- Start im Raid: laufenden Kampf vom Server laden ----------
  if (raid) {
    if (endBtn) endBtn.disabled = true;
    fetch('/raid/zustand', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        s = vomServer(data.state);
        bossBar.setMax(s.boss.max);
        bossBar.set(s.boss.hp);
        spielerBar.setMax(s.spieler.max);
        spielerBar.set(s.spieler.hp);
        if (data.ev && data.ev.length) {
          // erster Aufruf: Startkarten ziehen lassen
          var hand0 = s.hand;
          s.hand = [];
          zeichnen();
          s.hand = hand0;
          setTimeout(function () { abspielen(data.ev); }, 300);
        } else {
          s.hand.forEach(function (inst) { var el = handKarte(inst); el.classList.remove('bf-flipped'); hand.appendChild(el); });
          zeichnen();
          layout();
        }
      })
      .catch(function (err) {
        console.error(err);
        hint('Der Kampf konnte nicht geladen werden. <a href="/raid">Zurück zum Raid</a>');
      });
    window.bossfight = { zustand: function () { return s; }, regeln: R };
    return;
  }

  // ---------- Start: zuletzt geändertes Deck laden ----------
  bossBar.setMax(R.SPINNE.hp);
  bossBar.set(R.SPINNE.hp);
  spielerBar.setMax(R.SPIELER.hp);
  spielerBar.set(R.SPIELER.hp);
  if (endBtn) endBtn.disabled = true;
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
      var karten = [];
      d.cards.forEach(function (e) {
        var c = byId.get(e.card);
        if (!c) return;
        // ältere Decks können noch mehr Exemplare haben, als heute erlaubt (Items nur 1-mal)
        for (var k = 0; k < Math.min(e.n, c.limit || e.n); k++) karten.push(c);
      });
      var start = R.neu(karten);
      s = start.s;
      if (!s.deck.length && !s.hand.length) {
        hint('In deinem Deck ist keine Karte, die im Bosskampf spielbar ist.');
        return;
      }
      zeichnen();
      setTimeout(function () { abspielen(start.ev); }, 300);
    })
    .catch(function (err) {
      console.error(err);
      hint('Das Deck konnte nicht geladen werden.');
    });

  window.bossfight = { zustand: function () { return s; }, regeln: R };
})();

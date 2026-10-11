// Grading-Schreibtisch (#204): Objekte auf dem Tisch öffnen Fenster (<dialog data-gd-sheet>) – als Blatt von unten,
// auf breiten Bildschirmen seitlich. ?reiter=<key> öffnet beim Laden (Rückweg nach Formularen); die Zurück-Taste
// schließt das Fenster wieder. Hinweise (Flash) nach einem Formular wandern ins geöffnete Fenster.
(function () {
  'use strict';
  var desk = document.querySelector('[data-gd-desk]');
  if (!desk) return;
  var sheets = {};
  document.querySelectorAll('[data-gd-sheet]').forEach(function (d) { sheets[d.getAttribute('data-gd-sheet')] = d; });
  var base = location.pathname;
  // Zeiten der Auftragsverwaltung in ms – hier an einer Stelle einstellen (das CSS liest sie über Variablen mit)
  var T = { stamp: 2000, fade: 2000, enter: 2500 }; // Stempel landet · Inhalt blendet aus · Inhalt blendet ein
  var rootStyle = document.documentElement.style;
  rootStyle.setProperty('--ord-t-stamp', T.stamp + 'ms');
  rootStyle.setProperty('--ord-t-fade', T.fade + 'ms');
  rootStyle.setProperty('--ord-t-enter', T.enter + 'ms');
  var pushed = false; // Fenster per Klick geöffnet → Schließen geht in der History zurück

  // Antwort der Auftragsverwaltung (X-GD-Fetch): nur echtes JSON zählt – eine abgelaufene Sitzung leitet zum Login um
  // (Status 200), das darf nicht als „angenommen“ durchgehen
  function okJson(res) {
    if (!res.ok || res.redirected || (res.headers.get('content-type') || '').indexOf('json') < 0) throw new Error('abgelehnt');
    return res.json();
  }
  function post(form) {
    return fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), credentials: 'same-origin', headers: { 'X-GD-Fetch': '1' } }).then(okJson);
  }

  function current() {
    for (var k in sheets) if (sheets[k].open) return k;
    return null;
  }

  function open(key, push) {
    var d = sheets[key];
    if (!d) return false;
    var cur = current();
    if (cur === key) return true;
    if (cur) sheets[cur].close();
    d.showModal();
    if (push) {
      history.pushState({ gd: key }, '', base + '?reiter=' + key);
      pushed = true;
    } else {
      history.replaceState({ gd: key }, '', base + '?reiter=' + key);
    }
    d.dispatchEvent(new CustomEvent('gd:open'));
    return true;
  }

  Object.keys(sheets).forEach(function (key) {
    var d = sheets[key];
    // close kommt verzögert: nur reagieren, wenn die Adresse noch dieses Fenster zeigt (nicht nach Zurück/Wechsel)
    d.addEventListener('close', function () {
      if (!history.state || history.state.gd !== key) return;
      if (pushed) {
        pushed = false;
        history.back();
      } else {
        history.replaceState(null, '', base);
      }
    });
    // Tippen neben das Fenster schließt
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
    d.querySelectorAll('[data-gd-close]').forEach(function (b) { b.addEventListener('click', function () { d.close(); }); });
    // Am Griff nach unten wischen schließt (Handy)
    var head = d.querySelector('.gd-sheet-head');
    if (head && !d.classList.contains('gd-pop')) { // Popups (gd-pop) stehen mittig und werden nicht gewischt
      var startY = null;
      head.addEventListener('pointerdown', function (e) {
        if (e.target.closest('button')) return;
        startY = e.clientY;
        head.setPointerCapture(e.pointerId);
      });
      head.addEventListener('pointermove', function (e) {
        if (startY === null) return;
        var dy = Math.max(0, e.clientY - startY);
        d.style.transform = dy ? 'translateY(' + dy + 'px)' : '';
      });
      var end = function (e) {
        if (startY === null) return;
        var dy = e.clientY - startY;
        startY = null;
        d.style.transform = '';
        if (dy > 80) d.close();
      };
      head.addEventListener('pointerup', end);
      head.addEventListener('pointercancel', end);
    }
  });

  window.addEventListener('popstate', function (e) {
    var key = e.state && e.state.gd;
    var cur = current();
    if (cur && cur !== key) sheets[cur].close();
    if (key && sheets[key] && !sheets[key].open) sheets[key].showModal();
    pushed = !!key;
  });

  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-gd-open]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var key = a.getAttribute('data-gd-open');
    if (!open(key, true)) return;
    e.preventDefault();
    // gleich auf einen Reiter der Auftragsverwaltung (z. B. „+2 weitere angenommen“ auf der Matte)
    var tab = a.getAttribute('data-gd-open-tab');
    var tabBtn = tab && sheets[key].querySelector('[data-ord-tab="' + tab + '"]');
    if (tabBtn) tabBtn.click();
  });

  // Auftragsverwaltung im Eingang: Reiter, Auftrag wählen (Details rechts, auf dem Handy statt der Liste)
  function initOrd(ord) {
    var split = ord.querySelector('.gd-ord-split');
    var list = ord.querySelector('[data-ord-list]');
    var hint = ord.querySelector('[data-ord-hint]');
    var wide = window.matchMedia('(min-width: 640px)');

    ord.querySelectorAll('[data-ord-tab]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var key = tab.getAttribute('data-ord-tab');
        ord.querySelectorAll('[data-ord-tab]').forEach(function (t) {
          var on = t === tab;
          t.classList.toggle('is-on', on);
          t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        ord.querySelectorAll('[data-ord-pane]').forEach(function (p) { p.hidden = p.getAttribute('data-ord-pane') !== key; });
      });
    });

    function pick(id) {
      ord.querySelectorAll('[data-ord-pick]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-ord-pick') === id ? 'true' : 'false'); });
      ord.querySelectorAll('[data-ord-detail]').forEach(function (d) { d.hidden = d.getAttribute('data-ord-detail') !== id; });
      if (hint) hint.hidden = !!id;
      split.classList.toggle('is-detail', !!id);
    }
    ord.querySelectorAll('[data-ord-pick]').forEach(function (b) { b.addEventListener('click', function () { pick(b.getAttribute('data-ord-pick')); }); });
    ord.querySelectorAll('[data-ord-back]').forEach(function (b) { b.addEventListener('click', function () { pick(null); }); });

    // Breit: gleich den obersten Auftrag zeigen; schmal: erst die Liste
    ord.addEventListener('gd:show', function () {
      if (wide.matches && !ord.querySelector('[data-ord-pick][aria-pressed="true"]')) {
        var first = list.querySelector('[data-ord-pick]');
        if (first) pick(first.getAttribute('data-ord-pick'));
      }
    });
    // Abbrechen: erst nachfragen (Klick auf „Auftrag abbrechen“ zeigt Ja / Zurück)
    ord.querySelectorAll('[data-ord-abort]').forEach(function (form) {
      var ask = form.querySelector('[data-ord-abort-ask]');
      var box = form.querySelector('.gd-ord-confirm');
      var swap = function (on) { ask.hidden = on; box.hidden = !on; };
      ask.addEventListener('click', function () { swap(true); box.querySelector('.is-danger').focus(); });
      form.querySelector('[data-ord-abort-no]').addEventListener('click', function () { swap(false); ask.focus(); });
      // Abschicken ohne Seitenwechsel (kein Eintrag im Verlauf); der Eingang lädt danach weich nach
      form.addEventListener('submit', function (e) {
        if (form.dataset.sent) return;
        e.preventDefault();
        form.dataset.sent = '1';
        form.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
        post(form)
          .then(function () { refreshDesk('angenommen', true); })
          .catch(function () { form.submit(); });
      });
    });

    // Neue Zähler nach dem Annehmen: Anzeige oben und Knöpfe sperren, deren Kontingent jetzt voll ist (Mitglieder,
    // Laufkundschaft oder alle angenommenen) – sonst gäbe es erst beim Klick eine Fehlermeldung samt Neuladen
    function syncCounts(d) {
      if (!d || d.accepted == null) return;
      ord.setAttribute('data-ord-count', d.accepted);
      var text = function (key, v) { var b = ord.querySelector('[data-ord-stat="' + key + '"]'); if (b) b.textContent = v; };
      text('accepted', d.accepted + '/' + d.max);
      text('npc', d.npc.used + '/' + d.npc.limit);
      text('member', d.member.used + '/' + d.member.limit);
      ord.querySelectorAll('[data-ord-npc-left]').forEach(function (s) { s.textContent = Math.max(0, d.npc.limit - d.npc.used); });
      var full = d.accepted >= d.max;
      ord.querySelectorAll('.gd-ord-accept').forEach(function (f) {
        if (f.hidden) return; // schon angenommen (Stempel)
        var kind = f.getAttribute('data-ord-kind');
        var why = full ? 'Voll ' + d.accepted + '/' + d.max : (kind === 'npc' ? d.npc.used >= d.npc.limit : d.member.used >= d.member.limit) ? 'Heute erledigt' : null;
        if (!why) return;
        var off = document.createElement('span');
        off.className = 'gd-go is-off';
        off.setAttribute('aria-disabled', 'true');
        off.textContent = why;
        f.replaceWith(off);
      });
    }

    // Annehmen: ein „ANGENOMMEN“-Stempel landet auf dem Zettel; danach legt der Spieler den Auftrag selbst per Knopf zu „Angenommen“
    var calm = window.matchMedia('(prefers-reduced-motion: reduce)');
    ord.querySelectorAll('.gd-ord-accept').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        var paper = form.closest('.gd-ord-details');
        if (!paper || form.dataset.sent) return;
        e.preventDefault();
        form.dataset.sent = '1';
        var btn = form.querySelector('button');
        if (btn) btn.disabled = true;
        var mark = document.createElement('b');
        mark.className = 'gd-ord-ok';
        mark.textContent = 'Angenommen';
        mark.setAttribute('aria-hidden', 'true');
        paper.appendChild(mark);
        paper.classList.add('is-stamped');
        post(form)
          .then(function (data) {
            // Angenommen ist der Auftrag jetzt auf dem Server: Zähler vom Server übernehmen, Eintrag markieren, der Spieler legt ihn selbst nach „Angenommen“
            syncCounts(data);
            var orderId = form.querySelector('input[name="order"]');
            var item = orderId && ord.querySelector('[data-ord-pick="' + orderId.value + '"]');
            if (item) item.classList.add('is-taken');
            form.hidden = true;
            var go = document.createElement('button');
            go.type = 'button';
            go.className = 'gd-go gd-ord-transfer';
            go.textContent = 'Zu Angenommen hinzufügen ▶';
            go.disabled = !calm.matches; // erst klickbar, wenn der Stempel gelandet ist
            paper.appendChild(go);
            setTimeout(function () { go.disabled = false; go.focus({ preventScroll: true }); }, calm.matches ? 0 : T.stamp);
            go.addEventListener('click', function () { go.disabled = true; refreshDesk('angenommen'); });
          })
          .catch(function () { mark.remove(); form.submit(); }); // abgelehnt oder offline: normal abschicken, dann erscheint die Meldung
      });
    });

    // Auswählen: den Auftrag aktiv machen (ohne Seitenwechsel), die Liste lädt kurz nach
    ord.querySelectorAll('[data-ord-select]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        if (form.dataset.sent) return;
        e.preventDefault();
        form.dataset.sent = '1';
        form.querySelector('button').disabled = true;
        post(form)
          .then(function () { refreshDesk('angenommen', true); })
          .catch(function () { form.submit(); });
      });
    });

    // Karte antippen: große 3D-Ansicht wie im Rest der Seite (partials/card-zoom, public/js/handel.js); hier nur die Tastatur
    ord.addEventListener('keydown', function (e) {
      var card = e.target.closest && e.target.closest('[data-zoom-card]');
      if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); card.click(); }
    });
    var dlg = ord.closest('dialog');
    if (dlg && !dlg.dataset.ordBound) {
      dlg.dataset.ordBound = '1';
      dlg.addEventListener('gd:open', function () { var cur = dlg.querySelector('[data-gd-ord]'); if (cur) cur.dispatchEvent(new CustomEvent('gd:show')); });
    }
    if (dlg && dlg.open) ord.dispatchEvent(new CustomEvent('gd:show'));
  }

  // Nach dem Annehmen: Tisch und Eingang neu laden (Matte, Zähler, Liste), ohne die Seite zu wechseln
  function refreshDesk(tabKey, quick) {
    var body = sheets.auftraege && sheets.auftraege.querySelector('.gd-sheet-body');
    if (!body) { location.reload(); return; }
    var calmNow = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var FADE_MS = calmNow ? 0 : quick ? 260 : T.fade; // Auswählen und Abbrechen: kurzer Übergang, Annehmen: langer
    if (quick) { body.style.setProperty('--ord-t-fade', FADE_MS + 'ms'); body.style.setProperty('--ord-t-enter', '420ms'); }
    body.classList.add('is-leaving'); // sanft ausblenden, während der neue Stand lädt
    var wait = new Promise(function (done) { setTimeout(done, FADE_MS); });
    var load = fetch(base + '?reiter=auftraege', { credentials: 'same-origin' }).then(function (res) { return res.text(); });
    Promise.all([load, wait])
      .then(function (r) {
        var doc = new DOMParser().parseFromString(r[0], 'text/html');
        var freshDesk = doc.querySelector('[data-gd-desk]');
        var freshBody = doc.querySelector('[data-gd-sheet="auftraege"] .gd-sheet-body');
        if (!freshDesk || !freshBody) { location.reload(); return; }
        desk.innerHTML = freshDesk.innerHTML;
        body.innerHTML = freshBody.innerHTML;
        var help = sheets.auftraege.querySelector('[data-tour-info]');
        if (help) help.setAttribute('aria-expanded', 'false'); // ein offener Hilfetext ist mit dem Inhalt verschwunden
        var fresh = body.querySelector('[data-gd-ord]');
        initOrd(fresh);
        var target = tabKey && fresh.querySelector('[data-ord-tab="' + tabKey + '"]');
        if (target) target.click(); // jetzt erst: weiter zum gewünschten Reiter (Annehmen, Auswählen, Abbrechen: „Angenommen“)
        body.classList.remove('is-leaving');
        body.classList.add('is-entering'); // und wieder einblenden
        setTimeout(function () { body.classList.remove('is-entering'); body.style.removeProperty('--ord-t-fade'); body.style.removeProperty('--ord-t-enter'); }, (quick ? 420 : T.enter) + 100);
      })
      .catch(function () { location.reload(); });
  }
  document.querySelectorAll('[data-gd-ord]').forEach(initOrd);

  // Restzeit der Aufträge (data-due) weiterzählen, solange die Seite offen ist – gleiche Marken wie auf dem Server
  // (partials/grading-desk/auftraege.ejs): rot unter 24 Std, orange unter 48 Std
  function tickDue() {
    document.querySelectorAll('[data-due]').forEach(function (s) {
      var ms = new Date(s.getAttribute('data-due')) - Date.now();
      var h = ms / 36e5;
      var label = ms <= 0 ? 'abgelaufen' : h < 1 ? Math.ceil(ms / 6e4) + ' Min' : h < 24 ? Math.floor(h) + ' Std' : Math.ceil(h / 24) + ' T';
      s.textContent = ms <= 0 ? label : 'noch ' + label;
      s.classList.toggle('is-urgent', h < 24);
      s.classList.toggle('is-soon', h >= 24 && h < 48);
    });
  }
  setInterval(tickDue, 30 * 1000);

  // Rückweg nach einem Formular: Fenster öffnen und den Hinweis hineinholen
  var start = desk.getAttribute('data-gd-start');
  if (start && open(start, false)) {
    var ordTab = desk.getAttribute('data-gd-ord-tab');
    var ordBtn = ordTab && sheets[start].querySelector('[data-ord-tab="' + ordTab + '"]');
    if (ordBtn) ordBtn.click();
    var flash = document.querySelector('[data-flash-area] .flash');
    var body = sheets[start].querySelector('.gd-sheet-body');
    if (flash && body) body.insertBefore(flash, body.firstChild);
  }

  // Zurück von der Werkbank (?neu=1): das Kassenbuch und die Münzen hüpfen
  if (/[?&]neu=1/.test(location.search)) {
    var fresh = desk.querySelector('[data-gd-spike]');
    if (fresh) fresh.classList.add('is-new');
    var coins = desk.querySelector('[data-gd-coins]');
    if (coins) setTimeout(function () { coins.classList.add('is-bump'); }, 350);
    if (!start) history.replaceState(null, '', base);
  }

  // Handy geöffnet: neue Bewertungen gelten als gesehen
  var reviewBadge = document.querySelector('[data-gd-new-reviews]');
  if (reviewBadge && sheets.bewertungen) {
    sheets.bewertungen.addEventListener('gd:open', function () {
      var token = document.querySelector('input[name="_csrf"]');
      if (!token || !reviewBadge.isConnected) return;
      fetch('/grading/gesehen', { method: 'POST', body: new URLSearchParams({ _csrf: token.value }), credentials: 'same-origin' }).then(function (res) {
        if (res.ok) reviewBadge.remove();
      }).catch(function () {});
    });
  }

  // Vitrine einräumen: höchstens max Slabs ankreuzbar
  var drawer = document.querySelector('[data-gd-drawer]');
  if (drawer) {
    var max = +drawer.getAttribute('data-max');
    var sync = function () {
      var boxes = drawer.querySelectorAll('input[name="doc"]');
      var n = drawer.querySelectorAll('input[name="doc"]:checked').length;
      boxes.forEach(function (b) {
        if (b.closest('.is-locked')) return;
        b.disabled = !b.checked && n >= max;
      });
      var head = drawer.closest('dialog').querySelector('h2 .gr-dim');
      if (head) head.textContent = n + ' / ' + max;
    };
    drawer.addEventListener('change', sync);
    sync();
  }
  // Werkstatt › Material: Anzahl wählen (− / +), der Preis rechnet mit und die Rückfrage nennt die Summe
  document.querySelectorAll('[data-gd-qty]').forEach(function (form) {
    var input = form.querySelector('input[name="count"]');
    var total = form.querySelector('[data-gd-qty-total]');
    var price = +form.getAttribute('data-price') || 0;
    var label = form.getAttribute('data-label') || 'Stück';
    var fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
    var max = +input.max || 10;
    function sync() {
      var n = Math.max(1, Math.min(max, parseInt(input.value, 10) || 1));
      total.textContent = fmt.format((price * n) / 100);
      form.setAttribute('data-confirm', n + '× ' + label + ' für ' + fmt.format((price * n) / 100) + ' kaufen?');
    }
    form.querySelectorAll('[data-gd-qty-step]').forEach(function (b) {
      b.addEventListener('click', function () {
        input.value = Math.max(1, Math.min(max, (parseInt(input.value, 10) || 1) + (+b.getAttribute('data-gd-qty-step'))));
        sync();
      });
    });
    input.addEventListener('input', sync);
    sync();
  });

  // Kassenzettel: ein offener Bon schließt sich auch beim Antippen seiner Posten, nicht nur der Kopfzeile
  document.addEventListener('click', function (e) {
    var det = e.target.closest('.gd-bon details[open]');
    if (!det || e.target.closest('summary')) return;
    det.open = false;
  });
})();

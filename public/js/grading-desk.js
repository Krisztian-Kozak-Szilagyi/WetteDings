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
  var T = { stamp: 650, fade: 300, enter: 400 }; // Stempel landet · Inhalt blendet aus · Inhalt blendet ein
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
    var FADE_MS = calmNow ? 0 : quick ? 140 : T.fade; // Auswählen und Abbrechen: kurzer Übergang, Annehmen: langer
    if (quick) { body.style.setProperty('--ord-t-fade', FADE_MS + 'ms'); body.style.setProperty('--ord-t-enter', '200ms'); }
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
        setTimeout(function () { body.classList.remove('is-entering'); body.style.removeProperty('--ord-t-fade'); body.style.removeProperty('--ord-t-enter'); }, (quick ? 200 : T.enter) + 100);
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

  // Vitrine am Schreibtisch (ohne Untermenü): ziehen sortiert um, Klick auf eine Karte öffnet die Großansicht (Austauschen / Entfernen),
  // Klick auf ein leeres Fach die Auswahl freier Slabs. Jede Änderung geht sofort an den Server (POST /grading/vitrine).
  var vit = document.querySelector('[data-vit-edit]');
  if (vit) {
    var shelf = vit.querySelector('.gd-vit-shelf');
    var pop = vit.querySelector('[data-vit-pop]');
    var pickV = pop.querySelector('[data-vit-pickview]');
    var note = vit.querySelector('[data-vit-note]');
    var vmax = +vit.getAttribute('data-max');
    var target = null; // das Fach, das gerade getauscht wird (null = ins nächste freie Fach einsetzen)
    var vitems = function () { return Array.prototype.slice.call(shelf.querySelectorAll('.gd-vit-item[data-id]')); };
    var say = function (text) {
      note.textContent = text; note.hidden = false;
      clearTimeout(say.t); say.t = setTimeout(function () { note.hidden = true; }, 2600);
    };
    // so viele leere Fächer wie noch frei sind – immer hinter den Slabs
    var refill = function () {
      shelf.querySelectorAll('.gd-vit-empty').forEach(function (e) { e.remove(); });
      var tpl = vit.querySelector('[data-vit-empty]');
      for (var i = vitems().length; i < vmax; i++) shelf.appendChild(tpl.content.firstElementChild.cloneNode(true));
      vit.classList.toggle('is-empty', !vitems().length);
    };
    var save = function () {
      var body = new URLSearchParams();
      body.append('_csrf', vit.getAttribute('data-csrf'));
      vitems().forEach(function (e) { body.append('doc', e.getAttribute('data-id')); });
      return fetch('/grading/vitrine', { method: 'POST', body: body, credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (!j.ok) throw new Error(j.error || 'Speichern ging schief.'); })
        .catch(function (err) { say(err.message || 'Speichern ging schief.'); setTimeout(function () { window.location.reload(); }, 1800); });
    };
    var closePop = function () { pop.hidden = true; pickV.hidden = true; target = null; };
    var openPick = function () {
      var have = vitems().map(function (e) { return e.getAttribute('data-id'); });
      var shownN = 0;
      pickV.querySelectorAll('[data-pick-li]').forEach(function (li) {
        var gone = have.indexOf(li.getAttribute('data-pick-li')) >= 0;
        li.hidden = gone;
        if (!gone) shownN++;
      });
      pickV.querySelector('.gd-vit-none').hidden = shownN > 0;
      pickV.hidden = false; pop.hidden = false;
      var f = pickV.querySelector('[data-pick-li]:not([hidden]) button'); if (f) f.focus({ preventScroll: true });
    };

    // ziehen – das Bild-Ziehen des Browsers (Geisterbild) würde sonst die Maus übernehmen und das Ziehen abbrechen
    shelf.addEventListener('dragstart', function (e) { e.preventDefault(); });
    var drag = null;
    var swallow = false;
    shelf.addEventListener('pointerdown', function (e) {
      var el = e.target.closest('.gd-vit-item[data-id]');
      if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
      drag = { el: el, id: e.pointerId, x0: e.clientX, left0: el.offsetLeft, moved: false };
    });
    document.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var shift = function () { return e.clientX - drag.x0 - (drag.el.offsetLeft - drag.left0); };
      if (!drag.moved) {
        if (Math.abs(shift()) < 8) return;
        drag.moved = true;
        drag.el.classList.add('is-dragging');
        shelf.classList.add('is-sorting');
        try { drag.el.setPointerCapture(drag.id); } catch (err) { /* egal */ } // erst beim Ziehen, damit ein einfacher Klick seine Schaltfläche trifft
        closePop();
      }
      drag.el.style.transform = 'translateX(' + shift() + 'px)';
      var on = vitems();
      var i = on.indexOf(drag.el);
      var r = drag.el.getBoundingClientRect();
      var mid = r.left + r.width / 2;
      var next = on[i + 1];
      var prev = on[i - 1];
      if (next) { var rn = next.getBoundingClientRect(); if (mid > rn.left + rn.width / 2) shelf.insertBefore(drag.el, next.nextSibling); }
      if (prev) { var rp = prev.getBoundingClientRect(); if (mid < rp.left + rp.width / 2) shelf.insertBefore(drag.el, prev); }
      drag.el.style.transform = 'translateX(' + shift() + 'px)';
      var edge = shelf.getBoundingClientRect(); // am Rand weiterscrollen
      if (e.clientX > edge.right - 40) shelf.scrollLeft += 14; else if (e.clientX < edge.left + 40) shelf.scrollLeft -= 14;
    });
    var endDrag = function (e) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      var d = drag;
      drag = null;
      d.el.classList.remove('is-dragging');
      d.el.style.transform = '';
      shelf.classList.remove('is-sorting');
      if (d.moved) {
        // der Klick nach dem Ziehen darf weder die Großansicht (foil-view.js, fängt im document) noch etwas hier auslösen
        var stopClick = function (ev) { ev.preventDefault(); ev.stopPropagation(); };
        window.addEventListener('click', stopClick, true);
        setTimeout(function () { window.removeEventListener('click', stopClick, true); }, 0);
        swallow = true; setTimeout(function () { swallow = false; }, 0);
        if (d.left0 !== d.el.offsetLeft) save();
      }
    };
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);

    // Klicks: Karte → Großansicht mit Austauschen / Entfernen (foil-view.js, Ereignis vit:act), leeres Fach → Auswahl
    vit.addEventListener('click', function (e) {
      if (swallow) { e.preventDefault(); e.stopPropagation(); return; }
      var add = e.target.closest('[data-vit-add]');
      if (add) { target = null; openPick(); return; }
      var pick = e.target.closest('[data-pick]');
      if (pick) {
        var tpl = vit.querySelector('[data-vit-tpl="' + pick.getAttribute('data-pick') + '"]');
        if (!tpl) return;
        var node = tpl.content.firstElementChild.cloneNode(true);
        if (target) target.replaceWith(node);
        else { var firstEmpty = shelf.querySelector('.gd-vit-empty'); if (firstEmpty) shelf.insertBefore(node, firstEmpty); else shelf.appendChild(node); }
        closePop(); refill(); save();
        return;
      }
      if (e.target === pop) closePop(); // Klick neben das Menü schließt es
    });
    document.addEventListener('vit:act', function (e) {
      var el = vitems().filter(function (i) { return i.getAttribute('data-id') === e.detail.id; })[0];
      if (!el) return;
      if (e.detail.act === 'swap') { target = el; openPick(); return; }
      el.remove(); closePop(); refill(); save();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !pop.hidden) { e.stopPropagation(); closePop(); } }, true);
    // ← → am fokussierten Slab sortiert auch per Tastatur
    shelf.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var el = e.target.closest && e.target.closest('.gd-vit-item[data-id]');
      if (!el) return;
      var on = vitems();
      var i = on.indexOf(el);
      var j = i + (e.key === 'ArrowRight' ? 1 : -1);
      if (j < 0 || j >= on.length) return;
      e.preventDefault();
      if (j < i) shelf.insertBefore(el, on[j]); else shelf.insertBefore(el, on[j].nextSibling);
      var b = el.querySelector('[data-vit-slab]'); if (b) b.focus();
      save();
    });
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

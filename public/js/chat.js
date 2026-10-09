// Chat unten rechts (views/partials/chat.ejs, src/routes/chat.js).
// Fragt den Server nach seinem Änderungsstand: offen alle 3 s, geschlossen alle 15 s, im Hintergrund-Tab gar nicht.
// Solange sich nichts geändert hat, antwortet der Server ohne Datenbank. Texte immer als textContent (nie als HTML).
(function () {
  'use strict';

  var root = document.querySelector('[data-chat-root]');
  if (!root || !window.fetch) return;

  var csrf = root.getAttribute('data-csrf');
  var $ = function (sel) { return root.querySelector(sel); };
  var toggle = $('[data-chat-toggle]');
  var panel = $('[data-chat-panel]');
  var badge = $('[data-chat-badge]');
  var listView = $('[data-chat-list-view]');
  var convView = $('[data-chat-conv-view]');
  var list = $('[data-chat-list]');
  var empty = $('[data-chat-empty]');
  var listError = $('[data-chat-list-error]');
  var newForm = $('[data-chat-new-form]');
  var blockedBox = $('[data-chat-blocked]');
  var blockedList = $('[data-chat-blocked-list]');
  var title = $('[data-chat-title]');
  var blockBtn = $('[data-chat-block]');
  var log = $('[data-chat-log]');
  var note = $('[data-chat-note]');
  var error = $('[data-chat-error]');
  var form = $('[data-chat-form]');
  var input = form.querySelector('textarea');

  var OPEN_MS = 3000;
  var CLOSED_MS = 15000;
  // Merker pro Tab und Mitglied (Stand, ungelesene, offenes Gespräch) – überlebt den Seitenwechsel
  var prefix = 'chat.' + root.getAttribute('data-me') + '.';
  var store = {
    get: function (k) { try { return sessionStorage.getItem(prefix + k); } catch (e) { return null; } },
    set: function (k, v) { try { if (v == null) sessionStorage.removeItem(prefix + k); else sessionStorage.setItem(prefix + k, v); } catch (e) { /* privat */ } },
  };

  var state = {
    v: store.get('v') || '',
    open: false,
    conv: null, // { key, kind, name, blocked, partnerDeleted }
    firstId: null,
    lastId: null,
    busy: false,
    timer: null,
  };

  // ---------- Server ----------
  function getJson(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().catch(function () { return { error: 'Da ist etwas schiefgelaufen.' }; });
    });
  }
  function post(url, data) {
    var body = new URLSearchParams(data || {});
    body.set('_csrf', csrf);
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    }).then(function (r) {
      return r.json().catch(function () { return { error: r.status === 403 ? 'Die Sitzung ist abgelaufen. Bitte lade die Seite neu.' : 'Da ist etwas schiefgelaufen.' }; });
    });
  }

  // ---------- Anzeige ----------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function showError(box, msg) {
    box.textContent = msg || '';
    box.hidden = !msg;
  }
  function time(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var now = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    if (d.toDateString() === now.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.';
  }
  function setBadge(n) {
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n || '');
    toggle.setAttribute('aria-label', n ? 'Chat öffnen, ' + n + ' ungelesen' : 'Chat öffnen');
  }

  function renderOverview(data) {
    setBadge(data.unread);
    store.set('unread', String(data.unread || 0));
    list.textContent = '';
    (data.conversations || []).forEach(function (c) {
      var li = el('li');
      var btn = el('button', 'chat-item' + (c.unread ? ' is-unread' : '') + (c.kind === 'team' ? ' is-team' : ''));
      btn.type = 'button';
      btn.addEventListener('click', function () { openConv(c.key); });
      var avatar = el('span', 'chat-avatar', c.kind === 'team' ? (c.ticker || 'T').slice(0, 4) : c.name.slice(0, 2).toUpperCase());
      avatar.setAttribute('aria-hidden', 'true');
      var main = el('span', 'chat-item-main');
      var top = el('span', 'chat-item-top');
      top.appendChild(el('strong', 'chat-item-name', c.kind === 'team' ? c.name + ' · Team' : c.name));
      top.appendChild(el('span', 'chat-item-time', time(c.at)));
      main.appendChild(top);
      main.appendChild(el('span', 'chat-item-last', c.last ? (c.lastFrom ? c.lastFrom + ': ' : '') + c.last : c.kind === 'team' ? 'Euer Team-Chat' : ''));
      btn.appendChild(avatar);
      btn.appendChild(main);
      if (c.unread) btn.appendChild(el('span', 'chat-item-badge', c.unread > 99 ? '99+' : String(c.unread)));
      li.appendChild(btn);
      list.appendChild(li);
    });
    empty.hidden = !!(data.conversations && data.conversations.length);
    blockedList.textContent = '';
    (data.blocked || []).forEach(function (name) {
      var li = el('li');
      li.appendChild(el('span', null, name));
      var b = el('button', 'btn btn-ghost btn-sm', 'Freigeben');
      b.type = 'button';
      b.addEventListener('click', function () { setBlocked(name, false); });
      li.appendChild(b);
      blockedList.appendChild(li);
    });
    blockedBox.hidden = !(data.blocked && data.blocked.length);
  }

  function messageEl(m, kind) {
    var row = el('div', 'chat-msg ' + (m.me ? 'is-me' : 'is-other'));
    row.setAttribute('data-id', m.id);
    // Im Team-Chat führt der Name zum Profil (gelöschte Konten haben keins)
    if (!m.me && kind === 'team') {
      var from = el(m.gone ? 'span' : 'a', 'chat-msg-from', m.from);
      if (!m.gone) from.href = '/profil/' + encodeURIComponent(m.from);
      row.appendChild(from);
    }
    row.appendChild(el('span', 'chat-msg-text', m.text));
    var meta = el('span', 'chat-msg-meta', time(m.at));
    if (!m.me) {
      var flag = el('button', 'chat-msg-report', 'Melden');
      flag.type = 'button';
      flag.addEventListener('click', function () { report(m, flag); });
      meta.appendChild(flag);
    }
    row.appendChild(meta);
    return row;
  }

  function toBottom() {
    log.scrollTop = log.scrollHeight;
    requestAnimationFrame(function () { log.scrollTop = log.scrollHeight; });
  }

  function appendMessages(msgs, kind) {
    // Unsichtbarer Verlauf (Höhe 0) gilt als "unten", damit er beim Öffnen nicht oben hängen bleibt
    var atBottom = !log.clientHeight || log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    msgs.forEach(function (m) {
      if (log.querySelector('[data-id="' + m.id + '"]')) return;
      log.appendChild(messageEl(m, kind));
      state.lastId = m.id;
    });
    if (atBottom || msgs.some(function (m) { return m.me; })) toBottom();
  }

  function moreButton() {
    var b = el('button', 'btn btn-ghost btn-sm chat-more', 'Ältere Nachrichten');
    b.type = 'button';
    b.addEventListener('click', function () {
      b.disabled = true;
      getJson('/chat/verlauf?' + new URLSearchParams({ c: state.conv.key, vor: state.firstId })).then(function (data) {
        b.remove();
        if (data.error) return showError(error, data.error);
        var height = log.scrollHeight;
        var first = log.firstChild;
        data.messages.forEach(function (m) { log.insertBefore(messageEl(m, data.kind), first); });
        if (data.messages.length) state.firstId = data.messages[0].id;
        if (data.more) log.insertBefore(moreButton(), log.firstChild);
        log.scrollTop = log.scrollHeight - height;
      });
    });
    return b;
  }

  function renderConvHead() {
    var c = state.conv;
    title.textContent = '';
    if (c.kind === 'dm' && !c.partnerDeleted) {
      var a = el('a', null, c.name);
      a.href = '/profil/' + encodeURIComponent(c.name);
      title.appendChild(a);
    } else {
      title.textContent = c.kind === 'team' ? c.name + ' · Team' : c.name;
    }
    blockBtn.hidden = c.kind !== 'dm' || c.partnerDeleted;
    blockBtn.textContent = c.blocked ? 'Freigeben' : 'Blockieren';
    blockBtn.setAttribute('aria-label', (c.blocked ? 'Freigeben: ' : 'Blockieren: ') + c.name);
    var closed = c.blocked || c.partnerDeleted;
    note.hidden = !closed;
    note.textContent = c.partnerDeleted ? 'Dieses Konto gibt es nicht mehr.' : c.blocked ? 'Du hast ' + c.name + ' blockiert. Ihr könnt euch nicht schreiben.' : '';
    form.hidden = !!closed;
  }

  // ---------- Ansichten ----------
  function showList() {
    state.conv = null;
    store.set('conv', null);
    convView.hidden = true;
    listView.hidden = false;
    refresh(true);
  }

  function openConv(key) {
    showError(error, '');
    showError(listError, '');
    getJson('/chat/verlauf?' + new URLSearchParams({ c: key })).then(function (data) {
      if (data.error) {
        store.set('conv', null);
        showError(listError, data.error);
        return;
      }
      state.conv = { key: data.key, kind: data.kind, name: data.name, blocked: data.blocked, partnerDeleted: data.partnerDeleted };
      store.set('conv', data.key);
      state.firstId = data.messages.length ? data.messages[0].id : null;
      state.lastId = null;
      log.textContent = '';
      if (data.more) log.appendChild(moreButton());
      if (!data.messages.length) log.appendChild(el('p', 'chat-empty muted', data.kind === 'team' ? 'Noch nichts los im Team-Chat.' : 'Schreib die erste Nachricht.'));
      appendMessages(data.messages, data.kind);
      renderConvHead();
      listView.hidden = true;
      convView.hidden = false;
      // Erst wenn der Verlauf sichtbar ist, hat er eine Höhe – sonst bliebe er oben stehen (#186)
      toBottom();
      if (!form.hidden) input.focus();
      state.v = '';
      schedule(300); // Zähler gleich neu holen (Gespräch ist jetzt gelesen)
    });
  }

  function setOpen(open) {
    state.open = open;
    panel.hidden = !open;
    root.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    store.set('open', open ? '1' : null);
    if (open) {
      var key = store.get('conv');
      if (key) openConv(key);
      else showList();
    } else {
      state.conv = null;
    }
    schedule(open ? 0 : CLOSED_MS);
  }

  // ---------- Nachfragen ----------
  function refresh(force) {
    if (state.busy) return Promise.resolve();
    state.busy = true;
    var conv = state.conv;
    return getJson('/chat/stand?' + new URLSearchParams({ v: force ? '' : state.v }))
      .then(function (data) {
        if (!data || data.error || data.v == null) return;
        var changed = String(data.v) !== state.v;
        state.v = String(data.v);
        store.set('v', state.v);
        if (data.conversations) renderOverview(data);
        // Neues im offenen Gespräch? (nur wenn sich etwas geändert hat)
        if (changed && conv && state.conv === conv && state.open) {
          return getJson('/chat/verlauf?' + new URLSearchParams(state.lastId ? { c: conv.key, nach: state.lastId } : { c: conv.key })).then(function (d) {
            if (!d.error && state.conv === conv) {
              if (!state.lastId) log.textContent = '';
              conv.blocked = d.blocked;
              renderConvHead();
              appendMessages(d.messages, d.kind);
              // state.v bleibt: das Gespräch ist jetzt gelesen, die nächste Abfrage holt die neue Zahl
            }
          });
        }
      })
      .catch(function () {})
      .then(function () { state.busy = false; });
  }

  function schedule(ms) {
    clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      if (document.hidden) return; // weiter, sobald der Tab wieder sichtbar ist
      refresh(false).then(function () { schedule(state.open ? OPEN_MS : CLOSED_MS); });
    }, ms);
  }

  document.addEventListener('visibilitychange', function () { if (!document.hidden) schedule(0); });

  // ---------- Aktionen ----------
  function send() {
    var text = input.value.trim();
    if (!text || !state.conv) return;
    var sendBtn = form.querySelector('button[type="submit"]');
    sendBtn.disabled = true;
    showError(error, '');
    post('/chat/senden', { c: state.conv.key, text: text })
      .then(function (data) {
        if (data.error) return showError(error, data.error);
        input.value = '';
        grow();
        var hint = log.querySelector('.chat-empty');
        if (hint) hint.remove();
        appendMessages([data.message], state.conv.kind);
      })
      .catch(function () { showError(error, 'Nicht gesendet – bitte noch einmal versuchen.'); })
      .then(function () { sendBtn.disabled = false; input.focus(); });
  }

  function report(m, btn) {
    var reason = window.prompt('Nachricht von ' + m.from + ' melden? Das Team sieht dann diese und die fünf Nachrichten davor.\n\nGrund (freiwillig):', '');
    if (reason === null) return;
    btn.disabled = true;
    post('/chat/melden', { id: m.id, grund: reason }).then(function (data) {
      if (data.error) { btn.disabled = false; return showError(error, data.error); }
      btn.textContent = 'Gemeldet';
    });
  }

  function setBlocked(name, on) {
    if (on && !window.confirm(name + ' blockieren? Ihr könnt euch dann nicht mehr schreiben, bis du die Blockierung aufhebst.')) return;
    post('/chat/blockieren', { name: name, an: on ? '1' : '0' }).then(function (data) {
      if (data.error) return showError(state.conv ? error : listError, data.error);
      if (state.conv && state.conv.name === name) {
        state.conv.blocked = on;
        renderConvHead();
      }
      refresh(true);
    });
  }

  function startWith(name) {
    return post('/chat/mit', { name: name }).then(function (data) {
      if (data.error) { showError(listError, data.error); return false; }
      openConv(data.key);
      return true;
    });
  }

  function grow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }

  toggle.addEventListener('click', function () { setOpen(!state.open); });
  root.querySelectorAll('[data-chat-close]').forEach(function (b) { b.addEventListener('click', function () { setOpen(false); }); });
  $('[data-chat-back]').addEventListener('click', showList);
  $('[data-chat-new]').addEventListener('click', function () {
    newForm.hidden = !newForm.hidden;
    if (!newForm.hidden) newForm.querySelector('input').focus();
  });
  newForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var field = newForm.querySelector('input');
    startWith(field.value.trim()).then(function (ok) {
      if (ok) { field.value = ''; newForm.hidden = true; }
    });
  });
  blockBtn.addEventListener('click', function () { if (state.conv) setBlocked(state.conv.name, !state.conv.blocked); });
  form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
  input.addEventListener('input', grow);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.open && panel.contains(document.activeElement)) setOpen(false); });

  // „Nachricht“-Knopf irgendwo auf der Seite (z. B. Profil): data-chat-with="Name"
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-chat-with]');
    if (!b) return;
    e.preventDefault();
    if (!state.open) {
      state.open = true;
      panel.hidden = false;
      root.classList.add('is-open');
      toggle.setAttribute('aria-expanded', 'true');
      store.set('open', '1');
    }
    startWith(b.getAttribute('data-chat-with')).then(function (ok) {
      if (!ok) { convView.hidden = true; listView.hidden = false; refresh(true); }
    });
  });

  // Start: Zahl aus dem letzten Stand zeigen, Chat wieder öffnen, wenn er beim Seitenwechsel offen war
  setBadge(Number(store.get('unread')) || 0);
  if (store.get('open')) setOpen(true);
  else schedule(0);
})();

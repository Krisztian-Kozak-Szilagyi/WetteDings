(function () {
  'use strict';

  var root = document.querySelector('[data-support]');
  if (!root || !window.fetch) return;

  var toggle = root.querySelector('[data-support-toggle]');
  var panel = root.querySelector('[data-support-panel]');
  var log = root.querySelector('[data-support-log]');
  var form = root.querySelector('[data-support-form]');
  var input = form.querySelector('textarea');
  var sendBtn = form.querySelector('button[type="submit"]');
  var csrf = root.getAttribute('data-csrf');
  var name = root.getAttribute('data-name');
  var loaded = false;
  var busy = false;
  var STORE_KEY = 'supportOpen';

  function greeting() {
    return 'Hallo ' + name + '! Ich bin Warren Buffett, der Support-Bot von BfW Holdings. ' +
      'Frag mich alles zur Seite – Wetten, Coin Exchange, Lotterie, TCG oder dein Konto.';
  }

  // Falls das Modell doch Markdown schickt: Zeichen entfernen, Text behalten
  function plain(text) {
    return String(text)
      .replace(/```[a-z]*\n?/gi, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[*•]\s+/gm, '- ');
  }

  function add(role, text) {
    var div = document.createElement('div');
    div.className = 'support-msg support-' + role;
    div.textContent = role === 'assistant' ? plain(text) : text; // nie als HTML einfügen
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function post(url, data) {
    var body = new URLSearchParams(data || {});
    body.set('_csrf', csrf);
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    }).then(function (res) {
      return res.json().catch(function () {
        return { error: res.status === 403 ? 'Die Sitzung ist abgelaufen. Bitte lade die Seite neu.' : 'Da ist etwas schiefgelaufen.' };
      });
    });
  }

  function loadHistory() {
    if (loaded) return;
    loaded = true;
    add('assistant', greeting());
    fetch('/support/verlauf', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        (data.messages || []).forEach(function (m) { add(m.role === 'user' ? 'user' : 'assistant', m.content); });
      })
      .catch(function () {});
  }

  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Support-Chat schließen' : 'Support-Chat öffnen');
    root.classList.toggle('is-open', open);
    try { sessionStorage.setItem(STORE_KEY, open ? '1' : '0'); } catch (e) {}
    if (open) {
      loadHistory();
      setTimeout(function () { input.focus(); }, 50);
    }
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    input.style.overflowY = input.scrollHeight > 120 ? 'auto' : 'hidden';
  }

  toggle.addEventListener('click', function () { setOpen(panel.hidden); });
  root.querySelector('[data-support-close]').addEventListener('click', function () { setOpen(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden && !document.querySelector('dialog[open]')) setOpen(false);
  });

  root.querySelector('[data-support-reset]').addEventListener('click', function () {
    if (busy) return;
    post('/support/neu').then(function () {
      log.innerHTML = '';
      add('assistant', greeting());
    });
  });

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    sendBtn.disabled = true;
    add('user', text);
    input.value = '';
    autosize();
    var typing = add('assistant', 'Warren denkt nach …');
    typing.classList.add('support-typing');

    post('/support/chat', { message: text })
      .then(function (data) {
        typing.remove();
        if (data.reply) add('assistant', data.reply);
        else add('error', data.error || 'Da ist etwas schiefgelaufen.');
      })
      .catch(function () {
        typing.remove();
        add('error', 'Keine Verbindung. Bitte versuch es noch einmal.');
      })
      .then(function () {
        busy = false;
        sendBtn.disabled = false;
        input.focus();
      });
  });

  // Offen bleiben, wenn man innerhalb der Seite weiterklickt
  try { if (sessionStorage.getItem(STORE_KEY) === '1') setOpen(true); } catch (e) {}
})();

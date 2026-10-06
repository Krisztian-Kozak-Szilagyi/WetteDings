// Manipulationserkennung (siehe Datenschutzerklärung): hängt an jedes Formular das Aktions-Kennzeichen dieser Seite
// und zählt, ob vor einer Aktion echte Eingaben passiert sind (Maus, Touch, Tastatur). Aktionen per fetch bekommen
// beides als Kopfzeile; die Antwort liefert das Kennzeichen für die nächste Aktion. Es wird nichts blockiert.
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="bfw-at"]');
  if (!meta) return;
  var trusted = 0;
  var moves = 0;
  var synthetic = 0;

  function counts() {
    return 't' + trusted + 'm' + moves + 'u' + synthetic;
  }

  function field(form, name) {
    var el = form.querySelector('input[name="' + name + '"]');
    if (!el) {
      el = document.createElement('input');
      el.type = 'hidden';
      el.name = name;
      form.appendChild(el);
    }
    return el;
  }

  // Werte in alle POST-Formulare schreiben – auch vor form.submit() aus Skripten der Seite (dort gibt es kein submit-Ereignis)
  function sync() {
    var forms = document.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) {
      if ((forms[i].getAttribute('method') || '').toLowerCase() !== 'post') continue;
      field(forms[i], '_at').value = meta.content;
      field(forms[i], '_ev').value = counts();
    }
  }

  function onInput(e) {
    if (e.isTrusted) trusted++;
    else synthetic++;
    sync();
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (type) {
    document.addEventListener(type, onInput, { capture: true, passive: true });
  });
  document.addEventListener('click', function (e) {
    if (!e.isTrusted) synthetic++;
    sync();
  }, true);
  document.addEventListener('pointermove', function (e) {
    if (e.isTrusted) moves++;
  }, { capture: true, passive: true });
  document.addEventListener('submit', sync, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync);
  else sync();

  // Aktionen per fetch: Kennzeichen und Eingaben als Kopfzeile, neues Kennzeichen aus der Antwort übernehmen
  var nativeFetch = window.fetch;
  if (!nativeFetch) return;
  window.fetch = function (input, init) {
    init = init || {};
    var method = (init.method || (input && input.method) || 'GET').toUpperCase();
    var url = typeof input === 'string' ? input : input && input.url;
    var sameOrigin = !url || url.charAt(0) === '/' || url.indexOf(location.origin + '/') === 0;
    if (method === 'POST' && sameOrigin) {
      var headers = new Headers(init.headers || (input && input.headers) || undefined);
      headers.set('X-Action-Token', meta.content);
      headers.set('X-Action-Ev', counts());
      init.headers = headers;
      trusted = 0;
      moves = 0;
      synthetic = 0;
    }
    return nativeFetch.call(this, input, init).then(function (res) {
      var next = res.headers && res.headers.get('X-Action-Token');
      if (next) {
        meta.content = next;
        sync();
      }
      return res;
    });
  };
})();

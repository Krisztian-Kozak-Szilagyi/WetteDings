// Notizzettel an der Werkbank (views/partials/grading-notes.ejs): Mängel abhaken, die Note wie im Ablauf ausrechnen
// (Obergrenze aus Knick und Zentrierung, minus 1 je Mangel, mindestens 1) und auf Wunsch auswählen. Der Zettel kennt
// nur, was man selbst einträgt – Messung und Bügel-Ergebnis übernimmt er aus dem, was der Tisch ohnehin anzeigt.
// Gebügelter Knick: man zählt die glatten der 10 Knick-Stücke ab, daraus folgt die Obergrenze.
// Die Notizen bleiben beim Neuladen erhalten (je Auftrag im Browser gespeichert).
(function () {
  'use strict';
  var root = document.querySelector('[data-gr-notes]');
  if (!root) return;
  var KEY = 'gr-notes:' + root.getAttribute('data-job');
  var CORNERS = ['tl', 'tr', 'bl', 'br'];
  var PIECES = 10; // Knick-Stücke, wie CREASE_SEGMENTS in src/grading/condition.js
  var blank = function () { return { crease: 'none', pieces: 0, center: 10, scratches: 0, edges: 0, corners: {}, text: '' }; };
  /** Obergrenze eines gebügelten Knicks aus den glatten Stücken: je 2 eine Note mehr, höchstens 9 (wie ironCap) */
  var piecesCap = function (n) { return Math.min(9, 4 + Math.floor(n / 2)); };
  var state = blank();

  var $ = function (sel) { return root.querySelector(sel); };
  var calcEl = $('[data-gn-calc]');
  var gradeEl = $('[data-gn-grade]');
  var hintEl = $('[data-gn-hint]');
  var measuredEl = $('[data-gn-measured]');
  var textEl = $('[data-gn-text]');
  var ironHelp = $('[data-gn-ironhelp]');
  var pieceBtns = root.querySelectorAll('[data-gn-piece]');
  var defaultHint = hintEl.textContent;

  // ---------- Speichern (nur dieser Auftrag; Zettel alter Aufträge werden weggeräumt) ----------
  function load() {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (raw) {
        var s = JSON.parse(raw);
        state = Object.assign(blank(), s, { corners: Object.assign({}, s.corners) });
        // älterer Zettel: Obergrenze statt glatter Stücke gespeichert
        if (s.pieces == null && s.ironed) state.pieces = Math.max(0, Math.min(PIECES, (Number(s.ironed) - 4) * 2));
        delete state.ironed;
      }
      for (var i = window.localStorage.length - 1; i >= 0; i--) {
        var k = window.localStorage.key(i);
        if (k && k.indexOf('gr-notes:') === 0 && k !== KEY) window.localStorage.removeItem(k);
      }
    } catch (e) { /* ohne Speicher geht der Zettel trotzdem, nur nicht über das Neuladen hinaus */ }
  }
  function save() {
    try { window.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* siehe load */ }
  }

  // ---------- Rechnen und Anzeigen ----------
  function creaseCap() {
    if (state.crease === '4') return 4;
    if (state.crease === 'ironed') return piecesCap(state.pieces);
    return 10;
  }
  function cornerCount() {
    return CORNERS.filter(function (k) { return state.corners[k]; }).length;
  }
  function result() {
    var cap = Math.min(creaseCap(), Number(state.center) || 10);
    var minus = state.scratches + cornerCount() + state.edges;
    return { cap: cap, minus: minus, grade: Math.max(1, cap - minus) };
  }
  function render() {
    var c = root.querySelector('input[name="gn-crease"][value="' + state.crease + '"]');
    if (c) c.checked = true;
    ironHelp.hidden = state.crease !== 'ironed';
    pieceBtns.forEach(function (b) {
      var on = Number(b.getAttribute('data-gn-piece')) <= state.pieces;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    $('[data-gn-pieces]').textContent = state.pieces;
    $('[data-gn-pieces-cap]').textContent = piecesCap(state.pieces);
    $('[data-gn-ironed-cap]').textContent = piecesCap(state.pieces);
    var z = root.querySelector('input[name="gn-center"][value="' + state.center + '"]');
    if (z) z.checked = true;
    $('[data-gn-val="scratches"]').textContent = state.scratches;
    $('[data-gn-val="edges"]').textContent = state.edges;
    CORNERS.forEach(function (k) { $('[data-gn-corner="' + k + '"]').checked = !!state.corners[k]; });
    if (document.activeElement !== textEl) textEl.value = state.text;
    var r = result();
    var by = state.crease !== 'none' && creaseCap() <= state.center ? (state.crease === 'ironed' ? 'gebügelter Knick' : 'Knick') : state.center < 10 ? 'Zentrierung' : '';
    calcEl.textContent = 'Obergrenze ' + r.cap + (by ? ' (' + by + ')' : '') + ' − ' + r.minus + (r.minus === 1 ? ' Mangel' : ' Mängel');
    gradeEl.textContent = r.grade;
    root.classList.toggle('has-marks', r.minus > 0 || r.cap < 10);
  }
  function update(fn) {
    fn();
    save();
    render();
  }

  // ---------- Eingaben ----------
  root.addEventListener('change', function (e) {
    var t = e.target;
    if (t.name === 'gn-crease') update(function () { state.crease = t.value; });
    else if (t.name === 'gn-center') update(function () { state.center = Number(t.value); });
    else if (t.hasAttribute('data-gn-corner')) update(function () { state.corners[t.getAttribute('data-gn-corner')] = t.checked; });
  });
  root.addEventListener('click', function (e) {
    var inc = e.target.closest('[data-gn-inc]');
    var dec = e.target.closest('[data-gn-dec]');
    var piece = e.target.closest('[data-gn-piece]');
    if (inc) update(function () { var k = inc.getAttribute('data-gn-inc'); state[k] = Math.min(20, state[k] + 1); });
    if (dec) update(function () { var k = dec.getAttribute('data-gn-dec'); state[k] = Math.max(0, state[k] - 1); });
    // Stücke von links abhaken; ein Klick auf das letzte abgehakte nimmt es wieder weg
    if (piece) {
      update(function () {
        var n = Number(piece.getAttribute('data-gn-piece'));
        state.pieces = state.pieces === n ? n - 1 : n;
        state.crease = 'ironed';
      });
    }
  });
  textEl.addEventListener('input', function () {
    state.text = textEl.value.slice(0, 300);
    save();
  });

  // Messung vom Tisch übernehmen: die Messleiste zeigt Verhältnis und Obergrenze an (public/js/grading.js)
  $('[data-gn-measure]').addEventListener('click', function () {
    var ratio = document.querySelector('[data-gr-mratio]');
    var capEl = document.querySelector('[data-gr-mcap]');
    var m = capEl && /(\d+)/.exec(capEl.textContent || '');
    if (!m) {
      measuredEl.textContent = 'Erst mit 📏 Messen die Linien an die Bildränder legen.';
      return;
    }
    var cap = Number(m[1]);
    update(function () { state.center = cap; });
    measuredEl.textContent = 'Gemessen: ' + (ratio ? ratio.textContent : '') + ' → ' + cap;
  });

  // Bügel-Ergebnis übernehmen, sobald der Tisch es anzeigt („Zu 64 % glatt – … begrenzt die Note jetzt auf 7“)
  var ironRes = document.querySelector('[data-gr-iron-result]');
  if (ironRes && window.MutationObserver) {
    new MutationObserver(function () {
      var m = /(\d+) % glatt/.exec(ironRes.textContent || '');
      if (m && !ironRes.hidden) update(function () { state.crease = 'ironed'; state.pieces = Math.min(PIECES, Math.floor(Number(m[1]) / 10)); });
    }).observe(ironRes, { childList: true, characterData: true, subtree: true, attributes: true });
  }

  // Note auswählen: wie ein Klick auf die Noten-Taste – abgegeben wird erst mit „Note abgeben“
  $('[data-gn-pick]').addEventListener('click', function () {
    var g = result().grade;
    var panel = document.querySelector('[data-gr-panel="grade"]');
    var btn = document.querySelector('[data-grade="' + g + '"]');
    if (!panel || panel.hidden) {
      hintEl.textContent = 'Erst beim Schritt „Benoten“ – bis dahin kannst du schon notieren.';
    } else if (!btn || btn.disabled) {
      hintEl.textContent = 'Die Note ist schon abgegeben.';
    } else {
      btn.click();
      btn.focus();
      hintEl.textContent = 'Note ' + g + ' ausgewählt – jetzt „Note abgeben“.';
      return;
    }
    hintEl.classList.add('is-warn');
    setTimeout(function () { hintEl.classList.remove('is-warn'); hintEl.textContent = defaultHint; }, 3500);
  });

  // Leeren: zweimal klicken (ohne Browser-Dialog)
  var resetBtn = $('[data-gn-reset]');
  var armed = null;
  resetBtn.addEventListener('click', function () {
    if (!armed) {
      resetBtn.textContent = 'Wirklich leeren?';
      armed = setTimeout(function () { armed = null; resetBtn.textContent = 'Zettel leeren'; }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    resetBtn.textContent = 'Zettel leeren';
    measuredEl.textContent = '';
    update(function () { state = blank(); });
    textEl.value = '';
  });

  load();
  render();
})();

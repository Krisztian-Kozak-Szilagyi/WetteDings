// Dio Meister der Schatten als Boss-Figur im Raid (views/raid-kampf.ejs) – ersetzt die gezeichnete Spinne des Bosskampfs. Bietet dieselbe
// Schnittstelle (window.bossfightBoss), über die die Effekte (public/js/bossfight-fx.js) treffen: Trefferpunkt, Treffer-
// Reaktion (Aufblitzen in der Farbe des Effekts, Zucken) und kurzes Anhalten. Esc führt zurück zur Raid-Seite.
(function () {
  'use strict';
  var boss = document.querySelector('[data-raid-boss]');
  if (!boss) return;
  var img = boss.querySelector('img');

  var hitTimer = null;
  window.bossfightBoss = {
    // Trefferpunkt: etwa auf Brusthöhe der Figur
    punkt: function () {
      var r = img.getBoundingClientRect();
      return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.38, r: r.width * 0.18 };
    },
    treffer: function (farbe, staerke) {
      boss.style.setProperty('--hit', farbe || '#ffd68a');
      boss.classList.remove('is-hit', 'is-hit-schwer');
      void boss.offsetWidth; // Animation neu starten
      boss.classList.add(staerke > 1 ? 'is-hit-schwer' : 'is-hit');
      clearTimeout(hitTimer);
      hitTimer = setTimeout(function () { boss.classList.remove('is-hit', 'is-hit-schwer'); }, 600);
    },
    stopp: function (sek) {
      boss.classList.add('is-still');
      setTimeout(function () { boss.classList.remove('is-still'); }, (sek || 0.5) * 1000);
    },
  };

  // Aufgeben: erst nach einem zweiten Klick (keine Browser-Dialoge im Vollbild)
  var quit = document.querySelector('[data-raid-quit]');
  if (quit) {
    var btn = quit.querySelector('button');
    var armed = null;
    quit.addEventListener('submit', function (e) {
      if (armed) return;
      e.preventDefault();
      btn.textContent = 'Wirklich aufgeben?';
      btn.classList.add('is-armed');
      armed = setTimeout(function () {
        armed = null;
        btn.textContent = 'Aufgeben';
        btn.classList.remove('is-armed');
      }, 3000);
    });
  }

  // Vollbild ohne Navigation: Esc führt zur Raid-Seite (der Kampf läuft weiter und kann dort fortgesetzt werden)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !document.body.classList.contains('bf-zielwahl')) location.href = '/raid';
  });
})();

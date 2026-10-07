// Dashboard: Countdowns im Sekundentakt und Broker-Kurse alle 5 Sekunden (ohne Neuladen der Seite)
(function () {
  var cds = document.querySelectorAll('[data-dash-cd]');
  var pad = function (n) { return String(n).padStart(2, '0'); };
  // Kachel-Uhr (data-dash-clock): Abschnitte Tage/Std/Min/Sek, sonst Text "1 T 02:03:04"
  function clock(el, parts) {
    var segs = el.querySelectorAll('.dx-seg');
    if (segs.length !== parts.length) {
      el.textContent = '';
      parts.forEach(function (p) {
        var seg = document.createElement('span');
        seg.className = 'dx-seg';
        seg.appendChild(document.createElement('b'));
        var u = document.createElement('small');
        u.textContent = p[1];
        seg.appendChild(u);
        el.appendChild(seg);
      });
      segs = el.querySelectorAll('.dx-seg');
    }
    parts.forEach(function (p, i) { segs[i].firstChild.textContent = pad(p[0]); });
  }
  function tick() {
    cds.forEach(function (el) {
      var s = Math.floor((Number(el.getAttribute('data-dash-cd')) - Date.now()) / 1000);
      if (s <= 0) { el.textContent = 'jetzt'; el.classList.add('is-now'); el.classList.remove('is-soon'); return; }
      var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
      if (el.hasAttribute('data-dash-clock')) {
        var parts = [[h, 'Std'], [m, 'Min'], [s % 60, 'Sek']];
        if (d) parts.unshift([d, 'Tage']);
        clock(el, parts);
      } else {
        el.textContent = (d ? d + ' T ' : '') + pad(h) + ':' + pad(m) + ':' + pad(s % 60);
      }
      el.classList.toggle('is-soon', s < 3600);
    });
  }
  if (cds.length) { tick(); setInterval(tick, 1000); }

  // ---------- Favoriten (#130): vergrößern wie im Album und den Favorit entfernen – ohne Neuladen ----------
  // Normale Karten öffnen den Zoom (partials/card-zoom), folierte die 3D-Ansicht (public/js/foil-view.js). Beide
  // Fenster schicken das Favoriten-Formular hierher; danach wird die Kachel zu einem freien „+“-Platz.
  var favGrid = document.querySelector('[data-dx-favs]');
  var zoom = document.querySelector('[data-zoom-modal]');
  if (favGrid && zoom) {
    var tilt = zoom.querySelector('[data-zoom-tilt]');
    if (window.tcgBindTilt) window.tcgBindTilt(tilt);
    var zoomFav = zoom.querySelector('[data-zoom-fav]');
    var zoomAlbum = zoom.querySelector('[data-zoom-album]');
    var closeDialog = function (dlg) { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); };

    favGrid.addEventListener('click', function (e) {
      var slot = e.target.closest('[data-dx-fav]');
      if (!slot) return;
      var d = slot.dataset;
      var on = d.favOn === '1';
      tilt.className = 'tcg-zoom r-' + d.rarity; // Seltenheits-Effekte wie im Album
      var img = zoom.querySelector('[data-zoom-img]');
      img.src = d.image;
      img.alt = d.name + ' (' + d.rarityLabel + ')';
      zoom.querySelector('[data-zoom-name]').textContent = d.name;
      var badge = zoom.querySelector('[data-zoom-rarity]');
      badge.textContent = d.rarityLabel;
      badge.className = 'tcg-badge r-' + d.rarity;
      zoom.querySelector('[data-zoom-meta]').textContent = on ? 'Einer deiner Favoriten' : 'Zufällig aus deiner Sammlung – du hast noch keine Favoriten gewählt.';
      zoomFav.hidden = false;
      zoomFav.querySelector('input[name="card"]').value = d.favKey;
      zoomFav.querySelector('button').textContent = on ? '★ Favorit entfernen' : '☆ Als Favorit zeigen';
      // direkt zu dieser Karte im Album – dort leuchtet sie kurz auf (public/js/tcg.js)
      if (zoomAlbum) {
        zoomAlbum.href = '/tcg/album#karte-' + encodeURIComponent(d.favKey);
        zoomAlbum.hidden = false;
      }
      clearError(zoom);
      if (typeof zoom.showModal === 'function') zoom.showModal();
      else zoom.setAttribute('open', '');
    });
    zoom.querySelector('[data-zoom-close]').addEventListener('click', function () { closeDialog(zoom); });
    zoom.addEventListener('click', function (e) { if (e.target === zoom) closeDialog(zoom); });

    function clearError(dlg) {
      var old = dlg.querySelector('[data-dx-fav-error]');
      if (old) old.remove();
    }
    function showError(form, text) {
      var dlg = form.closest('dialog');
      clearError(dlg);
      var p = document.createElement('p');
      p.className = 'dx-fav-error';
      p.setAttribute('data-dx-fav-error', '');
      p.setAttribute('role', 'alert');
      p.textContent = text;
      form.before(p);
    }
    // Leerer Platz wie vom Server gerendert: führt ins Album
    function emptySlot() {
      var a = document.createElement('a');
      a.className = 'tcg-slot tcg-fav-empty';
      a.href = '/tcg/album';
      a.setAttribute('aria-label', 'Freier Favoriten-Platz – zum Album');
      var plus = document.createElement('span');
      plus.textContent = '+';
      a.appendChild(plus);
      return a;
    }

    document.addEventListener('submit', function (e) {
      var form = e.target;
      if (!form.matches('[data-zoom-fav], [data-foil-fav]')) return;
      e.preventDefault();
      var key = form.querySelector('input[name="card"]').value;
      var button = form.querySelector('button');
      button.disabled = true;
      fetch(form.action, {
        method: 'POST',
        body: new URLSearchParams(new FormData(form)),
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (data) {
          button.disabled = false;
          if (!data.ok) return showError(form, data.error || 'Das hat nicht geklappt. Bitte lade die Seite neu.');
          closeDialog(form.closest('dialog'));
          // Eine zufällige Karte wurde zum Favoriten: jetzt gilt die eigene Auswahl – neu laden, damit sie allein steht
          if (data.on) return window.location.reload();
          var slot = favGrid.querySelector('[data-fav-key="' + key.replace(/["\\]/g, '') + '"]');
          if (!slot) return;
          slot.classList.add('is-leaving');
          setTimeout(function () {
            slot.remove();
            favGrid.appendChild(emptySlot());
          }, 220);
        })
        .catch(function () {
          button.disabled = false;
          showError(form, 'Keine Verbindung. Bitte versuche es erneut.');
        });
    });
  }

  var ticks = document.querySelectorAll('[data-dash-tick]');
  if (!ticks.length) return;
  function price(p) {
    var digits = p >= 1 ? 2 : p >= 0.01 ? 4 : 6;
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(p);
  }
  function pct(x) { return (x > 0 ? '+' : '') + (x * 100).toFixed(2).replace('.', ',') + ' %'; }
  function poll() {
    if (document.hidden) return;
    fetch('/broker/api/uebersicht', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (list) {
        if (!Array.isArray(list)) return;
        list.forEach(function (s) {
          var row = document.querySelector('[data-dash-tick="' + s.symbol + '"]');
          if (!row) return;
          var p = row.querySelector('[data-dash-price]');
          var c = row.querySelector('[data-dash-change]');
          var txt = price(s.price);
          if (p && p.textContent !== txt) {
            p.textContent = txt;
            row.classList.remove('is-flash');
            void row.offsetWidth; // Animation neu starten
            row.classList.add('is-flash');
          }
          if (c) { c.textContent = pct(s.change24h); c.className = s.change24h >= 0 ? 'pos' : 'neg'; }
        });
      })
      .catch(function () {});
  }
  setInterval(poll, 5000);
})();

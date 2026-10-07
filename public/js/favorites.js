// Favoriten (Dashboard, TCG-Seite – #130): vergrößern wie im Album und den Favorit entfernen – ohne Neuladen.
// Raster: views/partials/fav-grid.ejs. Normale Karten öffnen den Zoom (partials/card-zoom mit favForm), folierte die
// 3D-Ansicht (public/js/foil-view.js, partials/foil-modal mit favForm). Beide Fenster schicken das Favoriten-Formular
// hierher; danach wird die Kachel zu einem freien „+“-Platz.
(function () {
  var favGrid = document.querySelector('[data-fav-grid]');
  var zoom = document.querySelector('[data-zoom-modal]');
  if (!favGrid || !zoom) return;
  var tilt = zoom.querySelector('[data-zoom-tilt]');
  if (window.tcgBindTilt) window.tcgBindTilt(tilt); // 3D-Neigung aus public/js/tcg.js
  var zoomFav = zoom.querySelector('[data-zoom-fav]');
  var zoomAlbum = zoom.querySelector('[data-zoom-album]');
  var closeDialog = function (dlg) { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); };

  function clearError(dlg) {
    var old = dlg.querySelector('[data-fav-error]');
    if (old) old.remove();
  }
  function showError(form, text) {
    var dlg = form.closest('dialog');
    clearError(dlg);
    var p = document.createElement('p');
    p.className = 'fav-error';
    p.setAttribute('data-fav-error', '');
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

  favGrid.addEventListener('click', function (e) {
    var slot = e.target.closest('[data-fav-zoom]');
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
})();

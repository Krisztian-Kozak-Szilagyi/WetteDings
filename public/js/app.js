(function () {
  'use strict';

  // Mobile Navigation
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('hauptnavigation');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Menü schließen' : 'Menü öffnen');
    });
  }

  // Hinweise schließen
  document.querySelectorAll('.flash-close').forEach(function (btn) {
    btn.addEventListener('click', function () {
      btn.parentElement.remove();
    });
  });

  // Sicherheitsabfrage vor unumkehrbaren Aktionen
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Doppelklicks auf Absenden verhindern
  document.querySelectorAll('form[method="post"]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (e.defaultPrevented) return;
      setTimeout(function () {
        form.querySelectorAll('button[type="submit"]').forEach(function (b) { b.disabled = true; });
      }, 0);
    });
  });

  // Einsatz-Formular: Schnellbeträge + Gewinnschätzung
  var euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  document.querySelectorAll('.stake-form').forEach(function (form) {
    var input = form.querySelector('input[name="amount"]');
    var out = form.querySelector('.estimate');
    var totals = { ja: Number(form.dataset.ja) || 0, nein: Number(form.dataset.nein) || 0 };
    var mySide = form.dataset.mySide || '';
    var myAmount = Number(form.dataset.myAmount) || 0;
    var max = Number(input.max) || Infinity;

    function side() {
      var r = form.querySelector('input[name="side"]:checked');
      return r ? r.value : null;
    }

    function update() {
      var s = side();
      var cents = Math.round((parseFloat(String(input.value).replace(',', '.')) || 0) * 100);
      if (!s || cents <= 0) { out.textContent = ''; return; }
      var other = s === 'ja' ? totals.nein : totals.ja;
      var mine = (s === 'ja' ? totals.ja : totals.nein) + cents;
      var stake = cents + (s === mySide ? myAmount : 0);
      if (other === 0) {
        out.innerHTML = 'Noch hält niemand dagegen – ohne Gegenseite gibt es nur den Einsatz zurück.';
        return;
      }
      var payout = Math.floor(stake * (mine + other) / mine);
      out.innerHTML = 'Wenn <strong>' + (s === 'ja' ? 'Ja' : 'Nein') + '</strong> gewinnt, bekommst du nach aktuellem Stand ca. <strong>' +
        euro.format(payout / 100) + '</strong> (Gewinn ' + euro.format((payout - stake) / 100) + ').';
    }

    form.querySelectorAll('[data-add]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = (parseFloat(input.value) || 0) + Number(b.dataset.add);
        input.value = Math.min(v, max).toFixed(2).replace(/\.00$/, '');
        update();
      });
    });
    form.querySelectorAll('[data-set]').forEach(function (b) {
      b.addEventListener('click', function () {
        input.value = Number(b.dataset.set).toFixed(2).replace(/\.00$/, '');
        update();
      });
    });
    input.addEventListener('input', update);
    form.querySelectorAll('input[name="side"]').forEach(function (r) { r.addEventListener('change', update); });
    update();
  });
})();

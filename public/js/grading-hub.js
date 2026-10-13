// Shop-Hub (#204), Reiter „Preise“: Vorschau, wie Kunden die Preise sehen, und Hinweis bei Werten außerhalb des Rahmens
(function () {
  var form = document.querySelector('[data-gh-prices]');
  if (!form) return;
  var fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  var euro = function (c) { return fmt.format(c / 100); };
  // "12,50" / "12.5" → Cent (ungültig → null), wie parseEuro auf dem Server ohne Tausenderpunkte
  var cents = function (v) {
    var s = String(v).trim().replace(/[\s€]/g, '');
    if (!/^\d{1,9}([.,]\d{1,2})?$/.test(s)) return null;
    var p = s.split(/[.,]/);
    return parseInt(p[0], 10) * 100 + parseInt(((p[1] || '') + '00').slice(0, 2), 10);
  };
  var set = function (sel, text) {
    var el = document.querySelector(sel);
    if (el) el.textContent = text;
  };

  function update() {
    var p = {};
    form.querySelectorAll('input[data-min]').forEach(function (inp) {
      var c = cents(inp.value);
      var ok = c !== null && c >= +inp.getAttribute('data-min') && c <= +inp.getAttribute('data-max');
      inp.setAttribute('aria-invalid', ok ? 'false' : 'true');
      p[inp.name] = c === null ? 0 : c;
    });
    set('[data-gh-sum]', euro(p.base + p.slab));
    set('[data-gh-sum-iron]', euro(p.base + p.iron + p.slab));
    set('[data-gh-express]', euro(p.express));
  }

  form.addEventListener('input', update);
  update();
})();

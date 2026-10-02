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

  // Hinweise schließen (delegiert – funktioniert auch für nachgeladene Hinweise)
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.flash-close');
    if (btn) btn.parentElement.remove();
  });

  // Sicherheitsabfragen vor unumkehrbaren Aktionen (delegiert, damit sie auch nach Live-Updates greifen)
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.hasAttribute('data-confirm') && !window.confirm(form.getAttribute('data-confirm'))) {
      e.preventDefault();
      return;
    }
    if (form.hasAttribute('data-confirm-resolve')) {
      var r = form.querySelector('input[name="outcome"]:checked');
      var label = r ? r.dataset.label : '?';
      if (!window.confirm('Ergebnis „' + label + '“ festlegen und auszahlen? Das kann nicht rückgängig gemacht werden.')) e.preventDefault();
    }
  });

  // Doppelklicks auf Absenden verhindern
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if ((form.getAttribute('method') || '').toLowerCase() !== 'post') return;
    setTimeout(function () {
      if (e.defaultPrevented) return;
      form.querySelectorAll('button[type="submit"]').forEach(function (b) { b.disabled = true; });
    }, 0);
  });

  // ---------- Live-Aktualisierung (alle 5 Sekunden) ----------
  // Seiten mit [data-live-root] fragen regelmäßig einen kleinen Versionsstand ab. Ändert er sich,
  // wird die Seite im Hintergrund neu geladen und nur die Bereiche mit [data-live] ausgetauscht –
  // Formulare und Eingaben bleiben unberührt. Ändert sich die [data-live-signature]
  // (z. B. Wette geschlossen), wird die ganze Seite neu geladen.
  var liveRoot = document.querySelector('[data-live-root]');
  if (liveRoot) {
    var liveUrl = liveRoot.getAttribute('data-live-url');
    // Versionsstand, mit dem die Seite gerendert wurde (vom Server mitgeliefert)
    var liveVersion = liveRoot.getAttribute('data-live-version') || null;
    var liveBusy = false;

    var applyLive = function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var fresh = doc.querySelector('[data-live-root]');
      if (!fresh || fresh.getAttribute('data-live-signature') !== liveRoot.getAttribute('data-live-signature')) {
        window.location.reload();
        return;
      }
      // Stand der nachgeladenen Seite übernehmen
      liveVersion = fresh.getAttribute('data-live-version') || liveVersion;
      document.querySelectorAll('[data-live]').forEach(function (el) {
        var next = doc.querySelector('[data-live="' + el.getAttribute('data-live') + '"]');
        if (next && next.innerHTML !== el.innerHTML) el.innerHTML = next.innerHTML;
      });
      document.querySelectorAll('[data-live-attrs]').forEach(function (el) {
        var next = doc.querySelector('[data-live-attrs="' + el.getAttribute('data-live-attrs') + '"]');
        if (!next) return;
        Array.prototype.forEach.call(next.attributes, function (a) {
          if (a.name.indexOf('data-') === 0 && el.getAttribute(a.name) !== a.value) el.setAttribute(a.name, a.value);
        });
      });
      // Neue Hinweise (z. B. Tagesbonus) anzeigen
      var flash = doc.querySelector('.flash');
      var flashArea = document.querySelector('[data-flash-area]');
      if (flash && flashArea && !flashArea.querySelector('.flash')) flashArea.innerHTML = flash.outerHTML;
      document.dispatchEvent(new CustomEvent('live:updated'));
    };

    var checkLive = function () {
      if (document.hidden || liveBusy) return;
      liveBusy = true;
      fetch(liveUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (r) { if (!r.ok || r.redirected) throw new Error('stand'); return r.json(); })
        .then(function (d) {
          if (liveVersion === null || d.v === liveVersion) { liveVersion = d.v; return null; }
          liveVersion = d.v;
          return fetch(window.location.href, { credentials: 'same-origin' }).then(function (r) {
            if (!r.ok || r.redirected) { window.location.reload(); return null; }
            return r.text().then(applyLive);
          });
        })
        .catch(function () {})
        .then(function () { liveBusy = false; });
    };

    checkLive();
    setInterval(checkLive, 5000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) checkLive(); });
  }

  // Teilen: Wettlink in die Zwischenablage kopieren
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  document.querySelectorAll('[data-share]').forEach(function (btn) {
    var label = btn.querySelector('[data-share-label]');
    var timer;
    btn.addEventListener('click', function () {
      var url = location.origin + location.pathname;
      copyText(url).then(function () {
        btn.classList.add('copied');
        label.textContent = 'Link kopiert!';
      }, function () {
        window.prompt('Link zum Kopieren:', url);
      }).then(function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          btn.classList.remove('copied');
          label.textContent = 'Teilen';
        }, 2500);
      });
    });
  });

  // Beliebigen Text kopieren (z. B. Registrierungscodes im Admin-Panel)
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    var original = btn.textContent;
    btn.addEventListener('click', function () {
      copyText(btn.getAttribute('data-copy')).then(function () {
        btn.textContent = 'Kopiert!';
        btn.classList.add('copied');
        setTimeout(function () { btn.textContent = original; btn.classList.remove('copied'); }, 2000);
      }, function () {
        window.prompt('Zum Kopieren:', btn.getAttribute('data-copy'));
      });
    });
  });

  // Zeichenzähler für Textfelder (z. B. Kommentare)
  document.querySelectorAll('[data-count-for]').forEach(function (counter) {
    var field = document.getElementById(counter.getAttribute('data-count-for'));
    if (!field) return;
    var max = field.getAttribute('maxlength');
    function update() { counter.textContent = field.value.length + ' / ' + max; }
    field.addEventListener('input', update);
    update();
  });

  // Neue Wette: Art umschalten, Optionen hinzufügen/entfernen
  var newBet = document.querySelector('.new-bet-form');
  if (newBet) {
    var panels = newBet.querySelectorAll('[data-type-panel]');
    var list = newBet.querySelector('.option-inputs');
    var addBtn = newBet.querySelector('[data-add-option]');
    var max = Number(list.dataset.max) || 10;
    var min = Number(list.dataset.min) || 2;

    function showType() {
      var checked = newBet.querySelector('input[name="type"]:checked');
      var type = checked ? checked.value : 'janein';
      panels.forEach(function (p) { p.hidden = p.getAttribute('data-type-panel') !== type; });
    }

    function rows() { return list.querySelectorAll('.option-input'); }

    function renumber() {
      rows().forEach(function (row, i) {
        var input = row.querySelector('input');
        input.placeholder = 'Option ' + (i + 1);
        input.setAttribute('aria-label', 'Option ' + (i + 1));
        row.querySelector('.option-num').className = 'option-num c-' + (i % 10);
      });
      var count = rows().length;
      addBtn.hidden = count >= max;
      list.querySelectorAll('[data-remove-option]').forEach(function (b) { b.disabled = count <= min; });
    }

    newBet.querySelectorAll('input[name="type"]').forEach(function (r) { r.addEventListener('change', showType); });

    addBtn.addEventListener('click', function () {
      if (rows().length >= max) return;
      var row = rows()[0].cloneNode(true);
      row.querySelector('input').value = '';
      list.appendChild(row);
      renumber();
      row.querySelector('input').focus();
    });

    list.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-remove-option]');
      if (!btn || rows().length <= min) return;
      btn.closest('.option-input').remove();
      renumber();
    });

    showType();
    renumber();
  }

  // Einsatz-Formular: Schnellbeträge + Gewinnschätzung
  var euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  document.querySelectorAll('.stake-form').forEach(function (form) {
    var input = form.querySelector('input[name="amount"]');
    var out = form.querySelector('.estimate');
    var max = Number(input.max) || Infinity;

    function update() {
      // Werte bei jedem Aufruf frisch lesen – sie werden durch die Live-Aktualisierung erneuert
      var totals = {};
      try { totals = JSON.parse(form.dataset.totals || '{}'); } catch (e) { totals = {}; }
      var pot = Object.keys(totals).reduce(function (s, k) { return s + Number(totals[k] || 0); }, 0);
      var feePct = (Number(form.dataset.fee) || 0) / 100;
      var mySide = form.dataset.mySide || '';
      var myAmount = Number(form.dataset.myAmount) || 0;
      var r = form.querySelector('input[name="side"]:checked');
      var cents = Math.round((parseFloat(String(input.value).replace(',', '.')) || 0) * 100);
      if (!r || cents <= 0) { out.textContent = ''; return; }
      var s = r.value;
      var label = r.dataset.label || s;
      var mine = Number(totals[s] || 0) + cents;
      var other = pot - Number(totals[s] || 0);
      var stake = cents + (s === mySide ? myAmount : 0);
      out.textContent = '';
      if (other === 0) {
        out.textContent = 'Noch hat niemand anders gesetzt – ohne Gegenseite gibt es nur den Einsatz zurück.';
        return;
      }
      // Provision höchstens so hoch wie die Einsätze der Gegenseite -> Gewinner bekommen nie weniger als ihren Einsatz
      var fee = Math.min((mine + other) * feePct, other);
      var payout = Math.floor(stake * (mine + other - fee) / mine);
      out.append('Wenn ');
      var b1 = document.createElement('strong'); b1.textContent = '„' + label + '“'; out.append(b1);
      out.append(' eintritt, bekommst du nach aktuellem Stand ca. ');
      var b2 = document.createElement('strong'); b2.textContent = euro.format(payout / 100); out.append(b2);
      out.append(' (Gewinn ' + euro.format((payout - stake) / 100) + ').');
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
    document.addEventListener('live:updated', update);
    update();
  });

  // Lotterie: Anzahl-Schnellwahl und Kostenanzeige
  document.querySelectorAll('.lotto-form').forEach(function (form) {
    var input = form.querySelector('input[name="count"]');
    var out = form.querySelector('[data-lotto-cost]');
    var price = Number(form.getAttribute('data-price')) || 0;
    function update() {
      var n = parseInt(input.value, 10) || 0;
      out.textContent = n > 0 ? n + (n === 1 ? ' Los' : ' Lose') + ' = ' + euro.format((n * price) / 100) : '';
    }
    form.querySelectorAll('[data-count]').forEach(function (b) {
      b.addEventListener('click', function () { input.value = b.getAttribute('data-count'); update(); });
    });
    input.addEventListener('input', update);
    update();
  });

  // Patchnotes: Knöpfe über dem Textfeld setzen die Auszeichnung (Zeilenanfang bzw. um die Markierung)
  document.querySelectorAll('[data-pn-toolbar]').forEach(function (bar) {
    var ta = document.getElementById(bar.getAttribute('data-pn-toolbar'));
    if (!ta) return;
    bar.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
      var line = btn.getAttribute('data-pn-line');
      var wrap = btn.getAttribute('data-pn-wrap');
      if (line) {
        var start = v.lastIndexOf('\n', a - 1) + 1;
        ta.value = v.slice(0, start) + line + v.slice(start);
        a += line.length; b += line.length;
      } else if (wrap) {
        var end = btn.getAttribute('data-pn-wrap-end') || wrap; // z. B. <dev> … </dev>
        ta.value = v.slice(0, a) + wrap + (v.slice(a, b) || 'Text') + end + v.slice(b);
        b = (a === b ? a + 4 : b) + wrap.length; a += wrap.length;
      }
      ta.focus();
      ta.setSelectionRange(a, b);
    });
  });

  // Admin: TCG – Summe der Chancen und Packwert live berechnen
  var tcgAdmin = document.querySelector('[data-tcg-admin]');
  if (tcgAdmin) {
    var num = function (s) {
      var v = parseFloat(String(s || '').replace(/\s|%|€/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
      return isFinite(v) ? v : NaN;
    };
    var fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
    var recalc = function () {
      var sum = 0, ev = 0;
      tcgAdmin.querySelectorAll('input[name^="weight_"]').forEach(function (inp) {
        var key = inp.name.slice(7);
        var w = num(inp.value);
        var sell = num(tcgAdmin.querySelector('input[name="sell_' + key + '"]').value);
        if (isFinite(w)) sum += w;
        if (isFinite(w) && isFinite(sell)) ev += (w / 100) * sell * 3;
      });
      var pack = num(tcgAdmin.querySelector('input[name="pack"]').value);
      var sumEl = tcgAdmin.querySelector('[data-tcg-sum]');
      sumEl.textContent = sum.toFixed(2).replace('.', ',') + ' %';
      sumEl.className = Math.abs(sum - 100) < 0.001 ? 'pos' : 'neg';
      tcgAdmin.querySelector('[data-tcg-ev]').textContent = fmt.format(ev);
      var ratioEl = tcgAdmin.querySelector('[data-tcg-ratio]');
      ratioEl.textContent = pack > 0 ? Math.round((ev / pack) * 100) + ' %' : '–';
      ratioEl.className = pack > 0 && ev >= pack ? 'neg' : 'pos';
      tcgAdmin.querySelector('[data-tcg-warn]').hidden = !(pack > 0 && ev >= pack);
    };
    tcgAdmin.addEventListener('input', recalc);
    recalc();
  }

  // Countdown (z. B. Lotterie-Ziehung): [data-countdown="<Zeitpunkt in ms>"]
  function tickCountdowns() {
    document.querySelectorAll('[data-countdown]').forEach(function (el) {
      var ms = Number(el.getAttribute('data-countdown')) - Date.now();
      if (ms <= 0) { el.textContent = 'jetzt'; return; }
      var s = Math.floor(ms / 1000);
      var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      el.textContent = (h ? h + ' Std. ' : '') + String(m).padStart(2, '0') + ' Min. ' + String(sec).padStart(2, '0') + ' Sek.';
    });
  }
  if (document.querySelector('[data-countdown]')) {
    tickCountdowns();
    setInterval(tickCountdowns, 1000);
  }
})();

// Namen innerhalb eines anderen Links (z. B. Wett-Karte): eigener Klick führt zum Profil statt zur Wette
(function () {
  function go(e) {
    var el = e.target.closest && e.target.closest('[data-user-link]');
    if (!el || (e.type === 'keydown' && e.key !== 'Enter')) return;
    e.preventDefault();
    e.stopPropagation();
    window.location.href = el.getAttribute('data-user-link');
  }
  document.addEventListener('click', go, true);
  document.addEventListener('keydown', go, true);
})();

// Rangliste: SVG-Filter für den lodernden Namen auf Platz 1
(function () {
  if (!document.querySelector('.flame-name') || document.getElementById('bfw-flame-defs')) return;
  var svg = '<svg id="bfw-flame-defs" width="0" height="0" style="position:absolute" aria-hidden="true">' +
    '<filter id="bfw-flame" x="-30%" y="-150%" width="160%" height="260%" color-interpolation-filters="sRGB">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.035 0.11" numOctaves="2" seed="7" result="noise">' +
        '<animate attributeName="baseFrequency" dur="1.6s" repeatCount="indefinite" ' +
          'values="0.035 0.11;0.04 0.15;0.03 0.09;0.035 0.11"/>' +
      '</feTurbulence>' +
      '<feDisplacementMap in="SourceGraphic" in2="noise" scale="11" xChannelSelector="R" yChannelSelector="G"/>' +
      '<feGaussianBlur stdDeviation="0.5"/>' +
    '</filter></svg>';
  var add = function () { document.body.insertAdjacentHTML('afterbegin', svg); };
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})();

(function () {
  'use strict';

  // Dialoge: [data-dialog-open="id"] öffnet <dialog id>, [data-dialog-close] oder Klick daneben schließt
  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-dialog-open]');
    if (opener) {
      var dlg = document.getElementById(opener.getAttribute('data-dialog-open'));
      if (dlg && dlg.showModal && !dlg.open) dlg.showModal();
      return;
    }
    var closer = e.target.closest('[data-dialog-close]');
    if (closer) {
      var d = closer.closest('dialog');
      if (d) d.close();
      return;
    }
    if (e.target.tagName === 'DIALOG' && e.target.classList.contains('dialog') && e.target.open) {
      var r = e.target.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
    }
  });

  // Zugeklappte Karte aufklappen, wenn die Adresse auf sie zeigt (z. B. /admin#tcg nach dem Speichern)
  var openTarget = function () {
    var el = null;
    try { el = location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null; } catch (err) { /* ungültige Adresse */ }
    if (el && el.tagName === 'DETAILS' && !el.open) {
      el.open = true;
      el.scrollIntoView();
    }
  };
  openTarget();
  window.addEventListener('hashchange', openTarget);

  // Hinweise schließen (delegiert – funktioniert auch für nachgeladene Hinweise)
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.flash-close');
    if (btn) btn.parentElement.remove();
  });

  // Text der Sicherheitsabfrage eines Formulars (data-confirm, bei Ergebnissen mit der gewählten Option)
  function confirmText(form) {
    if (form.hasAttribute('data-confirm-resolve')) {
      var r = form.querySelector('input[name="outcome"]:checked');
      var tpl = form.getAttribute('data-confirm-resolve') || 'Ergebnis „%s“ festlegen und auszahlen? Das kann nicht rückgängig gemacht werden.';
      return tpl.replace('%s', r ? r.dataset.label : '?');
    }
    return form.getAttribute('data-confirm') || '';
  }

  // Passwortabfrage für Moderations- und Spielwerte-Aktionen (Formulare mit data-reauth, nur für Admin/Devs).
  // Ersetzt dort die Sicherheitsabfrage: der Dialog zeigt deren Text und fragt zusätzlich das Passwort ab.
  var reauth = document.querySelector('[data-reauth-dialog]');
  var reauthTarget = null;
  if (reauth) {
    var reauthInput = reauth.querySelector('[data-reauth-input]');
    var reauthText = reauth.querySelector('[data-reauth-text]');
    reauth.querySelector('[data-reauth-cancel]').addEventListener('click', function () { reauth.close(); });
    reauth.addEventListener('close', function () { reauthInput.value = ''; });
    reauth.querySelector('[data-reauth-form]').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!reauthTarget || !reauthInput.value) return;
      var form = reauthTarget;
      var field = form.querySelector('input[name="reauth_password"]');
      if (!field) {
        field = document.createElement('input');
        field.type = 'hidden';
        field.name = 'reauth_password';
        form.appendChild(field);
      }
      field.value = reauthInput.value;
      form.dataset.reauthOk = '1';
      reauth.close();
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
    });
  }
  function askPassword(form) {
    if (!reauth) return false;
    reauthTarget = form;
    var text = confirmText(form);
    reauthText.textContent = text;
    reauthText.hidden = !text;
    reauth.showModal();
    reauthInput.focus();
    return true;
  }

  // Sicherheitsabfragen vor unumkehrbaren Aktionen (delegiert, damit sie auch nach Live-Updates greifen)
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.hasAttribute('data-reauth')) {
      if (form.dataset.reauthOk === '1') {
        delete form.dataset.reauthOk; // Passwort ist eingetragen: jetzt wirklich absenden
        return;
      }
      if (askPassword(form)) {
        e.preventDefault();
        return;
      }
    }
    if (form.hasAttribute('data-confirm') && !window.confirm(form.getAttribute('data-confirm'))) {
      e.preventDefault();
      return;
    }
    // Der Text steht am Formular, weil er je nach Rolle anders lautet (Stimme abgeben vs. entscheiden)
    if (form.hasAttribute('data-confirm-resolve') && !window.confirm(confirmText(form))) e.preventDefault();
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

  // Neue Wette als Assistent: ein Schritt nach dem anderen (views/new-bet.ejs). Ohne JS bleiben alle Schritte sichtbar.
  var wizard = document.querySelector('[data-wizard]');
  if (wizard) {
    var steps = Array.prototype.slice.call(wizard.querySelectorAll('[data-step]'));
    var names = (wizard.getAttribute('data-steps') || '').split('|');
    var nav = wizard.querySelector('[data-wizard-nav]');
    var backBtn = wizard.querySelector('[data-wizard-back]');
    var nextBtn = wizard.querySelector('[data-wizard-next]');
    var progress = document.querySelector('[data-wizard-progress]');
    var label = document.querySelector('[data-wizard-label]');
    var bar = document.querySelector('[data-wizard-bar]');
    var summary = wizard.querySelector('[data-wizard-summary]');
    var current = Math.min(steps.length - 1, Math.max(0, parseInt(wizard.getAttribute('data-start-step'), 10) || 0));
    wizard.noValidate = true; // geprüft wird je Schritt (und am Ende auf dem Server)

    var field = function (name) { return wizard.querySelector('[name="' + name + '"]'); };
    var selectedText = function (sel) { return sel && sel.value ? sel.options[sel.selectedIndex].text : ''; };
    var fmtDate = function (v) {
      if (!v) return '–';
      var d = new Date(v);
      return isNaN(d) ? v : d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) + ' Uhr';
    };

    // Eigene Prüfungen, die das Browser-Formular nicht kennt
    function customError(step) {
      if (step.contains(field('options'))) {
        var type = wizard.querySelector('input[name="type"]:checked');
        if (type && type.value === 'optionen') {
          var filled = Array.prototype.map.call(wizard.querySelectorAll('input[name="options"]'), function (i) { return i.value.trim().toLowerCase(); }).filter(Boolean);
          var min = Number(wizard.querySelector('.option-inputs').dataset.min) || 2;
          if (filled.length < min) return { el: wizard.querySelector('input[name="options"]'), msg: 'Bitte gib mindestens ' + min + ' Optionen an.' };
          if (new Set(filled).size !== filled.length) return { el: wizard.querySelector('input[name="options"]'), msg: 'Jede Option darf nur einmal vorkommen.' };
        }
      }
      var deadline = field('deadline');
      var resultAt = field('resultAt');
      if (step.contains(resultAt) && deadline.value && resultAt.value && resultAt.value < deadline.value) {
        return { el: resultAt, msg: 'Das Ergebnis kann nicht vor dem Einsatzschluss feststehen.' };
      }
      return null;
    }

    function stepValid(step) {
      var inputs = step.querySelectorAll('input, select, textarea');
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i];
        if (el.closest('[hidden]') || el.disabled) continue;
        if (!el.checkValidity()) { el.reportValidity(); return false; }
      }
      var err = customError(step);
      if (err) {
        err.el.setCustomValidity(err.msg);
        err.el.reportValidity();
        err.el.addEventListener('input', function clear() { err.el.setCustomValidity(''); err.el.removeEventListener('input', clear); });
        return false;
      }
      return true;
    }

    function fillSummary() {
      var type = wizard.querySelector('input[name="type"]:checked');
      var answers = type && type.value === 'optionen'
        ? Array.prototype.map.call(wizard.querySelectorAll('input[name="options"]'), function (i) { return i.value.trim(); }).filter(Boolean).join(' · ')
        : 'Ja · Nein';
      var rows = [
        ['Frage', field('title').value.trim()],
        ['Antworten', answers],
        ['Details', field('description').value.trim() || '–'],
        ['Schiedsrichter', selectedText(field('referee')) || '–'],
      ];
      if (field('group')) rows.push(['Sichtbar für', selectedText(field('group')) || 'Alle Mitglieder']);
      rows.push(['Einsätze bis', fmtDate(field('deadline').value)], ['Ergebnis am', fmtDate(field('resultAt').value)]);
      summary.textContent = '';
      rows.forEach(function (r, i) {
        var dt = document.createElement('dt');
        var dd = document.createElement('dd');
        var edit = document.createElement('button');
        dt.textContent = r[0];
        dd.textContent = r[1];
        edit.type = 'button';
        edit.className = 'wizard-edit';
        edit.textContent = 'Ändern';
        // Zeile → Schritt: Frage 0, Antworten 1, Details 2, Schiedsrichter/Gruppe 3, Termine 4
        var target = [0, 1, 2, 3, field('group') ? 3 : 4, 4, 4][i];
        edit.addEventListener('click', function () { show(target); });
        dd.appendChild(edit);
        summary.appendChild(dt);
        summary.appendChild(dd);
      });
    }

    function show(i) {
      current = i;
      steps.forEach(function (s, n) { s.hidden = n !== i; });
      var last = i === steps.length - 1;
      backBtn.hidden = i === 0;
      nextBtn.hidden = last;
      // Optionaler Schritt ohne Eingabe: "Überspringen" statt "Weiter"
      var desc = field('description');
      nextBtn.textContent = steps[i].contains(desc) && !desc.value.trim() ? 'Überspringen' : 'Weiter';
      label.textContent = 'Schritt ' + (i + 1) + ' von ' + steps.length + ' · ' + (names[i] || '');
      bar.style.width = ((i + 1) / steps.length) * 100 + '%';
      if (last) fillSummary();
      var focus = steps[i].querySelector('input:not([type="radio"]):not([hidden]), select, textarea');
      if (focus && !last) focus.focus({ preventScroll: true });
    }

    nextBtn.addEventListener('click', function () {
      if (stepValid(steps[current])) show(current + 1);
    });
    backBtn.addEventListener('click', function () { show(current - 1); });
    var desc = field('description');
    desc.addEventListener('input', function () { if (steps[current].contains(desc)) nextBtn.textContent = desc.value.trim() ? 'Weiter' : 'Überspringen'; });
    // Enter in einem Textfeld geht zum nächsten Schritt statt das Formular abzuschicken
    wizard.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON' || current === steps.length - 1) return;
      e.preventDefault();
      if (e.target.name !== 'options') nextBtn.click(); // in den Optionen schickt Enter nichts ab und blättert nicht weiter
    });
    // Abschicken nur, wenn alle Schritte stimmen – sonst zum ersten fehlerhaften Schritt
    wizard.addEventListener('submit', function (e) {
      for (var n = 0; n < steps.length; n++) {
        show(n);
        if (!stepValid(steps[n])) { e.preventDefault(); return; }
      }
    });

    nav.hidden = false;
    progress.hidden = false;
    summary.hidden = false;
    wizard.querySelectorAll('[data-wizard-only]').forEach(function (el) { el.hidden = false; });
    wizard.classList.add('is-wizard');
    show(current);
  }

  // Einsatz-Formular: Schnellbeträge, möglicher Gewinn, Bestätigung in zwei Schritten
  var euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  document.querySelectorAll('.stake-form').forEach(function (form) {
    var input = form.querySelector('input[name="amount"]');
    var out = form.querySelector('.estimate');
    var winEl = form.querySelector('[data-win]');
    var quoteEl = form.querySelector('[data-win-quote]');
    var stepForm = form.querySelector('[data-stake-step="form"]');
    var stepConfirm = form.querySelector('[data-stake-step="confirm"]');
    var max = Number(input.max) || Infinity;
    var last = null; // letzte Berechnung für die Bestätigung

    function setWin(text, quote) {
      if (winEl) winEl.textContent = text;
      if (quoteEl) quoteEl.textContent = quote || '';
    }

    function update() {
      // Werte bei jedem Aufruf frisch lesen – sie werden durch die Live-Aktualisierung erneuert
      var totals = {};
      try { totals = JSON.parse(form.dataset.totals || '{}'); } catch (e) { totals = {}; }
      var pot = Object.keys(totals).reduce(function (sum, k) { return sum + Number(totals[k] || 0); }, 0);
      var feePct = (Number(form.dataset.fee) || 0) / 100;
      var mySide = form.dataset.mySide || '';
      var myAmount = Number(form.dataset.myAmount) || 0;
      var r = form.querySelector('input[name="side"]:checked');
      var cents = Math.round((parseFloat(String(input.value).replace(',', '.')) || 0) * 100);
      out.textContent = '';
      last = null;
      if (!r || cents <= 0) { setWin('–', ''); return; }
      var side = r.value;
      var label = r.dataset.label || side;
      var mine = Number(totals[side] || 0) + cents;
      var other = pot - Number(totals[side] || 0);
      var stake = cents + (side === mySide ? myAmount : 0);
      last = { label: label, cents: cents, payout: null };
      if (other === 0) {
        setWin(euro.format(0), '');
        out.textContent = 'Noch hat niemand anders gesetzt – ohne Gegenseite gibt es nur den Einsatz zurück.';
        return;
      }
      // Provision höchstens so hoch wie die Einsätze der Gegenseite -> Gewinner bekommen nie weniger als ihren Einsatz
      var fee = Math.min((mine + other) * feePct, other);
      var payout = Math.floor(stake * (mine + other - fee) / mine);
      last.payout = payout;
      setWin(euro.format((payout - stake) / 100), 'Quote ' + (payout / stake).toFixed(2).replace('.', ',') + '× · Auszahlung ' + euro.format(payout / 100));
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

    // Schritt 1 „Weiter“ zeigt die Zusammenfassung, Schritt 2 „Bestätigen“ sendet ab
    if (stepForm && stepConfirm) {
      form.addEventListener('submit', function (e) {
        if (form.dataset.confirmed === '1') return;
        if (!form.checkValidity()) return;
        e.preventDefault();
        update();
        if (!last) return;
        form.querySelector('[data-confirm-amount]').textContent = euro.format(last.cents / 100);
        form.querySelector('[data-confirm-label]').textContent = last.label;
        form.querySelector('[data-confirm-win]').textContent = last.payout !== null
          ? 'Möglicher Gewinn nach aktuellem Stand: ' + (winEl ? winEl.textContent : '') + '. Die Quote kann sich noch ändern.'
          : 'Noch keine Gegenseite – ohne Gegenseite gibt es nur den Einsatz zurück.';
        stepForm.hidden = true;
        stepConfirm.hidden = false;
        stepConfirm.querySelector('[data-stake-confirm]').focus();
      });
      stepConfirm.querySelector('[data-stake-confirm]').addEventListener('click', function () {
        form.dataset.confirmed = '1';
      });
      stepConfirm.querySelector('[data-stake-back]').addEventListener('click', function () {
        stepConfirm.hidden = true;
        stepForm.hidden = false;
      });
    }
  });

  // Lotterie: Anzahl-Schnellwahl und Kostenanzeige
  document.querySelectorAll('.lotto-form').forEach(function (form) {
    var input = form.querySelector('input[name="count"]');
    var out = form.querySelector('[data-lotto-cost]');
    var price = Number(form.getAttribute('data-price')) || 0;
    function update() {
      var n = parseInt(input.value, 10) || 0;
      out.textContent = n > 0 ? euro.format((n * price) / 100) : '';
    }
    form.querySelectorAll('[data-count]').forEach(function (b) {
      b.addEventListener('click', function () { input.value = b.getAttribute('data-count'); update(); });
    });
    form.querySelectorAll('[data-step]').forEach(function (b) {
      b.addEventListener('click', function () {
        var n = (parseInt(input.value, 10) || 0) + Number(b.getAttribute('data-step'));
        input.value = Math.min(Number(input.max) || n, Math.max(Number(input.min) || 1, n));
        update();
      });
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
    var perPack = Number(tcgAdmin.getAttribute('data-cards-per-pack')) || 5;
    var recalc = function () {
      var sum = 0, ev = 0;
      tcgAdmin.querySelectorAll('input[name^="weight_"]').forEach(function (inp) {
        var key = inp.name.slice(7);
        var w = num(inp.value);
        var sell = num(tcgAdmin.querySelector('input[name="sell_' + key + '"]').value);
        if (isFinite(w)) sum += w;
        if (isFinite(w) && isFinite(sell)) ev += (w / 100) * sell * perPack;
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
    // Variante mit getrennten Feldern: [data-countdown-parts] mit [data-cd="h|m|s"]
    document.querySelectorAll('[data-countdown-parts]').forEach(function (el) {
      var s = Math.max(0, Math.floor((Number(el.getAttribute('data-countdown-parts')) - Date.now()) / 1000));
      var parts = { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
      el.querySelectorAll('[data-cd]').forEach(function (p) {
        p.textContent = String(parts[p.getAttribute('data-cd')]).padStart(2, '0');
      });
    });
  }
  if (document.querySelector('[data-countdown], [data-countdown-parts]')) {
    tickCountdowns();
    setInterval(tickCountdowns, 1000);
  }
})();

// Profil-Menü oben rechts: schließt bei Klick daneben und mit Escape
(function () {
  // gilt auch für andere Aufklappmenüs (z. B. "Moderation" im Profil)
  var menus = document.querySelectorAll('[data-user-menu], [data-dropdown]');
  if (!menus.length) return;
  document.addEventListener('click', function (e) {
    menus.forEach(function (menu) { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    menus.forEach(function (menu) { if (menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
  });
})();

// Glocke: "Als gelesen markieren" und "Alle gelesen" im Hintergrund schicken – das Menü bleibt offen.
// Schlägt die Anfrage fehl, wird das Formular normal abgeschickt (Seite lädt neu).
(function () {
  var bell = document.querySelector('[data-bell]');
  if (!bell || !window.fetch) return;
  var count = bell.querySelector('[data-bell-count]');
  var all = bell.querySelector('[data-bell-all]');
  function markRead(row) {
    row.classList.remove('is-unread');
    var f = row.querySelector('[data-bell-form]');
    if (f) f.remove();
  }
  function setUnread(n) {
    count.textContent = n > 99 ? '99+' : String(n);
    count.hidden = !n;
    all.hidden = !n;
    bell.querySelector('summary').setAttribute('aria-label', 'Benachrichtigungen' + (n ? ' (' + n + ' ungelesen)' : ''));
  }
  bell.addEventListener('submit', function (e) {
    var form = e.target.closest('[data-bell-form]');
    if (!form) return;
    e.preventDefault();
    var isAll = form.hasAttribute('data-bell-all');
    var row = form.closest('[data-bell-row]');
    fetch(form.action, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form)).toString(),
      credentials: 'same-origin',
    })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (data) {
        if (isAll) bell.querySelectorAll('[data-bell-row].is-unread').forEach(markRead);
        else if (row) markRead(row);
        setUnread(Number(data.unread) || 0);
      })
      .catch(function () { form.submit(); });
  });
})();

// Namen innerhalb eines anderen Links (z. B. Wett-Karte): eigener Klick führt zum Profil statt zur Wette
(function () {
  function go(e) {
    var el = e.target.closest && e.target.closest('[data-user-link]');
    if (!el || (e.type === 'keydown' && e.key !== 'Enter')) return;
    e.preventDefault();
    e.stopPropagation();
    // nur Profil-Seiten dieser Plattform
    var m = /^\/profil\/([^/\\]+)$/.exec(el.getAttribute('data-user-link') || '');
    if (!m) return;
    var name = m[1];
    try { name = decodeURIComponent(name); } catch (err) { /* Name bleibt, wie er ist */ }
    window.location.assign('/profil/' + encodeURIComponent(name));
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

// Eigener Block: Der Block oben verlässt die Funktion früh (return), wenn es auf der Seite z. B. keinen Flammen-Namen gibt –
// was hier steht, muss auf jeder Seite laufen.
(function () {
  'use strict';

  // Neuer Erfolg: Fenster wie das Beute-Fenster. Ist beim Laden schon einer offen, sofort zeigen; sonst alle 10 Sekunden
  // (und kurz nach jeder Aktion) nachfragen – so springt es auch ohne Neuladen auf, z. B. direkt nach dem Packöffnen.
  // Esc schließt nicht; „Weiter“ bestätigt im Hintergrund und zeigt gleich den nächsten Erfolg, falls noch einer wartet.
  var onReady = function (fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); };
  onReady(function () {
    var pop = document.querySelector('[data-ach-pop]');
    if (!pop || !pop.showModal) return;
    var form = pop.querySelector('[data-ach-form]');
    var q = function (sel) { return pop.querySelector(sel); };
    pop.addEventListener('cancel', function (e) { e.preventDefault(); });

    var fill = function (d) {
      q('[data-ach-id]').value = d.id;
      q('[data-ach-icon]').setAttribute('src', d.icon);
      q('[data-ach-name]').textContent = d.name;
      q('[data-ach-text]').textContent = d.text;
      q('[data-ach-reward]').textContent = d.reward || '';
      q('[data-ach-reward-row]').hidden = !d.reward;
      var more = q('[data-ach-more]');
      var left = (d.left || 1) - 1;
      more.hidden = left < 1;
      more.textContent = left === 1 ? 'Noch 1 weiterer Erfolg wartet.' : 'Noch ' + left + ' weitere Erfolge warten.';
      pop.classList.toggle('is-unique', !!d.unique);
      // Einblend-Animation für jeden Erfolg neu starten
      pop.classList.remove('is-fresh');
      void pop.offsetWidth;
      pop.classList.add('is-fresh');
    };
    var open = function (d) {
      if (d) fill(d);
      if (!pop.open) pop.showModal();
    };
    if (pop.hasAttribute('data-open')) open(null);

    var busy = false;
    form.addEventListener('submit', function (e) {
      if (!window.fetch) return;
      e.preventDefault();
      if (busy) return;
      busy = true;
      fetch(form.action, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: new URLSearchParams(new FormData(form)) })
        .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
        .then(function (res) { if (res.next) fill(res.next); else pop.close(); })
        .catch(function () { form.submit(); })
        .then(function () { busy = false; });
    });

    var poll = function () {
      if (pop.open || document.hidden) return;
      fetch('/erfolge/neu', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (res) { if (res && res.popup) open(res.popup); })
        .catch(function () {});
    };
    setInterval(poll, 10000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
    // Nach einer Aktion (Formular, Klick auf einen Knopf) prüft der Server binnen ~2 Sekunden – kurz danach nachfragen
    var later = null;
    var soon = function () { clearTimeout(later); later = setTimeout(poll, 3500); };
    document.addEventListener('submit', function (e) { if (e.target !== form) soon(); });
    document.addEventListener('click', function (e) { if (e.target.closest('button') && !pop.contains(e.target)) soon(); });
  });

  // Zeichenzähler für Textfelder: data-count="<id des Zählers>" (Emojis zählen als ein Zeichen)
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!el.hasAttribute || !el.hasAttribute('data-count')) return;
    var out = document.getElementById(el.getAttribute('data-count'));
    if (out) out.textContent = String(Array.from(el.value).length);
  });
})();

// Admin: Grading – Verdienst pro Tag live schätzen (gleiche Rechnung wie src/grading/estimate.js)
(function () {
  var box = document.querySelector('[data-grading-calc]');
  if (!box) return;
  var form = box.closest('form');
  var input;
  try { input = JSON.parse(box.getAttribute('data-grading-calc')); } catch (e) { return; }
  var fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  var val = function (name) {
    var el = form.querySelector('[name="' + name + '"]');
    var v = parseFloat(String(el ? el.value : '').replace(/\s|€|%/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    return isFinite(v) && v >= 0 ? v : 0;
  };
  var set = function (sel, text) { var el = box.querySelector(sel); if (el) el.textContent = text; };
  var recalc = function () {
    var jobs = val('gr_jobs');
    var pay = { clean: val('gr_pay_clean') * 100, grade: val('gr_pay_grade') * 100, slab: val('gr_pay_slab') * 100 };
    var premium = val('gr_premium');
    var ref = input.profiles[input.profiles.length - 1].key;
    var prev = null;
    input.levels.forEach(function (l, i) {
      var cost = i ? val('gr_cost_' + l.level) * 100 : 0;
      var day = {};
      input.profiles.forEach(function (p) {
        var j = (pay.clean * p.clean) / 100;
        if (l.steps.indexOf('grade') >= 0) j += pay.grade * (p.exact + p.near / 2);
        if (l.steps.indexOf('slab') >= 0) j += (pay.slab * p.seal) / 100;
        j = j * (l.premium ? 1 + premium / 100 : 1) * input.factor;
        if (l.steps.indexOf('slab') >= 0 && p.seal > 0) j += input.foilValue;
        day[p.key] = Math.round(jobs * j);
        set('[data-gc-day="' + l.level + '-' + p.key + '"]', fmt.format(day[p.key] / 100));
      });
      set('[data-gc-cost="' + l.level + '"]', cost ? fmt.format(cost / 100) : '–');
      var gain = prev ? day[ref] - prev[ref] : 0;
      set('[data-gc-gain="' + l.level + '"]', i ? (gain >= 0 ? '+' : '') + fmt.format(gain / 100) : '–');
      set('[data-gc-payback="' + l.level + '"]', i && gain > 0 ? Math.ceil(cost / gain) + ' Tagen' : '–');
      prev = day;
    });
    set('[data-gc-bonus]', fmt.format(val('amount')));
  };
  form.addEventListener('input', recalc);
})();

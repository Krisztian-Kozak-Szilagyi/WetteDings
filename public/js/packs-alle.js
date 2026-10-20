// Alle Booster Packs auf einmal öffnen (Inventar, views/inventar.ejs): POST /tcg/alle-oeffnen, danach eine scrollbare
// Übersicht – seltenste Karten zuerst, gleiche Karten zusammengefasst, neue Karten markiert.
(function () {
  var forms = document.querySelectorAll('[data-tcg-open-all]');
  var box = document.querySelector('[data-pack-all]');
  if (!forms.length || !box || !window.fetch) return;
  var list = box.querySelector('[data-pack-all-list]');
  var title = box.querySelector('[data-pack-all-title]');
  var sum = box.querySelector('[data-pack-all-sum]');
  var euro = function (c) { return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(c / 100); };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function open(form) {
    // offenen Dialog (Pack-Aktionen) schließen, Übersicht zeigen
    var dlg = form.closest('dialog');
    if (dlg && dlg.open) dlg.close();
    list.innerHTML = '';
    list.appendChild(el('p', 'pack-all-wait', 'Deine ' + form.getAttribute('data-count') + ' Packs werden geöffnet …'));
    title.textContent = 'Packs werden geöffnet …';
    sum.textContent = '';
    box.hidden = false;
    document.body.classList.add('tcg-noscroll');
    fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(new FormData(form)).toString(),
      credentials: 'same-origin',
    })
      .then(function (res) { return res.json().catch(function () { return { error: 'Das hat nicht geklappt. Bitte lade die Seite neu.' }; }); })
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        show(data);
      })
      .catch(function (err) {
        title.textContent = 'Das hat nicht geklappt';
        list.innerHTML = '';
        list.appendChild(el('p', 'pack-all-error', err.message || 'Keine Verbindung. Bitte versuche es erneut.'));
      });
  }

  function show(data) {
    var newCount = data.cards.filter(function (c) { return c.isNew; }).length;
    title.textContent = data.packs + ' ' + (data.packs === 1 ? 'Pack' : 'Packs') + ' geöffnet';
    sum.textContent = data.cards.length + ' Karten · Wert ' + euro(data.total) + (newCount ? ' · ' + newCount + ' neu für dein Album' : '') +
      (data.packsLeft ? ' · ' + data.packsLeft + ' Packs noch übrig (höchstens 200 auf einmal)' : '');
    // nach Seltenheit absteigend, je Seltenheit gleiche Karten zusammengefasst (neue und häufigste zuerst)
    var groups = {};
    data.cards.forEach(function (c) {
      var g = groups[c.rarity] || (groups[c.rarity] = { rank: c.rank, label: c.rarityLabel, rarity: c.rarity, n: 0, value: 0, cards: {} });
      g.n++;
      g.value += c.value;
      var e = g.cards[c.id] || (g.cards[c.id] = { card: c, n: 0, isNew: false });
      e.n++;
      if (c.isNew) e.isNew = true;
    });
    list.innerHTML = '';
    Object.keys(groups)
      .map(function (k) { return groups[k]; })
      .sort(function (a, b) { return b.rank - a.rank; })
      .forEach(function (g) {
        var sec = el('section', 'pack-all-group r-' + g.rarity);
        var head = el('h3', 'pack-all-group-head');
        head.appendChild(el('span', 'tcg-dot'));
        head.appendChild(el('span', '', g.label));
        head.appendChild(el('span', 'pack-all-group-n', g.n + '× · ' + euro(g.value)));
        sec.appendChild(head);
        var grid = el('ul', 'pack-all-grid');
        Object.keys(g.cards)
          .map(function (k) { return g.cards[k]; })
          .sort(function (a, b) { return (b.isNew - a.isNew) || b.n - a.n || a.card.name.localeCompare(b.card.name, 'de'); })
          .forEach(function (e) {
            var li = el('li', 'pack-all-card' + (e.isNew ? ' is-new' : ''));
            var img = el('img');
            img.src = e.card.image;
            img.alt = e.card.name;
            img.width = 720;
            img.height = 1008;
            img.loading = 'lazy';
            li.appendChild(img);
            if (e.n > 1) li.appendChild(el('span', 'pack-all-n', '×' + e.n));
            if (e.isNew) li.appendChild(el('span', 'tcg-new-badge', 'Neu'));
            li.appendChild(el('span', 'pack-all-name', e.card.name));
            grid.appendChild(li);
          });
        sec.appendChild(grid);
        list.appendChild(sec);
      });
    list.scrollTop = 0;
    list.focus();
  }

  forms.forEach(function (f) {
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      open(f);
    });
  });
  // schließen: Inventar neu laden (Packs sind weg)
  box.addEventListener('click', function (e) { if (e.target === box) location.reload(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !box.hidden) location.reload(); });
})();

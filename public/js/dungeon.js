// Dungeon-Seite: Countdown bis zum Start, Gruppen-Chat (Abfrage alle paar Sekunden) und Wiedergabe der Kämpfe.
// Ändert sich die Gruppe (Beitritt, Einladung, Start, Ende), lädt die Seite neu – der Chat-Entwurf bleibt erhalten.
(function () {
  const page = document.querySelector('[data-dg-page]');
  if (!page) return;

  const serverOffset = Date.now() - Number(page.dataset.now || Date.now()); // Uhr des Browsers minus Server-Uhr
  const serverNow = () => Date.now() - serverOffset;
  // Mage Tower: kein Termin (data-start leer) – kein Countdown, Abmelden bis zum Betreten
  const start = page.dataset.start ? new Date(page.dataset.start).getTime() : null;
  const lockMs = Number(page.dataset.lock || 10) * 1000;
  const rev = page.dataset.rev;
  const DRAFT_KEY = 'dg-chat-draft';

  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch { /* ohne Speicher */ } },
  };

  // ---------- Countdown ----------
  const countdown = page.querySelector('[data-dg-countdown]');
  const leaveBtn = page.querySelector('[data-dg-leave] button');
  const pad = (n) => String(n).padStart(2, '0');
  function tickCountdown() {
    if (start === null) return;
    const left = start - serverNow();
    if (countdown) {
      if (left <= 0) countdown.textContent = 'startet …';
      else {
        const s = Math.ceil(left / 1000);
        const h = Math.floor(s / 3600);
        countdown.textContent = 'noch ' + (h ? h + ':' : '') + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
      }
    }
    if (leaveBtn && left <= lockMs) leaveBtn.disabled = true;
  }
  tickCountdown();
  setInterval(tickCountdown, 1000);

  // ---------- Chat ----------
  const chatList = page.querySelector('[data-dg-chat-list]');
  const chatForm = page.querySelector('[data-dg-chat-form]');
  const chatInput = chatForm && chatForm.querySelector('input[name="text"]');
  let chatKey = '';
  const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

  function renderChat(list) {
    if (!chatList || !list) return;
    const key = list.length + ':' + (list.length ? list[list.length - 1].at : '');
    if (key === chatKey) return;
    chatKey = key;
    const atBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 40;
    chatList.replaceChildren(
      ...list.map((c) => {
        const li = document.createElement('li');
        if (c.me) li.className = 'is-me';
        const who = document.createElement('strong');
        who.textContent = c.name;
        const when = document.createElement('time');
        when.textContent = timeFmt.format(new Date(c.at));
        const text = document.createElement('span');
        text.textContent = c.text;
        li.append(who, when, text);
        return li;
      })
    );
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'dg-chat-empty';
      li.textContent = 'Noch keine Nachrichten.';
      chatList.append(li);
    }
    if (atBottom || chatList.dataset.first !== '0') chatList.scrollTop = chatList.scrollHeight;
    chatList.dataset.first = '0';
  }

  if (chatInput) {
    chatInput.value = store.get(DRAFT_KEY) || '';
    chatInput.addEventListener('input', () => store.set(DRAFT_KEY, chatInput.value));
  }
  if (chatForm) {
    chatForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!chatInput.value.trim()) return;
      const body = new URLSearchParams(new FormData(chatForm));
      chatInput.disabled = true;
      try {
        const r = await fetch('/dungeon/chat', { method: 'POST', body, credentials: 'same-origin' });
        if (r.ok) {
          chatInput.value = '';
          store.set(DRAFT_KEY, '');
          poll();
        }
      } catch { /* nächster Versuch beim nächsten Senden */ }
      chatInput.disabled = false;
      chatInput.focus();
    });
  }

  // ---------- Abfrage ----------
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const r = await fetch('/dungeon/status', { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) {
        const data = await r.json();
        if (data.rev !== rev) {
          location.reload();
          return;
        }
        renderChat(data.chat);
      }
    } catch { /* offline – später erneut */ }
    polling = false;
  }
  poll();
  setInterval(() => {
    if (!document.hidden) poll();
  }, 3000);

  // ---------- Einladen: Vorschläge beim Hineinklicken (nur wer gerade beitreten kann) ----------
  const inviteBox = page.querySelector('[data-dg-invite]');
  if (inviteBox) {
    const input = inviteBox.querySelector('input');
    const list = inviteBox.querySelector('.dg-suggest');
    let players = null; // vom Server, beim Hineinklicken frisch geladen
    let loadedAt = 0;
    let shown = [];
    let active = -1;

    async function load() {
      if (players && Date.now() - loadedAt < 10000) return;
      try {
        const r = await fetch('/dungeon/einladbar', { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok) {
          players = (await r.json()).players || [];
          loadedAt = Date.now();
        }
      } catch { /* ohne Verbindung: Name von Hand eintippen */ }
    }

    function setActive(i) {
      active = i;
      [...list.children].forEach((li, k) => li.classList.toggle('is-active', k === i));
      const li = list.children[i];
      if (li && li.id) {
        input.setAttribute('aria-activedescendant', li.id);
        li.scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    }

    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      setActive(-1);
    }

    // Treffer am Namensanfang zuerst, dann irgendwo im Namen
    function render() {
      if (!players) return close();
      const q = input.value.trim().toLowerCase();
      const starts = players.filter((p) => p.name.toLowerCase().startsWith(q));
      const inside = q ? players.filter((p) => !p.name.toLowerCase().startsWith(q) && p.name.toLowerCase().includes(q)) : [];
      shown = [...starts, ...inside];
      list.replaceChildren(
        ...shown.map((p, i) => {
          const li = document.createElement('li');
          li.id = 'dg-invite-opt-' + i;
          li.setAttribute('role', 'option');
          li.textContent = p.name;
          if (p.note) {
            const note = document.createElement('small');
            note.textContent = p.note;
            li.append(note);
          }
          return li;
        })
      );
      if (!shown.length) {
        const li = document.createElement('li');
        li.className = 'dg-suggest-empty';
        li.textContent = q ? 'Niemand Passendes frei.' : 'Gerade ist niemand frei.';
        list.append(li);
      }
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      setActive(-1);
    }

    function pick(i) {
      const p = shown[i];
      if (!p) return;
      input.value = p.name;
      close();
      input.focus();
    }

    async function open() {
      await load();
      if (document.activeElement === input) render();
    }

    input.addEventListener('focus', open);
    input.addEventListener('click', () => { if (list.hidden) open(); });
    input.addEventListener('input', render);
    input.addEventListener('blur', () => setTimeout(close, 120)); // Klick in die Liste zählt noch
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) return void open();
        const n = shown.length;
        if (n) setActive(e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n);
      } else if (e.key === 'Enter' && !list.hidden && active >= 0) {
        e.preventDefault(); // erst übernehmen, ein zweites Enter lädt ein
        pick(active);
      } else if (e.key === 'Escape' && !list.hidden) {
        e.preventDefault();
        close();
      }
    });
    list.addEventListener('mousedown', (e) => e.preventDefault()); // Fokus bleibt im Feld
    list.addEventListener('click', (e) => {
      const li = e.target.closest('li[role="option"]');
      if (li) pick([...list.children].indexOf(li));
    });
  }

  // ---------- Karte groß ansehen (Plätze und Kartenauswahl) ----------
  const zoom = document.querySelector('[data-zoom-modal]');
  if (zoom) {
    const tilt = zoom.querySelector('[data-zoom-tilt]');
    if (window.tcgBindTilt) window.tcgBindTilt(tilt);
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-dg-zoom]');
      if (!btn) return;
      e.preventDefault(); // in der Kartenauswahl: vergrößern, nicht auswählen
      const d = btn.dataset;
      tilt.className = 'tcg-zoom r-' + d.rarity;
      const img = zoom.querySelector('[data-zoom-img]');
      img.src = d.image;
      img.alt = d.name + ' (' + d.rarityLabel + ')';
      zoom.querySelector('[data-zoom-name]').textContent = d.name;
      const badge = zoom.querySelector('[data-zoom-rarity]');
      badge.textContent = d.rarityLabel;
      badge.className = 'tcg-badge r-' + d.rarity;
      zoom.querySelector('[data-zoom-meta]').textContent = d.meta || '';
      if (typeof zoom.showModal === 'function') zoom.showModal();
      else zoom.setAttribute('open', '');
    });
    const close = () => (typeof zoom.close === 'function' ? zoom.close() : zoom.removeAttribute('open'));
    zoom.querySelector('[data-zoom-close]').addEventListener('click', close);
    zoom.addEventListener('click', (e) => {
      if (e.target === zoom) close();
    });
  }

  // ---------- Dieselbe Karte als Charakter und Boost nur mit zwei freien Exemplaren ----------
  page.querySelectorAll('form').forEach((form) => {
    const boostInputs = [...form.querySelectorAll('input[name="boost"]')];
    if (!boostInputs.length) return;
    const sync = () => {
      const main = form.querySelector('input[name="card"]:checked');
      boostInputs.forEach((inp) => {
        const item = inp.closest('[data-dg-item]');
        if (!item) return;
        const blocked = !!main && inp.value === main.value && Number(item.dataset.count) < 2;
        inp.disabled = blocked;
        item.classList.toggle('is-blocked', blocked);
        item.title = blocked ? 'Schon als Charakter gewählt – als Boost brauchst du ein zweites Exemplar' : '';
        if (blocked && inp.checked) {
          inp.checked = false;
          const none = form.querySelector('input[name="boost"][value=""]');
          if (none) none.checked = true;
        }
      });
    };
    form.addEventListener('change', (e) => {
      if (e.target.name === 'card') sync();
    });
    sync();
  });

  // ---------- Kartenauswahl in der Lobby (#111): Fenster neben dem eigenen Platz, Klick übernimmt sofort ----------
  const cardsForm = page.querySelector('[data-dg-cards-form]');
  if (cardsForm) {
    const pickers = [...cardsForm.querySelectorAll('[data-dg-picker]')];
    const close = (dlg) => (typeof dlg.close === 'function' ? dlg.close() : dlg.removeAttribute('open'));
    // Breite Fenster: neben (sonst unter/über) dem angeklickten Platz; schmale: als Blatt von unten (CSS)
    function place(dlg, trigger) {
      dlg.style.left = dlg.style.top = '';
      dlg.classList.remove('is-anchored');
      if (window.innerWidth < 720 || !trigger) return;
      const r = trigger.getBoundingClientRect();
      const w = dlg.offsetWidth;
      const h = dlg.offsetHeight;
      const gap = 14;
      let left = r.right + gap;
      if (left + w > window.innerWidth - 8) left = r.left - gap - w; // rechts kein Platz: links daneben
      if (left < 8) left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
      const top = Math.min(Math.max(8, r.top + r.height / 2 - h / 2), window.innerHeight - h - 8);
      dlg.style.left = left + 'px';
      dlg.style.top = Math.max(8, top) + 'px';
      dlg.classList.add('is-anchored');
    }
    page.querySelectorAll('[data-dg-open]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const dlg = cardsForm.querySelector('[data-dg-picker="' + btn.dataset.dgOpen + '"]');
        if (!dlg) return;
        if (typeof dlg.showModal === 'function') dlg.showModal();
        else dlg.setAttribute('open', '');
        place(dlg, btn.closest('.dg-slot-card, .dg-boost') || btn);
        const search = dlg.querySelector('[data-dg-search]');
        if (search && window.innerWidth >= 720) search.focus();
      })
    );
    pickers.forEach((dlg) => {
      dlg.querySelector('[data-dg-picker-close]').addEventListener('click', () => close(dlg));
      dlg.addEventListener('click', (e) => {
        if (e.target === dlg) close(dlg); // Klick daneben schließt
      });
    });
    window.addEventListener('resize', () => pickers.forEach((dlg) => dlg.open && dlg.classList.contains('is-anchored') && close(dlg)));
    // Auswahl sofort speichern, danach neu laden (Scroll-Position bleibt). Fehler stehen im Fenster selbst.
    let saving = false;
    const showError = (dlg, text) => {
      let el = dlg.querySelector('[data-dg-picker-error]');
      if (!el) {
        el = document.createElement('p');
        el.className = 'dg-picker-error';
        el.setAttribute('data-dg-picker-error', '');
        el.setAttribute('role', 'alert');
        dlg.querySelector('.dg-picker-head').after(el);
      }
      el.textContent = text;
    };
    cardsForm.addEventListener('change', async (e) => {
      if (saving || (e.target.name !== 'card' && e.target.name !== 'boost')) return;
      const dlg = e.target.closest('[data-dg-picker]');
      saving = true;
      dlg.classList.add('is-saving');
      try {
        const r = await fetch(cardsForm.action, {
          method: 'POST',
          body: new URLSearchParams(new FormData(cardsForm)),
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok) return location.reload();
        showError(dlg, data.error || 'Das hat nicht geklappt. Bitte lade die Seite neu.');
        cardsForm.reset(); // Auswahl wieder wie gespeichert
      } catch {
        showError(dlg, 'Keine Verbindung. Bitte versuche es erneut.');
        cardsForm.reset();
      }
      saving = false;
      dlg.classList.remove('is-saving');
    });
  }

  // ---------- Kartenauswahl: Suche, Seltenheit, Seiten zu je 12 Karten ----------
  const PER_PAGE = 12;
  page.querySelectorAll('[data-dg-picklist]').forEach((box) => {
    const items = [...box.querySelectorAll('[data-dg-item]')];
    const search = box.querySelector('[data-dg-search]');
    const chips = [...box.querySelectorAll('[data-dg-rar]')];
    let rarity = '';
    const prev = box.querySelector('[data-dg-prev]');
    const next = box.querySelector('[data-dg-next]');
    const info = box.querySelector('[data-dg-pageinfo]');
    const empty = box.querySelector('[data-dg-empty]');
    let pageNo = 0;
    const matches = () => {
      const q = search ? search.value.trim().toLowerCase() : '';
      const r = rarity;
      return items.filter((it) => (!r || it.dataset.rarity === r) && (!q || it.dataset.name.includes(q)));
    };
    function render() {
      const list = matches();
      const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
      pageNo = Math.min(Math.max(0, pageNo), pages - 1);
      const from = pageNo * PER_PAGE;
      const visible = new Set(list.slice(from, from + PER_PAGE));
      items.forEach((it) => {
        it.hidden = !visible.has(it);
      });
      prev.hidden = next.hidden = pages <= 1;
      prev.disabled = pageNo === 0;
      next.disabled = pageNo >= pages - 1;
      info.textContent = pages > 1 ? 'Seite ' + (pageNo + 1) + ' von ' + pages : '';
      empty.hidden = list.length > 0;
    }
    // Anfangs die Seite mit der schon gewählten Karte zeigen
    const checked = items.findIndex((it) => it.querySelector('input:checked'));
    if (checked > 0) pageNo = Math.floor(checked / PER_PAGE);
    if (search) search.addEventListener('input', () => { pageNo = 0; render(); });
    chips.forEach((chip) =>
      chip.addEventListener('click', () => {
        rarity = chip.dataset.dgRar;
        chips.forEach((c) => {
          c.classList.toggle('active', c === chip);
          c.setAttribute('aria-selected', c === chip ? 'true' : 'false');
        });
        pageNo = 0;
        render();
      })
    );
    prev.addEventListener('click', () => { pageNo--; render(); });
    next.addEventListener('click', () => { pageNo++; render(); });
    render();
  });

  // ---------- Beute-Fenster: Spieler für Spieler aufdecken ----------
  const lootDlg = document.querySelector('[data-dg-loot]');
  if (lootDlg && typeof lootDlg.showModal === 'function') {
    lootDlg.showModal();
    const rows = [...lootDlg.querySelectorAll('[data-dg-loot-row]')];
    rows.forEach((row, i) => setTimeout(() => row.classList.add('is-shown'), 400 + i * 450));
    lootDlg.querySelector('[data-dg-loot-close]').addEventListener('click', () => lootDlg.close());
    // erst beim Schließen (Weiter oder Esc) als gesehen merken – Neuladen zeigt es sonst erneut
    lootDlg.addEventListener('close', () => {
      const body = new URLSearchParams(new FormData(lootDlg.querySelector('[data-dg-loot-form]')));
      fetch('/dungeon/beute-gesehen', { method: 'POST', body, credentials: 'same-origin' }).catch(() => {});
    });
  }

  // ---------- Wiedergabe der Kämpfe ----------
  // Ablauf: Einleitung, dann je Kampf seine Dauer (gewonnene enden beim Sieg) und eine Pause mit Countdown.
  const dataEl = document.getElementById('dg-playback');
  if (!dataEl) return;
  const pb = JSON.parse(dataEl.textContent);
  pb.fights.forEach((f) => {
    f.seconds = f.seconds || pb.fightSeconds;
  });
  const pbOffset = Date.now() - pb.now;
  const elapsed = () => (Date.now() - pbOffset - pb.startedAt) / 1000;
  const starts = [];
  pb.fights.reduce((t, f) => {
    starts.push(t);
    return t + f.seconds + pb.pause;
  }, pb.intro);
  const total = (pb.endsAt - pb.startedAt) / 1000;

  const titleEl = page.querySelector('[data-dg-fight-title]');
  const textEl = page.querySelector('[data-dg-fight-text]');
  const barsEl = page.querySelector('[data-dg-bars]');
  const hpBar = page.querySelector('[data-dg-hp-bar]');
  const hpLabel = page.querySelector('[data-dg-hp-label]');
  const timeBar = page.querySelector('[data-dg-time-bar]');
  const timeLabel = page.querySelector('[data-dg-time-label]');
  const nextEl = page.querySelector('[data-dg-next]');
  const logList = page.querySelector('[data-dg-log-list]');
  const slotEls = [...page.querySelectorAll('[data-dg-slot]')];
  const names = pb.names || [];

  // Fortschritt je Kampf: wie viele Ticks schon gezeigt wurden, ob Beginn/Ende schon gemeldet sind
  const shown = pb.fights.map(() => ({ ticks: 0, started: false, ended: false, team: new Set() }));
  let first = true; // beim ersten Durchlauf (Seite mitten im Kampf geöffnet) keine Effekte nachholen

  function log(text, cls) {
    if (!logList) return;
    const li = document.createElement('li');
    if (cls) li.className = cls;
    li.textContent = text;
    logList.prepend(li);
  }

  function pop(m, text, cls) {
    if (first) return;
    const el = slotEls[m] && slotEls[m].querySelector('[data-dg-pops]');
    if (!el) return;
    const s = document.createElement('span');
    s.className = 'dg-pop' + (cls ? ' ' + cls : '');
    s.textContent = text;
    el.append(s);
    setTimeout(() => s.remove(), 1400);
    return s;
  }

  // ---------- Kartenwerte live (nur Rahmen-Karten): jeder Kampf beginnt mit den Grundwerten ----------
  const cardInfo = pb.cards || [];
  const curStats = cardInfo.map((c) => (c ? c.stats : null));
  cardInfo.forEach((c) => c && Object.values(c.imgs).forEach((u) => { new Image().src = u; })); // vorladen
  const STAT_LABELS = ['Speed', 'FIA', 'FIS', 'BWL'];
  const flash = (el, cls) => {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  };
  // quiet: ohne Anzeige der Änderung (Rücksetzen zu Kampfbeginn)
  function setCard(m, st, url, quiet) {
    const btn = slotEls[m] && slotEls[m].querySelector('.dg-slot-zoom');
    const img = btn && btn.querySelector('img');
    const prev = curStats[m];
    curStats[m] = st;
    if (img && url && img.getAttribute('src') !== url) {
      img.src = url;
      btn.dataset.image = url; // Großansicht zeigt dieselben Werte
    }
    if (quiet || first || !prev || !btn) return;
    // Jede geänderte Eigenschaft steigt auf: grün ▲ (Buff), rot ▼ (Debuff) – auch bei alten Karten
    let n = 0;
    st.forEach((v, k) => {
      if (v === prev[k]) return;
      const el = pop(m, STAT_LABELS[k] + (v > prev[k] ? ' ▲ ' : ' ▼ ') + v, v > prev[k] ? 'is-stat-up' : 'is-stat-down');
      if (el) el.style.marginTop = n++ * 34 - 40 + 'px'; // mehrere Werte untereinander
    });
    if (st.some((v, k) => v > prev[k])) flash(btn, 'fx-stat-up');
    if (st.some((v, k) => v < prev[k])) flash(btn, 'fx-stat-down');
  }
  const showStats = (m, st) => cardInfo[m] && st && setCard(m, st, cardInfo[m].imgs[st.join(',')]);
  const resetStats = () => cardInfo.forEach((c, m) => c && setCard(m, c.stats, c.base, true));

  function cast(m) {
    pop(m, '★', 'is-ability');
    if (first || !slotEls[m]) return;
    slotEls[m].classList.add('is-casting');
    setTimeout(() => slotEls[m].classList.remove('is-casting'), 900);
  }

  // Turm: nur die aktuelle Runde (die Gesamtzahl bleibt geheim)
  const roundEl = page.querySelector('[data-dg-round]');
  function step(active, after) {
    if (roundEl) {
      const i = active >= 0 ? active : Math.max(0, after);
      const f = pb.fights[i];
      const ended = active < 0 && after >= 0;
      roundEl.textContent = 'Runde ' + (i + 1);
      roundEl.classList.toggle('is-active', !ended);
      roundEl.classList.toggle('is-win', ended && !!f && f.success);
      roundEl.classList.toggle('is-loss', ended && !!f && !f.success);
    }
    page.querySelectorAll('[data-dg-step]').forEach((li) => {
      const i = Number(li.dataset.dgStep);
      const f = pb.fights[i];
      li.classList.toggle('is-active', i === active);
      li.classList.toggle('is-win', !!f && shown[i].ended && f.success);
      li.classList.toggle('is-loss', !!f && shown[i].ended && !f.success);
    });
  }

  const secs = (x) => Math.max(0, Math.ceil(x)) + ' s';

  // Fortschritt füllt sich bis zum Ziel; die Deadline läuft ab
  function setBars(f, done, game) {
    const have = Math.min(done, f.required);
    const left = f.required - have;
    hpBar.style.width = (have / f.required) * 100 + '%';
    hpLabel.textContent = left ? have + ' / ' + f.required : 'Geschafft!';
    const timeLeft = Math.max(0, f.limit - game) / f.limit;
    timeBar.style.width = timeLeft * 100 + '%';
    timeBar.classList.toggle('is-low', timeLeft < 0.25);
    timeLabel.textContent = left ? secs(timeLeft * pb.fightSeconds) : '–';
  }

  function frame() {
    const t = elapsed();
    let active = -1; // Kampf, der gerade läuft
    let after = -1; // zuletzt beendeter Kampf (in der Pause danach)
    pb.fights.forEach((f, i) => {
      const s = shown[i];
      const t0 = starts[i];
      if (t < t0) return;
      if (!s.started) {
        s.started = true;
        log((pb.tower ? 'Runde ' + f.round + ': ' : f.boss ? 'Boss: ' : 'Kampf: ') + f.title, 'is-head');
        resetStats();
      }
      const end = f.success ? f.doneAt : f.limit;
      const g0 = f.start || 0;
      const game = g0 + Math.min(1, (t - t0) / f.seconds) * (end - g0);
      while (s.ticks < f.ticks.length && f.ticks[s.ticks].t <= game) {
        const x = f.ticks[s.ticks++];
        if (x.st) showStats(x.m, x.st);
        if (x.ability) {
          f.abilities.filter((a) => a.m === x.m).forEach((a) => {
            if (!a.team) log(names[a.m] + ': ' + a.label + ' – ' + a.text, 'is-ability');
            else if (!s.team.has(a.from + a.label)) {
              s.team.add(a.from + a.label);
              log('Ganze Gruppe: ' + a.label + ' – ' + a.text + ' (Boost von ' + names[a.from] + ')', 'is-ability');
              cast(a.from);
            }
          });
          cast(x.m);
        } else if (x.destroy) {
          pop(x.m, 'Zerstört!', 'is-crit');
        } else {
          pop(x.m, '+' + x.p, x.crit ? 'is-crit' : '');
        }
      }
      const done = f.ticks.slice(0, s.ticks).reduce((sum, x) => sum + (x.p || 0), 0);
      if (t < t0 + f.seconds) {
        active = i;
        titleEl.textContent = f.title;
        textEl.textContent = f.text;
        setBars(f, done, game);
      } else {
        after = i;
        if (!s.ended) {
          s.ended = true;
          setBars(f, done, game);
          log(f.success ? f.successText : f.failText, f.success ? 'is-win' : 'is-loss');
        }
      }
    });

    barsEl.hidden = active < 0 && after < 0;
    nextEl.hidden = active >= 0;
    if (active < 0) {
      if (after < 0) {
        nextEl.textContent = (pb.tower ? 'Runde 1 beginnt in ' : 'Der erste Kampf beginnt in ') + secs(pb.intro - t);
      } else {
        const f = pb.fights[after];
        const last = after === pb.fights.length - 1;
        titleEl.textContent = f.success ? f.title + ': besiegt!' : f.title + ': Zeit abgelaufen – Rückzug!';
        textEl.textContent = f.success ? f.successText : f.failText;
        if (!last) nextEl.textContent = (pb.tower ? 'Runde ' + (after + 2) + ' beginnt in ' : 'Nächster Kampf in ') + secs(starts[after + 1] - t);
        else if (t < total) nextEl.textContent = 'Beute wird verteilt in ' + secs(total - t);
        else nextEl.textContent = 'Beute wird verteilt …';
      }
    }
    // Zeit um: jede Sekunde nachfragen, damit das Ergebnis ohne Wartezeit erscheint
    if (t >= total && Math.floor(t * 4) % 4 === 0) poll();
    step(active, after);
    first = false;
  }
  frame();
  setInterval(frame, 250);
})();

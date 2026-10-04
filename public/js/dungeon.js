// Dungeon-Seite: Countdown bis zum Start, Gruppen-Chat (Abfrage alle paar Sekunden) und Wiedergabe der Kämpfe.
// Ändert sich die Gruppe (Beitritt, Einladung, Start, Ende), lädt die Seite neu – der Chat-Entwurf bleibt erhalten.
(function () {
  const page = document.querySelector('[data-dg-page]');
  if (!page) return;

  const serverOffset = Date.now() - Number(page.dataset.now || Date.now()); // Uhr des Browsers minus Server-Uhr
  const serverNow = () => Date.now() - serverOffset;
  const start = new Date(page.dataset.start).getTime();
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

  // ---------- Kartenauswahl: Suche, Seltenheit, Seiten zu je 20 Karten ----------
  const PER_PAGE = 20;
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

  function step(active) {
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
        log((f.boss ? 'Boss: ' : 'Kampf: ') + f.title, 'is-head');
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
        nextEl.textContent = 'Der erste Kampf beginnt in ' + secs(pb.intro - t);
      } else {
        const f = pb.fights[after];
        const last = after === pb.fights.length - 1;
        titleEl.textContent = f.success ? f.title + ': besiegt!' : f.title + ': Zeit abgelaufen – Rückzug!';
        textEl.textContent = f.success ? f.successText : f.failText;
        if (!last) nextEl.textContent = 'Nächster Kampf in ' + secs(starts[after + 1] - t);
        else if (t < total) nextEl.textContent = 'Beute wird verteilt in ' + secs(total - t);
        else nextEl.textContent = 'Beute wird verteilt …';
      }
    }
    // Zeit um: jede Sekunde nachfragen, damit das Ergebnis ohne Wartezeit erscheint
    if (t >= total && Math.floor(t * 4) % 4 === 0) poll();
    step(active);
    first = false;
  }
  frame();
  setInterval(frame, 250);
})();

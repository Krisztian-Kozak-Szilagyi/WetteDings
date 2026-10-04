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

  // ---------- Wiedergabe der Kämpfe ----------
  // Ablauf: Einleitung, dann je Kampf seine Dauer (gewonnene enden beim Sieg) und eine Pause mit Countdown.
  const dataEl = document.getElementById('dg-playback');
  if (!dataEl) return;
  const pb = JSON.parse(dataEl.textContent);
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
  }

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

  function setBars(f, done, game) {
    const left = Math.max(0, f.required - done);
    hpBar.style.width = (left / f.required) * 100 + '%';
    hpLabel.textContent = left ? left + ' / ' + f.required : 'Besiegt!';
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
      }
      const end = f.success ? f.doneAt : f.limit;
      const game = Math.min(1, (t - t0) / f.seconds) * end;
      while (s.ticks < f.ticks.length && f.ticks[s.ticks].t <= game) {
        const x = f.ticks[s.ticks++];
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
    step(active);
    first = false;
  }
  frame();
  setInterval(frame, 250);
})();

// Live-Turm (eSports): Zustand vom Server (data-state, dann jede Sekunde GET /dungeon/live/stand) anzeigen,
// den laufenden Kampf abspielen und Aktionen in der Pause senden (POST /dungeon/live/<aktion>).
// Der Server entscheidet alles – die Seite rechnet nur die Anzeige (Zeit, Punkte bis jetzt, Bock).
(() => {
  const root = document.querySelector('[data-live-root]');
  if (!root) return;
  const $ = (sel) => root.querySelector(`[data-live-${sel}]`);
  const csrf = (root.querySelector('[data-live-csrf] input[name="_csrf"]') || {}).value || '';

  let state = JSON.parse(root.dataset.state || '{}');
  let offset = state.now - Date.now(); // Server-Uhr minus eigene Uhr
  let busy = false;
  let lastFightKey = null;
  let switchOpen = false;

  const STAT = { fia: 'FIA', fis: 'FIS', bwl: 'BWL' };
  const NAMES = { boost: 'Boost · alle', einzel: 'Boost · eine Karte', wechsel: 'Kartenwechsel', verl: 'Verlängerung' };
  const TIPS = {
    boost: 'Alle Hauptkarten +20 %. Die 40 Sekunden starten mit dem nächsten Kampf und laufen in der Pause danach weiter – wer dort lange überlegt, verschenkt den Rest.',
    einzel: 'Nur eine Hauptkarte +20 %, 40 Sekunden ab dem nächsten Kampf. Schließt den Boost für alle aus.',
    wechsel: 'Du tauschst deine Hauptkarte. Hast du keinen Bock mehr, startet die neue Karte mit 50 %.',
    verl: 'Der nächste Kampf dauert einige Sekunden länger.',
  };
  const fmt = (n) => Math.round(n || 0).toLocaleString('de-DE');
  const pctText = (v) => `${String(Math.round(v * 10) / 10).replace('.', ',')} %`;
  const clock = (sec) => {
    const s = Math.max(0, Math.ceil(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const serverNow = () => Date.now() + offset;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };
  const bockColor = (v) => (v <= 0 ? 'is-zero' : v > 50 ? 'is-ok' : v > 25 ? 'is-low' : 'is-crit');
  const bockHint = (v) => (v <= 0 ? 'Karte pausiert – in der Pause retten' : v > 50 ? 'alles gut' : v > 25 ? 'wird knapp' : 'kritisch');

  // ---------- Kampf-Zeitpunkt ----------
  /** Wie weit ist der Kampf (echte Sekunden seit Beginn, gedeckelt)? */
  function fightElapsed() {
    const f = state.fight;
    if (!f) return 0;
    return Math.max(0, Math.min(f.seconds, (serverNow() - f.startAt) / 1000));
  }
  const toReal = (f, t) => (t * f.fightSeconds) / f.workTime;

  /** Bock je Spieler zum Zeitpunkt sec im Kampf */
  function bockAt(f, sec) {
    const out = (f.bockBefore && f.bockBefore.length ? f.bockBefore : state.players.map((p) => p.bock)).slice();
    (f.drains || []).forEach((d) => {
      if (toReal(f, d.t) <= sec + 1e-6) out[d.m] = d.bock;
    });
    return out;
  }

  // ---------- Anzeige ----------
  function renderBar() {
    $('floor').textContent = state.phase === 'start' ? '1' : String(state.phase === 'pause' ? state.n + 1 : Math.max(1, state.n));
    const pips = $('pips');
    pips.textContent = '';
    for (let i = 1; i <= state.energyMax; i++) {
      const p = el('span', 'lt-pip');
      if (i <= state.energy) p.classList.add('is-on');
      else if (i <= state.energyStart) p.classList.add('is-pending');
      pips.appendChild(p);
    }
    $('energy-text').textContent = `${state.energy} / ${state.energyMax}`;
    const drink = $('drink');
    drink.textContent = '';
    drink.appendChild(el('span', 'lt-drink-dot'));
    drink.appendChild(document.createTextNode(state.drink.used ? `BfW Energy getrunken${state.drink.byName ? ` (${state.drink.byName})` : ''}` : state.drink.available ? 'BfW Energy: noch da' : 'kein BfW Energy dabei'));
  }

  function renderBoost() {
    const me = state.players[state.me];
    const since = (serverNow() - state.now) / 1000;
    const left = me ? Math.max(0, me.boostLeft - since) : 0;
    const box = $('boost');
    box.hidden = left <= 0;
    if (left > 0) {
      $('boost-text').textContent = ` noch ${Math.ceil(left)} s · läuft in der Pause weiter`;
      $('boost-ring').setAttribute('stroke-dashoffset', String(100.5 * (1 - Math.min(1, left / state.boostSeconds))));
    }
    const note = $('boost-left');
    if (note) note.textContent = left > 0 ? `Boost läuft weiter: noch ${Math.ceil(left)} s` : '';
  }

  function renderBoss() {
    const f = state.fight;
    const box = $('boss');
    box.hidden = !f || state.phase === 'ende' || state.phase === 'pause';
    if (!f) return;
    $('stat').textContent = STAT[f.stat] || '';
    $('stat').className = `lt-stat is-${f.stat}`;
    const trait = $('trait');
    trait.hidden = !f.trait;
    if (f.trait) {
      trait.textContent = `${f.trait.label}: ${f.trait.text}`;
      trait.title = f.trait.text;
    }
    $('title').textContent = `Stockwerk ${f.n} · ${f.title || ''}`;
    $('text').textContent = f.text || '';
    $('required').textContent = fmt(f.required);
    const sec = state.phase === 'kampf' ? fightElapsed() : f.seconds;
    let pts = 0;
    for (const t of f.ticks) if (toReal(f, t.t) <= sec + 1e-6) pts += t.p;
    if (state.phase !== 'kampf') pts = f.total;
    pts = Math.min(pts, f.required);
    $('points').textContent = fmt(pts);
    $('points-bar').style.width = `${Math.min(100, (pts / f.required) * 100)}%`;
    const limitReal = toReal(f, f.limit);
    $('time').textContent = clock(Math.max(0, limitReal - sec));
    $('time-bar').style.width = `${Math.max(0, Math.min(100, ((limitReal - sec) / limitReal) * 100))}%`;
    $('deadline-note').textContent = sec * 2 > limitReal ? 'Halbzeit vorbei' : '';
    const out = $('outcome');
    const done = state.phase !== 'kampf' || sec >= f.seconds - 0.05;
    out.hidden = !done;
    if (done) {
      out.textContent = f.success ? f.successText || 'Geschafft!' : f.failText || 'Gescheitert.';
      out.className = `lt-outcome ${f.success ? 'is-win' : 'is-lose'}`;
    }
  }

  function renderPlayers() {
    const box = $('players');
    box.textContent = '';
    box.hidden = state.phase === 'pause';
    if (box.hidden) return;
    const f = state.fight;
    const sec = state.phase === 'kampf' ? fightElapsed() : Infinity;
    const bock = f && state.phase === 'kampf' ? bockAt(f, sec) : state.players.map((p) => p.bock);
    const hitNow = new Set(f && state.phase === 'kampf' ? (f.drains || []).filter((d) => toReal(f, d.t) <= sec && sec - toReal(f, d.t) < 3).map((d) => d.m) : []);
    state.players.forEach((p, i) => {
      const card = el('article', `lt-player${p.me ? ' is-me' : ''}${hitNow.has(i) ? ' is-hit' : ''}`);
      const top = el('div', 'lt-player-top');
      const img = el('div', `lt-card r-${p.card ? p.card.rarity : 'none'}`);
      if (p.card) {
        const im = el('img');
        im.src = p.card.image;
        im.alt = p.card.name;
        im.width = 720;
        im.height = 1008;
        im.loading = 'lazy';
        img.appendChild(im);
      }
      top.appendChild(img);
      const info = el('div', 'lt-player-info');
      info.appendChild(el('strong', 'lt-player-name', p.name));
      if (f && p.card && p.card.stats) {
        let mine = 0;
        for (const t of f.ticks) if (t.m === i && toReal(f, t.t) <= sec + 1e-6) mine += t.p;
        info.appendChild(el('span', 'muted small', `${STAT[f.stat]} ${p.card.stats[f.stat]} · Beitrag ${fmt(mine)}`));
      }
      if (hitNow.has(i)) info.appendChild(el('span', 'lt-hit', `−${pctText(f.drains.find((d) => d.m === i).amount)} Bock`));
      const boost = el('div', 'lt-boostcard');
      const mini = el('span', `lt-mini r-${p.boost ? p.boost.rarity : 'none'}`);
      if (p.boost) {
        const im = el('img');
        im.src = p.boost.image;
        im.alt = '';
        im.width = 720;
        im.height = 1008;
        im.loading = 'lazy';
        mini.appendChild(im);
      }
      boost.appendChild(mini);
      const bt = el('span', 'lt-boostcard-text');
      bt.appendChild(el('span', 'muted small', 'Boost'));
      bt.appendChild(el('span', '', p.boost ? p.boost.name : 'kein Boost'));
      boost.appendChild(bt);
      info.appendChild(boost);
      top.appendChild(info);
      card.appendChild(top);

      const b = bock[i];
      const meter = el('div', 'lt-bock');
      const head = el('div', 'lt-bock-head');
      head.appendChild(el('span', 'lt-label', 'Bock'));
      head.appendChild(el('strong', `lt-bock-value ${bockColor(b)}`, b <= 0 ? 'Kein Bock' : pctText(b)));
      meter.appendChild(head);
      const track = el('div', 'lt-track');
      const fill = el('span', `lt-fill ${bockColor(b)}`);
      fill.style.width = `${Math.max(0, Math.min(100, b))}%`;
      track.appendChild(fill);
      meter.appendChild(track);
      meter.appendChild(el('span', 'muted small', bockHint(b)));
      card.appendChild(meter);
      if (b <= 0) card.classList.add('is-out');
      box.appendChild(card);
    });
  }

  function renderLog() {
    const f = state.fight;
    const box = $('log-box');
    box.hidden = !f || state.phase === 'ende' || state.phase === 'pause';
    if (!f) return;
    const sec = state.phase === 'kampf' ? fightElapsed() : Infinity;
    const items = [];
    (f.drains || []).forEach((d) => items.push({ t: toReal(f, d.t), text: `${d.t > 0 ? 'Halbzeit' : 'Kampfbeginn'} – ${state.players[d.m].name} verliert ${pctText(d.amount)} Bock`, cls: 'is-bad' }));
    f.ticks.filter((t) => t.crit).forEach((t) => items.push({ t: toReal(f, t.t), text: `Krit! ${state.players[t.m].card ? state.players[t.m].card.name : ''} +${fmt(t.p)}`, cls: '' }));
    const list = $('log');
    list.textContent = '';
    items
      .filter((x) => x.t <= sec)
      .sort((a, b) => b.t - a.t)
      .slice(0, 6)
      .forEach((x) => {
        const li = el('li', x.cls);
        li.appendChild(el('span', 'lt-log-time', clock(x.t)));
        li.appendChild(el('span', '', x.text));
        list.appendChild(li);
      });
  }

  /** Kosten einer Fähigkeit, wenn sie jetzt dazukäme (oder schon gewählt ist) */
  function costOf(key, chosen) {
    const i = chosen.findIndex((c) => c.key === key);
    const extra = (i >= 0 ? i : chosen.length) > 0 ? state.overload : 0;
    return state.costs[key] + extra;
  }

  const DESC = {
    boost: () => `+20 % für alle Hauptkarten, ${state.boostSeconds} s ab Kampfbeginn`,
    einzel: () => `+20 % für eine Hauptkarte, ${state.boostSeconds} s`,
    wechsel: () => 'Deine Hauptkarte tauschen – ohne Bock startet die neue mit 50 %',
    verl: () => `+${state.extSeconds} s für den nächsten Boss`,
  };

  /** Tooltip-Blase (zeigt sich beim Darüberfahren oder Fokus, nur CSS) */
  const tip = (key) => el('span', 'lt-tip', TIPS[key]);

  /** Kachel einer Fähigkeit wie im Design: ganze Kachel klickbar, Name + Kosten, Beschreibung, Status */
  function abilityTile(key) {
    const chosen = state.chosen;
    const pick = chosen.find((c) => c.key === key && (key !== 'wechsel' || c.by === state.me));
    const anyPick = chosen.filter((c) => c.key === key);
    const rival = key === 'boost' ? 'einzel' : key === 'einzel' ? 'boost' : null;
    const rest = rival ? chosen.filter((c) => c.key !== rival) : chosen;
    const extra = (pick ? chosen.indexOf(pick) : rest.length) > 0;
    const cost = state.costs[key] + (extra ? state.overload : 0);
    const refund = rival && chosen.some((c) => c.key === rival) ? costOf(rival, chosen) : 0;
    const canPay = !!pick || state.energy + refund >= cost;
    const who = anyPick.map((c) => (c.by === state.me ? 'dir' : c.byName)).join(', ');
    let stateText;
    if (anyPick.length) stateText = `Gewählt von ${who}${key === 'einzel' ? ` · ${state.players[anyPick[0].target].name}` : ''}${key === 'wechsel' ? '' : ' – nochmal tippen zum Abwählen'}`;
    else if (!canPay) stateText = 'Zu wenig Energie';
    else if (extra) stateText = `Überladung: +${state.overload} Energie`;
    else stateText = key === 'einzel' ? 'Karte antippen' : key === 'wechsel' ? 'Antippen und Karte wählen' : 'Antippen zum Wählen';
    const mine = anyPick.some((c) => c.by === state.me);
    const cls = `lt-tile${anyPick.length ? ' is-on' : ''}${canPay ? '' : ' is-off'}`;
    const head = el('span', 'lt-tile-head');
    head.appendChild(el('span', 'lt-tile-name', NAMES[key]));
    head.appendChild(el('span', 'lt-tile-cost', extra ? `${cost} (+${state.overload})` : String(cost)));
    const status = el('span', `lt-tile-state${anyPick.length ? (mine ? ' is-mine' : ' is-other') : ''}`, stateText);

    if (key === 'einzel') {
      const tile = el('div', cls);
      tile.appendChild(head);
      const row = el('span', 'lt-targets');
      state.players.forEach((p, i) => {
        const on = !!(pick && pick.target === i);
        const b = el('button', `lt-target${on ? ' is-on' : ''}`, p.name);
        b.type = 'button';
        b.disabled = !canPay && !on;
        b.setAttribute('aria-pressed', String(on));
        b.addEventListener('click', () => send('waehlen', { key, target: i }));
        row.appendChild(b);
      });
      tile.appendChild(row);
      tile.appendChild(status);
      tile.appendChild(tip(key));
      return tile;
    }
    const tile = el('button', cls);
    tile.type = 'button';
    tile.disabled = !canPay || (key === 'wechsel' && !!pick);
    tile.setAttribute('aria-pressed', String(!!pick));
    tile.appendChild(head);
    tile.appendChild(el('span', 'lt-tile-desc', DESC[key]()));
    tile.appendChild(status);
    tile.appendChild(tip(key));
    tile.addEventListener('click', () => (key === 'wechsel' ? openSwitch() : send('waehlen', { key })));
    return tile;
  }

  function renderCountdown() {
    const left = (state.phaseEndsAt - serverNow()) / 1000;
    const box = $('countdown-box');
    $('countdown').textContent = clock(left);
    $('countdown-bar').style.width = `${Math.max(0, Math.min(100, (left / state.pauseSeconds) * 100))}%`;
    box.classList.toggle('is-low', left <= 15 && left > 5);
    box.classList.toggle('is-crit', left <= 5);
  }

  function renderPause() {
    const box = $('pause');
    box.hidden = state.phase !== 'pause';
    if (box.hidden) return;
    const f = state.fight;
    $('pause-title').textContent = f ? `Stockwerk ${f.n} geschafft` : '';
    $('pause-sub').textContent = `${f ? `${fmt(f.total)} Punkte · ` : ''}weiter geht's, sobald alle „Weiter“ drücken – spätestens nach ${state.pauseSeconds} s.`;
    renderCountdown();

    // nächster Boss
    const nx = $('next');
    nx.textContent = '';
    const n = state.next;
    if (n) {
      const l = el('div', 'lt-next-left');
      l.appendChild(el('span', 'lt-next-kicker', `Als Nächstes · Stockwerk ${n.n}`));
      const chips = el('div', 'lt-chips');
      chips.appendChild(el('span', `lt-stat is-big is-${n.stat || 'none'}`, n.hidden ? '?' : STAT[n.stat]));
      if (n.trait) chips.appendChild(el('span', 'lt-trait is-big', `${n.trait.label}: ${n.trait.text}`));
      if (n.hidden) chips.appendChild(el('span', 'lt-trait is-big', n.n === 1 ? 'Findet selbst heraus, was er will' : 'Nebel – diesmal keine Vorschau'));
      l.appendChild(chips);
      if (n.title) l.appendChild(el('span', 'muted small', n.title));
      nx.appendChild(l);
      if (n.required) {
        const r = el('div', 'lt-next-right');
        r.appendChild(el('span', 'lt-next-kicker', 'Ziel'));
        r.appendChild(el('strong', '', fmt(n.required)));
        nx.appendChild(r);
      }
    }

    // Fähigkeiten
    $('energy-after').textContent = String(state.energy);
    const pp = $('pause-pips');
    pp.textContent = '';
    for (let i = 1; i <= state.energyMax; i++) {
      const p = el('span', 'lt-pip is-big');
      if (i <= state.energy) p.classList.add('is-on');
      else if (i <= state.energyStart) p.classList.add('is-pending');
      pp.appendChild(p);
    }
    const ab = $('abilities');
    ab.textContent = '';
    ['boost', 'einzel', 'wechsel', 'verl'].forEach((k) => ab.appendChild(abilityTile(k)));

    // BfW Energy: Team-Energie oder Bock eines beliebigen Spielers
    const dp = $('drinks');
    dp.textContent = '';
    $('drink-panel').hidden = !state.drink.available;
    if (state.drink.available) {
      const opts = [{ mode: 'team', name: 'Team-Energie auffüllen', text: `${state.energy} → ${state.energyMax} Energie`, off: state.energy >= state.energyMax }].concat(
        state.players.map((p, i) => ({ mode: 'bock', target: i, name: `Bock für ${p.name}`, text: `${p.bock <= 0 ? '0 %' : pctText(p.bock)} → 100 %${p.bock <= 0 ? ', ohne Kartenwechsel' : ''}`, off: p.bock >= 100 }))
      );
      opts.forEach((o) => {
        const b = el('button', 'lt-drink-opt');
        b.type = 'button';
        b.disabled = o.off;
        b.appendChild(el('span', 'lt-drink-name', o.name));
        b.appendChild(el('span', 'lt-drink-text', o.text));
        b.addEventListener('click', () => send('energy', { mode: o.mode, target: o.target === undefined ? '' : o.target }));
        dp.appendChild(b);
      });
    }

    // Team: Bock und wer schon „Weiter“ gedrückt hat
    const team = $('team');
    team.textContent = '';
    team.appendChild(el('strong', 'lt-side-head', 'Team'));
    state.players.forEach((p) => {
      const row = el('div', 'lt-team-row');
      const top = el('div', 'lt-team-top');
      const nm = el('span', 'lt-team-name', p.name);
      if (p.card) nm.appendChild(el('span', 'lt-team-card', ` · ${p.card.name}`));
      top.appendChild(nm);
      top.appendChild(el('span', p.weiter ? 'lt-weiter-on' : 'lt-weiter-off', p.weiter ? '✓ Weiter' : 'überlegt …'));
      row.appendChild(top);
      const bar = el('div', 'lt-team-bar');
      const track = el('div', 'lt-track is-mid');
      const fill = el('span', `lt-fill ${bockColor(p.bock)}`);
      fill.style.width = `${Math.max(0, Math.min(100, p.bock))}%`;
      track.appendChild(fill);
      bar.appendChild(track);
      bar.appendChild(el('span', `lt-team-pct ${bockColor(p.bock)}`, p.bock <= 0 ? 'Kein Bock' : pctText(p.bock)));
      row.appendChild(bar);
      team.appendChild(row);
    });

    const me = state.players[state.me];
    const cf = $('coffee');
    cf.hidden = !(me && me.coffee);
    if (me && me.coffee) {
      const t = $('coffee-text');
      t.textContent = 'Dein Kaffee: ';
      t.appendChild(el('strong', '', `${me.coffee.name.replace('Casino-Kaffee', '').trim() || 'Kaffee'} +${me.coffee.pct} % Bock`));
      $('coffee-go').textContent = `Kaffee trinken (${me.bock <= 0 ? '0 %' : pctText(me.bock)} → ${pctText(Math.min(100, me.bock + me.coffee.pct))})`;
      $('coffee-go').disabled = me.bock >= 100;
    }
    const w = $('weiter');
    const waiting = state.players.filter((p) => !p.weiter && !p.me).map((p) => p.name);
    w.textContent = me && me.weiter ? `Warte auf ${waiting.join(', ') || 'die anderen'} … (zurücknehmen)` : 'Weiter';
    w.classList.toggle('is-pressed', !!(me && me.weiter));
  }

  function renderStart() {
    const box = $('start');
    box.hidden = state.phase !== 'start';
    if (!box.hidden) $('start-count').textContent = String(Math.max(0, Math.ceil((state.phaseEndsAt - serverNow()) / 1000)));
  }

  function renderResult() {
    const box = $('result');
    box.hidden = state.phase !== 'ende';
    if (box.hidden || !state.result) return;
    const last = state.fight;
    $('result-title').textContent = last && !last.success ? `Auf Stockwerk ${last.n} gescheitert` : 'Lauf beendet';
    $('result-rounds').textContent = String(state.result.rounds);
    $('result-points').textContent = fmt(state.result.points);
    const strip = $('strip');
    strip.textContent = '';
    const total = state.result.rounds + (last && !last.success ? 1 : 0);
    for (let i = 1; i <= total; i++) {
      const cell = el('div', 'lt-strip-cell');
      const fill = el('span', i <= state.result.rounds ? 'is-win' : 'is-lose');
      fill.style.width = i <= state.result.rounds ? '100%' : `${Math.round((last.total / last.required) * 100)}%`;
      const track = el('span', 'lt-strip-track');
      track.appendChild(fill);
      cell.appendChild(track);
      cell.appendChild(el('span', 'lt-strip-n', String(i)));
      strip.appendChild(cell);
    }
  }

  function render() {
    renderBar();
    renderBoost();
    renderStart();
    renderBoss();
    renderPlayers();
    renderLog();
    renderPause();
    renderResult();
  }

  // ---------- Kartenwechsel ----------
  async function openSwitch() {
    const box = $('switch');
    const sel = $('switch-select');
    sel.textContent = '';
    box.hidden = false;
    switchOpen = true;
    try {
      const r = await fetch('/dungeon/live/karten', { credentials: 'same-origin', cache: 'no-store' });
      const data = await r.json();
      const stat = state.next && state.next.stat;
      (data.cards || [])
        .sort((a, b) => (stat ? b.stats[stat] - a.stats[stat] : 0))
        .forEach((c) => {
          const o = el('option', '', `${c.name} (${c.rarity}) · FIA ${c.stats.fia} · FIS ${c.stats.fis} · BWL ${c.stats.bwl}`);
          o.value = c.id;
          sel.appendChild(o);
        });
      if (!sel.options.length) sel.appendChild(el('option', '', 'Keine freie Karte'));
    } catch {
      showError('Karten konnten nicht geladen werden.');
    }
  }
  $('switch-cancel').addEventListener('click', () => {
    $('switch').hidden = true;
    switchOpen = false;
  });
  $('switch-go').addEventListener('click', async () => {
    const id = $('switch-select').value;
    if (!id) return;
    await send('wechsel', { card: id });
    $('switch').hidden = true;
    switchOpen = false;
  });

  // ---------- Aktionen ----------
  function showError(msg) {
    const e = $('error');
    e.hidden = !msg;
    e.textContent = msg || '';
  }

  async function send(action, fields = {}) {
    if (busy) return;
    busy = true;
    showError('');
    try {
      const body = new URLSearchParams({ _csrf: csrf, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])) });
      const r = await fetch(`/dungeon/live/${action}`, { method: 'POST', body, credentials: 'same-origin' });
      const data = await r.json().catch(() => ({}));
      if (data.state) apply(data.state);
      else if (data.error) showError(data.error);
    } catch {
      showError('Keine Verbindung – bitte gleich noch einmal.');
    } finally {
      busy = false;
    }
  }
  $('weiter').addEventListener('click', () => send('weiter'));
  $('coffee-go').addEventListener('click', () => send('kaffee'));

  function apply(next) {
    const wasPhase = state.phase;
    state = next;
    offset = state.now - Date.now();
    if (wasPhase !== 'ende' && state.phase === 'ende') {
      // Ergebnis: einmal neu laden, damit „Eure Woche“ den neuen Lauf zeigt
      setTimeout(() => window.location.reload(), 1500);
    }
    const key = state.fight ? `${state.fight.n}:${state.fight.startAt}` : null;
    if (key !== lastFightKey) lastFightKey = key;
    if (state.phase !== 'pause' && switchOpen) {
      $('switch').hidden = true;
      switchOpen = false;
    }
    render();
  }

  async function poll() {
    if (document.hidden) return;
    try {
      const r = await fetch('/dungeon/live/stand', { credentials: 'same-origin', cache: 'no-store' });
      const data = await r.json();
      if (data.gone) return void window.location.assign('/dungeon');
      if (!busy) apply(data);
    } catch {
      /* nächster Versuch in einer Sekunde */
    }
  }

  render();
  setInterval(poll, 1000);
  // flüssige Anzeige (Zeit, Punkte, Countdown) zwischen den Abfragen
  setInterval(() => {
    if (document.hidden) return;
    renderBar();
    renderBoost();
    renderStart();
    renderBoss();
    if (state.phase === 'kampf') {
      renderPlayers();
      renderLog();
    }
    if (state.phase === 'pause') renderCountdown();
  }, 250);
})();

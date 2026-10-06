const test = require('node:test');
const assert = require('node:assert');
const s = require('../src/moderation/suspicionLogic');
const { LEVEL } = require('../src/device/deviceLogic');

const t0 = Date.UTC(2026, 9, 5, 10, 0, 0); // 12:00 deutsche Zeit
const series = (gapsSec, start = t0) => {
  const out = [start];
  for (const g of gapsSec) out.push(out[out.length - 1] + g * 1000);
  return out.map((ms) => new Date(ms));
};

test('Serien und Abstände', () => {
  assert.deepEqual(s.gaps([3000, 1000, 2000]), [1000, 1000]);
  assert.equal(s.bursts(series([1, 1, 120, 1])).length, 2);
  assert.equal(s.median([5, 1, 3]), 3);
  assert.equal(s.median([1, 2, 3, 4]), 2.5);
});

test('Takt: Metronom wird erkannt, Durchklicken von Hand nicht', () => {
  // Skript mit fester Pause: 3 s plus etwas Netz-Rauschen
  const bot = series([3.0, 3.02, 2.99, 3.01, 3.0, 2.98, 3.01, 3.0, 3.02, 2.99, 3.0, 3.01]);
  const hit = s.rhythmFinding(bot, 'oeffnen');
  assert.ok(hit);
  assert.equal(hit.count, 13);
  assert.equal(hit.level, LEVEL.moeglich);
  assert.match(hit.summary, /13 Pack-Öffnungen im Takt von 3 s/);
  // lang und noch gleichmäßiger: wahrscheinlich
  assert.equal(s.rhythmFinding(series(Array(24).fill(3)), 'oeffnen').level, LEVEL.wahrscheinlich);
  // echte Abstände aus dem Protokoll (17 Packs schnell von Hand geöffnet): ca. 9 % Streuung
  const human = series([10.026, 3.711, 3.266, 3.121, 2.936, 2.993, 3.268, 3.416, 3.09, 3.449, 3.954, 4.216, 6.654, 3.311, 3.007, 2.805]);
  assert.equal(s.rhythmFinding(human, 'oeffnen'), null);
  // gleichmäßig, aber langsam (alle 30 s): kein Hinweis
  assert.equal(s.rhythmFinding(series(Array(15).fill(30)), 'oeffnen'), null);
  // zu wenige Aktionen
  assert.equal(s.rhythmFinding(series(Array(s.RHYTHM_MIN - 2).fill(3)), 'oeffnen'), null);
});

test('Tempo: Folgen unter der menschlichen Untergrenze', () => {
  const fast = s.tempoFinding(series([0.3, 0.3, 0.3, 0.3, 0.3]), 'oeffnen');
  assert.ok(fast);
  assert.equal(fast.count, 6);
  assert.equal(fast.level, LEVEL.moeglich);
  assert.equal(s.tempoFinding(series(Array(12).fill(0.3)), 'oeffnen').level, LEVEL.wahrscheinlich);
  // Pack-Käufe im Abstand von 0,6 s (schnelles Klicken) bleiben unauffällig
  assert.equal(s.tempoFinding(series([0.72, 0.67, 0.66, 0.86, 0.6, 0.7]), 'kaufen'), null);
  // eine langsame Aktion unterbricht die Folge
  assert.equal(s.tempoFinding(series([0.3, 0.3, 5, 0.3, 0.3]), 'oeffnen'), null);
  // die längste Folge wird beschrieben, der Zeitraum reicht bis zur letzten (neue Belege öffnen erledigte Hinweise)
  const two = series([0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 9, 0.3, 0.3, 0.3, 0.3, 0.3]);
  const both = s.tempoFinding(two, 'oeffnen');
  assert.equal(both.count, 8);
  assert.equal(both.runs, 2);
  assert.equal(both.to.getTime(), two[two.length - 1].getTime());
  assert.match(both.summary, /2× in diesem Zeitraum/);
});

test('Takt: Zeitraum reicht bis zur letzten gleichmäßigen Serie', () => {
  const first = series(Array(14).fill(3));
  const second = series(Array(12).fill(2), first[first.length - 1].getTime() + 10 * 60 * 1000);
  const hit = s.rhythmFinding([...first, ...second], 'oeffnen');
  assert.equal(hit.runs, 2);
  assert.equal(hit.to.getTime(), second[second.length - 1].getTime());
  assert.match(hit.summary, /unter 1 %/);
});

test('IHK: direkt bei Ablauf abgeholt und sofort neu gestartet, auch nachts', () => {
  const tz = 'Europe/Berlin';
  const runs = (startMs, n, reactS, restartS) => {
    const out = [];
    let at = startMs;
    for (let i = 0; i < n; i++) {
      const endsAt = at + 10 * 60 * 1000;
      const collectedAt = endsAt + reactS * 1000;
      out.push({ createdAt: new Date(at), endsAt: new Date(endsAt), collectedAt: new Date(collectedAt) });
      at = collectedAt + restartS * 1000;
    }
    return out;
  };
  // 10 Quests ab 3:00 deutscher Zeit (1:00 UTC): die ersten drei Abholungen vor 6 Uhr
  const night = s.ihkFinding(runs(Date.UTC(2026, 9, 5, 1, 0, 0), 10, 1, 4), tz);
  assert.ok(night);
  assert.equal(night.level, LEVEL.wahrscheinlich);
  assert.ok(night.night >= 3);
  // dasselbe tagsüber: möglich (ein wartender Mensch kann auch so schnell sein)
  const day = s.ihkFinding(runs(t0, 10, 1, 4), tz);
  assert.equal(day.level, LEVEL.moeglich);
  assert.equal(day.night, 0);
  // normale Spieler holen später ab
  assert.equal(s.ihkFinding(runs(t0, 10, 90, 300), tz), null);
  // zu wenige Quests
  assert.equal(s.ihkFinding(runs(t0, s.IHK_MIN_RUNS - 1, 1, 4), tz), null);
  // eine normale Abholung danach ist kein neuer Beleg (sonst öffnet sich ein erledigter Hinweis wieder)
  const exact = runs(t0, 10, 1, 4);
  const lastExact = exact[exact.length - 1].collectedAt.getTime();
  const later = { createdAt: new Date(lastExact + 3600 * 1000), endsAt: new Date(lastExact + 4200 * 1000), collectedAt: new Date(lastExact + 9000 * 1000) };
  const withLater = s.ihkFinding([...exact, later], tz);
  assert.ok(withLater);
  assert.equal(withLater.to.getTime(), lastExact);
});

test('Broker-Scalping: viele schnelle Runden mit hoher Trefferquote', () => {
  const trades = (results) => {
    const out = [];
    let at = t0;
    results.forEach((win) => {
      out.push({ coin: 'SAM', side: 'kauf', units: 1000, cents: 50000, createdAt: new Date(at) });
      at += 30 * 1000;
      out.push({ coin: 'SAM', side: 'verkauf', units: 1000, cents: win ? 50080 : 49950, createdAt: new Date(at) });
      at += 20 * 1000;
    });
    return out;
  };
  const strong = s.scalpFinding(trades([...Array(15).fill(true), false]));
  assert.ok(strong);
  assert.equal(strong.level, LEVEL.wahrscheinlich);
  assert.equal(strong.count, 16);
  assert.equal(strong.wins, 15);
  assert.equal(strong.gain, 15 * 80 - 50);
  assert.equal(s.scalpFinding(trades([true, true, true, true, true, true, true, false, true])).level, LEVEL.moeglich);
  // Trefferquote wie beim Zufall: unauffällig
  assert.equal(s.scalpFinding(trades(Array(20).fill(0).map((_, i) => i % 2 === 0))), null);
  // lange Haltedauer zählt nicht als Runde
  const slow = trades(Array(10).fill(true)).map((t, i) => ({ ...t, createdAt: new Date(t0 + i * 10 * 60 * 1000) }));
  assert.equal(s.scalpFinding(slow), null);
  // neue Belege nur durch Runden im Plus
  const tail = trades([...Array(15).fill(true), false]);
  assert.equal(s.scalpFinding(tail).to.getTime(), tail[tail.length - 3].createdAt.getTime());
});

test('Broker-Scalping: Verkauf über mehrere Käufe und Teilverkäufe mit anteiligem Einstand', () => {
  // zweimal 10 € nachkaufen, alles für 19 € verkaufen: 1 € Verlust, kein Gewinn
  const rounds = (n) => {
    const out = [];
    let at = t0;
    for (let i = 0; i < n; i++) {
      out.push({ coin: 'SAM', side: 'kauf', units: 100, cents: 1000, createdAt: new Date(at) });
      out.push({ coin: 'SAM', side: 'kauf', units: 100, cents: 1000, createdAt: new Date(at + 10 * 1000) });
      out.push({ coin: 'SAM', side: 'verkauf', units: 200, cents: 1900, createdAt: new Date(at + 20 * 1000) });
      at += 60 * 1000;
    }
    return out;
  };
  assert.equal(s.scalpFinding(rounds(10)), null);
  // Teilverkauf: Hälfte für 6 € bei 10 € Einstand ist ein Gewinn von 1 €, kein Verlust von 4 €
  const halves = [];
  let at = t0;
  for (let i = 0; i < 8; i++) {
    halves.push({ coin: 'SAM', side: 'kauf', units: 100, cents: 1000, createdAt: new Date(at) });
    halves.push({ coin: 'SAM', side: 'verkauf', units: 50, cents: 600, createdAt: new Date(at + 10 * 1000) });
    halves.push({ coin: 'SAM', side: 'verkauf', units: 50, cents: 600, createdAt: new Date(at + 20 * 1000) });
    at += 60 * 1000;
  }
  const f = s.scalpFinding(halves);
  assert.ok(f);
  assert.equal(f.count, 16);
  assert.equal(f.wins, 16);
  assert.equal(f.gain, 16 * 100);
  // Verkauf von Einheiten, die vor dem Zeitraum gekauft wurden: Einstand unbekannt, keine Runde
  assert.equal(s.scalpFinding(halves.filter((t) => t.side === 'verkauf')), null);
});

test('Wertverschiebung: Glitch für 1 € ja, Holo zum Marktpreis nein', () => {
  const values = { glitch: 250000, holo: 9000, bockhaber: 70000, crumpled: 300 };
  const valueOf = (id) => values[id] || 0;
  const sale = (card, price, extra = {}) => ({ kind: 'privat', seller: 'a', buyer: 'b', give: [{ card }], want: [], price, ...extra });
  const glitch = s.valueFinding(sale('glitch', 100), valueOf);
  assert.deepEqual(glitch, { from: 'a', to: 'b', given: 250000, received: 100, shifted: 249900 });
  assert.equal(s.valueFinding(sale('holo', 25000, { kind: 'markt' }), valueOf), null);
  // gewöhnlicher Verkauf zum Bankwert und darüber ist unauffällig (die Kartenseite zählt mit)
  assert.equal(s.valueFinding(sale('bockhaber', 70000), valueOf), null);
  // Käufer zahlt viel zu viel für Crumpled: Geld fließt zum Anbieter
  assert.equal(s.valueFinding(sale('crumpled', 100000), valueOf).to, 'a');
  // Tausch Bockhaber gegen Crumpled: der Empfänger profitiert
  const swap = s.valueFinding({ kind: 'tausch', seller: 'a', to: 'b', buyer: 'b', give: [{ card: 'bockhaber' }], want: [{ card: 'crumpled' }], price: 0 }, valueOf);
  assert.equal(swap.to, 'b');
  assert.equal(swap.received, 300);
  // Aufpreis gleicht aus
  assert.equal(s.valueFinding({ kind: 'tausch', seller: 'a', to: 'b', give: [{ card: 'bockhaber' }], want: [{ card: 'crumpled' }], extraFrom: 'to', price: 60000 }, valueOf), null);
  // Anbieter legt Geld drauf: zählt auf seiner Seite
  assert.equal(s.valueFinding({ kind: 'tausch', seller: 'a', to: 'b', give: [{ card: 'crumpled' }], want: [{ card: 'bockhaber' }], extraFrom: 'seller', price: 60000 }, valueOf), null);
  // kleine Beträge sind egal
  assert.equal(s.valueFinding(sale('crumpled', 1), valueOf), null);
  // offenes Angebot ohne Käufer
  assert.equal(s.valueFinding(sale('glitch', 1, { kind: 'markt', buyer: null }), valueOf), null);

  const names = new Map([['a', 'Anna'], ['b', 'Ben']]);
  const one = s.valuePairFinding([{ ...glitch, at: new Date(t0), text: 'x' }], names);
  assert.equal(one.level, LEVEL.wahrscheinlich); // über 500 €
  assert.equal(one.winner, 'b');
  assert.match(one.summary, /zugunsten von Ben/);
  const small = { from: 'a', to: 'b', shifted: 6000, at: new Date(t0), text: 'y' };
  assert.equal(s.valuePairFinding([small], names).level, LEVEL.moeglich);
  assert.equal(s.valuePairFinding([small], names, true).level, LEVEL.wahrscheinlich); // auch Mehrfach-Konto
  assert.equal(s.valuePairFinding([small, small, small], names).level, LEVEL.wahrscheinlich);
});

test('Dungeon: jeder Termin rund um die Uhr, sofort angemeldet, Beute nie angeschaut', () => {
  const H = 3600e3;
  const tz = 'Europe/Berlin';
  const opts = { intervalMs: 2 * H, lockMs: 10e3, timeZone: tz };
  const start = Date.UTC(2026, 9, 4, 22, 0, 0); // 0:00 deutsche Zeit
  // Skript: 13 Termine in Folge (24 Std.), jeweils 5 s nach Öffnen der Anmeldung, Beute nie angeschaut
  const bot = Array.from({ length: 13 }, (_, i) => {
    const slot = start + i * 2 * H;
    return { slot: new Date(slot), joinedAt: new Date(slot - 2 * H - 10e3 + 5e3), seen: false, finished: true };
  });
  const f = s.dungeonFinding(bot, opts);
  assert.ok(f);
  assert.equal(f.level, LEVEL.wahrscheinlich);
  assert.equal(f.streak, 13);
  assert.ok(f.joinMs <= 10e3);
  assert.equal(f.unseen, 13);
  assert.match(f.summary, /13 Termine in Folge/);
  // Mensch: abends ein paar Termine, irgendwann während der zwei Stunden angemeldet, Beute angeschaut
  const human = [18, 20, 22].flatMap((h, d) => [0, 1].map((day) => {
    const slot = Date.UTC(2026, 9, 1 + day, h - 2, 0, 0);
    return { slot: new Date(slot), joinedAt: new Date(slot - (40 + d * 20) * 60e3), seen: true, finished: true };
  }));
  assert.equal(human.length, 6);
  assert.equal(s.dungeonFinding(human, opts), null);
  // sofort angemeldet, aber tagsüber und Beute angeschaut: nur möglich
  const quick = human.map((r) => ({ ...r, joinedAt: new Date(r.slot.getTime() - 2 * H + 20e3) }));
  assert.equal(s.dungeonFinding(quick, opts).level, LEVEL.moeglich);
  // zu wenige Durchläufe
  assert.equal(s.dungeonFinding(bot.slice(0, 5), opts), null);
});

test('Grading: fertig genau zur Mindestzeit', () => {
  const job = (i, extraS, clean = 100, seal = 100) => ({ createdAt: new Date(t0 + i * 600e3), doneAt: new Date(t0 + i * 600e3 + 10 * 800 + extraS * 1000), clean, seal, spots: 10 });
  const bot = Array.from({ length: 8 }, (_, i) => job(i, 0.5));
  const f = s.gradingFinding(bot, 800);
  assert.ok(f);
  assert.equal(f.level, LEVEL.wahrscheinlich);
  assert.equal(f.perfect, 8);
  // von Hand: deutlich länger als die Mindestzeit
  assert.equal(s.gradingFinding(Array.from({ length: 8 }, (_, i) => job(i, 25 + i)), 800), null);
  // knapp über der Mindestzeit, nicht perfekt: möglich
  assert.equal(s.gradingFinding(Array.from({ length: 8 }, (_, i) => job(i, 3, 90, 80)), 800).level, LEVEL.moeglich);
  assert.equal(s.gradingFinding(bot.slice(0, 5), 800), null);
});

test('Rund um die Uhr: über 20 Stunden ohne Schlafpause, auch nachts', () => {
  const tz = 'Europe/Berlin';
  const start = Date.UTC(2026, 9, 4, 10, 0, 0); // 12:00 deutsche Zeit
  // alle 30 Minuten eine Aktion, 32 Stunden lang
  const bot = Array.from({ length: 65 }, (_, i) => new Date(start + i * 30 * 60e3));
  const f = s.activityFinding(bot, tz);
  assert.ok(f);
  assert.equal(f.level, LEVEL.wahrscheinlich);
  assert.ok(f.nightHours >= 3);
  // 22 Stunden: nur möglich
  assert.equal(s.activityFinding(bot.slice(0, 45), tz).level, LEVEL.moeglich);
  // Mensch: tagsüber viel, nachts 7 Stunden Pause
  const day = (d) => Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 9, d, 6, 0, 0) + i * 30 * 60e3)); // 8–23 Uhr
  assert.equal(s.activityFinding([...day(4), ...day(5)], tz), null);
});

test('Kein normaler Browser: ferngesteuert, Skript-Werkzeug oder ohne Fingerabdruck und Kopfzeilen', () => {
  const day = (x) => ({ actions: 0, noProbe: 0, noFetchMeta: 0, bare: 0, webdriver: 0, botUa: 0, uas: [], firstAt: new Date(t0), lastAt: new Date(t0 + 3600e3), ...x });
  assert.equal(s.browserFinding([day({ actions: 50 })]), null);
  const wd = s.browserFinding([day({ actions: 50, webdriver: 50, uas: ['Mozilla/5.0 Chrome'] })]);
  assert.equal(wd.level, LEVEL.wahrscheinlich);
  assert.match(wd.summary, /ferngesteuerten Browser/);
  assert.equal(s.browserFinding([day({ actions: 5, botUa: 5, uas: ['python-requests/2.31'] })]).level, LEVEL.wahrscheinlich);
  assert.equal(s.browserFinding([day({ actions: 40, noProbe: 30, noFetchMeta: 30, bare: 30 })]).level, LEVEL.wahrscheinlich);
  // nur ohne Fingerabdruck (z. B. ohne JavaScript): möglich
  assert.equal(s.browserFinding([day({ actions: 40, noProbe: 30 })]).level, LEVEL.moeglich);
  // alter Safari ohne Sec-Fetch-Kopfzeilen, aber mit Fingerabdruck: unauffällig
  assert.equal(s.browserFinding([day({ actions: 40, noFetchMeta: 40 })]), null);
  // einzelne Ausreißer reichen nicht
  assert.equal(s.browserFinding([day({ actions: 200, bare: 5, noProbe: 5, noFetchMeta: 5 })]), null);
});

test('Ungewöhnliche Einnahmen: weit über dem Üblichen', () => {
  const at = new Date(t0);
  const normal = Array.from({ length: 9 }, (_, i) => ({ user: `u${i}`, type: 'ihk_lohn', amount: 3000 + i * 100, createdAt: at }));
  const out = s.incomeFindings([...normal, { user: 'bot', type: 'dungeon_lohn', amount: 60000, createdAt: at }, { user: 'bot', type: 'ihk_lohn', amount: 20000, createdAt: at }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].user, 'bot');
  assert.equal(out[0].level, LEVEL.moeglich);
  assert.match(out[0].summary, /Dungeon/);
  // zu wenige Spieler für einen Vergleich
  assert.deepEqual(s.incomeFindings([...normal.slice(0, 5), { user: 'bot', type: 'dungeon_lohn', amount: 60000, createdAt: at }]), []);
  // Lotto und Wettgewinne zählen nicht
  assert.deepEqual(s.incomeFindings([...normal, { user: 'glück', type: 'lotto_gewinn', amount: 900000, createdAt: at }]), []);
});

test('Wett-Einsätze zählen bei Tempo und Takt mit', () => {
  assert.ok(s.ACTIONS.wetten);
  assert.ok(s.tempoFinding(series(Array(8).fill(0.5)), 'wetten'));
});

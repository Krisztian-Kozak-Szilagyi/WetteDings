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
});

test('Broker-Scalping: viele schnelle Runden mit hoher Trefferquote', () => {
  const trades = (results) => {
    const out = [];
    let at = t0;
    results.forEach((win) => {
      out.push({ coin: 'SAM', side: 'kauf', cents: 50000, createdAt: new Date(at) });
      at += 30 * 1000;
      out.push({ coin: 'SAM', side: 'verkauf', cents: win ? 50080 : 49950, createdAt: new Date(at) });
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
});

test('Wertverschiebung: Glitch für 1 € ja, Holo zum Marktpreis nein', () => {
  const values = { glitch: 250000, holo: 9000, bockhaber: 70000, crumpled: 300 };
  const valueOf = (id) => values[id] || 0;
  const glitch = s.valueFinding({ kind: 'privat', seller: 'a', buyer: 'b', card: 'glitch', price: 100 }, valueOf);
  assert.deepEqual(glitch, { from: 'a', to: 'b', given: 250000, received: 100, shifted: 249900 });
  assert.equal(s.valueFinding({ kind: 'markt', seller: 'a', buyer: 'b', card: 'holo', price: 25000 }, valueOf), null);
  // Käufer zahlt viel zu viel für Crumpled: Geld fließt zum Anbieter
  assert.equal(s.valueFinding({ kind: 'privat', seller: 'a', buyer: 'b', card: 'crumpled', price: 100000 }, valueOf).to, 'a');
  // Tausch Bockhaber gegen Crumpled: der Empfänger profitiert
  const swap = s.valueFinding({ kind: 'tausch', seller: 'a', to: 'b', give: [{ card: 'bockhaber' }], take: [{ card: 'crumpled' }], price: 0 }, valueOf);
  assert.equal(swap.to, 'b');
  // Aufpreis gleicht aus
  assert.equal(s.valueFinding({ kind: 'tausch', seller: 'a', to: 'b', give: [{ card: 'bockhaber' }], take: [{ card: 'crumpled' }], extraFrom: 'to', price: 60000 }, valueOf), null);
  // kleine Beträge sind egal
  assert.equal(s.valueFinding({ kind: 'privat', seller: 'a', buyer: 'b', card: 'crumpled', price: 1 }, valueOf), null);
  // offenes Angebot ohne Käufer
  assert.equal(s.valueFinding({ kind: 'markt', seller: 'a', buyer: null, card: 'glitch', price: 1 }, valueOf), null);

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

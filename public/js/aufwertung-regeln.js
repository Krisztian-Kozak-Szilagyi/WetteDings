// Kartenaufwertung – reine Rechnung ohne Datenbank, gleich im Browser (window.AufwertungRegeln, Anzeige von Chance und
// Rückgabe) und auf dem Server (src/tcg/upgrade.js, entscheidet). Seltenheiten als { key, sell (Cent), weight
// (Pack-Gewicht) } in der Stufenfolge (häufig → selten), Einstellungen wie in src/tcg/upgrade.js.
//
// Ziel: ein fairer Weg, die Sammlung zu vervollständigen, ohne viel Wert zu verlieren.
// Ziel ist die Stufe über der seltensten eingesetzten Karte. Ausgang eines Vertrags (ein Wurf):
//   Jackpot (jackpot / 10.000)      eine Glitch- oder Icon-Karte (nach ihren Pack-Gewichten), nie schlechter als das Ziel
//   Glückstreffer (bonus / 10.000)  eine Stufe über dem Ziel (gibt es keine, zählt er als normaler Erfolg)
//   sonst mit der Chance p          eine Karte des Ziels, ohne Erfolg eine Karte der seltensten eingesetzten Seltenheit
// Wertausgleich: bleibt der Bankwert der neuen Karte unter ausgleich % des Einsatzwerts, gibt es die Differenz als
// Spielgeld dazu – mehr als (100 − ausgleich) % kann man nie verlieren. Das ist immer weniger, als die Bank für die
// eingesetzten Karten zahlen würde, es kommt also kein zusätzliches Geld ins Spiel.
// p = maxChance × q, höchstens so viel, dass im Mittel (Karte + Ausgleich, mit Jackpot und Glückstreffer) nicht mehr als
// rueckgabe % des Einsatzwerts herauskommt. q = wie selten der Einsatz ist: jede Karte zählt mit Pack-Gewicht(oberste) /
// Pack-Gewicht(eigene) – 10 Karten der obersten Seltenheit ergeben q = 1, 1 Gold + 9 BFWler etwa 0,45.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AufwertungRegeln = factory();
})(this, function () {
  'use strict';

  var JACKPOT = ['glitch', 'icon']; // Seltenheiten des Jackpots (soweit über dem Ziel)

  function index(ladder) {
    var by = {};
    ladder.forEach(function (r, i) { by[r.key] = { r: r, i: i }; });
    return by;
  }

  /**
   * Vertrag auswerten. keys: Seltenheiten der eingesetzten Karten. Gibt null zurück, wenn er ungültig ist
   * (unbekannte Seltenheit oder oberste Stufe ohne nächste), sonst Chancen, Werte und den Ausgleich.
   */
  function vertrag(keys, ladder, s) {
    if (!keys.length) return null;
    var by = index(ladder);
    if (keys.some(function (k) { return !by[k]; })) return null;
    var topI = Math.max.apply(null, keys.map(function (k) { return by[k].i; }));
    if (topI >= ladder.length - 1) return null;
    var top = ladder[topI];
    var target = ladder[topI + 1];
    var bonusR = ladder[topI + 2] || null;
    var n = keys.length;
    var value = keys.reduce(function (sum, k) { return sum + by[k].r.sell; }, 0);
    var floor = Math.floor(((s.ausgleich || 0) / 100) * value); // so viel kommt mindestens zurück (Karte + Spielgeld)
    var back = function (cardValue) { return Math.max(floor, cardValue); }; // Karte plus Ausgleich
    // q: Anteil „voller“ Karten der obersten Seltenheit, gemessen an der Seltenheit in Packs
    var q = keys.reduce(function (sum, k) {
      var w = by[k].r.weight;
      return sum + (w > 0 && top.weight > 0 ? Math.min(1, top.weight / w) : 1);
    }, 0) / n;
    // Jackpot: Glitch/Icon über dem Ziel, verteilt nach Pack-Gewicht
    var jp = JACKPOT.map(function (k) { return by[k] && by[k].i > topI + 1 ? by[k].r : null; }).filter(Boolean);
    var jpW = jp.reduce(function (sum, r) { return sum + (r.weight || 1); }, 0);
    var jpBack = jp.reduce(function (sum, r) { return sum + back(r.sell) * (r.weight || 1); }, 0) / (jpW || 1);
    var j = jp.length ? s.jackpot / 10000 : 0;
    var b = s.bonus / 10000;
    var bonusBack = back(bonusR ? bonusR.sell : target.sell);
    var upBack = back(target.sell);
    var failBack = back(top.sell);
    // Glückstreffer und Jackpot dürfen die Grenze nicht allein sprengen (sonst wäre der Vertrag im Mittel ein Gewinn,
    // egal wie die Chance steht): notfalls werden beide in diesem Vertrag anteilig seltener
    var limit = (s.rueckgabe / 100) * value;
    var extra = j * (jpBack - failBack) + b * (bonusBack - failBack);
    if (extra > 0 && failBack + extra > limit) {
      var k = Math.max(0, (limit - failBack) / extra);
      j *= k;
      b *= k;
    }
    // höchste Chance, bei der der Mittelwert die Grenze einhält
    var rest = 1 - j - b;
    var budget = ((s.rueckgabe / 100) * value - j * jpBack - b * bonusBack) / rest; // für Erfolg/Fehlschlag übrig
    var fair = upBack > failBack ? (budget - failBack) / (upBack - failBack) : 1;
    var p = Math.max(0, Math.min(1, (s.maxChance / 100) * q, fair));
    var ev = j * jpBack + b * bonusBack + rest * (p * upBack + (1 - p) * failBack);
    return {
      top: top.key,
      target: target.key,
      bonus: bonusR ? bonusR.key : null,
      jackpot: jp.map(function (r) { return { key: r.key, p: (r.weight || 1) / jpW }; }),
      q: q,
      chance: p, // Chance auf das Ziel, wenn weder Jackpot noch Glückstreffer
      pJackpot: j,
      pBonus: b,
      value: value, // Bankwert des Einsatzes (Cent)
      floor: floor, // mindestens zurück (Cent)
      ev: ev, // erwartete Rückgabe: Karte + Ausgleich (Cent)
    };
  }

  /** Wertausgleich in Cent, wenn die neue Karte cardValue wert ist */
  function ausgleich(v, cardValue) {
    return Math.max(0, v.floor - cardValue);
  }

  /** Ausgang würfeln: { kind: 'jackpot'|'bonus'|'erfolg'|'fehlschlag', rarity } – rand() → [0, 1) */
  function wurf(keys, v, rand) {
    var r = rand();
    if (r < v.pJackpot) {
      var x = rand();
      for (var i = 0; i < v.jackpot.length; i++) {
        x -= v.jackpot[i].p;
        if (x < 0 || i === v.jackpot.length - 1) return { kind: 'jackpot', rarity: v.jackpot[i].key };
      }
    }
    if (r < v.pJackpot + v.pBonus) return { kind: 'bonus', rarity: v.bonus || v.target };
    if (rand() < v.chance) return { kind: 'erfolg', rarity: v.target };
    return { kind: 'fehlschlag', rarity: v.top }; // die seltenste eingesetzte Seltenheit bleibt
  }

  return { JACKPOT: JACKPOT, vertrag: vertrag, ausgleich: ausgleich, wurf: wurf };
});

// Kartenaufwertung – reine Rechnung ohne Datenbank, gleich im Browser (window.AufwertungRegeln, Anzeige der Chance) und
// auf dem Server (src/tcg/upgrade.js, entscheidet). Seltenheiten als { key, sell (Cent), weight (Pack-Gewicht) } in der
// Stufenfolge (häufig → selten), Einstellungen wie in src/tcg/upgrade.js.
//
// Ziel ist die Stufe über der seltensten eingesetzten Karte. Ausgang eines Vertrags (ein Wurf):
//   Jackpot (jackpot / 10.000)      eine Glitch- oder Icon-Karte (nach ihren Pack-Gewichten), nie schlechter als das Ziel
//   Glückstreffer (bonus / 10.000)  eine Stufe über dem Ziel (gibt es keine, zählt er als normaler Erfolg)
//   sonst mit der Chance p          eine Karte des Ziels, ohne Erfolg eine Karte aus der Seltenheit einer zufällig
//                                   gewählten eingesetzten Karte
// p = maxChance × q, höchstens so viel, dass im Mittel nicht mehr als rueckgabe % des Einsatzwerts herauskommt (Jackpot
// und Glückstreffer eingerechnet). q = wie selten der Einsatz ist: jede Karte zählt mit Pack-Gewicht(oberste) /
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
   * (unbekannte Seltenheit oder oberste Stufe ohne nächste), sonst die Ausgänge mit Wahrscheinlichkeit und Wert.
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
    var avg = value / n; // Wert des Fehlschlags im Mittel (Seltenheit einer zufälligen eingesetzten Karte)
    // q: Anteil „voller“ Karten der obersten Seltenheit, gemessen an der Seltenheit in Packs
    var q = keys.reduce(function (sum, k) {
      var w = by[k].r.weight;
      return sum + (w > 0 && top.weight > 0 ? Math.min(1, top.weight / w) : 1);
    }, 0) / n;
    // Jackpot: Glitch/Icon über dem Ziel, verteilt nach Pack-Gewicht
    var jp = JACKPOT.map(function (k) { return by[k] && by[k].i > topI + 1 ? by[k].r : null; }).filter(Boolean);
    var jpW = jp.reduce(function (sum, r) { return sum + (r.weight || 1); }, 0);
    var jpValue = jp.reduce(function (sum, r) { return sum + r.sell * (r.weight || 1); }, 0) / (jpW || 1);
    var j = jp.length ? s.jackpot / 10000 : 0;
    var b = s.bonus / 10000;
    var bonusValue = bonusR ? bonusR.sell : target.sell;
    // höchste Chance, bei der der Mittelwert die Wertgrenze einhält
    var rest = 1 - j - b;
    var budget = ((s.rueckgabe / 100) * value - j * jpValue - b * bonusValue) / rest; // für Erfolg/Fehlschlag übrig
    var fair = target.sell > avg ? (budget - avg) / (target.sell - avg) : 1;
    var p = Math.max(0, Math.min(1, (s.maxChance / 100) * q, fair));
    var ev = j * jpValue + b * bonusValue + rest * (p * target.sell + (1 - p) * avg);
    return {
      top: top.key,
      target: target.key,
      bonus: bonusR ? bonusR.key : null,
      jackpot: jp.map(function (r) { return { key: r.key, p: (r.weight || 1) / jpW }; }),
      q: q,
      chance: p, // Chance auf das Ziel, wenn weder Jackpot noch Glückstreffer
      pJackpot: j,
      pBonus: b,
      value: value,
      ev: ev, // erwarteter Wert der neuen Karte (Cent)
    };
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
    return { kind: 'fehlschlag', rarity: keys[Math.floor(rand() * keys.length)] };
  }

  return { JACKPOT: JACKPOT, vertrag: vertrag, wurf: wurf };
});

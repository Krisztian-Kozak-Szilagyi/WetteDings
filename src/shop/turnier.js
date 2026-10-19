// Shop-Demo: Turniere am Spieltisch – reine Regeln, ohne Datenbank (Krisztian, 2026-10-19).
// Der Spieler legt Startgeld und Preisgeld fest und kündigt das Turnier mindestens TURNIER.lead Tage vorher am PC an.
// Je höher der Preis und je niedriger das Startgeld, desto mehr kommen – aber desto weniger bleibt übrig. Wer zu oft
// Turniere macht, bekommt weniger Teilnehmer (Turnier-Müdigkeit). Am Turniertag melden sich die Teilnehmer an der
// Kasse an, der Spieler startet die Runden am PC, die Sieger melden ihr Ergebnis an der Kasse.
// Alle Zahlen = Platzhalter. Zufall immer als Parameter (rng), im Browser: window.ShopTurnier.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShopTurnier = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TURNIER = {
    tableLevel: 3, // Spieltisch ab Ruf-Stufe 3
    level: 4, // Turniere ab Ruf-Stufe 4
    lead: 2, // so viele Tage vorher ankündigen
    fatigueDays: 7, // Turnier innerhalb von 7 Tagen nach dem letzten → weniger Teilnehmer
    base: { 4: 8, 5: 10, 6: 12 }, // Teilnehmer bei „normalem“ Angebot je Ruf-Stufe (darüber: 12)
    minPlayers: 4,
    maxPlayers: 16,
    feeMax: 500,
    prizeMax: 10000,
    boardHype: 0.3, // Schwarzes Brett im Laden: +30 % Interesse
    posterHype: 0.1, // je hängendem Plakat +10 % (kommt mit der Stadt)
    matchSeconds: [20, 35], // Dauer einer Partie (Spielsekunden)
    overtime: 0.25, // so lange (Anteil eines Tages) nach Ladenschluss läuft ein Turnier höchstens weiter, dann Abbruch
    // Teilnehmer kaufen lieber Merch und Getränke (Wunsch-Gewicht), Turnier-Edition am liebsten
    boost: { merch: 3, turnier: 6, drink: 3 },
    // Nicht-Turnier-Tage: manche Kunden setzen sich zum Spielen an einen freien Spieltisch und holen sich vorher oft ein Getränk
    casualChance: 0.12,
    casualDrink: 0.7,
    casualSeconds: [30, 60],
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /** Wie verlockend ist das Angebot? Preisgeld lockt, Startgeld schreckt ab (1 = normal) */
  function appeal(prize, fee) {
    return clamp((0.5 + (prize || 0) / 100) / (1 + (fee || 0) / 10), 0.25, 2.5);
  }

  /** Müdigkeit: letztes Turnier vor `days` Tagen (null = noch nie) → Faktor 0,4 … 1 */
  function fatigue(days, cfg) {
    const c = cfg || TURNIER;
    if (days === null || days === undefined || days >= c.fatigueDays) return 1;
    return 0.4 + (0.6 * Math.max(0, days)) / c.fatigueDays;
  }

  /**
   * Wie viele kommen? ctx = { level, prize, fee, board (Brett im Laden), posters (Anzahl), daysSinceLast } → { n, expected }
   * expected = ohne Zufall (für die Vorschau am PC)
   */
  function signups(ctx, rng, cfg) {
    const c = cfg || TURNIER;
    const base = c.base[Math.min(6, Math.max(4, ctx.level || 4))] || 12;
    const hype = 1 + (ctx.board ? c.boardHype : 0) + (ctx.posters || 0) * c.posterHype;
    const raw = base * appeal(ctx.prize, ctx.fee) * hype * fatigue(ctx.daysSinceLast, c);
    const expected = clamp(Math.round(raw), 0, c.maxPlayers);
    const n = rng ? clamp(Math.round(raw * (0.85 + rng() * 0.3)), 0, c.maxPlayers) : expected;
    return { n, expected };
  }

  /** Paarungen einer Runde (K.-o.): Spieler mischen, je zwei gegeneinander, bei ungerader Zahl kommt einer kampflos weiter */
  function pairRound(players, rng) {
    const list = players.slice();
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    const matches = [];
    for (let i = 0; i + 1 < list.length; i += 2) matches.push([list[i], list[i + 1]]);
    return { matches, bye: list.length % 2 ? list[list.length - 1] : null };
  }

  /** Wer gewinnt? 50:50 (später: Deck-Stärke) */
  const winner = (match, rng) => (rng() < 0.5 ? match[0] : match[1]);
  const matchSeconds = (rng, cfg) => { const c = cfg || TURNIER; return c.matchSeconds[0] + rng() * (c.matchSeconds[1] - c.matchSeconds[0]); };

  /**
   * Bewertung eines Teilnehmers: Komfort beim Warten (wie bei Aufträgen: ohne Stuhl höchstens 3★, Stuhl 4★, Stuhl + Getränk 5★)
   * minus Ärger (lange angestanden, lange ohne Partie …). Nie unter 1.
   */
  function reviewStars(p) {
    const comfort = p.chair ? (p.drink ? 5 : 4) : 3;
    return clamp(comfort - (p.annoy || 0), 1, 5);
  }

  return { TURNIER, appeal, fatigue, signups, pairRound, winner, matchSeconds, reviewStars };
});

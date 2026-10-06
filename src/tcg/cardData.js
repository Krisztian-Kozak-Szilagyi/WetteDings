// Karten mit gezeichnetem Rahmen (ab Season 1): Das Bild in public/img/tcg enthält nur Rahmen und Motiv –
// Werte und Fähigkeitstext stehen hier und werden per Code auf die Karte gesetzt (src/tcg/cardSvg.js).
// Buffen/Nerfen = Zahl hier ändern, kein neues Bild nötig.
//
// Schlüssel = Karten-ID aus dem Dateinamen ("st-ivan-boss.webp" -> "st-ivan-boss").
//   season:  Schlüssel aus src/tcg/seasons.js
//   frame:   Rahmen-Layout aus src/tcg/frames.js (wo die Fenster auf dem Bild liegen)
//   name:    Name wie auf der Karte (sonst aus dem Dateinamen)
//   stats:   [Speed, FIA, FIS, BWL]
//   abilityName: Name der Fähigkeit (fett über dem Text, optional)
//   ability: Fähigkeitstext im großen Fenster
//   kampf:   Kampfwerte für den kommenden Kampfmodus (eigener Block, getrennt von den IHK-Werten in stats).
//            Die Felder legen wir mit den Spielregeln fest.
// Test-Items für den Bosskampf (Seltenheit test-item, Admins bekommen sie beim Start – src/migrate.js).
//   kampf.typ: waffe | zauber | schild; haende: belegte Hände (1 oder 2); schaden: Grundschaden, einmal pro Runde;
//   schutz: weniger erlittener Schaden in %; haltbarkeit: Treffer bis zum Zerbrechen (0 = unzerstörbar);
//   fx: Effekt beim Einsatz (public/js/bossfight-fx.js): feuer | nekro | hieb | hieb-schwer
const item = (name, abilityName, ability, kampf) => ({ season: 'season-1', frame: 'item', name, stats: [0, 0, 0, 0], abilityName, ability, kampf });
const TEST_ITEMS = {
  'one-handed-sword-test-item': item('One-Handed Sword', 'Einhändige Waffe', '8 Schaden, einmal pro Runde.', { typ: 'waffe', haende: 1, schaden: 8, fx: 'hieb' }),
  'axe-test-item': item('Axe', 'Zweihändige Waffe', '14 Schaden, einmal pro Runde.', { typ: 'waffe', haende: 2, schaden: 14, fx: 'hieb-schwer' }),
  'fire-spell-test-item': item('Fire Spell', 'Zauber', '12 Schaden, einmal pro Runde.', { typ: 'zauber', haende: 1, schaden: 12, fx: 'feuer' }),
  'necrotic-spell-test-item': item('Necrotic Spell', 'Zauber', '10 Schaden, einmal pro Runde.', { typ: 'zauber', haende: 1, schaden: 10, fx: 'nekro' }),
  'wooden-shield-test-item': item('Wooden Shield', 'Schild', '10 % weniger Schaden. Zerbricht nach 4 Treffern.', { typ: 'schild', haende: 1, schutz: 10, haltbarkeit: 4 }),
  'tower-shield-test-item': item('Tower Shield', 'Schild', '10 % weniger Schaden. Unzerstörbar.', { typ: 'schild', haende: 1, schutz: 10, haltbarkeit: 0 }),
};

module.exports = {
  ...TEST_ITEMS,
  'st-ivan-boss': {
    season: 'season-1',
    frame: 'gilded',
    name: 'St. Ivan, the Forsaken',
    stats: [96, 95, 99, 90],
    // Forkbomb (Idee: Krisztian) – wirkt auf gegnerische Karten, also erst im kommenden Spielmodus.
    // Regeln dafür (stehen absichtlich nicht auf der Karte): Reinigung (z. B. St. Ivans „Backup“) hebt den
    // Effekt auf; verlässt St. Ivan das Spielfeld (z. B. durch Hermann), endet er sofort.
    abilityName: 'Forkbomb',
    ability: 'Alle gegnerischen Karten werden 30 % langsamer, jede Runde lässt der Effekt um 2 % nach.',
  },
};

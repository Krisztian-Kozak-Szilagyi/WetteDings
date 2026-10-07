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
  'one-handed-sword-test-item': item('One-Handed Sword', 'Einhändige Waffe', '8 Schaden, einmal pro Runde. Ausrüsten: 1 Energie.', { typ: 'waffe', haende: 1, schaden: 8, fx: 'hieb' }),
  'axe-test-item': item('Axe', 'Zweihändige Waffe', '14 Schaden, einmal pro Runde. Ausrüsten: 2 Energie.', { typ: 'waffe', haende: 2, schaden: 14, fx: 'hieb-schwer' }),
  'fire-spell-test-item': item('Fire Spell', 'Zauber', '12 Schaden, einmal pro Runde. Ausrüsten: 1 Energie.', { typ: 'zauber', haende: 1, schaden: 12, fx: 'feuer' }),
  'necrotic-spell-test-item': item('Necrotic Spell', 'Zauber', '10 Schaden, einmal pro Runde. Ausrüsten: 1 Energie.', { typ: 'zauber', haende: 1, schaden: 10, fx: 'nekro' }),
  'wooden-shield-test-item': item('Wooden Shield', 'Schild', '10 % weniger Schaden. Zerbricht nach 4 Treffern. Ausrüsten: 1 Energie.', { typ: 'schild', haende: 1, schutz: 10, haltbarkeit: 4 }),
  'tower-shield-test-item': item('Tower Shield', 'Schild', '10 % weniger Schaden. Unzerstörbar. Ausrüsten: 1 Energie.', { typ: 'schild', haende: 1, schutz: 10, haltbarkeit: 0 }),
};

// Helden-Test-Karten (Rahmen "held"): einmal ausspielen, wirken sofort, dann weg.
//   kampf.typ: held; kosten: Energie (3 pro Runde); ang: Schaden am Boss; sch: Block gegen den nächsten Boss-Angriff;
//   hei: Heilung; effekt: Fähigkeit – fluch { schaden, runden } | treffer (Anzahl Treffer) | hinterhalt (Faktor, wenn
//   in der Runde schon eine Karte gespielt wurde) | selbst (eigener Schaden) | verzoegert (Schaden erst nächste Runde);
//   fx: Effekt wie bei den Items
const held = (name, [kosten, ang, sch, hei], abilityName, ability, effekt = null, fx = 'hieb') => ({
  season: 'season-1',
  frame: 'held',
  name,
  stats: [0, 0, 0, 0],
  abilityName,
  ability,
  kampf: { typ: 'held', kosten, ang, sch, hei, effekt, fx },
});
const TEST_HELDEN = {
  'necromancer-test-item': held('The Necromancer', [3, 4, 0, 4], 'Fluch', 'Der Boss erleidet 3 Runden lang je 4 Schaden.', { fluch: { schaden: 4, runden: 3 } }, 'nekro'),
  'crusader-test-item': held('Crusader of Dawn', [2, 4, 12, 0], 'Schildwall', 'Fängt 12 Schaden des nächsten Boss-Angriffs ab.', null, 'hieb'),
  'elven-marksman-test-item': held('Elven Marksman', [2, 5, 0, 0], 'Doppelschuss', 'Trifft zweimal.', { treffer: 2 }, 'hieb'),
  'shadowblade-test-item': held('Shadowblade', [1, 4, 0, 0], 'Hinterhalt', 'Dreifacher Schaden, wenn du in dieser Runde schon eine andere Karte gespielt hast.', { hinterhalt: 3 }, 'hieb'),
  'tide-mage-test-item': held('Tide Mage', [2, 3, 4, 10], 'Gezeitenwelle', 'Heilt 10 Leben und fängt 4 Schaden ab.', null, 'feuer'),
  'berserker-test-item': held('Berserker', [2, 16, 0, 0], 'Blutrausch', 'Du verlierst selbst 5 Leben.', { selbst: 5 }, 'hieb-schwer'),
  'siege-master-test-item': held('Siege Master', [3, 24, 0, 0], 'Nachladen', 'Der Schaden trifft erst zu Beginn der nächsten Runde.', { verzoegert: true }, 'feuer'),
};

module.exports = {
  ...TEST_ITEMS,
  ...TEST_HELDEN,
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

// Karten mit gezeichnetem Rahmen (ab Season 1): Das Bild in public/img/tcg enthält nur Rahmen und Motiv –
// Werte und Fähigkeitstext stehen hier und werden per Code auf die Karte gesetzt (src/tcg/cardSvg.js).
// Buffen/Nerfen = Zahl hier ändern, kein neues Bild nötig.
//
// Schlüssel = Karten-ID aus dem Dateinamen ("st-ivan-boss.webp" -> "st-ivan-boss").
//   season:  Schlüssel aus src/tcg/seasons.js
//   frame:   Rahmen-Layout aus src/tcg/frames.js (wo die Fenster auf dem Bild liegen)
//   name:    Name wie auf der Karte (sonst aus dem Dateinamen)
//   title:   Text im Namensbalken, wenn er vom Namen abweicht (Varianten wie „Ömer the Golden“; der Name bleibt „Ömer“)
//   stats:   [Speed, FIA, FIS, BWL]
//   abilityName: Name der Fähigkeit (fett über dem Text, optional)
//   ability: Fähigkeitstext im großen Fenster
//   kampf:   Kampfwerte für den kommenden Kampfmodus (eigener Block, getrennt von den IHK-Werten in stats).
//            Die Felder legen wir mit den Spielregeln fest.
// Test-Karten für den Bosskampf (Seltenheit test-item, Admins bekommen sie beim Start – src/migrate.js).
// Regeln: public/js/bossfight-regeln.js. Balance per Simulation: npm run sim:bosskampf (scripts/bossfight-sim.js).
// Die Kartentexte werden aus den Zahlen gebaut – Werte ändern genügt, Text und Bild passen sich an.
//
// Items (Rahmen "item"): ausrüsten kostet 1 Energie pro Hand, im Deck nur 1-mal.
//   kampf.typ: waffe | zauber | schild; haende: 1 oder 2; schaden: einmal pro Runde einsetzbar;
//   schutz: weniger erlittener Schaden in %; haltbarkeit: Treffer bis zum Zerbrechen (0 = unzerstörbar);
//   fx: Effekt beim Einsatz (public/js/bossfight-fx.js): feuer | nekro | hieb | hieb-schwer
const energie = (n) => `Ausrüsten: ${n} Energie.`;
const item = (name, abilityName, text, kampf) => ({
  season: 'season-1',
  frame: 'item',
  name,
  stats: [0, 0, 0, 0],
  abilityName,
  ability: text(kampf),
  kampf,
});
const waffe = (k) => `${k.schaden} Schaden, einmal pro Runde. ${energie(k.haende)}`;
const TEST_ITEMS = {
  'one-handed-sword-test-item': item('One-Handed Sword', 'Einhändige Waffe', waffe, { typ: 'waffe', haende: 1, schaden: 5, fx: 'hieb' }),
  'axe-test-item': item('Axe', 'Zweihändige Waffe', waffe, { typ: 'waffe', haende: 2, schaden: 9, fx: 'hieb-schwer' }),
  'fire-spell-test-item': item('Fire Spell', 'Zauber', waffe, { typ: 'zauber', haende: 1, schaden: 5, fx: 'feuer' }),
  'necrotic-spell-test-item': item('Necrotic Spell', 'Zauber', waffe, { typ: 'zauber', haende: 1, schaden: 5, fx: 'nekro' }),
  'wooden-shield-test-item': item('Wooden Shield', 'Schild', (k) => `${k.schutz} % weniger Schaden. Zerbricht nach ${k.haltbarkeit} Treffern. ${energie(1)}`, { typ: 'schild', haende: 1, schutz: 20, haltbarkeit: 4 }),
  'tower-shield-test-item': item('Tower Shield', 'Schild', (k) => `${k.schutz} % weniger Schaden. Unzerstörbar. ${energie(1)}`, { typ: 'schild', haende: 1, schutz: 15, haltbarkeit: 0 }),
};

// Helden (Rahmen held | druide | hain | nekro | eis): einmal ausspielen, wirken sofort, dann weg.
//   kampf.typ: held; kosten: Energie (3 pro Runde); ang: Schaden am Boss; sch: Block gegen den nächsten Boss-Angriff;
//   hei: Heilung; fx: Effekt wie bei den Items; effekt: Fähigkeit –
//     dot { name, schaden, runden }  Boss erleidet zu Beginn jeder Runde Schaden (Fluch, Blutung)
//     treffer n                      ANG trifft n-mal
//     hinterhalt f                   ANG × f, wenn in der Runde schon eine Karte gespielt wurde
//     krit { chance, faktor }        Chance auf mehrfachen Schaden
//     selbst n                       du verlierst n Leben
//     lebensraub                     du heilst so viel, wie die Karte Schaden macht
//     energie n                      sofort n Energie mehr
//     verzoegert                     ANG trifft erst zu Beginn der nächsten Runde
//     betaeuben                      der Boss setzt seinen nächsten Angriff aus
//     schwaechen p                   der nächste Boss-Angriff macht p % weniger Schaden
//     letztesGefecht { grenze, faktor }  unter grenze Leben: ANG und SCH × faktor
//     staerken { ang, sch, kosten }  Druiden: eine gewählte Karte in der Hand wird stärker (gleiche Karte stapelt nicht)
const held = (name, [kosten, ang, sch, hei], abilityName, text, effekt = null, fx = 'hieb', frame = 'held') => {
  const kampf = { typ: 'held', kosten, ang, sch, hei, effekt, fx };
  return { season: 'season-1', frame, name, stats: [0, 0, 0, 0], abilityName, ability: text(kampf, effekt || {}), kampf };
};
const TEST_HELDEN = {
  'necromancer-test-item': held('The Necromancer', [2, 0, 0, 4], 'Fluch', (k, e) => `Der Boss erleidet ${e.dot.runden} Runden lang je ${e.dot.schaden} Schaden.`, { dot: { name: 'Fluch', schaden: 7, runden: 3 } }, 'nekro'),
  'crusader-test-item': held('Crusader of Dawn', [2, 4, 12, 0], 'Schildwall', (k) => `Fängt ${k.sch} Schaden des nächsten Boss-Angriffs ab.`, null, 'hieb'),
  'elven-marksman-test-item': held('Elven Marksman', [2, 11, 0, 0], 'Doppelschuss', (k, e) => `Trifft ${e.treffer}-mal.`, { treffer: 2 }, 'hieb'),
  'shadowblade-test-item': held('Shadowblade', [1, 5, 0, 0], 'Hinterhalt', (k, e) => `${e.hinterhalt}-facher Schaden, wenn du in dieser Runde schon eine andere Karte gespielt hast.`, { hinterhalt: 3 }, 'hieb'),
  'tide-mage-test-item': held('Tide Mage', [2, 2, 3, 10], 'Gezeitenwelle', (k) => `Heilt ${k.hei} Leben und fängt ${k.sch} Schaden ab.`, null, 'feuer'),
  'berserker-test-item': held('Berserker', [2, 26, 0, 0], 'Blutrausch', (k, e) => `Du verlierst selbst ${e.selbst} Leben.`, { selbst: 3 }, 'hieb-schwer'),
  'siege-master-test-item': held('Siege Master', [3, 38, 0, 0], 'Nachladen', () => 'Der Schaden trifft erst zu Beginn der nächsten Runde.', { verzoegert: true }, 'feuer'),
  'stonebreaker-test-item': held('Stonebreaker', [3, 4, 0, 0], 'Erdbeben', (k, e) => `Der Boss gerät ins Wanken: sein nächster Angriff macht ${e.schwaechen} % weniger Schaden.`, { schwaechen: 60 }, 'feuer'),
  'alley-cutthroat-test-item': held('Alley Cutthroat', [1, 4, 0, 0], 'Blutung', (k, e) => `Der Boss blutet ${e.dot.runden} Runden lang für je ${e.dot.schaden} Schaden.`, { dot: { name: 'Blutung', schaden: 4, runden: 3 } }, 'hieb'),
  'blood-priest-test-item': held('Blood Priest', [2, 9, 0, 0], 'Lebensraub', () => 'Du heilst so viel, wie diese Karte Schaden macht.', { lebensraub: true }, 'nekro'),
  'standard-bearer-test-item': held('Standard Bearer', [1, 0, 0, 0], 'Sammeln', (k, e) => `Du erhältst sofort ${e.energie} Energie.`, { energie: 2 }, 'hieb'),
  'crimson-archer-test-item': held('Crimson Archer', [1, 8, 0, 0], 'Kritischer Schuss', (k, e) => `${Math.round(e.krit.chance * 100)} % Chance auf ${e.krit.faktor}-fachen Schaden.`, { krit: { chance: 0.35, faktor: 3 } }, 'hieb'),
  'unbroken-crusader-test-item': held('Unbroken Crusader', [2, 5, 5, 0], 'Letztes Gefecht', (k, e) => `Unter ${e.letztesGefecht.grenze} Leben wirken ANG und SCH ${e.letztesGefecht.faktor}-fach.`, { letztesGefecht: { grenze: 40, faktor: 2 } }, 'hieb'),
  'lich-sovereign-test-item': held('Lich Sovereign', [3, 6, 0, 0], 'Totenfluch', (k, e) => `Der Boss erleidet ${e.dot.runden} Runden lang je ${e.dot.schaden} Schaden.`, { dot: { name: 'Totenfluch', schaden: 11, runden: 3 } }, 'nekro', 'nekro'),
  'frost-sorceress-test-item': held('Frost Sorceress', [2, 3, 0, 0], 'Eiseskälte', (k, e) => `Der nächste Boss-Angriff macht ${e.schwaechen} % weniger Schaden.`, { schwaechen: 50 }, 'feuer', 'eis'),
  'verdant-druid-test-item': held('Verdant Druid', [1, 0, 0, 2], 'Wachstum', (k, e) => `Wähle eine Karte in deiner Hand: +${e.staerken.ang} ANG.`, { staerken: { ang: 5 } }, 'feuer', 'druide'),
  'heart-of-the-grove-test-item': held('Heart of the Grove', [2, 0, 0, 2], 'Segen des Waldes', (k, e) => `Wähle eine Karte in deiner Hand: +${e.staerken.ang} ANG, +${e.staerken.sch} SCH und ${e.staerken.kosten} Energie billiger.`, { staerken: { ang: 3, sch: 2, kosten: 1 } }, 'feuer', 'hain'),
};

// Season-1-Karten ohne Werte, noch nicht erhältlich (unreleased, siehe catalog.js). Bilder: Footman = Original,
// Gold/Holo/Arcane erzeugt mit scripts/rarity-variants.js.
const unreleased = (name, ids) => Object.fromEntries(ids.map((id) => [id, { season: 'season-1', name, unreleased: true }]));
const SEASON1_UNRELEASED = {
  ...unreleased('Mark Suntouched', ['mark-suntouched-1-footman', 'mark-suntouched-2-gold', 'mark-suntouched-3-holo', 'mark-suntouched-4-arcane']),
  ...unreleased('The Gracebringer', ['the-gracebringer-1-footman', 'the-gracebringer-2-gold', 'the-gracebringer-3-holo', 'the-gracebringer-4-arcane']),
};

// Karten-Overhaul Teil 1: Ömer, Aleks, Matze, Luca, Hugo und Lilly im Vollbild-Layout von St. Ivan, the Forsaken – je Seltenheit eigene Farben und
// Effekte (Rahmen „rar-<seltenheit>“ in frames.js, Bilder aus scripts/card-frame.js). Gleiche Karten-IDs wie bisher: wer
// die Karte hatte, hat jetzt die überarbeitete. Werte unverändert aus stats.js, Fähigkeit wie in src/ihk/abilities.js.
const overhaul = (name, abilityName, ability) => (id, rarity, title) => ({ season: 'pre-season', frame: `rar-${rarity}`, name, title, stats: require('./stats')[id], abilityName, ability });
const omer = overhaul('Ömer', 'Macht der Osmanen', 'Verleiht freundlichen ITler-Karten die Macht der Osmanen und erhöht dadurch dauerhaft ihre FIS-Stärke um 15 %.');
const aleks = overhaul('Aleks', 'Russische Telefonnummer', 'Nach dem Anrufen einer russischen Telefonnummer ist es in der Lage, die von ihm selbst generierten Punkte einmalig auf das Maximum (99) zu fälschen.');
const matze = overhaul('Matze', 'Hundekarte!', 'Für jede ausgespielte Hundekarte erhält man +10 auf FIS und +5 auf alle anderen Stats.');
const luca = overhaul('Luca', 'Simulationsspiel-Erfahrung', 'Aufgrund seiner wirtschaftlichen Erfahrungen aus Simulationsspielen ist er in der Lage, sein eigenes BWL-Niveau um 50 % zu steigern.');
// Mark, the Suntouched (Season 1): neue Karte, Platzhalter-Werte in stats.js, Fähigkeit „Sonnendurchbruch“ in abilities.js
const mark = (id, rarity) => ({ ...overhaul('Mark', 'Sonnendurchbruch', 'Zur Halbzeit bricht die Sonne durch: In Quests und Dungeons verlängert sich die Zeit um 50 % der Gesamtdauer, im Mage Tower füllt er den Bock seiner Gruppe um 30 % auf. Danach erhalten er und seine Gruppe +5 auf alle Werte.')(id, rarity, 'Mark, the Suntouched'), season: 'season-1' });
// Mirjam, the Gracebringer (Season 1): neue Karte, Platzhalter-Werte in stats.js, Fähigkeit „Alles Pink!“ in abilities.js
const mirjam = (id, rarity) => ({ ...overhaul('Mirjam', 'Alles Pink!', 'Zur Halbzeit verdoppelt Mirjam bei sich selbst und bei jedem Gruppenmitglied den jeweils niedrigsten Wert.')(id, rarity, 'Mirjam, the Gracebringer'), season: 'season-1' });
// Hunde (Spell, ohne Werte): Rahmen ohne Wertefenster, Plakette „✦ SPELL“ (rar-holo-spell)
const DOG_TEXT = 'Jede ausgespielte Hundekarte erhöht alle Werte der freundlichen Charaktere um 3. Es können maximal zwei Hunde gleichzeitig ausgespielt werden, und derselbe Hund darf nicht mehrfach ausgespielt werden.';
const dog = (name) => ({ season: 'pre-season', frame: 'rar-holo-spell', name, stats: [0, 0, 0, 0], ability: DOG_TEXT });
const OVERHAUL = {
  'omer-1-crumpled': omer('omer-1-crumpled', 'crumpled', 'Ömer the Crumpled'),
  'omer-2-bfwler': omer('omer-2-bfwler', 'bfwler', 'Ömer the BFWler'),
  'omer-3-gold': omer('omer-3-gold', 'gold', 'Ömer the Golden'),
  'omer-4-holo': omer('omer-4-holo', 'holo', 'Ömer the Holographic'),
  'omer-5-bockhaber': omer('omer-5-bockhaber', 'bockhaber', 'Ömer the Bockhaber'),
  'omer-6-glitch': omer('omer-6-glitch', 'glitch', 'Glitch the Ömered'),
  'aleks-1-crumpled': aleks('aleks-1-crumpled', 'crumpled', 'Aleks the Crumpled'),
  'aleks-2-bfwler': aleks('aleks-2-bfwler', 'bfwler', 'Aleks the BFWler'),
  'aleks-3-gold': aleks('aleks-3-gold', 'gold', 'Aleks the Golden'),
  'aleks-4-holo': aleks('aleks-4-holo', 'holo', 'Aleks the Holographic'),
  'aleks-5-bockhaber': aleks('aleks-5-bockhaber', 'bockhaber', 'Aleks the Bockhaber'),
  'aleks-6-glitch': aleks('aleks-6-glitch', 'glitch', 'Glitch the Aleksed'),
  'matze-1-crumpled': matze('matze-1-crumpled', 'crumpled', 'Matze the Crumpled'),
  'matze-2-bfwler': matze('matze-2-bfwler', 'bfwler', 'Matze the BFWler'),
  'matze-3-gold': matze('matze-3-gold', 'gold', 'Matze the Golden'),
  'matze-4-holo': matze('matze-4-holo', 'holo', 'Matze the Holographic'),
  'matze-5-bockhaber': matze('matze-5-bockhaber', 'bockhaber', 'Matze the Bockhaber'),
  'matze-6-glitch': matze('matze-6-glitch', 'glitch', 'Glitch the Matzed'),
  'luca-1-crumpled': luca('luca-1-crumpled', 'crumpled', 'Luca the Crumpled'),
  'luca-2-bfwler': luca('luca-2-bfwler', 'bfwler', 'Luca the BFWler'),
  'luca-3-gold': luca('luca-3-gold', 'gold', 'Luca the Golden'),
  'luca-4-holo': luca('luca-4-holo', 'holo', 'Luca the Holographic'),
  'luca-5-bockhaber': luca('luca-5-bockhaber', 'bockhaber', 'Luca the Bockhaber'),
  'luca-6-glitch': luca('luca-6-glitch', 'glitch', 'Glitch the Lucaed'),
  'mark-1-crumpled': mark('mark-1-crumpled', 'crumpled'),
  'mark-2-bfwler': mark('mark-2-bfwler', 'bfwler'),
  'mark-3-gold': mark('mark-3-gold', 'gold'),
  'mark-4-holo': mark('mark-4-holo', 'holo'),
  'mark-5-bockhaber': mark('mark-5-bockhaber', 'bockhaber'),
  'mark-6-glitch': mark('mark-6-glitch', 'glitch'),
  'mirjam-1-crumpled': mirjam('mirjam-1-crumpled', 'crumpled'),
  'mirjam-2-bfwler': mirjam('mirjam-2-bfwler', 'bfwler'),
  'mirjam-3-gold': mirjam('mirjam-3-gold', 'gold'),
  'mirjam-4-holo': mirjam('mirjam-4-holo', 'holo'),
  'mirjam-5-bockhaber': mirjam('mirjam-5-bockhaber', 'bockhaber'),
  'mirjam-6-glitch': mirjam('mirjam-6-glitch', 'glitch'),
  'hugo-holo': dog('Hugo'),
  'lilly-holo': dog('Lilly'),
};

module.exports = {
  ...TEST_ITEMS,
  ...OVERHAUL,
  ...TEST_HELDEN,
  ...SEASON1_UNRELEASED,
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

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
module.exports = {
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

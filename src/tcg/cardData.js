// Karten mit gezeichnetem Rahmen (ab Season 1): Das Bild in public/img/tcg enthält nur Rahmen und Motiv –
// Werte und Fähigkeitstext stehen hier und werden per Code auf die Karte gesetzt (src/tcg/cardSvg.js).
// Buffen/Nerfen = Zahl hier ändern, kein neues Bild nötig.
//
// Schlüssel = Karten-ID aus dem Dateinamen ("st-ivan-boss.webp" -> "st-ivan-boss").
//   season:  Schlüssel aus src/tcg/seasons.js
//   frame:   Rahmen-Layout aus src/tcg/frames.js (wo die Fenster auf dem Bild liegen)
//   name:    Name wie auf der Karte (sonst aus dem Dateinamen)
//   stats:   [Speed, FIA, FIS, BWL]
//   ability: Fähigkeitstext im großen Fenster
module.exports = {
  'st-ivan-boss': {
    season: 'season-1',
    frame: 'gilded',
    name: 'St. Ivan, the Forsaken',
    stats: [96, 95, 99, 90],
    // Forkbomb (Idee: Krisztian) – wirkt auf gegnerische Karten, also erst im kommenden Spielmodus
    ability: '„Forkbomb“: Alle gegnerischen Karten werden 20 % langsamer, jede Runde lässt der Effekt um 2 % nach. Reinigende Karten (z. B. St. Ivans „Backup“) heben ihn auf; verlässt St. Ivan das Spielfeld (z. B. durch Hermann), endet er sofort.',
  },
};

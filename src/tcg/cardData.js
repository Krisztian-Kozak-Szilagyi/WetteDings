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
    // Platzhalter – den endgültigen Text schreibt Krisztian
    ability: 'Platzhalter – die Fähigkeit von St. Ivan folgt.',
  },
};

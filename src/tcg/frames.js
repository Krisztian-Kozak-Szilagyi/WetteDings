// Rahmen-Layouts für Karten mit gezeichnetem Rahmen (src/tcg/cardData.js). Koordinaten in Bildpixeln (720 × 1008),
// gemessen an den goldenen Fenstern im Bild. Neuer Rahmen = neuer Eintrag; Karten wählen ihn mit frame: '<key>'.
//   stats: Mittelpunkt der kleinen Fenster (Bezeichnung oben, Zahl darunter)
//   speed: Plakette rechts neben dem Namensbalken
//   text:  Innenfläche des großen Fensters für den Fähigkeitstext (Schrift wird kleiner, bis er passt)
module.exports = {
  gilded: {
    width: 720,
    height: 1008,
    stats: [
      { key: 'fia', label: 'FIA', x: 111, y: 432 },
      { key: 'fis', label: 'FIS', x: 111, y: 563 },
      { key: 'bwl', label: 'BWL', x: 111, y: 691 },
    ],
    speed: { x: 454, y: 46, w: 104, h: 56 },
    text: { x: 104, y: 806, w: 494, h: 112, size: 25, minSize: 15, lineHeight: 1.32 },
    colors: {
      value: '#f6d58e', // wie der Kartentitel
      label: '#c99a4e',
      text: '#f3e4cb',
      outline: '#2a0507',
      plate: '#4a0b10',
      plateBorder: '#d6a54c',
      up: '#8fe8a8', // gebuffter Wert (z. B. durch einen Boost im Kampf)
      down: '#a8bfff', // geschwächter Wert
    },
  },
};

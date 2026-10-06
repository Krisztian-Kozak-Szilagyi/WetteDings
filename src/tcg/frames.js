// Rahmen-Layouts für Karten mit gezeichnetem Rahmen (src/tcg/cardData.js). Koordinaten in Bildpixeln (720 × 1008),
// gemessen an den goldenen Fenstern im Bild. Neuer Rahmen = neuer Eintrag; Karten wählen ihn mit frame: '<key>'.
//   stats: Mittelpunkt der kleinen Fenster (Bezeichnung oben, Zahl darunter)
//   speed: Plakette oben rechts, am rechten Kartenrand (nicht direkt am Namen)
//   text:  Innenfläche des großen Fensters für den Fähigkeitstext (Schrift wird kleiner, bis er passt)
module.exports = {
  // Item-Karten (Waffen, Schilde, Zauber; 720 × 1080): nur Name im Bild und ein großes Textfenster unten, keine Werte
  item: {
    width: 720,
    height: 1080,
    stats: [],
    speed: null,
    text: { x: 92, y: 866, w: 536, h: 128, size: 30, minSize: 18, lineHeight: 1.3 },
    colors: {
      value: '#f6d58e',
      label: '#c99a4e',
      text: '#f3e4cb',
      outline: '#2a0507',
      plate: '#4a0b10',
      plateBorder: '#d6a54c',
      up: '#8fe8a8',
      down: '#ff9b9b',
    },
  },
  gilded: {
    width: 720,
    height: 1008,
    stats: [
      { key: 'fia', label: 'FIA', x: 111, y: 432 },
      { key: 'fis', label: 'FIS', x: 111, y: 563 },
      { key: 'bwl', label: 'BWL', x: 111, y: 691 },
    ],
    speed: { x: 566, y: 46, w: 104, h: 56 },
    text: { x: 104, y: 806, w: 494, h: 112, size: 25, minSize: 15, lineHeight: 1.32 },
    colors: {
      value: '#f6d58e', // wie der Kartentitel
      label: '#c99a4e',
      text: '#f3e4cb',
      outline: '#2a0507',
      plate: '#4a0b10',
      plateBorder: '#d6a54c',
      up: '#8fe8a8', // gebuffter Wert (z. B. durch einen Boost im Kampf)
      down: '#ff9b9b', // geschwächter Wert (Debuff)
    },
  },
};

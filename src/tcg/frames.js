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

// Helden-Karten für den Bosskampf (720 × 1008): Fenster wie gilded, aber leerer Namensbalken (Name per Code) und
// Kampfwerte statt FIA/FIS/BWL – ANG = Schaden am Boss, SCH = Block gegen den nächsten Boss-Angriff, HEI = Heilung.
// Die Plakette oben rechts zeigt die Energiekosten. Werte kommen aus card.kampf (values), 0 erscheint als „–“.
module.exports.held = {
  ...module.exports.gilded,
  stats: [
    { key: 'ang', label: 'ANG', x: 111, y: 432 },
    { key: 'sch', label: 'SCH', x: 111, y: 563 },
    { key: 'hei', label: 'HEI', x: 111, y: 691 },
  ],
  name: { x: 251, y: 71, w: 400, size: 38, minSize: 24 }, // Mitte des Namensbalkens (bei allen Bildern gleich breit genug)
  dash: true,
  values: (card) => {
    const k = card.kampf || {};
    return { speed: k.kosten || 0, ang: k.ang || 0, sch: k.sch || 0, hei: k.hei || 0 };
  },
};

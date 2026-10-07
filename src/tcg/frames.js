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

// Helden-Karten für den Bosskampf (720 × 1008): leerer Namensbalken (Name per Code), Kampfwerte statt FIA/FIS/BWL –
// ANG = Schaden am Boss, SCH = Block gegen den nächsten Boss-Angriff, HEI = Heilung. Die Plakette zeigt die
// Energiekosten. Werte kommen aus card.kampf (values), 0 erscheint als „–“.
// name.y = senkrechte Mitte des Balkens (der Text wird an den Großbuchstaben ausgerichtet, siehe cardSvg.nameSvg).
const heldValues = (card) => {
  const k = card.kampf || {};
  return { speed: k.kosten || 0, ang: k.ang || 0, sch: k.sch || 0, hei: k.hei || 0 };
};
const heldStats = (x, ys) => [
  { key: 'ang', label: 'ANG', x, y: ys[0] },
  { key: 'sch', label: 'SCH', x, y: ys[1] },
  { key: 'hei', label: 'HEI', x, y: ys[2] },
];
const heldFrame = (o) => ({ ...module.exports.gilded, dash: true, values: heldValues, ...o, colors: { ...module.exports.gilded.colors, ...(o.colors || {}) } });

// Roter Rahmen (wie gilded): Plakette rechts neben dem Namensbalken
module.exports.held = heldFrame({
  stats: heldStats(111, [432, 563, 691]),
  name: { x: 251, y: 70, w: 400, size: 38, minSize: 24 },
});

// Grüner Druiden-Rahmen mit Ranken (Verdant Druid): Fenster etwas höher als beim roten Rahmen
module.exports.druide = heldFrame({
  stats: heldStats(106, [422, 549, 675]),
  name: { x: 248, y: 71, w: 390, size: 38, minSize: 24 },
  text: { x: 100, y: 778, w: 520, h: 124, size: 25, minSize: 15, lineHeight: 1.32 },
  colors: { plate: '#123018', label: '#c9b06a' },
});

// Breite Namensbalken (Hain, Nekro, Eis): die Plakette sitzt rechts im Balken, der Name links davon
module.exports.hain = heldFrame({
  stats: heldStats(113, [406, 511, 625]),
  name: { x: 267, y: 81, w: 380, size: 38, minSize: 24 },
  speed: { x: 474, y: 55, w: 104, h: 54 },
  text: { x: 100, y: 772, w: 520, h: 150, size: 26, minSize: 15, lineHeight: 1.32 },
  colors: { plate: '#123018', label: '#c9b06a' },
});
module.exports.nekro = heldFrame({
  stats: heldStats(115, [406, 514, 625]),
  name: { x: 302, y: 75, w: 400, size: 38, minSize: 24 },
  speed: { x: 540, y: 49, w: 104, h: 54 },
  text: { x: 95, y: 772, w: 530, h: 150, size: 26, minSize: 15, lineHeight: 1.32 },
  colors: { value: '#d8fff6', label: '#7fe3d2', text: '#e3f2ef', outline: '#05100e', plate: '#16211f', plateBorder: '#5fe0d0' },
});
module.exports.eis = heldFrame({
  stats: heldStats(115, [406, 514, 625]),
  name: { x: 301, y: 71, w: 400, size: 38, minSize: 24 },
  speed: { x: 528, y: 44, w: 104, h: 54 },
  text: { x: 92, y: 772, w: 536, h: 150, size: 26, minSize: 15, lineHeight: 1.32 },
  colors: { value: '#eaf6ff', label: '#9fc8ee', text: '#e6f1fb', outline: '#06122a', plate: '#0e2446', plateBorder: '#9fd0ff' },
});

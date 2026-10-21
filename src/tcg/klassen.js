// Klassen (Meta-Patch): jede Karte mit neuem Design hat eine Klasse – sie steht im dritten Wertefenster (Symbol und
// Name) und ist die Grundlage für Synergien und Team-Building. Erst einmal drei: Tank, Schaden, Heiler.
// Symbole als SVG-Pfade im 24er-Raster, gezeichnet von src/tcg/cardSvg.js in den Farben der Seltenheit.
const SWORD = '<path d="M20.8 2.2 21.8 3.2 21 6.4 11.4 16 8 12.6 17.6 3Z"/><path d="M5.2 11.4 6.6 10 14 17.4 12.6 18.8Z"/><path d="M8.6 15.4 10.6 17.4 6.2 21.8 4.2 19.8Z"/><circle cx="4.1" cy="21.9" r="1.6"/>';
const SHIELD = '<path d="M12 1.8 20.4 5v6.2c0 5.6-3.6 9.6-8.4 11.1-4.8-1.5-8.4-5.5-8.4-11.1V5Z"/>';
const CROSS = '<path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7Z"/>';
const HEART = '<path d="M12 21.4 3.5 13.1C1.1 10.7 1.1 6.9 3.5 4.6 5.8 2.4 9.4 2.6 12 5.4c2.6-2.8 6.2-3 8.5-.8 2.4 2.3 2.4 6.1 0 8.5Z"/>';
const COIN = '<circle cx="12" cy="12" r="10.5"/><circle cx="12" cy="12" r="7.3" fill="none" stroke="rgba(0,0,0,.4)" stroke-width="1.4"/><path d="M12 7.2 13.4 10.6 17 12 13.4 13.4 12 16.8 10.6 13.4 7 12 10.6 10.6Z" fill="rgba(0,0,0,.4)"/>';

const KLASSEN = [
  { key: 'tank', name: 'Tank', icon: SHIELD },
  { key: 'schaden', name: 'Schaden', icon: SWORD },
  { key: 'heiler', name: 'Heiler', icon: CROSS },
];
const klasseByKey = Object.fromEntries(KLASSEN.map((k) => [k.key, k]));

// Symbole der Werte: Angriff (Schwert) und Leben (Herz) in den Fenstern, Kosten (Münze, Mana) in der Plakette
const VALUE_ICONS = { ang: SWORD, leb: HEART, kosten: COIN };

module.exports = { KLASSEN, klasseByKey, VALUE_ICONS };

// Seasons: Jede Karte gehört zu genau einer Season. Auf der Vorderseite steht sie nicht – man erkennt sie an der
// Rückseite (CSS-Klasse "season-<key>", siehe .tcg-back / .foil-back-art / .gr-back in style.css).
// Neue Season = Eintrag hier + Rückseite im CSS; die Karten nennen ihre Season in src/tcg/cardData.js.
// Reihenfolge = zeitlich (älteste zuerst). Im Album steht die neueste oben.
const SEASONS = [
  { key: 'pre-season', label: 'Pre-Season' },
  { key: 'season-1', label: 'Season 1' },
];

// Alle Karten ohne eigenen Eintrag in cardData.js stammen aus der Pre-Season
const DEFAULT_SEASON = SEASONS[0].key;
const seasonByKey = Object.fromEntries(SEASONS.map((s, i) => [s.key, { ...s, order: i }]));

module.exports = { SEASONS, DEFAULT_SEASON, seasonByKey };

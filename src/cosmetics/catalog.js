// Kosmetik: feste Liste der kaufbaren Dinge. Vorerst nur Avatare – später kommen weitere Arten dazu
// (Banner, Avatar-Rahmen, Namensschilder …): je Art ein Eintrag in KINDS und eine eigene Liste.
// Gekauft wird mit Konfetti (zerkleinerte Karten), alles ist an das Konto gebunden (kein Handel).
// Preis, Effekt und Name stellt der Admin ein (Spielwerte → Kosmetik); hier stehen nur die Startwerte.

const KINDS = [{ key: 'avatar', label: 'Avatare' }];

// Effekte, die der Admin einem Avatar geben kann (CSS-Klasse cos-fx-<key>, siehe style.css)
const EFFECTS = [
  { key: '', label: 'Kein Effekt' },
  { key: 'glitch', label: 'Glitch' },
  { key: 'gold', label: 'Goldglanz' },
  { key: 'holo', label: 'Holo' },
  { key: 'glow', label: 'Leuchten' },
  { key: 'arcane', label: 'Arcane' },
];

// Startpreise in Konfetti (1 Konfetti = 1 € Bankwert einer zerkleinerten Karte):
// einfache Vektor-Gesichter günstiger, gezeichnete Bilder etwas teurer.
const SIMPLE = 100;
const DRAWN = 250;

const AVATARS = [
  { key: 'anna', name: 'Anna', ext: 'webp', price: DRAWN },
  { key: 'bolond-gomba', name: 'Verrückter Pilz', ext: 'svg', price: SIMPLE },
  { key: 'bolond-gomba-2', name: 'Verrückter Pilz II', ext: 'svg', price: SIMPLE },
  { key: 'dog-1', name: 'Wuschel', ext: 'webp', price: DRAWN },
  { key: 'face', name: 'Der Blick', ext: 'svg', price: SIMPLE },
  { key: 'face2', name: 'Der Schrei', ext: 'svg', price: SIMPLE },
  { key: 'girnyo', name: 'Der Wurm', ext: 'svg', price: SIMPLE },
  { key: 'goblin', name: 'Goblin', ext: 'webp', price: DRAWN },
  { key: 'koponya', name: 'Totenkopf', ext: 'webp', price: DRAWN },
  { key: 'krisz-csabit', name: 'Der Schnurrbart', ext: 'webp', price: DRAWN },
  { key: 'polip-lany', name: 'Krakenmädchen', ext: 'webp', price: DRAWN },
  { key: 'sisak', name: 'Der Helm', ext: 'webp', price: DRAWN },
  { key: 'sushi', name: 'Sushi', ext: 'svg', price: SIMPLE },
  { key: 'teki', name: 'Der Schamane', ext: 'webp', price: DRAWN },
  { key: 'wow-1', name: 'Die Waldläuferin', ext: 'webp', price: DRAWN },
  { key: 'wow-2', name: 'Der Schlächter', ext: 'webp', price: DRAWN },
  { key: 'wow-3', name: 'Der Verräter', ext: 'webp', price: DRAWN },
  { key: 'wow-4', name: 'Die Elfe', ext: 'webp', price: DRAWN },
  { key: 'wow-5', name: 'Der Schädelsammler', ext: 'webp', price: DRAWN },
  { key: 'wow-6', name: 'Der Ork', ext: 'webp', price: DRAWN },
  { key: 'wow-7', name: 'Der Frostkönig', ext: 'webp', price: DRAWN },
  { key: 'zander', name: 'Zander', ext: 'webp', price: DRAWN },
].map((a) => ({ ...a, kind: 'avatar', effect: '', url: `/img/avatars/${a.key}.${a.ext}` }));

/** Eintrag im Besitz-Array (User.cosmetics), z. B. "avatar:anna" */
const ownedKey = (kind, key) => `${kind}:${key}`;

/** Kaufbarer Eintrag zu (vom Nutzer gesendeter) Art und Schlüssel – nur aus der festen Liste */
const findItem = (kind, key) => (kind === 'avatar' ? AVATARS.find((a) => a.key === key) || null : null);

const findEffect = (key) => EFFECTS.find((e) => e.key === key) || null;

module.exports = { KINDS, EFFECTS, AVATARS, ownedKey, findItem, findEffect };

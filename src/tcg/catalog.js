const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const STATS = require('./stats');

const IMAGE_DIR = path.join(__dirname, '..', '..', 'public', 'img', 'tcg');
const IMAGE_URL = '/img/tcg';
/** Bild-URL mit Änderungszeit als Version – ausgetauschte Bilder umgehen so den Browser-Cache */
function imageUrl(file) {
  let v = '';
  try {
    v = `?v=${Math.floor(fs.statSync(path.join(IMAGE_DIR, file)).mtimeMs).toString(36)}`;
  } catch {
    // Datei fehlt – ohne Version
  }
  return `${IMAGE_URL}/${file}${v}`;
}

const PACK_IMAGE = imageUrl('bfw-holdings-booster-pack.png');
const CARDS_PER_PACK = 3;

// Booster-Pack-Arten. Später kommen weitere dazu (eigener Schlüssel, Name und Bild).
const PACK_TYPES = [{ key: 'bfw-holdings', label: 'BfW Holdings Booster Pack', image: PACK_IMAGE }];
const DEFAULT_PACK = PACK_TYPES[0].key;
const packTypeByKey = Object.fromEntries(PACK_TYPES.map((p) => [p.key, p]));

/**
 * Seltenheiten von häufig nach selten. weight = Chance pro Karte in 1/10.000 (Summe 10.000),
 * sell = Verkaufspreis in Cent.
 *
 * Erwartungswert pro Karte: 23,85 € -> pro Pack 71,56 € bei 80 € Packpreis (~89 % Rückfluss).
 * Ein schwaches Pack (2× Crumpled + 1× BFWler = 30 €) bleibt klar im Minus.
 *
 * hidden = geheime Seltenheit: taucht für Mitglieder weder in den Drop-Raten noch im Filter auf.
 */
const RARITIES = [
  { key: 'crumpled', label: 'Crumpled', weight: 5809, sell: 500 },
  { key: 'bfwler', label: 'BFWler', weight: 2800, sell: 2000 },
  { key: 'gold', label: 'Gold', weight: 1100, sell: 4000 },
  { key: 'holo', label: 'Holo', weight: 250, sell: 15000 },
  { key: 'bockhaber', label: 'Bockhaber', weight: 30, sell: 100000 },
  { key: 'glitch', label: 'Glitch', weight: 8, sell: 300000 },
  { key: 'icon', label: 'Icon', weight: 2, sell: 400000 },
  { key: 'sith', label: 'Sith', weight: 1, sell: 1000000, hidden: true },
];
const TOTAL_WEIGHT = RARITIES.reduce((s, r) => s + r.weight, 0);
// Standardwerte; Chancen und Preise können im Admin-Panel geändert werden (src/tcg/settings.js).
// Die Chancen ergeben dabei immer zusammen TOTAL_WEIGHT (= 100 %).
const DEFAULT_SELL = Object.fromEntries(RARITIES.map((r) => [r.key, r.sell]));
const DEFAULT_WEIGHT = Object.fromEntries(RARITIES.map((r) => [r.key, r.weight]));
RARITIES.forEach((r, i) => {
  r.rank = i;
});
// Gleiche Objekte wie in RARITIES, damit Preisänderungen überall sofort gelten
const rarityByKey = Object.fromEntries(RARITIES.map((r) => [r.key, r]));
/** Seltenheiten, die Mitglieder sehen dürfen (ohne die geheimen) */
const visibleRarities = () => RARITIES.filter((r) => !r.hidden);

// Namen, die sich nicht automatisch aus dem Dateinamen ergeben (so wie sie auf der Karte stehen)
const NAME_OVERRIDES = {
  'casino-kaffee': 'Casino-Kaffee',
  'st-ivan': 'St. Ivan',
  omer: 'Ömer',
  'grafikkarte-amd': 'AMD-Grafikkarte',
  'grafikkarte-nvidia': 'NVIDIA-Grafikkarte',
  seven: '7',
  'oliver-the-sigrist': 'Oliver the Sigrist',
};

/** "bfw-energy" -> "BFW Energy", "krisz" -> "Krisz" */
function prettyName(slug) {
  if (NAME_OVERRIDES[slug]) return NAME_OVERRIDES[slug];
  return slug
    .split('-')
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Karten aus den Dateinamen in public/img/tcg lesen: "<name>[-<nr>]-<seltenheit>.png",
 * z. B. "krisz-6-glitch.png" oder "bfw-energy-gold.png". Neue Karten = einfach Datei ablegen.
 * Optional mit Werten (Speed-FIA-FIS-BWL): "anna-3-gold_36-39-21-12.png" – die Karten-ID bleibt "anna-3-gold".
 */
function loadCards(dir = IMAGE_DIR) {
  const pattern = new RegExp(`^(.+?)(?:-\\d+)?-(${RARITIES.map((r) => r.key).join('|')})(?:_(\\d+)-(\\d+)-(\\d+)-(\\d+))?\\.(png|jpe?g|webp)$`, 'i');
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .map((file) => {
      const m = file.match(pattern);
      if (!m) return null;
      const rarity = m[2].toLowerCase();
      const id = file.replace(/(_\d+-\d+-\d+-\d+)?\.[^.]+$/, '').toLowerCase();
      const raw = m[3] ? [m[3], m[4], m[5], m[6]].map(Number) : STATS[id];
      const stats = raw ? { speed: raw[0], fia: raw[1], fis: raw[2], bwl: raw[3] } : null;
      return {
        id,
        name: prettyName(m[1].toLowerCase()),
        rarity,
        image: imageUrl(file),
        stats,
        // Charakter = hat FIA/FIS/BWL-Werte (Items wie Kaffee oder Grafikkarte haben 0)
        isCharacter: !!stats && stats.speed > 0 && stats.fia + stats.fis + stats.bwl > 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => rarityByKey[a.rarity].rank - rarityByKey[b.rarity].rank || a.name.localeCompare(b.name, 'de'));
}

const CARDS = loadCards();
const cardById = Object.fromEntries(CARDS.map((c) => [c.id, c]));
const cardsByRarity = Object.fromEntries(RARITIES.map((r) => [r.key, CARDS.filter((c) => c.rarity === r.key)]));

/** Seltenheit würfeln: roll ist eine Zahl 0 … TOTAL_WEIGHT−1 */
function rarityForRoll(roll) {
  let acc = 0;
  for (const r of RARITIES) {
    acc += r.weight;
    if (roll < acc) return r.key;
  }
  return RARITIES[0].key;
}

/**
 * Eine Karte ziehen: erst die Seltenheit, dann gleichverteilt eine Karte dieser Seltenheit.
 * Gibt es für eine Seltenheit (noch) keine Karte, wird auf die nächsthäufigere ausgewichen.
 */
function drawCard(randomInt = crypto.randomInt) {
  let rank = rarityByKey[rarityForRoll(randomInt(TOTAL_WEIGHT))].rank;
  while (rank > 0 && !cardsByRarity[RARITIES[rank].key].length) rank--;
  const pool = cardsByRarity[RARITIES[rank].key];
  if (!pool.length) throw new Error('Keine TCG-Karten gefunden (public/img/tcg).');
  return pool[randomInt(pool.length)];
}

function drawPack(randomInt = crypto.randomInt) {
  return Array.from({ length: CARDS_PER_PACK }, () => drawCard(randomInt));
}

/** Erwartungswert (Cent) einer Karte bzw. eines Packs beim Verkauf */
const expectedCardValue = () => RARITIES.reduce((s, r) => s + (r.weight / TOTAL_WEIGHT) * r.sell, 0);
const expectedPackValue = () => expectedCardValue() * CARDS_PER_PACK;

/** Chance pro Karte als Anteil (0 … 1) */
const chance = (key) => rarityByKey[key].weight / TOTAL_WEIGHT;

module.exports = {
  PACK_IMAGE,
  CARDS_PER_PACK,
  PACK_TYPES,
  DEFAULT_PACK,
  packTypeByKey,
  RARITIES,
  DEFAULT_SELL,
  DEFAULT_WEIGHT,
  TOTAL_WEIGHT,
  CARDS,
  rarityByKey,
  visibleRarities,
  cardById,
  cardsByRarity,
  prettyName,
  loadCards,
  rarityForRoll,
  drawCard,
  drawPack,
  expectedCardValue,
  expectedPackValue,
  chance,
};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const STATS = require('./stats');
const CARD_DATA = require('./cardData');
const FRAMES = require('./frames');
const { SEASONS, DEFAULT_SEASON, seasonByKey } = require('./seasons');

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

const PACK_IMAGE = imageUrl('bfw-holdings-booster-pack.webp');
const CARDS_PER_PACK = 5;

// Booster-Pack-Arten. Später kommen weitere dazu (eigener Schlüssel, Name und Bild).
const PACK_TYPES = [{ key: 'bfw-holdings', label: 'BfW Holdings Booster Pack', image: PACK_IMAGE }];
const DEFAULT_PACK = PACK_TYPES[0].key;
const packTypeByKey = Object.fromEntries(PACK_TYPES.map((p) => [p.key, p]));

/**
 * Seltenheiten von häufig nach selten. weight = Chance pro Karte in 1/10.000 (Summe 10.000),
 * sell = Verkaufspreis in Cent.
 *
 * Erwartungswert pro Karte: 23,85 € -> pro Pack (5 Karten) 119,27 €. Den Packpreis stellt das Admin-Panel ein.
 *
 * hidden = geheime Seltenheit: taucht für Mitglieder weder in den Drop-Raten noch im Filter auf.
 */
const RARITIES = [
  { key: 'crumpled', label: 'Crumpled', weight: 5809, sell: 300 },
  { key: 'bfwler', label: 'BFWler', weight: 2800, sell: 1300 },
  { key: 'gold', label: 'Gold', weight: 1100, sell: 2000 },
  { key: 'holo', label: 'Holo', weight: 250, sell: 5000 },
  { key: 'bockhaber', label: 'Bockhaber', weight: 30, sell: 50000 },
  { key: 'glitch', label: 'Glitch', weight: 8, sell: 250000 },
  { key: 'icon', label: 'Icon', weight: 2, sell: 400000 },
  { key: 'sith', label: 'Sith', weight: 1, sell: 1000000, hidden: true },
];
const TOTAL_WEIGHT = RARITIES.reduce((s, r) => s + r.weight, 0);
/**
 * Seltenheiten, die nie aus Packs kommen, sondern nur als Beute (z. B. Boss-Karte aus dem Dungeon).
 * Sie stehen nicht in RARITIES (Pack-Chancen, Admin-Chancen, Bots, Grading bleiben unberührt), sind aber über
 * rarityByKey, cardsByRarity und visibleRarities() überall bekannt. noBank = die Bank kauft sie nicht an;
 * sell ist dann nur der Kartenwert (zählt zum Vermögen, foliert mit Wertsteigerung), kein Ankaufspreis.
 */
const DROP_RARITIES = [{ key: 'boss', label: 'Boss', weight: 0, sell: 500000, dropOnly: true, noBank: true }];
const ALL_RARITIES = [...RARITIES, ...DROP_RARITIES];
// Standardwerte; Chancen und Preise können im Admin-Panel geändert werden (src/tcg/settings.js).
// Die Chancen ergeben dabei immer zusammen TOTAL_WEIGHT (= 100 %).
const DEFAULT_SELL = Object.fromEntries(RARITIES.map((r) => [r.key, r.sell]));
const DEFAULT_WEIGHT = Object.fromEntries(RARITIES.map((r) => [r.key, r.weight]));
ALL_RARITIES.forEach((r, i) => {
  r.rank = i;
});
// Gleiche Objekte wie in RARITIES, damit Preisänderungen überall sofort gelten
const rarityByKey = Object.fromEntries(ALL_RARITIES.map((r) => [r.key, r]));
/** Seltenheiten, die Mitglieder sehen dürfen (ohne die geheimen) */
const visibleRarities = () => ALL_RARITIES.filter((r) => !r.hidden);

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
 * Karten aus den Dateinamen in public/img/tcg lesen: "<name>[-<nr>]-<seltenheit>.webp",
 * z. B. "krisz-6-glitch.webp" oder "bfw-energy-gold.webp". Neue Karten = einfach Datei ablegen
 * (PNG geht auch; "npm run webp" wandelt sie um).
 * Optional mit Werten (Speed-FIA-FIS-BWL): "anna-3-gold_36-39-21-12.webp" – die Karten-ID bleibt "anna-3-gold".
 */
function loadCards(dir = IMAGE_DIR) {
  const pattern = new RegExp(`^(.+?)(?:-\\d+)?-(${ALL_RARITIES.map((r) => r.key).join('|')})(?:_(\\d+)-(\\d+)-(\\d+)-(\\d+))?\\.(png|jpe?g|webp)$`, 'i');
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
      // Karten mit gezeichnetem Rahmen: Werte und Text aus cardData.js, Bild als SVG mit eingesetzten Werten
      const data = Object.prototype.hasOwnProperty.call(CARD_DATA, id) ? CARD_DATA[id] : null;
      const framed = !!(data && FRAMES[data.frame]);
      const raw = framed ? data.stats : m[3] ? [m[3], m[4], m[5], m[6]].map(Number) : STATS[id];
      const stats = raw ? { speed: raw[0], fia: raw[1], fis: raw[2], bwl: raw[3] } : null;
      const card = {
        id,
        name: (data && data.name) || prettyName(m[1].toLowerCase()),
        rarity,
        season: data && seasonByKey[data.season] ? data.season : DEFAULT_SEASON,
        stats,
        // Charakter = hat FIA/FIS/BWL-Werte (Items wie Kaffee oder Grafikkarte haben 0)
        isCharacter: !!stats && stats.speed > 0 && stats.fia + stats.fis + stats.bwl > 0,
      };
      // Kampfwerte (eigener Block, nur neue Karten) – macht die Karte deckfähig (src/game/deck.js)
      if (data && data.kampf) card.kampf = data.kampf;
      if (framed) Object.assign(card, { frame: data.frame, ability: data.ability || '', abilityName: data.abilityName || '', artFile: path.join(dir, file) });
      // Bild-URL bei jedem Zugriff neu (Version = Änderungszeit): ein ausgetauschtes Bild erscheint ohne Neustart
      Object.defineProperty(card, 'image', { enumerable: true, get: () => (framed ? cardImage(card) : imageUrl(file)) });
      return card;
    })
    .filter(Boolean)
    .sort((a, b) => rarityByKey[a.rarity].rank - rarityByKey[b.rarity].rank || a.name.localeCompare(b.name, 'de'));
}

const CARDS = loadCards();
const cardById = Object.fromEntries(CARDS.map((c) => [c.id, c]));
const cardsByRarity = Object.fromEntries(ALL_RARITIES.map((r) => [r.key, CARDS.filter((c) => c.rarity === r.key)]));
const cardsBySeason = Object.fromEntries(SEASONS.map((s) => [s.key, CARDS.filter((c) => c.season === s.key)]));

/**
 * Bild-URL einer Rahmen-Karte (SVG, src/tcg/cardSvg.js). values: abweichende Werte, z. B. { fia: 110 } bei einem Boost –
 * sie erscheinen farbig auf der Karte. v = Version aus Werten, Text und Bild: Änderungen umgehen den Browser-Cache.
 */
function cardImage(card, values = {}) {
  let mtime = 0;
  try {
    mtime = Math.floor(fs.statSync(card.artFile).mtimeMs);
  } catch {
    // Datei fehlt – ohne Bildversion
  }
  const v = crypto.createHash('sha1').update(JSON.stringify([card.name, card.frame, card.stats, card.abilityName, card.ability, mtime])).digest('hex').slice(0, 10);
  const q = ['speed', 'fia', 'fis', 'bwl'].filter((k) => Number.isInteger(values[k]) && card.stats && values[k] !== card.stats[k]).map((k) => `${k}=${Math.max(0, Math.min(999, values[k]))}`);
  return `${IMAGE_URL}/karte/${card.id}.svg?${[...q, `v=${v}`].join('&')}`;
}

/**
 * Bilder einer Rahmen-Karte für die Werte-Wechsel einer Kampf-Wiedergabe: { "Speed,FIA,FIS,BWL": URL }.
 * ticks: Takte aus ihkService.simulate (st = neue Werte). Karten ohne Rahmen (Werte im Bild) liefern {}.
 */
function statImages(card, ticks) {
  const out = {};
  if (!card || !card.frame) return out;
  for (const t of ticks || []) {
    const st = t && t.st;
    if (!st || st.length !== 4) continue;
    out[st.join(',')] = cardImage(card, { speed: st[0], fia: st[1], fis: st[2], bwl: st[3] });
  }
  return out;
}

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
  DROP_RARITIES,
  ALL_RARITIES,
  SEASONS,
  seasonByKey,
  cardsBySeason,
  cardImage,
  statImages,
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

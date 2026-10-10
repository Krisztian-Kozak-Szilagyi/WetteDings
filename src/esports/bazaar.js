// Lil Dré's Bazaar – reine Logik (kein Datenbankzugriff). Laden für eSports-Teams mit mindestens TEAM_SIZE Mitgliedern
// im Handel. Jedes Team hat seinen eigenen Laden: OFFER_COUNT Plätze, jeder Platz wird unabhängig aus POOL gewürfelt
// (dieselbe Karte darf mehrmals vorkommen). Kauft ein Mitglied einen Platz, ist er für das ganze Team weg.
// Neue Ware jeden Tag um 00:00 (deutsche Zeit). Preis: PRICE_PERCENT % des Bank-Verkaufspreises der Seltenheit.
const catalog = require('../tcg/catalog');

const OFFER_COUNT = 4;
const PRICE_PERCENT = 150;
// Nur was im eSports-Live-Turm nutzbar ist (src/dungeon/liveTower.js: COFFEE, ENERGY_CARD)
const POOL = ['casino-kaffee-1-crumpled', 'casino-kaffee-2-bfwler', 'casino-kaffee-3-gold', 'bfw-energy-gold'];

/** Preis in Cent: 150 % des aktuellen Verkaufspreises der Seltenheit */
const priceFor = (rarity) => Math.round((((catalog.rarityByKey[rarity] || {}).sell || 0) * PRICE_PERCENT) / 100);

/** Karten des Pools, die wirklich im Katalog stehen */
const poolCards = (cardById = catalog.cardById) => POOL.map((id) => cardById[id]).filter(Boolean);

/** Vier Plätze würfeln: je Platz randomInt(Poolgröße), Wiederholungen erlaubt */
function drawOffers(randomInt, cards = poolCards()) {
  if (!cards.length) return [];
  return Array.from({ length: OFFER_COUNT }, () => {
    const c = cards[randomInt(cards.length)];
    return { card: c.id, rarity: c.rarity, price: priceFor(c.rarity) };
  });
}

module.exports = { OFFER_COUNT, PRICE_PERCENT, POOL, priceFor, poolCards, drawOffers };

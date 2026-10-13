// Daten für die Sammlungs-Ansicht im Album-Look (Album und Sammlung eines Mitglieds): Slab-Regal, Kartennummern, Zertifikatsschild
const catalog = require('./catalog');
const population = require('./population');

/** Slabs einer Sammlung (collection().foiledCopies) als einzelne Karten, beste Note zuerst, dann seltenste Karte */
function slabCopiesOf(coll) {
  return Object.entries(coll.foiledCopies)
    .flatMap(([cardId, list]) => list.filter((f) => f.slab).map((f) => ({ ...f, card: catalog.cardById[cardId] })))
    .filter((s) => s.card)
    .sort((a, b) => b.slab.grade - a.slab.grade || (catalog.rarityByKey[b.card.rarity].rank || 0) - (catalog.rarityByKey[a.card.rarity].rank || 0) || a.card.name.localeCompare(b.card.name, 'de'));
}

/** Kartennummer je Season (#01 …) – wie im Raster gezählt; steht im Panel der Großansicht */
function cardNoMap() {
  const cardNo = {};
  for (const s of catalog.SEASONS) catalog.CARDS.filter((c) => c.season === s.key && c.rarity !== 'test-item').forEach((c, i) => { cardNo[c.id] = String(i + 1).padStart(2, '0'); });
  return cardNo;
}

/** Was die Ansicht zusätzlich braucht: { slabCopies, cardNo, popStatsOf } (popStatsOf: Seltenheit der Note fürs Zertifikatsschild) */
async function viewData(coll) {
  const slabCopies = slabCopiesOf(coll);
  const pop = slabCopies.length ? await population.all() : null;
  return { slabCopies, cardNo: cardNoMap(), popStatsOf: (cardId, grade) => (pop ? population.gradeRarity(cardId, pop, grade) : null) };
}

module.exports = { viewData, slabCopiesOf, cardNoMap };

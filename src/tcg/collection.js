// Sammlung eines Nutzers mit allen Kennzahlen – für TCG-Seite, Album, Handel und fremde Sammlungen
const { TcgCard } = require('../models/Tcg');
const { lockedDocs, isStateLock } = require('./locks');
const catalog = require('./catalog');
const foil = require('../items/foil');
const { inventory, bankPrice } = require('./tcgService');
const { gradeStats, centerShift, visibleMarks } = require('../grading/condition');
const { konfettiFor } = require('../cosmetics/logic');

async function collection(user) {
  const [owned, locked, foiledDocs, damagedDocs] = await Promise.all([
    inventory(user._id),
    lockedDocs(user._id),
    TcgCard.find({ user: user._id, foiledAt: { $ne: null } }).select('card rarity foiledAt slab condition.defects.centering').sort({ foiledAt: 1 }).lean(),
    // nur die sichtbaren Spuren laden – Note und übrige Mängel bleiben auf dem Server (#204)
    TcgCard.find({ user: user._id, foiledAt: null, $or: [{ damaged: true }, { lastGrade: { $ne: null } }] }).select('card rarity creased ironedAt lastGrade condition.defects.scratches condition.defects.crease').sort({ createdAt: 1 }).lean(),
  ]);
  // Folierte Exemplare je Karte – im Album und in fremden Sammlungen eigene Plätze: { cardId: [{ id, foiledAt }] }
  const foiledCopies = {};
  for (const d of foiledDocs) {
    const r = catalog.rarityByKey[d.rarity];
    const lock = locked.reasons.get(String(d._id));
    (foiledCopies[d.card] = foiledCopies[d.card] || []).push({
      id: String(d._id),
      foiledAt: d.foiledAt,
      slab: d.slab ? { code: d.slab.code, grade: d.slab.grade } : null, // Slab: Kürzel und Note auf dem Etikett; Sleeve: null (#204)
      grade: d.slab ? d.slab.grade : null, // Note nur auf dem Slab – in der Schutzhülle bleibt sie geheim
      center: d.condition ? centerShift(d.condition.defects && d.condition.defects.centering, d._id) : null, // sichtbarer Versatz
      value: foil.cardValue(r ? r.sell : 0, foil.growthFrom(d)),
      lock: lock && !isStateLock(lock) ? lock : null, // 'handel' | 'quest'
    });
  }
  // Unfolierte Exemplare mit sichtbarem Schaden (#204) oder früherer Bewertung (lastGrade) – eigene Plätze, in der Großansicht mit Kratzern und Knick:
  // { cardId: [{ id, marks, creased, ironed, lastGrade, value, lock }] }
  const markedCopies = {};
  for (const d of damagedDocs) {
    const r = catalog.rarityByKey[d.rarity];
    const lock = locked.reasons.get(String(d._id));
    (markedCopies[d.card] = markedCopies[d.card] || []).push({
      id: String(d._id),
      marks: visibleMarks(d.condition && d.condition.defects, d._id, !!d.ironedAt),
      creased: !!d.creased,
      ironed: !!d.ironedAt,
      lastGrade: d.lastGrade && d.lastGrade.grade ? { code: d.lastGrade.code, grade: d.lastGrade.grade } : null, // Note des letzten Shops, der Slab ist ab
      value: bankPrice(r ? r.sell : 0, d), // Bankwert: ungebügelter Knick die Hälfte
      lock: lock || null, // 'handel' | 'quest' | 'dungeon' | 'duell'
    });
  }
  // Gesperrte Exemplare je Karte (Quest/Handel): { cardId: { n, reason } }
  const lockedByCard = {};
  const tradingByCard = {}; // unfolierte Exemplare in einem Handelsangebot – gehen weg, zählen nicht als Duplikat
  for (const d of await TcgCard.find({ _id: { $in: locked.docs } }).select('card foiledAt').lean()) {
    const reason = locked.reasons.get(String(d._id));
    if ((reason === 'handel' || reason === 'duell') && !d.foiledAt) tradingByCard[d.card] = (tradingByCard[d.card] || 0) + 1;
    const e = (lockedByCard[d.card] = lockedByCard[d.card] || { n: 0, reason });
    if (isStateLock(e.reason) && !isStateLock(reason)) e.reason = reason; // Quest/Handel sind wichtiger als Folie und Slab
    e.n += 1;
  }
  const counts = Object.fromEntries(owned.map((o) => [o._id, o.n]));
  // Folierte Exemplare je Karte (Markierung im Album)
  const foiledByCard = Object.fromEntries(owned.filter((o) => o.foiled).map((o) => [o._id, o.foiled]));
  // Unfolierte Exemplare mit Knick je Karte (#204) – ein Knick ist sichtbar, die Note bleibt geheim
  const creasedByCard = Object.fromEntries(owned.filter((o) => o.creased).map((o) => [o._id, o.creased]));
  // Freie Exemplare je Karte (nicht auf Quest, nicht im Handel, nicht foliert)
  const free = Object.fromEntries(owned.map((o) => [o._id, o.n - (lockedByCard[o._id] ? lockedByCard[o._id].n : 0)]));
  const sell = (o) => (catalog.rarityByKey[o.rarity] ? catalog.rarityByKey[o.rarity].sell : 0);
  // Geschützte Karten und Boss-Karten (die Bank kauft sie nicht) zählen nicht zu den Duplikaten, die "Alle Duplikate verkaufen" verkauft, folierte Exemplare und solche im Handel auch nicht
  const protectedIds = new Set(user.tcgProtected || []);
  // Wert der Duplikate einer Karte (n − 1 Stück): zuerst die mit ungebügeltem Knick (halber Preis), dann die übrigen
  const dupWorth = (o, s, f = (v) => v) => {
    const k = Math.min(o.creased || 0, o.n - 1);
    return k * f(bankPrice(s, { creased: true })) + (o.n - 1 - k) * f(s);
  };
  const dups = owned.filter((o) => !protectedIds.has(o._id) && !(catalog.rarityByKey[o.rarity] || {}).noBank).map((o) => ({ ...o, n: o.n - (o.foiled || 0) - (tradingByCard[o._id] || 0) })).filter((o) => o.n > 1);
  return {
    counts,
    free,
    lockedByCard,
    foiledByCard,
    creasedByCard,
    foiledCopies,
    markedCopies,
    graded: gradeStats(foiledDocs.map((d) => d.slab && d.slab.grade)), // beste Note und Schnitt der Slabs
    protectedIds,
    uniqueOwned: catalog.CARDS.filter((c) => counts[c.id]).length,
    cardCount: owned.reduce((s, o) => s + o.n, 0),
    collectionValue: owned.reduce((s, o) => s + (o.v || 0), 0), // mit Wertsteigerung folierter Karten
    dupCount: dups.reduce((s, o) => s + o.n - 1, 0),
    // Knick-Exemplare gehen zuerst weg und bringen die Hälfte (tcgService.bankOrder/bankPrice, #204)
    dupValue: dups.reduce((s, o) => s + dupWorth(o, sell(o)), 0),
    dupKonfetti: dups.reduce((s, o) => s + dupWorth(o, sell(o), konfettiFor), 0), // dieselben Duplikate zerkleinert
  };
}

module.exports = { collection };

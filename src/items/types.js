// Gegenstands-Arten – die EINZIGE Stelle, an der ein neuer Gegenstand angelegt wird (reine Daten, kein Datenbankzugriff).
//
// Pro Art:
//   key:      fester Schlüssel (nie umbenennen – steht in der Datenbank)
//   label:    Name im Spiel
//   category: Gruppe aus CATEGORIES (für Inventar-Filter, künftige Rezepte im Grading-Shop usw.)
//   storage:  'stueck' = jedes Stück ein eigenes Dokument (Item) – nur für Gegenstände mit eigenem Zustand
//                        oder Handel pro Stück (z. B. Folie);
//             'stapel' = ein Dokument pro Nutzer und Art mit Anzahl (ItemStack) – Standard für Verbrauchsmaterial
//                        (Tücher, Hüllen, Boxen …), skaliert auch bei Tausenden Stück
//   tradable: im Handel anbietbar (derzeit nur bei storage 'stueck')
//   sell:     Ankaufspreis der Bank in Cent (0 = Bank kauft nicht an)
//   image:    Bild (/img/items/…)
//   text:     Beschreibung im Inventar
const CATEGORIES = [
  { key: 'material', label: 'Material' }, // wird bei einer Arbeit verbraucht (z. B. Folie)
  { key: 'werkzeug', label: 'Werkzeug' }, // bleibt erhalten, schaltet etwas frei
  { key: 'verpackung', label: 'Verpackung' }, // Hüllen, Toploader, Boxen …
];

// Woher ein Gegenstand kommt / wohin er geht (Item.source, ItemLog.source)
const SOURCES = ['admin', 'grading', 'dungeon', 'handel', 'lotto', 'kampf', 'bank', 'folieren', 'blackmarket'];

const ITEM_TYPES = [
  {
    key: 'folie',
    label: 'Folie',
    category: 'material',
    storage: 'stueck',
    tradable: true,
    sell: 1000,
    image: '/img/items/folie.svg',
    text: 'Schweißt eine deiner Karten ein. Folierte Karten steigen im Wert und lassen sich im Album einzeln zu diesem Wert an die Bank verkaufen – auf Quests geschickt werden können sie nicht.',
  },
];

/** Prüft die Liste beim Laden – ein Tippfehler soll sofort (und im Test) auffallen, nicht erst im Spiel */
function validateTypes(types = ITEM_TYPES) {
  const keys = new Set();
  const cats = new Set(CATEGORIES.map((c) => c.key));
  for (const t of types) {
    if (!/^[a-z][a-z0-9-]*$/.test(t.key || '')) throw new Error(`Gegenstand: ungültiger Schlüssel "${t.key}"`);
    if (keys.has(t.key)) throw new Error(`Gegenstand: Schlüssel "${t.key}" doppelt`);
    keys.add(t.key);
    if (!t.label) throw new Error(`Gegenstand "${t.key}": label fehlt`);
    if (!cats.has(t.category)) throw new Error(`Gegenstand "${t.key}": unbekannte Kategorie "${t.category}"`);
    if (t.storage !== 'stueck' && t.storage !== 'stapel') throw new Error(`Gegenstand "${t.key}": storage muss 'stueck' oder 'stapel' sein`);
    if (t.tradable && t.storage !== 'stueck') throw new Error(`Gegenstand "${t.key}": Handel geht nur mit storage 'stueck'`);
    if (!Number.isInteger(t.sell) || t.sell < 0) throw new Error(`Gegenstand "${t.key}": sell muss ganze Cent ≥ 0 sein`);
  }
  return true;
}
validateTypes();

const itemTypeByKey = Object.fromEntries(ITEM_TYPES.map((t) => [t.key, t]));
/** Art zu einem (Nutzer-)Schlüssel – Vergleich mit der festen Liste, nie per obj[key] */
const itemType = (key) => ITEM_TYPES.find((t) => t.key === key) || null;

module.exports = { CATEGORIES, SOURCES, ITEM_TYPES, itemTypeByKey, itemType, validateTypes };

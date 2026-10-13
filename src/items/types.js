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
//   buy:      Verkaufspreis der Bank in Cent (0 = nicht im Shop); im Admin-Panel einstellbar (items/foil.js, PRICE_FIELD)
//   via:      wo man ihn kauft: 'bank' = Bank-Shop im Inventar, 'grading' = Bank-Shop und Werkstatt, aber nur mit Grading-Shop
//             (setzt einen aktiven Shop voraus). Ohne buy egal.
//   image:    Bild (/img/items/…)
//   text:     Beschreibung im Inventar
const CATEGORIES = [
  { key: 'material', label: 'Material' }, // wird bei einer Arbeit verbraucht (z. B. leerer Slab beim Versiegeln)
  { key: 'werkzeug', label: 'Werkzeug' }, // bleibt erhalten, schaltet etwas frei
  { key: 'verpackung', label: 'Verpackung' }, // Hüllen, Toploader, Boxen …
];

// Woher ein Gegenstand kommt / wohin er geht (Item.source, ItemLog.source)
const VIA = ['bank', 'grading'];
const SOURCES = ['admin', 'grading', 'dungeon', 'handel', 'lotto', 'kampf', 'bank', 'folieren', 'blackmarket', 'versiegeln'];

const ITEM_TYPES = [
  {
    key: 'folie', // Schlüssel bleibt (steht in der Datenbank) – im Spiel heißt die Folie jetzt „TCG Sleeve“
    label: 'TCG Sleeve',
    category: 'verpackung',
    storage: 'stueck',
    tradable: true,
    sell: 1000,
    buy: 1500,
    via: 'bank',
    image: '/img/items/folie.svg',
    text: 'Schutzhülle für eine Karte: Sie spielt weiter mit und ist auf Quests, im Dungeon und im Turm vor Kratzern und Knicken sicher. Die Note zeigt nur ein Slab. Abziehen im Album gibt dir den Sleeve zurück. Karten im Sleeve gehen nicht an die Bank und nicht ins Duell.',
  },
  {
    key: 'slab',
    label: 'Leerer Slab',
    category: 'material',
    storage: 'stueck',
    tradable: true,
    sell: 2500,
    buy: 4000,
    via: 'grading',
    image: '/img/items/slab.svg',
    text: 'Das Gehäuse, in das ein Grading-Shop eine Karte einschweißt – jeder Auftrag mit „Benoten + Slab“ verbraucht einen. Kaufen: Bank-Shop oder Werkstatt (mit Grading-Shop) oder Handel.',
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
    const buy = t.buy === undefined ? 0 : t.buy; // ohne Angabe: nicht im Bank-Shop
    if (!Number.isInteger(buy) || buy < 0) throw new Error(`Gegenstand "${t.key}": buy muss ganze Cent ≥ 0 sein`);
    if (t.via !== undefined && !VIA.includes(t.via)) throw new Error(`Gegenstand "${t.key}": via muss 'bank' oder 'grading' sein`);
    if (buy && buy < t.sell) throw new Error(`Gegenstand "${t.key}": die Bank darf nicht billiger verkaufen (${buy}) als sie ankauft (${t.sell}) – sonst ließe sich Geld drucken`);
  }
  return true;
}
validateTypes();

const itemTypeByKey = Object.fromEntries(ITEM_TYPES.map((t) => [t.key, t]));
/** Art zu einem (Nutzer-)Schlüssel – Vergleich mit der festen Liste, nie per obj[key] */
const itemType = (key) => ITEM_TYPES.find((t) => t.key === key) || null;

module.exports = { CATEGORIES, SOURCES, ITEM_TYPES, itemTypeByKey, itemType, validateTypes };

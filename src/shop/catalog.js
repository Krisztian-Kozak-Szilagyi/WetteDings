// Shop-Demo: Möbel-Katalog aus den Platzhalter-Daten (items.json, 2026-10-13 von ChatGPT erzeugt, Preise = PLATZHALTER).
// Hier kommt nur dazu, was zum Zeichnen der Platzhalter-Klötze nötig ist: Höhe in Pixeln, Gruppe (Farbe), Ebene.
// Ebenen: 'boden' = normales Möbel, 'flach' = liegt am Boden (Teppich, darauf darf etwas stehen),
//         'theke' = steht auf einer Theke (Booster-Display), 'wand' = hängt an der Rückwand.
const items = require('./items.json');

// Gruppe = Farbe im Spiel
const GROUPS = {
  arbeit: { name: 'Arbeit', color: 0x4f86c6 },
  verkauf: { name: 'Verkauf', color: 0xd99a3c },
  spieler: { name: 'Spieler & Community', color: 0x4fae7a },
  technik: { name: 'Lager & Technik', color: 0x8a8f9c },
  deko: { name: 'Deko', color: 0xa070c8 },
};

// id → [Gruppe, Höhe in px, Theke? (darauf darf ein Booster-Display stehen)]
const LOOK = {
  cashier_counter: ['arbeit', 34, true],
  card_cleaning_table: ['arbeit', 26],
  card_grading_table: ['arbeit', 26],
  pack_opening_counter: ['arbeit', 30, true],
  shelf_small: ['verkauf', 70],
  shelf_medium: ['verkauf', 70],
  shelf_big: ['verkauf', 70],
  drink_refrigerator: ['verkauf', 66],
  cd_dvd_holder: ['verkauf', 46],
  card_display_case: ['verkauf', 30, true],
  booster_display: ['verkauf', 22],
  chair: ['spieler', 22],
  playmat_table: ['spieler', 24],
  arcade_machine: ['spieler', 62],
  bulletin_board: ['spieler', 30],
  trophy_cabinet: ['spieler', 62],
  dehumidifier: ['technik', 32],
  safe: ['technik', 32],
  plant: ['deko', 38],
  poster: ['deko', 34],
  rug: ['deko', 2],
  floor_lamp: ['deko', 58],
  neon_sign: ['deko', 22],
  beanbag: ['deko', 16],
  standee: ['deko', 52],
  trash_bin: ['deko', 20],
};

const byId = Object.fromEntries(items.map((i) => [i.id, i]));

function layerOf(src) {
  if (src.placement === 'wall') return 'wand';
  if (src.placement === 'counter-top') return 'theke';
  if (src.id === 'rug') return 'flach';
  return 'boden';
}

/** Alles, was man in den Laden stellen kann – in der Reihenfolge der Gruppen */
const CATALOG = Object.entries(LOOK)
  .filter(([id]) => byId[id])
  .map(([id, [group, height, counter]]) => {
    const src = byId[id];
    return {
      id,
      name: src.name_de,
      group,
      w: src.footprint.w,
      d: src.footprint.h,
      height,
      layer: layerOf(src),
      counter: !!counter,
      price: (src.placeholder_price && src.placeholder_price.amount) || 0,
      utility: src.utility,
      capacity: src.capacity,
    };
  })
  // Eigene Teile, die nicht in items.json stehen (Krisztian, 2026-10-16: Lager + Geheimraum; Preise = Platzhalter)
  .concat([
    { id: 'lager_regal_klein', name: 'Lagerregal (klein)', group: 'technik', w: 2, d: 1, height: 74, layer: 'boden', counter: false, price: 150,
      utility: 'Vorrat im Lager – nur im Lager aufstellbar, Kunden kommen nicht heran.', capacity: '40 Stück', lagerOnly: true },
    { id: 'lager_regal_gross', name: 'Lagerregal (groß)', group: 'technik', w: 3, d: 1, height: 74, layer: 'boden', counter: false, price: 250,
      utility: 'Vorrat im Lager – nur im Lager aufstellbar, Kunden kommen nicht heran.', capacity: '80 Stück', lagerOnly: true },
    // Luftentfeuchter an der Wand (Krisztian, 2026-10-16): teurer, braucht keinen Platz am Boden – nur neben einer Wand
    { id: 'dehumidifier_wall', name: 'Luftentfeuchter (Wand)', group: 'technik', w: 1, d: 1, height: 18, layer: 'wandnah', counter: false, price: 350,
      utility: 'Schützt Karten im Lager vor Feuchtigkeit (1 Gerät je 16 Felder). Hängt an der Wand, braucht keinen Platz.', capacity: null, lagerOk: true },
    { id: 'geheimschrank', name: 'Schrank (Geheimtür)', group: 'technik', w: 1, d: 1, height: 74, layer: 'boden', counter: false, price: 300,
      utility: 'Verdeckt den Eingang zum Geheimraum – E schiebt ihn zur Seite. Darin lässt sich auch etwas lagern.', capacity: '20 Stück',
      secret: true }, // kommt mit dem Geheimraum, nicht einzeln bestellbar
  ])
  .sort((a, b) => Object.keys(GROUPS).indexOf(a.group) - Object.keys(GROUPS).indexOf(b.group));
// Ruf-Stufe, ab der ein Möbel bestellbar ist (Krisztian, 2026-10-16, Platzhalter): 2 Lager-Sachen, 3 CD/DVD-Ständer
const LEVEL_OF = { lager_regal_klein: 2, lager_regal_gross: 2, dehumidifier: 2, dehumidifier_wall: 2, cd_dvd_holder: 3 };
CATALOG.forEach((d) => { d.level = LEVEL_OF[d.id] || 1; });
// Luftentfeuchter am Boden: darf ins Lager, deutscher Text
CATALOG.forEach((d) => {
  if (d.id !== 'dehumidifier') return;
  d.lagerOk = true;
  d.utility = 'Schützt Karten im Lager vor Feuchtigkeit (1 Gerät je 16 Felder).';
});

// Ware zum Verkaufen: Marktpreis = Platzhalter-Preis aus items.json, Einkauf = BUY_FACTOR davon.
// [Karton-Inhalt (Stück), Farbe] – Karton-Größen sind Platzhalter (Krisztian, 2026-10-13: erst der Rahmen)
const BUY_FACTOR = 0.5;
const WARE = {
  booster_pack: [24, 0xe0b040],
  booster_box: [4, 0xc06a2a],
  single_card: [10, 0x5aa0e0],
  graded_slab: [2, 0x9fd8e8],
  sleeve_pack: [10, 0x7a6ad0],
  toploader: [20, 0xb8c0cc],
  board_game_box: [4, 0x4fae7a],
  energy_drink_can: [12, 0x50d0a0],
  coffee: [12, 0x8a5a3a],
};
// Lizenzen (Krisztian, 2026-10-14): Grundsortiment ohne Lizenz, der Rest in Paketen
const LICENSES = [
  { id: 'sammler', name: 'Sammler-Lizenz', price: 2500, level: 2, text: 'Booster-Boxen, Einzelkarten und bewertete Karten im Slab' },
  { id: 'brettspiele', name: 'Brettspiel-Lizenz', price: 1500, level: 3, text: 'Brettspiele' },
];
const PAPER = ['single_card', 'booster_pack', 'booster_box', 'board_game_box'];
const LICENSE_OF = { booster_box: 'sammler', single_card: 'sammler', graded_slab: 'sammler', board_game_box: 'brettspiele' };

const GOODS = Object.entries(WARE)
  .filter(([id]) => byId[id])
  .map(([id, [perBox, color]]) => {
    const market = byId[id].placeholder_price.amount;
    // tier = ab welcher Stufe Kunden danach fragen (vorbereitet, alles Stufe 1); license = nötige Lizenz zum Bestellen
    // paper = verdirbt im Lager ohne Luftentfeuchter (Krisztian, 2026-10-16)
    return { id, kind: 'ware', name: byId[id].name_de, perBox, color, market, buy: Math.round(market * BUY_FACTOR * 100) / 100, tier: 1, license: LICENSE_OF[id] || null, paper: PAPER.includes(id) };
  })
  // Material für Aufträge (Preise wie im Bank-Shop der Seite: TCG Sleeve 15, Leerer Slab 40) – nicht für Kunden im Regal
  .concat([
    // Alte Spiele für den CD/DVD-Ständer (Krisztian, 2026-10-16: vorbereitet; Preise = Platzhalter, ab Ruf-Stufe 3)
    { id: 'retro_cd', kind: 'ware', name: 'Altes Spiel (CD)', perBox: 10, color: 0xd8d8e8, market: 15, buy: 7.5, tier: 1, license: null, level: 3 },
    { id: 'retro_dvd', kind: 'ware', name: 'Altes Spiel (DVD)', perBox: 10, color: 0x6a7ad8, market: 25, buy: 12.5, tier: 1, license: null, level: 3 },
    { id: 'mat_sleeve', kind: 'material', name: 'TCG Sleeve', perBox: 10, color: 0xc0a0f0, market: 15, buy: 15, tier: 1, license: null },
    { id: 'mat_slab', kind: 'material', name: 'Leerer Slab', perBox: 5, color: 0xd8e8f0, market: 40, buy: 40, tier: 1, license: null },
  ]);

// Dienstleistungen: Marktpreis = Lohn im Grading-Shop der Seite (Krisztian, 2026-10-14), station = Möbel dafür,
// material = wird dabei verbraucht. Reinigen + Bügeln am Kartenreinigungstisch, Benoten + Versiegeln am Kartenbewertungstisch,
// TCG Sleeve an der Booster-Öffnungstheke.
const SERVICES = [
  { id: 'clean', name: 'Reinigen', market: 25, station: 'card_cleaning_table' },
  { id: 'iron', name: 'Knick bügeln', market: 20, station: 'card_cleaning_table' },
  { id: 'grade', name: 'Benoten', market: 30, station: 'card_grading_table' },
  { id: 'slab', name: 'Versiegeln (Slab)', market: 60, station: 'card_grading_table', material: 'mat_slab' },
  { id: 'foil', name: 'In TCG Sleeve', market: 15, station: 'pack_opening_counter', material: 'mat_sleeve' },
];
// Was Kunden bestellen (Gewicht): Bügeln kommt von selbst dazu, wenn die Karte einen Knick hat und gereinigt wird.
// Slab und Sleeve schließen sich aus (die Karte steckt entweder im Slab oder im Sleeve).
const SERVICE_PACKS = [
  { services: ['clean'], weight: 3 },
  { services: ['clean', 'foil'], weight: 2 },
  { services: ['grade', 'slab'], weight: 2 },
  { services: ['clean', 'grade', 'slab'], weight: 2 },
];

// Was in welches Möbel passt (Platz = Stückzahl, jedes Stück braucht einen Platz; gemischt erlaubt)
const SHELF_GOODS = ['board_game_box', 'booster_box', 'sleeve_pack', 'toploader', 'booster_pack'];
const HOLDS = {
  shelf_small: SHELF_GOODS,
  shelf_medium: SHELF_GOODS,
  shelf_big: SHELF_GOODS,
  drink_refrigerator: ['energy_drink_can', 'coffee'],
  card_display_case: ['single_card', 'graded_slab'],
  booster_display: ['booster_pack'],
  cd_dvd_holder: ['retro_cd', 'retro_dvd'],
  card_grading_table: ['mat_slab'],
  pack_opening_counter: ['mat_sleeve'],
};
// Plätze, wo die Kapazität im Text nicht passt (Material-Vorrat an den Arbeitstischen)
const SLOTS = { card_grading_table: 10, pack_opening_counter: 20, lager_regal_klein: 40, lager_regal_gross: 80, geheimschrank: 20 };
// Lagerregale und der Schrank nehmen alles (Ware und Material)
const ALL_GOODS = GOODS.map((g) => g.id);
HOLDS.lager_regal_klein = ALL_GOODS;
HOLDS.lager_regal_gross = ALL_GOODS;
HOLDS.geheimschrank = ALL_GOODS;
CATALOG.forEach((d) => {
  const holds = HOLDS[d.id];
  if (!holds) return;
  d.holds = holds;
  d.slots = SLOTS[d.id] || parseInt(String(d.capacity).match(/\d+/), 10) || 6;
});

const UNIT_PRICE = (byId.empty_neighbor_unit && byId.empty_neighbor_unit.placeholder_price.amount) || 5000;

// Kleidung (Krisztian, 2026-10-16): ändert das Aussehen der Figur, am PC kaufen und gleich anziehen. suspicion = wie stark
// sie später in der Stadt den Verdacht senkt – Werte kommen von Krisztian (vorerst leer). Preise = Platzhalter
const CLOTHES_SLOTS = [{ id: 'kopf', name: 'Kopf' }, { id: 'oberteil', name: 'Oberteil' }, { id: 'hose', name: 'Hose' }];
const CLOTHES = [
  { id: 'kappe_rot', slot: 'kopf', name: 'Kappe (rot)', shape: 'kappe', color: 0xc8382f, price: 40, suspicion: null },
  { id: 'muetze_grau', slot: 'kopf', name: 'Mütze (grau)', shape: 'muetze', color: 0x8a8f9c, price: 40, suspicion: null },
  { id: 'kapuze_schwarz', slot: 'kopf', name: 'Kapuze (schwarz)', shape: 'kapuze', color: 0x22252e, price: 70, suspicion: null },
  { id: 'hoodie_grau', slot: 'oberteil', name: 'Hoodie (grau)', color: 0x6f7480, price: 80, suspicion: null },
  { id: 'hemd_weiss', slot: 'oberteil', name: 'Hemd (weiß)', color: 0xe8e6e0, price: 60, suspicion: null },
  { id: 'lederjacke', slot: 'oberteil', name: 'Lederjacke', color: 0x5a3a22, price: 140, suspicion: null },
  { id: 'jeans', slot: 'hose', name: 'Jeans', color: 0x34508a, price: 50, suspicion: null },
  { id: 'cargo_oliv', slot: 'hose', name: 'Cargohose (oliv)', color: 0x5f6a3a, price: 60, suspicion: null },
  { id: 'anzughose', slot: 'hose', name: 'Anzughose (schwarz)', color: 0x1e2028, price: 90, suspicion: null },
];

module.exports = { CATALOG, GROUPS, GOODS, LICENSES, SERVICES, SERVICE_PACKS, UNIT_PRICE, CLOTHES, CLOTHES_SLOTS };

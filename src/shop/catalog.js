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
  .sort((a, b) => Object.keys(GROUPS).indexOf(a.group) - Object.keys(GROUPS).indexOf(b.group));

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
const GOODS = Object.entries(WARE)
  .filter(([id]) => byId[id])
  .map(([id, [perBox, color]]) => {
    const market = byId[id].placeholder_price.amount;
    // tier = ab welcher Stufe Kunden danach fragen (vorbereitet, alles Stufe 1)
    return { id, name: byId[id].name_de, perBox, color, market, buy: Math.round(market * BUY_FACTOR * 100) / 100, tier: 1 };
  });

// Was in welches Möbel passt (Platz = Stückzahl, jedes Stück braucht einen Platz; gemischt erlaubt)
const SHELF_GOODS = ['board_game_box', 'booster_box', 'sleeve_pack', 'toploader', 'booster_pack'];
const HOLDS = {
  shelf_small: SHELF_GOODS,
  shelf_medium: SHELF_GOODS,
  shelf_big: SHELF_GOODS,
  drink_refrigerator: ['energy_drink_can', 'coffee'],
  card_display_case: ['single_card', 'graded_slab'],
  booster_display: ['booster_pack'],
};
CATALOG.forEach((d) => {
  const holds = HOLDS[d.id];
  if (!holds) return;
  d.holds = holds;
  d.slots = parseInt(String(d.capacity).match(/\d+/), 10) || 6;
});

const UNIT_PRICE = (byId.empty_neighbor_unit && byId.empty_neighbor_unit.placeholder_price.amount) || 5000;

module.exports = { CATALOG, GROUPS, GOODS, UNIT_PRICE };

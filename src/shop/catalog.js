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

const UNIT_PRICE = (byId.empty_neighbor_unit && byId.empty_neighbor_unit.placeholder_price.amount) || 5000;

module.exports = { CATALOG, GROUPS, UNIT_PRICE };

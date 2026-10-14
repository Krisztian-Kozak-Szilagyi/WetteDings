// Raid „The Gambit of Shadows“ gegen Dio Meister der Schatten – reine Logik ohne Datenbank: Einstellungen, Kampfwerte der Karten, Dio als Boss und das
// Nachspielen eines Kampfs. Gekämpft wird mit den Bosskampf-Regeln (public/js/bossfight-regeln.js), die auch im
// Browser laufen. Der Server hält jeden Kampf als Startwert + Liste der Züge und spielt ihn bei jedem Zug nach –
// so entscheidet nur der Server, und niemand kann den Zufall vorausberechnen (src/raid/raidService.js).
const R = require('../../public/js/bossfight-regeln');
const catalog = require('../tcg/catalog');

// Seltenheiten, für die Kosten und Stärke einstellbar sind (Test-Items haben eigene Kampfwerte)
const RARITY_KEYS = catalog.ALL_RARITIES.filter((r) => r.key !== 'test-item').map((r) => r.key);

// Angriffe von Dio Meister der Schatten (Schlüssel fest, Werte im Admin-Panel). min/max = Schaden, gewicht = wie oft er gewählt wird,
// schwer = großer Angriff (nie zweimal hintereinander, im Zorn doppelt so oft), gift = Schaden je Runde für giftRunden,
// netz = so viel weniger Energie in der nächsten Runde, muenze = Münzwurf (Kopf: kopfFaktor-fach, Zahl: Glücks-Token),
// fern = Armbrust: trifft auch Karten weit hinten auf dem Spielfeld (sonst nur bis boss.nahReichweite)
const ATTACKS = [
  { key: 'dolch', name: 'Dolchstich', min: 12, max: 16, gewicht: 4, schwer: false, gift: 0, giftRunden: 0, netz: 0, muenze: false, fern: false },
  { key: 'armbrust', name: 'Armbrustschuss', min: 16, max: 20, gewicht: 3, schwer: false, gift: 0, giftRunden: 0, netz: 0, muenze: false, fern: true },
  { key: 'lotterie', name: 'Krit-Lotterie', min: 14, max: 18, gewicht: 3, schwer: false, gift: 0, giftRunden: 0, netz: 0, muenze: true, fern: false },
  { key: 'giftdolch', name: 'Vergifteter Dolch', min: 8, max: 10, gewicht: 2, schwer: false, gift: 4, giftRunden: 3, netz: 0, muenze: false, fern: false },
  { key: 'rauchbombe', name: 'Rauchbombe', min: 6, max: 8, gewicht: 1.5, schwer: false, gift: 0, giftRunden: 0, netz: 1, muenze: false, fern: false },
  { key: 'allin', name: 'All In', min: 34, max: 40, gewicht: 1.5, schwer: true, gift: 0, giftRunden: 0, netz: 0, muenze: false, fern: false },
];

// Standardwerte (Admin-Panel → Spielwerte → Raid). Prozentwerte als ganze Zahlen (50 = 50 %).
// karten: Kampfwerte aus den IHK-Werten. Jede Karte hat eine Rolle nach ihrem stärksten Wert (FIA → Angreifer, FIS →
// Verteidiger, BWL → Heiler): dieser Wert zählt voll, die anderen beiden nur mit neben %. ANG = FIA × ang %, SCH = FIS × sch %,
// HEI = BWL × hei %, jeweils mal Stärke der Seltenheit (gleicht die sehr unterschiedlichen IHK-Werte aus, damit im Raid
// vor allem das Spiel entscheidet und nicht nur die Sammlung); Kosten = Energie je Seltenheit.
// Spielfeld: Karten in karten.permanent bleiben nach dem Ausspielen liegen (ohne Limit, frei platziert), wirken jede Runde
// erneut und haben karten.leben Leben. Dio greift mit boss.feldZiel % Chance eine von ihnen statt des Spielers an – vorne
// liegende vorneFaktor-mal so oft wie ganz hinten; Nahkampf erreicht nur Karten bis nahReichweite % der Tiefe, die Armbrust alle.
// Alle anderen Karten sind Effektkarten (wirken einmal, dann Ablagestapel).
const DEFAULTS = {
  open: false,
  triesPerDay: 3,
  maxRounds: 30,
  // Energie: energieStart im ersten Zug, nach jedem beendeten Zug 1 mehr (höchstens energieMax). 5 Karten zu Beginn, dann 1 je Zug.
  spieler: { hp: 200, energieStart: 1, energieMax: 10, startHand: 5, ziehen: 1, handMax: 10 },
  // Balance (npm run sim:raid, 2026-10-13, Energie wächst, 1 Karte je Zug, noch keine permanenten Karten): Crumpled/BFWler
  // 0 %, Gold/Holo ≈ 51 %, Holo/Bockhaber ≈ 86 %, Glitch ≈ 98 % – die Spielweise macht kaum Unterschied. Offen bis zum
  // Karten-Rework (Effekte, permanente Karten), danach neu abstimmen.
  // Krit-Lotterie wie Dios Karte: jeder Angriff krittet mit grundKrit % (+ tokenKrit % je Glücks-Token) und trifft dann
  // kritFaktor-fach; danach Münzwurf (kopfChance): Kopf = kritischer Armbrust-Zusatztreffer, Zahl = Dolch-Zusatztreffer
  // und ein Glücks-Token. Zusatztreffer: zusatzMin–zusatzMax Schaden. Der Münzwurf-Angriff trifft bei Kopf kopfFaktor-fach.
  boss: { hp: 285, wutAb: 50, wutFaktor: 125, kopfChance: 50, kopfFaktor: 200, grundKrit: 10, kritFaktor: 200, tokenKrit: 1, zusatzMin: 4, zusatzMax: 6, feldZiel: 35, vorneFaktor: 4, nahReichweite: 50 },
  angriffe: ATTACKS,
  karten: {
    ang: 40,
    sch: 40,
    hei: 20,
    neben: 20,
    leben: 40,
    permanent: [], // Karten-IDs der permanenten Karten (Admin-Panel)
    // Energiekosten je Seltenheit; einzelne Karten können eigene Kosten haben (kostenKarte: { Karten-ID: Kosten })
    kosten: { crumpled: 1, bfwler: 1, gold: 2, holo: 3, bockhaber: 3, glitch: 4, icon: 4, sith: 4, boss: 5, footman: 1, arcane: 4 },
    kostenKarte: {},
    // Stärke je Seltenheit: teurere Karten sind stärker, aber flach – mit 1 Karte je Zug zählt jede Karte, nicht die Energie.
    // Hauptwert ≈ 30 / 36 / 44 / 52 / 60 bei 1 / 2 / 3 / 4 / 5 Energie
    staerke: { crumpled: 192, bfwler: 157, gold: 171, holo: 196, bockhaber: 180, glitch: 130, icon: 143, sith: 143, boss: 159, footman: 157, arcane: 130 },
  },
  belohnung: { geld: 20000, dioChance: 10 },
};

// Erlaubte Werte: [min, max]
const LIMITS = {
  triesPerDay: [1, 50],
  maxRounds: [5, 200],
  spieler: { hp: [10, 1000], energieStart: [0, 20], energieMax: [1, 20], startHand: [1, 10], ziehen: [0, 10], handMax: [3, 15] },
  boss: { hp: [50, 100000], wutAb: [0, 100], wutFaktor: [100, 500], kopfChance: [0, 100], kopfFaktor: [100, 1000], grundKrit: [0, 100], kritFaktor: [100, 1000], tokenKrit: [0, 20], zusatzMin: [0, 500], zusatzMax: [0, 500], feldZiel: [0, 100], vorneFaktor: [1, 20], nahReichweite: [0, 100] },
  angriff: { min: [0, 1000], max: [0, 1000], gewicht: [0, 100], gift: [0, 100], giftRunden: [0, 10], netz: [0, 5] },
  karten: { ang: [0, 500], sch: [0, 500], hei: [0, 500], neben: [0, 100], leben: [1, 1000], kosten: [0, 20], staerke: [0, 1000] },
  belohnung: { geld: [0, 100000000], dioChance: [0, 100] },
};

// Karten, die permanent sein können: Charaktere mit IHK-Werten (Items spielen im Raid nicht mit)
const PERMANENT_OK = (card) => !!card && !!card.isCharacter && !!card.stats;

const inRange = (v, [min, max], int = true) => Number.isFinite(v) && (!int || Number.isInteger(v)) && v >= min && v <= max;
const clone = (o) => JSON.parse(JSON.stringify(o));

/** Neue Werte prüfen (alle Felder nötig); wirft mit einer Liste der Fehler (err.invalid) */
function cleanSettings(input) {
  const s = input || {};
  const errors = [];
  const num = (label, v, lim, int = true) => {
    if (!inRange(v, lim, int)) errors.push(`${label}: ${lim[0]} bis ${lim[1]}`);
    return v;
  };
  const out = {
    open: !!s.open,
    triesPerDay: num('Versuche pro Tag', s.triesPerDay, LIMITS.triesPerDay),
    maxRounds: num('Höchstens Runden', s.maxRounds, LIMITS.maxRounds),
    spieler: {},
    boss: {},
    angriffe: [],
    karten: { kosten: {}, staerke: {}, permanent: [], kostenKarte: {} },
    belohnung: {},
  };
  for (const k of Object.keys(LIMITS.spieler)) out.spieler[k] = num(`Spieler ${k}`, s.spieler && s.spieler[k], LIMITS.spieler[k]);
  if (out.spieler.energieStart > out.spieler.energieMax) errors.push('Energie: Start größer als Maximum');
  for (const k of Object.keys(LIMITS.boss)) out.boss[k] = num(`Boss ${k}`, s.boss && s.boss[k], LIMITS.boss[k]);
  if (out.boss.zusatzMin > out.boss.zusatzMax) errors.push('Zusatztreffer: min größer als max');
  for (const def of ATTACKS) {
    const a = (s.angriffe || []).find((x) => x && x.key === def.key) || {};
    const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 40) : def.name;
    const row = { key: def.key, name, schwer: !!a.schwer, muenze: !!a.muenze, fern: !!a.fern };
    for (const k of Object.keys(LIMITS.angriff)) row[k] = num(`${name} ${k}`, a[k], LIMITS.angriff[k], k !== 'gewicht');
    if (row.min > row.max) errors.push(`${name}: min größer als max`);
    out.angriffe.push(row);
  }
  if (!out.angriffe.some((a) => a.gewicht > 0)) errors.push('Mindestens ein Angriff braucht ein Gewicht über 0');
  for (const k of ['ang', 'sch', 'hei', 'neben']) out.karten[k] = num(`Karten ${k} %`, s.karten && s.karten[k], LIMITS.karten[k]);
  out.karten.leben = num('Leben permanenter Karten', s.karten && s.karten.leben, LIMITS.karten.leben);
  // permanente Karten: nur bekannte, im Raid spielbare Karten, jede einmal
  const perm = s.karten && Array.isArray(s.karten.permanent) ? s.karten.permanent : [];
  out.karten.permanent = [...new Set(perm.filter((id) => typeof id === 'string' && PERMANENT_OK(catalog.cardById[id])))].sort();
  // Kosten einzelner Karten (überschreiben die Kosten ihrer Seltenheit); leer = Seltenheit
  for (const [id, v] of Object.entries((s.karten && s.karten.kostenKarte) || {})) {
    if (!PERMANENT_OK(catalog.cardById[id]) || v === null || v === undefined || v === '') continue;
    out.karten.kostenKarte[id] = num(`Kosten ${catalog.cardById[id].name}`, v, LIMITS.karten.kosten);
  }
  for (const r of RARITY_KEYS) {
    out.karten.kosten[r] = num(`Kosten ${r}`, s.karten && s.karten.kosten && s.karten.kosten[r], LIMITS.karten.kosten);
    out.karten.staerke[r] = num(`Stärke ${r}`, s.karten && s.karten.staerke && s.karten.staerke[r], LIMITS.karten.staerke);
  }
  for (const k of Object.keys(LIMITS.belohnung)) out.belohnung[k] = num(`Belohnung ${k}`, s.belohnung && s.belohnung[k], LIMITS.belohnung[k]);
  if (errors.length) {
    const err = new Error(errors.join(' · '));
    err.invalid = true;
    throw err;
  }
  return out;
}

/** Gespeicherte Werte über die Standardwerte legen – ungültige oder fehlende bleiben beim Standard */
function mergeSettings(doc) {
  const out = clone(DEFAULTS);
  if (!doc) return out;
  try {
    // Fehlende Teile mit Standardwerten auffüllen, dann komplett prüfen
    const merged = clone(DEFAULTS);
    if (typeof doc.open === 'boolean') merged.open = doc.open;
    for (const k of ['triesPerDay', 'maxRounds']) if (doc[k] !== undefined) merged[k] = doc[k];
    for (const part of ['spieler', 'boss', 'belohnung']) Object.assign(merged[part], doc[part] || {});
    if (doc.karten) {
      for (const k of ['ang', 'sch', 'hei', 'neben', 'leben']) if (doc.karten[k] !== undefined) merged.karten[k] = doc.karten[k];
      if (Array.isArray(doc.karten.permanent)) merged.karten.permanent = doc.karten.permanent;
      if (doc.karten.kostenKarte && typeof doc.karten.kostenKarte === 'object') merged.karten.kostenKarte = doc.karten.kostenKarte;
      Object.assign(merged.karten.kosten, doc.karten.kosten || {});
      Object.assign(merged.karten.staerke, doc.karten.staerke || {});
    }
    if (Array.isArray(doc.angriffe)) merged.angriffe = merged.angriffe.map((a) => ({ ...a, ...(doc.angriffe.find((x) => x && x.key === a.key) || {}) }));
    return cleanSettings(merged);
  } catch {
    return out;
  }
}

// Effekt beim Ausspielen je Seltenheit (public/js/bossfight-fx.js)
const FX = { glitch: 'nekro', icon: 'nekro', sith: 'nekro', boss: 'nekro', arcane: 'nekro', holo: 'feuer', bockhaber: 'feuer', gold: 'feuer' };

// Rolle einer Charakterkarte im Raid: ihr stärkster IHK-Wert (bei Gleichstand FIA vor FIS vor BWL)
const ROLE_LABEL = { fia: 'Angreifer', fis: 'Verteidiger', bwl: 'Heiler' };
const roleOf = (card) => ['fia', 'fis', 'bwl'].reduce((best, key) => (card.stats[key] > card.stats[best] ? key : best), 'fia');

/**
 * Kampfwerte einer Karte: eigene (Bosskampf-Test-Karten) oder aus den IHK-Werten abgeleitet (nur Charaktere).
 * Items ohne eigene Kampfwerte (Kaffee, Grafikkarte …) spielen im Raid nicht mit → null.
 */
function kampfFor(card, opts) {
  if (!card) return null;
  if (card.kampf) return card.kampf;
  if (!card.isCharacter || !card.stats) return null;
  const k = opts.karten;
  const st = card.stats;
  const m = (k.staerke[card.rarity] ?? 100) / 100;
  const role = roleOf(card);
  // Hauptwert voll, die anderen beiden mit neben %
  const v = (key, pct) => Math.max(0, Math.round((st[key] * pct * m * (key === role ? 1 : k.neben / 100)) / 100));
  return {
    typ: 'held',
    kosten: (k.kostenKarte || {})[card.id] ?? k.kosten[card.rarity] ?? 2,
    ang: v('fia', k.ang),
    sch: v('fis', k.sch),
    hei: v('bwl', k.hei),
    rolle: ROLE_LABEL[role],
    // Spielfeld: permanent = bleibt liegen bis zur Zerstörung, sonst Effektkarte
    dauer: (k.permanent || []).includes(card.id) ? 'permanent' : 'effekt',
    leben: k.leben,
    effekt: null,
    fx: FX[card.rarity] || 'hieb',
  };
}

/** Deck (Karten-IDs, Wiederholung = Exemplare) → Karten für den Kampf; nicht spielbare fallen heraus */
function deckCards(ids, opts) {
  return ids
    .map((id) => catalog.cardById[id])
    .filter(Boolean)
    .map((c) => ({ id: c.id, name: c.name, image: c.image, rarity: c.rarity, kampf: kampfFor(c, opts) }))
    .filter((c) => c.kampf);
}

/** Dio Meister der Schatten als Boss für die Regeln */
function bossDef(opts) {
  const b = opts.boss;
  return {
    key: 'dio',
    name: 'Dio Meister der Schatten',
    hp: b.hp,
    wutAb: b.wutAb / 100,
    wutFaktor: b.wutFaktor / 100,
    feldZiel: b.feldZiel / 100, // Chance, dass ein Angriff eine Karte auf dem Spielfeld trifft
    vorneFaktor: b.vorneFaktor, // ganz vorne liegende Karten so viel öfter Ziel als ganz hinten
    nahReichweite: b.nahReichweite / 100, // so weit (Anteil der Tiefe) reicht Nahkampf, die Armbrust (fern) überall hin
    muenze: { kopfChance: b.kopfChance / 100, kopfFaktor: b.kopfFaktor / 100 },
    // Krit-Lotterie wie Dios Karte (public/js/bossfight-regeln.js: rundeEnde, zusatztreffer)
    lotterie: { kopfChance: b.kopfChance / 100, kritFaktor: b.kritFaktor / 100, grundKrit: b.grundKrit / 100, tokenKrit: b.tokenKrit / 100, zusatz: [b.zusatzMin, b.zusatzMax] },
    angriffe: opts.angriffe
      .filter((a) => a.gewicht > 0)
      .map((a) => ({
        key: a.key,
        name: a.name,
        schaden: [a.min, a.max],
        gewicht: a.gewicht,
        ...(a.schwer ? { schwer: true } : {}),
        ...(a.gift && a.giftRunden ? { gift: { schaden: a.gift, runden: a.giftRunden } } : {}),
        ...(a.netz ? { netz: a.netz } : {}),
        ...(a.muenze ? { muenze: true } : {}),
        ...(a.fern ? { fern: true } : {}),
      })),
  };
}

/** Werte des Spielers für die Regeln (zwei Hände für Ausrüstung wie im Bosskampf; Energie wächst jede Runde) */
const spielerDef = (opts) => ({ ...opts.spieler, haende: 2 });

/** Zufall aus einem Startwert (mulberry32) – Server und Tests bekommen bei gleichem Startwert dieselben Würfe */
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ein Zug auf den Zustand anwenden. action: { a: 'spielen', uid, ziel, x, y } | { a: 'einsetzen', uid } | { a: 'ende' } (x/y: Platz auf dem Spielfeld) */
function applyAction(s, action) {
  if (!action || typeof action !== 'object') return [{ t: 'nein', grund: 'Unbekannter Zug.' }];
  if (action.a === 'spielen') return R.spielen(s, Number(action.uid), action.ziel == null ? undefined : Number(action.ziel), action.x == null ? null : { x: action.x, y: action.y });
  if (action.a === 'einsetzen') return R.einsetzen(s, Number(action.uid));
  if (action.a === 'ende') return R.rundeEnde(s);
  return [{ t: 'nein', grund: 'Unbekannter Zug.' }];
}

/** Hat ein Zug etwas bewirkt? (abgelehnte Züge werden nicht gespeichert) */
const accepted = (ev) => ev.length > 0 && !(ev.length === 1 && ev[0].t === 'nein');

/**
 * Kampf aus Startwert und gespeicherten Zügen wiederherstellen.
 * snap: { spieler, boss, karten } (beim Start festgehalten – spätere Änderungen im Admin-Panel ändern laufende Kämpfe nicht)
 * Gibt { s, ev } zurück; ev = Ereignisse des Starts (nur beim ersten Anzeigen gebraucht).
 */
function replay(seed, snap, actions = []) {
  const start = R.neu(snap.karten, { rng: mulberry(seed), spieler: snap.spieler, boss: snap.boss });
  for (const a of actions) applyAction(start.s, a);
  return start;
}

/** Was der Browser sehen darf: alles außer Zufall und der Reihenfolge des Nachziehstapels */
function publicState(s) {
  return {
    runde: s.runde,
    energie: s.energie,
    sp: s.sp,
    spieler: s.spieler,
    boss: s.boss,
    bd: { key: s.bd.key, name: s.bd.name, hp: s.bd.hp, wutAb: s.bd.wutAb, muenze: s.bd.muenze || null, lotterie: s.bd.lotterie || null, feldZiel: s.bd.feldZiel || 0, vorneFaktor: s.bd.vorneFaktor || 1, nahReichweite: s.bd.nahReichweite == null ? 1 : s.bd.nahReichweite },
    hand: s.hand,
    gear: s.gear,
    feld: s.feld,
    exil: s.exil,
    maxEnergie: s.maxEnergie,
    effekte: s.effekte,
    gespielt: s.gespielt,
    absicht: s.absicht,
    vorbei: s.vorbei,
    deck: s.deck.length,
    log: s.log,
  };
}

module.exports = { ROLE_LABEL, roleOf, PERMANENT_OK, ATTACKS, RARITY_KEYS, DEFAULTS, LIMITS, cleanSettings, mergeSettings, kampfFor, deckCards, bossDef, spielerDef, mulberry, applyAction, accepted, replay, publicState };

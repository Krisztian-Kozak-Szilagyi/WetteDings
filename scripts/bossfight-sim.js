// Bosskampf-Simulation für die Balance: spielt viele Kämpfe mit den echten Regeln (public/js/bossfight-regeln.js)
// und den Test-Karten (src/tcg/cardData.js). Drei Spielweisen:
//   zufall  – spielt, was geht, in zufälliger Reihenfolge
//   gierig  – nur Schaden, Verteidigung egal
//   klug    – schaut einen Zug voraus: Schaden, aber auch angekündigter Boss-Angriff, Leben, Block, Stärkungen
// Ziel (mittel bis schwer): klug gewinnt oft, aber nicht immer; wer nicht nachdenkt, verliert meistens.
//
// npm run sim:bosskampf [-- --n 3000 --seed 7 --deck alle|zufall]
const path = require('path');
const R = require(path.join(__dirname, '..', 'public', 'js', 'bossfight-regeln.js'));
const CARD_DATA = require(path.join(__dirname, '..', 'src', 'tcg', 'cardData.js'));
const { copyLimit } = require(path.join(__dirname, '..', 'src', 'game', 'deck.js'));

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const N = Number(arg('n', 2000));
const SEED = Number(arg('seed', 1));
const DECKART = arg('deck', 'zufall');

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Alle Test-Karten mit Kampfwerten, jede so oft, wie sie ins Deck darf (Items 1, Helden 2)
const KARTEN = Object.entries(CARD_DATA)
  .filter(([, d]) => d.kampf)
  .map(([id, d]) => ({ id, name: d.name, kampf: d.kampf }));
const POOL = KARTEN.flatMap((c) => Array(copyLimit({ rarity: 'test-item', kampf: c.kampf })).fill(c));

function deckFuer(rng) {
  if (DECKART === 'alle') return POOL.slice();
  const p = POOL.slice();
  for (let j = p.length - 1; j > 0; j--) {
    const r = Math.floor(rng() * (j + 1));
    [p[j], p[r]] = [p[r], p[j]];
  }
  return p.slice(0, 30);
}

// ---------- Bewertung eines Zustands (für "klug") ----------
function wert(s) {
  if (s.vorbei === 'sieg') return 1e6;
  if (s.vorbei === 'niederlage') return -1e6;
  let v = s.boss.max - s.boss.hp;
  for (const e of s.effekte) {
    if (e.art === 'nachladen') v += e.wert;
    if (e.art === 'dot') v += e.wert * e.runden;
    if (e.art === 'gift') v -= 1.5 * e.wert * e.runden;
  }
  // Ausrüstung: Angriffe der nächsten Runden, Schilde: weniger Schaden
  for (const g of s.gear) {
    const k = g.card.kampf;
    if (R.istAngriffsItem(k)) v += ((k.schaden || 0) + (g.bonus || 0)) * 2.5;
    if (k.typ === 'schild') v += ((k.schutz || 0) / 100) * 11 * (k.haltbarkeit ? k.haltbarkeit - g.hits : 5) * 1.3;
  }
  // Stärkungen in der Hand
  for (const i of s.hand) v += R.buffSumme(i, 'ang') * 0.9 + R.buffSumme(i, 'sch') * 0.5 + R.buffSumme(i, 'kosten') * 6;
  // Leben nach dem angekündigten Angriff – je weniger Leben, desto wertvoller jeder Punkt
  const nach = s.spieler.hp - R.vorschau(s).wert;
  const hpWert = (hp) => (hp <= 0 ? -1e5 : hp > 60 ? 60 * 1.6 + (hp - 60) * 1.3 : hp * 1.6);
  v += hpWert(nach);
  return v;
}

function zuege(s) {
  const list = [];
  for (const g of s.gear) if (R.istAngriffsItem(g.card.kampf) && !g.used) list.push({ art: 'einsetzen', uid: g.uid });
  for (const i of s.hand) {
    const ok = R.spielbar(s, i.uid);
    if (!ok.ok) continue;
    if (ok.ziel) for (const z of R.ziele(s, i.uid)) list.push({ art: 'spielen', uid: i.uid, ziel: z });
    else list.push({ art: 'spielen', uid: i.uid });
  }
  return list;
}
const ausfuehren = (s, z) => (z.art === 'einsetzen' ? R.einsetzen(s, z.uid) : R.spielen(s, z.uid, z.ziel));

const SPIELWEISEN = {
  zufall(s, rng) {
    for (let guard = 0; guard < 30 && !s.vorbei; guard++) {
      const z = zuege(s);
      if (!z.length) break;
      ausfuehren(s, z[Math.floor(rng() * z.length)]);
    }
  },
  gierig(s) {
    for (let guard = 0; guard < 30 && !s.vorbei; guard++) {
      let best = null;
      let bestV = 0;
      for (const z of zuege(s)) {
        const k = R.klon(s);
        k.rng = () => 0.999;
        ausfuehren(k, z);
        let v = k.boss.max - k.boss.hp;
        for (const e of k.effekte) if (e.art === 'nachladen' || e.art === 'dot') v += e.wert * (e.art === 'dot' ? e.runden : 1);
        for (const g of k.gear) if (R.istAngriffsItem(g.card.kampf)) v += (g.card.kampf.schaden || 0) * 2;
        for (const i of k.hand) v += R.buffSumme(i, 'ang');
        v -= s.boss.max - s.boss.hp;
        for (const e of s.effekte) if (e.art === 'nachladen' || e.art === 'dot') v -= e.wert * (e.art === 'dot' ? e.runden : 1);
        for (const g of s.gear) if (R.istAngriffsItem(g.card.kampf)) v -= (g.card.kampf.schaden || 0) * 2;
        for (const i of s.hand) v -= R.buffSumme(i, 'ang');
        if (v > bestV) {
          bestV = v;
          best = z;
        }
      }
      if (!best) break;
      ausfuehren(s, best);
    }
  },
  // Plant die ganze Runde: alle bezahlbaren Kartenkombinationen (Energie-Karten zuerst, dann Druiden, Hinterhalt
  // zuletzt), danach alle Waffen/Zauber einsetzen; gewählt wird der Plan mit der besten Bewertung (wert)
  klug(s) {
    const prio = (i) => {
      const e = i.card.kampf.effekt || {};
      return e.energie ? 0 : e.staerken ? 1 : e.hinterhalt ? 3 : 2;
    };
    let best = { v: -Infinity, plan: [] };
    const suche = (st, rest, plan) => {
      const blatt = R.klon(st);
      blatt.rng = () => 0.999;
      for (const g of blatt.gear) if (R.istAngriffsItem(g.card.kampf) && !g.used) R.einsetzen(blatt, g.uid);
      const v = wert(blatt);
      if (v > best.v) best = { v, plan: plan.slice() };
      for (let i = 0; i < rest.length; i++) {
        const inst = rest[i];
        const ok = R.spielbar(st, inst.uid);
        if (!ok.ok) continue;
        for (const ziel of ok.ziel ? R.ziele(st, inst.uid) : [undefined]) {
          const k = R.klon(st);
          k.rng = () => 0.999;
          R.spielen(k, inst.uid, ziel);
          plan.push({ uid: inst.uid, ziel });
          suche(k, rest.slice(i + 1), plan);
          plan.pop();
        }
      }
    };
    suche(s, s.hand.slice().sort((x, y) => prio(x) - prio(y)), []);
    for (const p of best.plan) if (!s.vorbei) R.spielen(s, p.uid, p.ziel);
    for (const g of s.gear.slice()) if (!s.vorbei && R.istAngriffsItem(g.card.kampf) && !g.used) R.einsetzen(s, g.uid);
  },
};

function kampf(spielweise, rng) {
  const deck = deckFuer(rng);
  const { s } = R.neu(deck, { rng });
  s.deckIds = deck.map((c) => c.id);
  while (!s.vorbei && s.runde <= 60) {
    SPIELWEISEN[spielweise](s, rng);
    if (!s.vorbei) R.rundeEnde(s);
  }
  return s;
}

module.exports = { SPIELWEISEN, wert, kampf };
if (require.main !== module) return;

const ergebnis = {};
// Karten-Analyse (klug, zufällige Decks): Siegquote mit der Karte im Deck – deutlich über dem Schnitt = zu stark
const kartenStat = new Map();
for (const sw of Object.keys(SPIELWEISEN)) {
  const rng = mulberry(SEED);
  let siege = 0;
  let runden = 0;
  let restSpieler = 0;
  let restBoss = 0;
  let niederlagen = 0;
  for (let i = 0; i < N; i++) {
    const s = kampf(sw, rng);
    if (sw === 'klug' && DECKART !== 'alle') {
      for (const id of new Set(s.deckIds)) {
        const k = kartenStat.get(id) || { mit: 0, siege: 0 };
        k.mit++;
        if (s.vorbei === 'sieg') k.siege++;
        kartenStat.set(id, k);
      }
    }
    runden += s.runde;
    if (s.vorbei === 'sieg') {
      siege++;
      restSpieler += s.spieler.hp;
    } else {
      niederlagen++;
      restBoss += s.boss.hp;
    }
  }
  ergebnis[sw] = {
    'Siege %': ((siege / N) * 100).toFixed(1),
    'Runden Ø': (runden / N).toFixed(1),
    'Leben übrig bei Sieg Ø': siege ? (restSpieler / siege).toFixed(0) : '–',
    'Boss-Leben bei Niederlage Ø': niederlagen ? (restBoss / niederlagen).toFixed(0) : '–',
  };
}
console.log(`Bosskampf-Simulation: ${N} Kämpfe je Spielweise, Deck: ${DECKART === 'alle' ? 'alle Test-Karten' : '30 zufällige Test-Karten'}, Boss ${R.SPINNE.hp} Leben`);
console.table(ergebnis);

if (process.argv.includes('--karten') && kartenStat.size) {
  const schnitt = Number(ergebnis.klug['Siege %']);
  const zeilen = [...kartenStat].map(([id, k]) => ({ Karte: id.replace('-test-item', ''), 'im Deck': k.mit, 'Siege % mit': ((k.siege / k.mit) * 100).toFixed(1), 'Abweichung': ((k.siege / k.mit) * 100 - schnitt).toFixed(1) }));
  zeilen.sort((a, b) => b['Abweichung'] - a['Abweichung']);
  console.table(zeilen);
}

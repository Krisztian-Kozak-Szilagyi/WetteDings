// Raid-Simulation für die Balance: spielt viele Kämpfe gegen Lucky Dio mit den echten Regeln und den Raid-Einstellungen
// (src/raid/logic.js). Decks aus den vorhandenen Charakterkarten, je Stufe einer typischen Sammlung (je Karte bis 2 Exemplare),
// gespielt mit den Spielweisen aus scripts/bossfight-sim.js (zufall, gierig, klug).
//
// npm run sim:raid [-- --n 400 --seed 1]
// Mit eigenen Werten: node scripts/raid-sim.js --boss-hp 500 --karten-ang 35 …
const path = require('path');
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/sim';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'x'.repeat(40);
const R = require(path.join(__dirname, '..', 'public', 'js', 'bossfight-regeln.js'));
const { SPIELWEISEN } = require('./bossfight-sim');
const logic = require(path.join(__dirname, '..', 'src', 'raid', 'logic.js'));
const catalog = require(path.join(__dirname, '..', 'src', 'tcg', 'catalog.js'));

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const N = Number(arg('n', 400));
const SEED = Number(arg('seed', 1));

// Werte aus der Kommandozeile überschreiben: --boss-hp 500, --karten-ang 35, --spieler-hp 120 …
const opts = JSON.parse(JSON.stringify(logic.DEFAULTS));
for (const part of ['boss', 'spieler', 'karten']) {
  for (const k of Object.keys(opts[part])) {
    const v = arg(`${part}-${k}`, null);
    if (v !== null && typeof opts[part][k] === 'number') opts[part][k] = Number(v);
  }
}
// --kosten-alle 1: alle Seltenheiten kosten gleich viel Energie
if (arg('kosten-alle', null) !== null) for (const r of Object.keys(opts.karten.kosten)) opts.karten.kosten[r] = Number(arg('kosten-alle'));

// Sammlungen: Charaktere der genannten Seltenheiten, je Karte bis 2 Exemplare, 30 Karten
const STUFEN = [
  { name: 'Anfänger (Crumpled/BFWler)', rar: ['crumpled', 'bfwler'] },
  { name: 'Mittel (Gold/Holo)', rar: ['gold', 'holo'] },
  { name: 'Stark (Holo/Bockhaber)', rar: ['holo', 'bockhaber'] },
  { name: 'Top (Glitch, Boss)', rar: ['glitch', 'boss'] },
];

function deckFuer(stufe, rng) {
  const pool = catalog.CARDS.filter((c) => c.isCharacter && stufe.rar.includes(c.rarity) && c.id !== 'lucky-dio-boss').flatMap((c) => [c.id, c.id]);
  for (let j = pool.length - 1; j > 0; j--) {
    const r = Math.floor(rng() * (j + 1));
    [pool[j], pool[r]] = [pool[r], pool[j]];
  }
  return logic.deckCards(pool.slice(0, 30), opts);
}

function kampf(stufe, spielweise, rng) {
  const deck = deckFuer(stufe, rng);
  const { s } = R.neu(deck, { rng, spieler: logic.spielerDef(opts), boss: logic.bossDef(opts) });
  while (!s.vorbei && s.runde <= opts.maxRounds) {
    SPIELWEISEN[spielweise](s, rng);
    if (!s.vorbei) R.rundeEnde(s);
  }
  if (!s.vorbei) s.vorbei = 'niederlage'; // Dio entkommt nach maxRounds
  return s;
}

if (require.main === module) {
  console.log(`Raid gegen Lucky Dio – ${N} Kämpfe je Deck und Spielweise (Boss ${opts.boss.hp} Leben, Spieler ${opts.spieler.hp})\n`);
  console.log('Deck'.padEnd(30) + 'Spielweise'.padEnd(12) + 'Siege'.padStart(7) + 'Ø Runden'.padStart(10) + 'Ø Boss-Rest'.padStart(13));
  for (const stufe of STUFEN) {
    for (const sw of ['zufall', 'gierig', 'klug']) {
      const rng = logic.mulberry(SEED);
      let siege = 0;
      let runden = 0;
      let rest = 0;
      for (let i = 0; i < N; i++) {
        const s = kampf(stufe, sw, rng);
        if (s.vorbei === 'sieg') siege++;
        runden += s.runde;
        rest += s.boss.hp;
      }
      console.log(stufe.name.padEnd(30) + sw.padEnd(12) + `${Math.round((siege / N) * 100)} %`.padStart(7) + (runden / N).toFixed(1).padStart(10) + Math.round(rest / N).toString().padStart(13));
    }
  }
  // Kampfwerte einiger Karten zur Einordnung
  console.log('\nKampfwerte (abgeleitet):');
  for (const id of ['krisz-1-crumpled', 'krisz-3-gold', 'krisz-4-holo', 'krisz-5-bockhaber', 'krisz-6-glitch', 'st-ivan-boss', 'luca-6-glitch']) {
    const k = logic.kampfFor(catalog.cardById[id], opts);
    console.log(`  ${id.padEnd(20)} Kosten ${k.kosten} · ANG ${k.ang} · SCH ${k.sch} · HEI ${k.hei}`);
  }
}

module.exports = { kampf, STUFEN, opts };

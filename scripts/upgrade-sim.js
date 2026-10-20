// Kartenaufwertung: Belastet sie die Wirtschaft? Spielt sehr viele Verträge mit den echten Regeln
// (public/js/aufwertung-regeln.js) und den Standardwerten bzw. gespeicherten Preisen nach und zeigt je Einsatz:
//   - wie viel Kartenwert im Mittel zurückkommt (unter 100 % = es verschwindet Wert, die Aufwertung ist ein Abfluss)
//   - wie oft Erfolg, Glückstreffer und Jackpot fallen
//   - wie viele Glitch- und Icon-Karten so netto neu entstehen – verglichen mit denen, die Packs nebenbei liefern, während
//     man die eingesetzten Karten zieht (wer 10 Crumpled zieht, bekommt dabei im Mittel 0,017 Glitch/Icon)
//
// npm run sim:aufwertung [-- --n 1000000 --bonus 9 --jackpot 1 --rueckgabe 90]
const path = require('path');
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/sim';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'x'.repeat(40);
const up = require(path.join(__dirname, '..', 'src', 'tcg', 'upgrade.js'));
const Regeln = require(path.join(__dirname, '..', 'public', 'js', 'aufwertung-regeln.js'));
const catalog = require(path.join(__dirname, '..', 'src', 'tcg', 'catalog.js'));

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const N = arg('n', 1000000);
const S = { ...up.DEFAULTS };
for (const k of ['bonus', 'jackpot', 'rueckgabe', 'maxChance', 'count']) S[k] = arg(k, S[k]);

// Zufall mit festem Startwert (mulberry32), damit Läufe vergleichbar sind
let seed = 12345;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const ladder = up.ladderDefs();
const sell = Object.fromEntries(ladder.map((r) => [r.key, r.sell]));
const weight = Object.fromEntries(catalog.RARITIES.map((r) => [r.key, r.weight]));
const n = (k, c) => Array.from({ length: c }, () => k);
const C = S.count;
const SCENARIOS = [
  ...ladder.slice(0, -1).map((r) => ({ name: `${C}× ${r.label}`, keys: n(r.key, C) })),
  { name: `1 Gold + ${C - 1} BFWler`, keys: ['gold', ...n('bfwler', C - 1)] },
  { name: `5 Gold + ${C - 5} BFWler`, keys: [...n('gold', 5), ...n('bfwler', C - 5)] },
  { name: `1 Gold + ${C - 1} Crumpled`, keys: ['gold', ...n('crumpled', C - 1)] },
  { name: `1 Holo + ${C - 1} Gold`, keys: ['holo', ...n('gold', C - 1)] },
  { name: `1 Bockhaber + ${C - 1} Crumpled`, keys: ['bockhaber', ...n('crumpled', C - 1)] },
  { name: `1 Glitch + ${C - 1} Crumpled`, keys: ['glitch', ...n('crumpled', C - 1)] },
];

const euro = (c) => (c / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const pct = (x, d = 1) => (x * 100).toFixed(d).replace('.', ',') + ' %';
console.log(`Kartenaufwertung – ${N.toLocaleString('de-DE')} Verträge je Einsatz · Rückgabe höchstens ${S.rueckgabe} % · Glückstreffer ${(S.bonus / 100).toString().replace('.', ',')} % · Jackpot ${(S.jackpot / 100).toString().replace('.', ',')} %\n`);
console.log('Einsatz'.padEnd(26), 'Ziel'.padEnd(10), 'Chance'.padStart(8), 'Einsatz'.padStart(12), 'zurück Ø'.padStart(12), 'Rückgabe'.padStart(9), 'Glück'.padStart(8), 'Jackpot'.padStart(8), ' Glitch/Icon netto je Vertrag · aus Packs nebenbei');
let worst = 0;
for (const sc of SCENARIOS) {
  const v = Regeln.vertrag(sc.keys, ladder, S);
  if (!v) continue;
  let value = 0;
  const kinds = { erfolg: 0, fehlschlag: 0, bonus: 0, jackpot: 0 };
  let rare = 0; // neue Glitch- oder Icon-Karten
  for (let i = 0; i < N; i++) {
    const r = Regeln.wurf(sc.keys, v, rand);
    kinds[r.kind]++;
    value += sell[r.rarity];
    if (r.rarity === 'glitch' || r.rarity === 'icon') rare++;
  }
  // abzüglich der eingesetzten Glitch/Icon (sie verschwinden) – netto neu entstanden
  const usedRare = sc.keys.filter((k) => k === 'glitch' || k === 'icon').length;
  const netRare = (rare - usedRare * N) / N;
  // Packs: so viele Glitch/Icon fallen im Mittel nebenbei, während man genau diese Einsatzkarten zieht
  const packRare = sc.keys.reduce((sum, k) => sum + ((weight.glitch || 0) + (weight.icon || 0)) / weight[k], 0);
  const back = value / N / v.value;
  worst = Math.max(worst, back);
  console.log(
    sc.name.padEnd(26),
    (catalog.rarityByKey[v.target].label).padEnd(10),
    pct(v.chance).padStart(8),
    euro(v.value).padStart(12),
    euro(value / N).padStart(12),
    pct(back).padStart(9),
    String(kinds.bonus).padStart(8),
    String(kinds.jackpot).padStart(8),
    `  ${netRare.toFixed(4).replace('.', ',').padStart(9)} · ${packRare.toFixed(4).replace('.', ',')}${netRare > 0 && packRare > 0 ? ` (${pct(netRare / packRare)})` : ''}`
  );
}
console.log(`\nHöchste Rückgabe: ${pct(worst)} – Grenze ${S.rueckgabe} %. Unter 100 % heißt: Jede Aufwertung nimmt Kartenwert aus dem Spiel,`);
console.log('es entsteht nie mehr Wert, als eingesetzt wurde, und neue Spielgeld-Beträge entstehen gar nicht (die Aufwertung zahlt nichts aus).');

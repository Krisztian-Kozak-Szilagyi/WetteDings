/**
 * eSports-Liga: reine Rechnung ohne Datenbank (Rangliste der Woche, Kurssprung der Team-ETFs, Kurswirkung von Käufen).
 * Mit gleichen Eingaben immer dasselbe Ergebnis – getestet in test/esports.test.js.
 *
 * Woche: Jeden Sonntag um REPORT_TIME wertet die Liga die Mage-Tower-Läufe der vergangenen sieben Tage aus.
 * Es zählen nur Läufe, in denen alle drei Spieler Mitglieder desselben Teams waren (schon vor Beginn der Woche).
 * Punkte eines Teams = Summe der Runden seiner TOP_RUNS besten Läufe; bei Gleichstand teilen sich Teams den Platz.
 * Sprung: Platz 1 → +25 %, letzter Platz → −20 % (im Log-Maß linear dazwischen, die Mitte ±0);
 * wer seinen Platz der Vorwoche hält oder verbessert, bekommt HOLD_BONUS dazu.
 */

const REPORT_DAY = 0; // Sonntag (Date.getDay)
const REPORT_TIME = '20:00';
const TEAM_SIZE = 3; // so viele Spieler hat ein Turm-Lauf; erst ab so vielen Mitgliedern wird der ETF gehandelt
const MAX_MEMBERS = 6;
const TOP_RUNS = 2;
const START_PRICE = 50;
const TOP_CHANGE = 0.25; // Platz 1
const BOTTOM_CHANGE = -0.2; // letzter Platz
const HOLD_BONUS = 0.045; // Platz gehalten oder verbessert
const FOUND_COST = 100000; // Cent: Gründung 1.000 €
const LEAVE_FEE = 25000; // Cent: Austritt aus einem gehandelten Team 250 € (geht an die übrigen Mitglieder)
const BANKRUPT_FEE = 100000; // Cent: Konkurs je Mitglied 1.000 € (auch ins Minus)
const FREEZE_DAYS = 14; // so lange darf ein Team unter TEAM_SIZE Mitgliedern bleiben, dann Konkurs
// Kurswirkung von Käufen/Verkäufen: je 100 € 0,05 % (Log), höchstens 2 % je Auftrag
const IMPACT_PER_EURO = 0.000005;
const IMPACT_MAX = 0.02;

const LOG_TOP = Math.log1p(TOP_CHANGE);
const LOG_BOTTOM = Math.log1p(BOTTOM_CHANGE);
const LOG_HOLD = Math.log1p(HOLD_BONUS);

const NAME_PATTERN = /^[\p{L}0-9][\p{L}0-9 .&'’_-]{1,22}[\p{L}0-9.]$/u;
const TICKER_PATTERN = /^[A-Z]{3,5}$/;

/** Teamname bereinigen und prüfen → Name oder null */
function cleanName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  return NAME_PATTERN.test(name) ? name : null;
}

/** Kürzel bereinigen und prüfen → Kürzel oder null */
function cleanTicker(value) {
  const t = String(value || '').trim().toUpperCase();
  return TICKER_PATTERN.test(t) ? t : null;
}

/** Punkte eines Teams aus den Runden seiner Läufe: Summe der TOP_RUNS besten */
function scoreOf(rounds) {
  const best = [...rounds].sort((a, b) => b - a).slice(0, TOP_RUNS);
  return { score: best.reduce((s, r) => s + r, 0), best };
}

/**
 * Rangliste und Sprünge der Woche.
 * @param {{id: string, rounds: number[], prevRank: number|null}[]} teams  alle gehandelten Teams der Woche
 * @returns {{id: string, score: number, best: number[], rank: number, of: number, held: boolean, log: number, change: number}[]}
 *          sortiert nach Platz. rank beginnt bei 1; Teams mit gleichen Punkten teilen sich den Platz und den Sprung.
 */
function rankWeek(teams) {
  const rows = teams.map((t) => ({ id: t.id, prevRank: t.prevRank ?? null, ...scoreOf(t.rounds || []) }));
  rows.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  const n = rows.length;
  // Log-Sprung für die Position i (0 = oben): linear von LOG_TOP bis LOG_BOTTOM; ein einzelnes Team bleibt bei 0
  const posLog = (i) => (n < 2 ? 0 : LOG_TOP + ((LOG_BOTTOM - LOG_TOP) * i) / (n - 1));
  const out = [];
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && rows[j + 1].score === rows[i].score) j++;
    // Gleichstand: Durchschnitt der Positionen i … j
    let base = 0;
    for (let k = i; k <= j; k++) base += posLog(k);
    base /= j - i + 1;
    for (let k = i; k <= j; k++) {
      const r = rows[k];
      const rank = i + 1;
      // Bonus nur mit Punkten: ein Team ohne gültigen Lauf hält keinen Platz
      const held = r.score > 0 && r.prevRank !== null && rank <= r.prevRank;
      const log = base + (held ? LOG_HOLD : 0);
      out.push({ id: r.id, score: r.score, best: r.best, rank, of: n, held, log, change: Math.expm1(log) });
    }
    i = j + 1;
  }
  return out;
}

/** Kurswirkung eines Auftrags (Log): Kauf hebt, Verkauf senkt – minimal und gedeckelt */
function impactLog(cents, side) {
  const size = Math.min(IMPACT_MAX, Math.max(0, cents / 100) * IMPACT_PER_EURO);
  return side === 'verkauf' ? -size : size;
}

/** Austrittsgebühr auf die übrigen Mitglieder verteilen (Cent, ganze Zahlen; Rest an die Ersten) */
function splitFee(cents, count) {
  if (count <= 0) return [];
  const each = Math.floor(cents / count);
  return Array.from({ length: count }, (_, i) => each + (i < cents - each * count ? 1 : 0));
}

const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;

/** Text des Wochenberichts eines Teams (Forum, im Namen des Teams) */
function reportText(team, row, dateText) {
  const runs = row.best.length ? row.best.map((r) => `${r} ${r === 1 ? 'Stockwerk' : 'Stockwerke'}`).join(' und ') : 'keinen gültigen Lauf';
  const lines = [
    `# Wochenbericht vom ${dateText}`,
    '',
    `**Platz ${row.rank} von ${row.of}** in der Mage-Tower-Liga.`,
    '',
    row.best.length ? `Unsere besten Läufe der Woche: ${runs} – zusammen **${row.score} Punkte**.` : 'Diese Woche haben wir keinen gültigen Lauf als volles Team geschafft.',
    row.held ? 'Wir haben unseren Platz gehalten.' : '',
    '',
    `Kursbewegung des ${team.ticker}: **${pct(row.change)}**.`,
  ];
  return { title: `Wochenbericht ${dateText}: Platz ${row.rank} von ${row.of}`, body: lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n') };
}

module.exports = {
  REPORT_DAY,
  REPORT_TIME,
  TEAM_SIZE,
  MAX_MEMBERS,
  TOP_RUNS,
  START_PRICE,
  TOP_CHANGE,
  BOTTOM_CHANGE,
  HOLD_BONUS,
  FOUND_COST,
  LEAVE_FEE,
  BANKRUPT_FEE,
  FREEZE_DAYS,
  cleanName,
  cleanTicker,
  scoreOf,
  rankWeek,
  impactLog,
  splitFee,
  reportText,
};

/**
 * eSports-Liga: reine Rechnung ohne Datenbank (Rangliste der Woche, Kurssprung der Team-ETFs, Kurswirkung von Käufen).
 * Mit gleichen Eingaben immer dasselbe Ergebnis – getestet in test/esports.test.js.
 *
 * Woche: Jeden Sonntag um REPORT_TIME wertet die Liga die Mage-Tower-Läufe der vergangenen sieben Tage aus.
 * Es zählen nur Läufe, in denen alle drei Spieler Mitglieder desselben Teams waren (schon vor Beginn der Woche).
 * Wertung eines Teams = Summe der Runden (Stockwerke) seiner TOP_RUNS besten Läufe; bei Gleichstand entscheiden die
 * gesammelten Punkte dieser Läufe (auch die des verlorenen Stockwerks), erst danach teilen sich Teams den Platz.
 * Sprung: Platz 1 → +25 %, letzter Platz → −20 % (im Log-Maß linear dazwischen, die Mitte ±0);
 * wer seinen Platz der Vorwoche hält oder verbessert, bekommt HOLD_BONUS dazu.
 */

const REPORT_DAY = 0; // Sonntag (Date.getDay)
const REPORT_TIME = '20:00';
const TEAM_SIZE = 3; // so viele Spieler hat ein Turm-Lauf; erst ab so vielen Mitgliedern wird der ETF gehandelt
const MAX_MEMBERS = 4;
const TOP_RUNS = 2;
const START_PRICE = 50;
const TOP_CHANGE = 0.25; // Platz 1
const BOTTOM_CHANGE = -0.2; // letzter Platz
const HOLD_BONUS = 0.045; // Platz gehalten oder verbessert
const FOUND_COST = 100000; // Cent: Gründung 1.000 € (Startwert, Admin: Spielwerte → eSports)
const MAX_FOUND_COST = 10000000; // Cent: höchstens 100.000 €
const LEAVE_FEE = 25000; // Cent: Austritt aus einem gehandelten Team 250 € (geht an die übrigen Mitglieder)
const BANKRUPT_FEE = 100000; // Cent: Konkurs je Mitglied 1.000 € (auch ins Minus)
const FREEZE_DAYS = 14; // so lange darf ein Team unter TEAM_SIZE Mitgliedern bleiben, dann Konkurs
// Kurswirkung von Käufen/Verkäufen: je 100 € 0,05 % (Log), höchstens 2 % je Auftrag
const IMPACT_PER_EURO = 0.000005;
const IMPACT_MAX = 0.02;

// Trophäen: Platz 1–3 der Woche (Gold, Silber, Bronze) – nur mit Punkten und nur, wenn genug Teams Punkte haben
// (sonst holt ein einzelnes Team jede Woche Gold). Preise je Mitglied stellt der Admin ein; hier die Startwerte.
const PLACES = [
  { place: 1, key: 'gold', label: 'Gold' },
  { place: 2, key: 'silber', label: 'Silber' },
  { place: 3, key: 'bronze', label: 'Bronze' },
];
const DEFAULT_PRIZES = [
  { cash: 150000, packs: 10 },
  { cash: 100000, packs: 7 },
  { cash: 100000, packs: 5 },
];
const DEFAULT_MIN_TEAMS = 3;
const MAX_PRIZE_CASH = 10000000; // Cent: 100.000 €
const MAX_PRIZE_PACKS = 50;
// Profil: Teambild = Avatar aus dem Kosmetik-Shop, für Teams zum halben Preis (zahlt der Kapitän)
const TEAM_AVATAR_FACTOR = 0.5;
const BIO_MAX = 2000;
const MOTTO_MAX = 60;
const COLORS = [
  { key: 'gold', label: 'Gold', hex: '#d9a441' },
  { key: 'karmesin', label: 'Karmesin', hex: '#b3322b' },
  { key: 'smaragd', label: 'Smaragd', hex: '#2f9e6b' },
  { key: 'saphir', label: 'Saphir', hex: '#3a6fd8' },
  { key: 'violett', label: 'Violett', hex: '#8a55d6' },
  { key: 'tuerkis', label: 'Türkis', hex: '#25a8b5' },
  { key: 'orange', label: 'Orange', hex: '#e07a2e' },
  { key: 'rosa', label: 'Rosa', hex: '#d65a9a' },
  { key: 'silber', label: 'Silber', hex: '#9aa4b2' },
];

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

/**
 * Wertung aus den Läufen: runs = Zahlen (Runden) oder { rounds, points }. Die TOP_RUNS besten Läufe (Runden, dann Punkte)
 * → { score: Summe der Runden, points: Summe ihrer Punkte, best: Runden der besten Läufe }
 */
function scoreOf(runs) {
  const list = runs.map((r) => (typeof r === 'number' ? { rounds: r, points: 0 } : { rounds: r.rounds || 0, points: r.points || 0 }));
  const best = list.sort((a, b) => b.rounds - a.rounds || b.points - a.points).slice(0, TOP_RUNS);
  return { score: best.reduce((s, r) => s + r.rounds, 0), points: best.reduce((s, r) => s + r.points, 0), best: best.map((r) => r.rounds) };
}

/**
 * Rangliste und Sprünge der Woche.
 * @param {{id: string, runs?: {rounds: number, points: number}[], rounds?: number[], prevRank: number|null}[]} teams  alle gehandelten Teams der Woche
 * @returns {{id: string, score: number, best: number[], rank: number, of: number, held: boolean, log: number, change: number}[]}
 *          sortiert nach Platz. rank beginnt bei 1; Teams mit gleichen Punkten teilen sich den Platz und den Sprung.
 */
function rankWeek(teams) {
  const rows = teams.map((t) => ({ id: t.id, prevRank: t.prevRank ?? null, ...scoreOf(t.runs || t.rounds || []) }));
  rows.sort((a, b) => b.score - a.score || b.points - a.points || String(a.id).localeCompare(String(b.id)));
  const n = rows.length;
  // Log-Sprung für die Position i (0 = oben): linear von LOG_TOP bis LOG_BOTTOM; ein einzelnes Team bleibt bei 0
  const posLog = (i) => (n < 2 ? 0 : LOG_TOP + ((LOG_BOTTOM - LOG_TOP) * i) / (n - 1));
  const out = [];
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && rows[j + 1].score === rows[i].score && rows[j + 1].points === rows[i].points) j++;
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
      out.push({ id: r.id, score: r.score, points: r.points, best: r.best, rank, of: n, held, log, change: Math.expm1(log) });
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

/**
 * Mitglieder über der Obergrenze (z. B. nach dem Senken von MAX_MEMBERS): die zuletzt Beigetretenen müssen gehen,
 * der Kapitän nie. Liefert die zu entfernenden Mitglieder, neueste zuerst.
 */
function overflow(members, captain, max = MAX_MEMBERS) {
  if (members.length <= max) return [];
  return members
    .filter((m) => String(m.user) !== String(captain))
    .sort((x, y) => new Date(y.joinedAt) - new Date(x.joinedAt))
    .slice(0, members.length - max);
}

const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;

/**
 * Trophäen der Woche aus der Rangliste (rankWeek): Platz 1–3 mit Punkten, Gleichstand teilt die Trophäe.
 * Nur wenn mindestens minTeams Teams Punkte haben. → [{ id, place }]
 */
function trophies(rows, minTeams = DEFAULT_MIN_TEAMS) {
  const scored = rows.filter((r) => r.score > 0);
  if (scored.length < Math.max(1, minTeams)) return [];
  return scored.filter((r) => r.rank <= PLACES.length).map((r) => ({ id: r.id, place: r.rank }));
}

const placeInfo = (place) => PLACES.find((p) => p.place === place) || null;

/** Wer bekommt den Preis? Mitglieder, die schon vor Beginn der Woche im Team waren (wie bei den Läufen) */
const prizeMembers = (members, since) => members.filter((m) => new Date(m.joinedAt).getTime() <= new Date(since).getTime());

/** Admin-Werte prüfen: prizes = [{ cash, packs }] je Platz, minTeams → Fehlertext oder null */
function prizesError(prizes, minTeams) {
  if (!Array.isArray(prizes) || prizes.length !== PLACES.length) return 'Für jeden Platz fehlt ein Preis.';
  for (const [i, p] of prizes.entries()) {
    const label = PLACES[i].label;
    if (!Number.isInteger(p.cash) || p.cash < 0 || p.cash > MAX_PRIZE_CASH) return `${label}: Geld 0 bis ${(MAX_PRIZE_CASH / 100).toLocaleString('de-DE')} €.`;
    if (!Number.isInteger(p.packs) || p.packs < 0 || p.packs > MAX_PRIZE_PACKS) return `${label}: Booster Packs 0 bis ${MAX_PRIZE_PACKS}.`;
  }
  if (!Number.isInteger(minTeams) || minTeams < 1 || minTeams > 20) return 'Mindestzahl der Teams: 1 bis 20.';
  return null;
}

/** Gründungskosten (Cent) prüfen → Fehlertext oder null */
const foundCostError = (cents) =>
  Number.isInteger(cents) && cents >= 0 && cents <= MAX_FOUND_COST ? null : `Gründungskosten: 0 bis ${(MAX_FOUND_COST / 100).toLocaleString('de-DE')} €.`;

/** Preis eines Avatars fürs Team (aufgerundet) */
const teamAvatarPrice = (price) => Math.ceil(price * TEAM_AVATAR_FACTOR);

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '');
/** Profiltext (mehrzeilig, höchstens BIO_MAX Zeichen) */
const cleanBio = (v) => cleanText(v, BIO_MAX);
/** Motto (eine Zeile, höchstens MOTTO_MAX Zeichen) */
const cleanMotto = (v) => cleanText(typeof v === 'string' ? v.replace(/\s+/g, ' ') : v, MOTTO_MAX);
/** Teamfarbe nur aus der festen Liste */
const findColor = (key) => COLORS.find((c) => c.key === key) || null;

/** Text des Wochenberichts eines Teams (Forum, im Namen des Teams); place = gewonnene Trophäe (1–3) oder null */
function reportText(team, row, dateText, place = null) {
  const runs = row.best.length ? row.best.map((r) => `${r} ${r === 1 ? 'Stockwerk' : 'Stockwerke'}`).join(' und ') : 'keinen gültigen Lauf';
  const lines = [
    `# Wochenbericht vom ${dateText}`,
    '',
    `**Platz ${row.rank} von ${row.of}** in der Mage-Tower-Liga.`,
    '',
    row.best.length ? `Unsere besten Läufe der Woche: ${runs} – zusammen **${row.score} ${row.score === 1 ? 'Stockwerk' : 'Stockwerke'}**${row.points ? ` und ${row.points.toLocaleString('de-DE')} Punkte` : ''}.` : 'Diese Woche haben wir keinen gültigen Lauf als volles Team geschafft.',
    row.held ? 'Wir haben unseren Platz gehalten.' : '',
    place && placeInfo(place) ? `🏆 Dafür gibt es die **${placeInfo(place).label}-Trophäe** der Woche.` : '',
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
  overflow,
  reportText,
  PLACES,
  DEFAULT_PRIZES,
  DEFAULT_MIN_TEAMS,
  MAX_PRIZE_PACKS,
  BIO_MAX,
  MOTTO_MAX,
  COLORS,
  trophies,
  placeInfo,
  prizeMembers,
  prizesError,
  foundCostError,
  teamAvatarPrice,
  cleanBio,
  cleanMotto,
  findColor,
};

/**
 * Börsenbericht: tägliche Auswertung der Aktivität der Seite (18:30 Uhr deutscher Zeit) und daraus der Kurssprung
 * des BfW-TCG ETF. Reine Logik ohne Datenbank – der Zufall kommt als Parameter (rng), gleiche Eingabe → gleiches Ergebnis.
 *
 * Jede Kennzahl wird mit dem Schnitt der 7 Vortage verglichen: m = log2(heute / Schnitt), begrenzt auf −1 … +1
 * (doppelt so viel = +1, halb so viel = −1). So zählt die Richtung, nicht das Ausmaß: 50 % mehr Geld im Spiel
 * heißt nicht 50 % Kurs. Dazu kommen Rekorde (mehr als an jedem der bis zu 30 Vortage).
 * Sprung (Log-Rendite) = SCORE_WEIGHT · Stimmung + RECORD_WEIGHT · Rekordanteil + kleines Rauschen, begrenzt.
 * Beispiele: alles verdoppelt und überall Rekord ≈ +60 %, ein guter Tag ≈ +10–20 %, ein normaler Tag ≈ 0,
 * ein schwacher Tag ≈ −10–15 %, alles halbiert ≈ −25 %.
 *
 * Gegen Hochtreiben durch Einzelne zählen die Kennzahlen Aktionen je Mitglied höchstens PER_USER_CAP-mal pro Tag
 * (wird beim Sammeln angewendet, siehe reportService.js).
 */

const SCORE_WEIGHT = 0.3;
const RECORD_WEIGHT = 0.18;
const NOISE = 0.03;
const MIN_LOG = -0.35; // ≈ −30 %
const MAX_LOG = 0.55; // ≈ +73 %
const BASE_DAYS = 7;
const RECORD_MIN_DAYS = 3; // Rekorde erst, wenn es genug Vergleichstage gibt
const PER_USER_CAP = 20;

// Kennzahlen: types = Buchungsarten im Kontoauszug (Ledger); anleger/aktionen aus ActivityPulse, forum aus Beiträgen
const METRICS = [
  { key: 'anleger', label: 'Aktive Anleger', unit: 'Anleger', weight: 2 },
  { key: 'aktionen', label: 'Transaktionen', unit: 'Transaktionen', weight: 2 },
  { key: 'wetten', label: 'Wettgeschäft', unit: 'Einsätze', types: ['einsatz'] },
  { key: 'broker', label: 'Broker-Handel', unit: 'Orders', types: ['coin_kauf', 'coin_verkauf'] },
  { key: 'packs', label: 'Booster-Absatz', unit: 'Käufe', types: ['tcg_pack'] },
  { key: 'handel', label: 'Kartenhandel', unit: 'Abschlüsse', types: ['handel_kauf', 'black_market'] },
  { key: 'lotterie', label: 'Lotterie', unit: 'Lose', types: ['lotto_los'] },
  { key: 'ihk', label: 'IHK-Aufträge', unit: 'Quests', types: ['ihk_lohn'] },
  { key: 'dungeon', label: 'Dungeon-Expeditionen', unit: 'Siege', types: ['dungeon_lohn'] },
  { key: 'grading', label: 'Grading-Gewerbe', unit: 'Aufträge', types: ['grading_lohn'] },
  { key: 'forum', label: 'Forum', unit: 'Beiträge' },
];

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/**
 * Auswertung eines Tages.
 * @param {Object<string, number>} today  Kennzahl → Wert des Tages
 * @param {Array<Object<string, number>>} history  Vortage, neuester zuerst (bis zu 30)
 * @param {() => number} rng
 */
function evaluate(today, history = [], rng = Math.random) {
  const base = history.slice(0, BASE_DAYS);
  const rows = [];
  let wSum = 0;
  let sSum = 0;
  let records = 0;
  for (const m of METRICS) {
    const value = Math.max(0, Number(today[m.key]) || 0);
    const avg = base.length ? base.reduce((s, d) => s + (Number(d[m.key]) || 0), 0) / base.length : null;
    const best = history.length ? Math.max(...history.map((d) => Number(d[m.key]) || 0)) : 0;
    const active = avg !== null && (value > 0 || avg > 0);
    const score = active ? clamp(Math.log2((value + 1) / (avg + 1)), -1, 1) : 0;
    const record = history.length >= RECORD_MIN_DAYS && value > 0 && value > best;
    const weight = m.weight || 1;
    if (active) {
      wSum += weight;
      sSum += weight * score;
      if (record) records += 1;
    }
    rows.push({ key: m.key, label: m.label, unit: m.unit, value, avg, change: avg ? value / avg - 1 : null, score, record });
  }
  const count = rows.filter((r) => r.avg !== null && (r.value > 0 || r.avg > 0)).length;
  const sentiment = wSum ? sSum / wSum : 0;
  const recordShare = count ? records / count : 0;
  const noise = history.length ? (rng() * 2 - 1) * NOISE : 0;
  const log = history.length ? clamp(SCORE_WEIGHT * sentiment + RECORD_WEIGHT * recordShare + noise, MIN_LOG, MAX_LOG) : 0;
  return { rows, sentiment, records, recordShare, log, change: Math.expm1(log), mood: moodOf(log) };
}

/** Stimmung für Text und Anzeige: 'crash' | 'schwach' | 'seitwaerts' | 'fest' | 'stark' | 'euphorie' */
function moodOf(log) {
  if (log <= -0.15) return 'crash';
  if (log <= -0.04) return 'schwach';
  if (log < 0.04) return 'seitwaerts';
  if (log < 0.15) return 'fest';
  if (log < 0.3) return 'stark';
  return 'euphorie';
}

// ---------- Text ----------

const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];
const intFmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0, signDisplay: 'exceptZero' });

const OPENERS = {
  crash: [
    'Schwarzer Tag auf dem Parkett: Die Umsätze brechen auf breiter Front ein, die Händler verlassen den Saal mit hängenden Köpfen.',
    'Tiefrot. Auf dem Parkett herrscht gespenstische Stille, die Kennzahlen rauschen in den Keller.',
    'Die Bären haben das Kommando übernommen – kaum ein Sektor kann sich dem Abwärtssog entziehen.',
  ],
  schwach: [
    'Ein zäher Handelstag geht zu Ende. Die Aktivität bleibt hinter dem Wochenschnitt zurück, die Stimmung ist gedrückt.',
    'Leichte Abgaben auf dem Parkett: Die Marktteilnehmer zeigen sich heute zurückhaltend.',
    'Verhaltener Handel – viele Akteure scheinen lieber an der Seitenlinie zu warten.',
  ],
  seitwaerts: [
    'Ein unaufgeregter Handelstag: Die Kennzahlen bewegen sich im Rahmen des Wochenschnitts.',
    'Seitwärts ist auch eine Richtung – das Parkett zeigt sich heute ausgeglichen.',
    'Business as usual bei BfW Holdings. Weder Euphorie noch Panik prägen das Bild.',
  ],
  fest: [
    'Freundlicher Handel: Die Aktivität liegt spürbar über dem Wochenschnitt.',
    'Die Händler sind gut gelaunt – der Markt schließt fest.',
    'Solider Tag auf dem Parkett. Mehrere Sektoren legen zu, die Stimmung hellt sich auf.',
  ],
  stark: [
    'Starker Handelstag! Die Umsätze ziehen auf breiter Front an, die Bullen geben den Ton an.',
    'Kräftige Zuwächse: Das Parkett brummt, die Telefone klingeln ohne Pause.',
    'Ein Tag für die Chronik der Bullen – fast alle Sektoren melden deutliche Zuwächse.',
  ],
  euphorie: [
    'Euphorie auf dem Parkett! Rekorde purzeln, die Händler liegen sich in den Armen.',
    'Historischer Handelstag: Die Aktivität explodiert, die Analysten kommen mit dem Schreiben kaum hinterher.',
    'Das Parkett steht Kopf – ein Feuerwerk an Zuwächsen und Rekorden.',
  ],
};

const TOP = [
  'Zugpferd des Tages: **{label}** – {value} {unit} ({change} ggü. Wochenschnitt).',
  'Besonders gefragt war heute das Segment **{label}** – {value} {unit}, {change} im Vergleich zum Wochenschnitt.',
  'Die Nase vorn hatte **{label}**: {value} {unit} ({change}).',
];
const FLOP = [
  'Schlusslicht: **{label}** – nur {value} {unit} ({change}).',
  'Schwächer zeigte sich **{label}** – {value} {unit}, {change} gegenüber dem Wochenschnitt.',
  'Sorgenkind des Tages bleibt **{label}** ({value} {unit}, {change}).',
];
const RECORD = [
  'Neue Bestmarken in: {list}.',
  'Rekordverdächtig? Nein – Rekord! Allzeithochs in: {list}.',
  'Die Chronisten notieren neue Höchststände in: {list}.',
];
const CLOSERS = [
  'Die Börse wünscht einen erfolgreichen Handelsabend.',
  'Wir melden uns morgen um 18:30 Uhr mit dem nächsten Bericht.',
  'Wie es weitergeht, entscheidet der Markt. Bis morgen um 18:30 Uhr.',
  'Diese Analyse stellt keine Anlageberatung dar. Investieren Sie nur Spielgeld, das Sie zu verlieren bereit sind.',
];

const fill = (tpl, r) =>
  tpl
    .replace('{label}', r.label)
    .replace('{value}', intFmt.format(r.value))
    .replace('{unit}', r.unit)
    .replace('{change}', r.change === null ? 'neu' : `${pctFmt.format(r.change * 100)} %`);

/** Titel und Text (Forum-Auszeichnung) des Berichts – erwähnt keine Kurse */
function reportText(result, dateLabel, rng = Math.random) {
  const lines = [pick(rng, OPENERS[result.mood]), '', '## Kennzahlen des Handelstages'];
  const shown = result.rows.filter((r) => r.value > 0 || (r.avg || 0) > 0);
  for (const r of shown) {
    const vs = r.change === null ? '' : ` (${pctFmt.format(r.change * 100)} % ggü. Wochenschnitt)`;
    lines.push(`- ${r.label}: ${intFmt.format(r.value)} ${r.unit}${vs}${r.record ? ' – **Rekord**' : ''}`);
  }
  const ranked = shown.filter((r) => r.avg !== null && r.value > 0).sort((a, b) => b.score - a.score);
  const notes = [];
  if (ranked.length >= 2 && ranked[0].score > 0.1) notes.push(fill(pick(rng, TOP), ranked[0]));
  const last = ranked[ranked.length - 1];
  if (ranked.length >= 2 && last.score < -0.1) notes.push(fill(pick(rng, FLOP), last));
  const recs = shown.filter((r) => r.record).map((r) => r.label);
  if (recs.length) notes.push(pick(rng, RECORD).replace('{list}', recs.join(', ')));
  if (notes.length) lines.push('', '## Analyse', ...notes);
  lines.push('', pick(rng, CLOSERS));
  return { title: `Börsenbericht vom ${dateLabel}`, body: lines.join('\n') };
}

module.exports = { METRICS, PER_USER_CAP, BASE_DAYS, MIN_LOG, MAX_LOG, evaluate, moodOf, reportText };

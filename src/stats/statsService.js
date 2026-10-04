// Auswertungen für die Statistik-Seite (Admin/Dev). Jeder Reiter besteht aus Themenblöcken, die je eine
// Balancing-Frage beantworten – mit eigenen Kennzahlen, Verläufen und Tabellen. Kennzahlen über den Zeitraum
// werden mit dem gleich langen Zeitraum davor verglichen. Tage gelten in deutscher Zeit.
const config = require('../config');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Ledger = require('../models/Ledger');
const StatDaily = require('../models/StatDaily');
const UserActivity = require('../models/UserActivity');
const SettingsChange = require('../models/SettingsChange');
const DuelTip = require('../models/DuelTip');
const { TcgCard, TcgPack, TcgOpening } = require('../models/Tcg');
const { Trade } = require('../models/Trade');
const BlackMarket = require('../models/BlackMarket');
const { IhkRun } = require('../models/Ihk');
const { CoinHour, CoinTrade } = require('../models/Coin');
const { LotteryRound } = require('../models/Lottery');
const { ForumCategory, ForumThread } = require('../models/Forum');
const catalog = require('../tcg/catalog');
const tcgSettings = require('../tcg/settings');
const ihk = require('../ihk/ihkService');
const { DIFFICULTIES, questById } = require('../ihk/quests');
const { ranking } = require('../services/rankService');
const bonusService = require('../services/bonusService');
const { parseZonedLocal } = require('../lib/time');
const { ledgerLabels } = require('../lib/viewHelpers');
const { dayAndHour } = require('./activity');
const { distribution, quantile } = require('./snapshot');
const { compareGini } = require('./giniReference');

const TZ = config.timezone;
const RANGES = [7, 30, 90, 365];
const DEFAULT_RANGE = 30;
// Reiter der Statistik-Seite (key = URL-Parameter "bereich", bleibt stabil, damit Links weiter funktionieren)
const SECTIONS = [
  { key: 'uebersicht', label: 'Übersicht', icon: 'grid', description: 'Die wichtigsten Kennzahlen und alle Änderungen auf einen Blick.' },
  { key: 'wirtschaft', label: 'Wirtschaft', icon: 'trend', description: 'Geldmenge, woher das Geld kommt und wohin es verschwindet – und wie das Vermögen verteilt ist.' },
  { key: 'spieler', label: 'Aktivität', icon: 'users', description: 'Wie viele Mitglieder spielen, wann sie spielen, ob neue bleiben und welche Bereiche sie nutzen.' },
  { key: 'tcg', label: 'TCG & Handel', icon: 'cards', description: 'Booster Packs, Drop-Raten, Karten im Umlauf, Handel zwischen Mitgliedern und Black Market.' },
  { key: 'spiele', label: 'Wetten & Spiele', icon: 'dice', description: 'Wetten und Duelle, IHK-Quests, Samantha Coin und Lotterie.' },
  { key: 'mitglied', label: 'Einzelspieler', icon: 'user', description: 'Alle Kennzahlen zu einem einzelnen Mitglied – Vermögen, Aktivität, Wetten, Karten und mehr.' },
];

// Buchungsarten nach Bereich. Die Summe je Bereich zeigt, wie viel Geld dort entsteht (+) oder verschwindet (−);
// Umbuchungen zwischen Spielern (Einsätze → Gewinne, Kauf → Verkauf) heben sich bis auf den Verlust auf.
const LEDGER_GROUPS = [
  { key: 'start', label: 'Startguthaben', types: ['startguthaben'], hint: 'neue Mitglieder' },
  { key: 'bonus', label: 'Tagesbonus', types: ['bonus'], hint: 'für Mitglieder unter der Bonus-Grenze' },
  { key: 'ihk', label: 'IHK-Löhne', types: ['ihk_lohn'], hint: 'geschaffte Quests' },
  { key: 'dungeon', label: 'Dungeon', types: ['dungeon_lohn'], hint: 'Lohn für gewonnene Kämpfe' },
  { key: 'grading', label: 'Grading-Shop', types: ['grading_lohn', 'grading_ausbau'], hint: 'Löhne für Aufträge − Ausbau des Shops' },
  { key: 'tcg', label: 'TCG (Bank)', types: ['tcg_pack', 'tcg_verkauf', 'item_verkauf', 'black_market'], hint: 'Verkäufe an die Bank (Karten, Gegenstände) − Packs und Black Market' },
  { key: 'coin', label: 'Coin', types: ['coin_kauf', 'coin_verkauf'], hint: 'Verkäufe − Käufe (Kursgewinne/-verluste)' },
  { key: 'wetten', label: 'Wetten', types: ['einsatz', 'auszahlung', 'erstattung', 'provision', 'provision_schiri'], hint: 'noch offene Einsätze und verfallene Gewinne' },
  { key: 'lotterie', label: 'Lotterie', types: ['lotto_los', 'lotto_gewinn'], hint: 'noch nicht gezogene und verfallene Töpfe' },
  { key: 'handel', label: 'Handel', types: ['handel_kauf', 'handel_verkauf', 'handel_tausch_zahlung', 'handel_tausch_erhalt'], hint: 'Handelssteuer' },
  { key: 'loeschung', label: 'Gelöschte Konten', types: ['konto_geloescht'], hint: 'verfallenes Guthaben' },
];
const groupOfType = Object.fromEntries(LEDGER_GROUPS.flatMap((g) => g.types.map((t) => [t, g.key])));

// ---------- Tage, Zeiträume, Bündelung ----------

/** Tag ("YYYY-MM-DD") um n Tage verschoben */
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Alle Tage von from bis to (einschließlich) */
function dayList(from, to) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Wochentag eines Tages (0 = Montag … 6 = Sonntag) */
function weekday(day) {
  const [y, m, d] = day.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Kalenderwoche nach ISO 8601: { year, week } */
function isoWeek(day) {
  const thursday = addDays(day, 3 - weekday(day)); // der Donnerstag der Woche bestimmt das Jahr
  const year = Number(thursday.slice(0, 4));
  const firstThursday = addDays(`${year}-01-04`, 3 - weekday(`${year}-01-04`));
  const diff = (Date.parse(thursday) - Date.parse(firstThursday)) / 86400000;
  return { year, week: 1 + Math.round(diff / 7) };
}

/**
 * Zeitraum mit n Tagen bis heute; back = 1 liefert den gleich langen Zeitraum davor (für Vergleiche).
 * since/until: Beginn des ersten bzw. Ende des letzten Tages (als Zeitpunkte für Abfragen).
 */
function period(rangeDays, now = new Date(), back = 0) {
  const n = RANGES.includes(rangeDays) ? rangeDays : DEFAULT_RANGE;
  const to = addDays(dayAndHour(now).day, -n * back);
  const from = addDays(to, -(n - 1));
  return {
    range: n,
    from,
    to,
    days: dayList(from, to),
    since: parseZonedLocal(`${from}T00:00`, TZ),
    until: parseZonedLocal(`${addDays(to, 1)}T00:00`, TZ),
  };
}

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const short = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;
const long = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

/**
 * Tage zu Abschnitten für die Diagramme bündeln: bis 31 Tage je Tag, bis 120 Tage je Woche, darüber je Monat.
 * -> { unit: 'tag' | 'woche' | 'monat', list: [{ key, label, long, days }] }
 */
function buckets(days) {
  const unit = days.length <= 31 ? 'tag' : days.length <= 120 ? 'woche' : 'monat';
  const list = [];
  for (const d of days) {
    let key;
    let label;
    if (unit === 'tag') {
      key = d;
      label = short(d);
    } else if (unit === 'woche') {
      const w = isoWeek(d);
      key = `${w.year}-W${w.week}`;
      label = `KW ${w.week}`;
    } else {
      key = d.slice(0, 7);
      label = `${MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${d.slice(2, 4)}`;
    }
    const last = list[list.length - 1];
    if (last && last.key === key) last.days.push(d);
    else list.push({ key, label, days: [d] });
  }
  for (const b of list) {
    const first = b.days[0];
    const lastDay = b.days[b.days.length - 1];
    b.long = unit === 'tag' ? long(first) : unit === 'woche' ? `${b.label} · ${short(first)}–${long(lastDay)}` : `${MONTHS[Number(first.slice(5, 7)) - 1]} ${first.slice(0, 4)}`;
  }
  return { unit, list };
}

/**
 * Tageswerte je Abschnitt zusammenfassen. agg: 'sum' (Mengen je Tag), 'last' (Bestände wie Geldmenge oder
 * Kurs: letzter bekannter Wert) oder 'avg' (Durchschnitt je Tag, z. B. aktive Mitglieder).
 */
function aggregate(values, days, list, agg = 'sum') {
  const index = Object.fromEntries(days.map((d, i) => [d, i]));
  return list.map((b) => {
    const vals = b.days.map((d) => values[index[d]]).filter((v) => v !== null && v !== undefined);
    if (!vals.length) return agg === 'sum' ? 0 : null;
    if (agg === 'last') return vals[vals.length - 1];
    const sum = vals.reduce((s, v) => s + v, 0);
    return agg === 'avg' ? sum / b.days.length : sum;
  });
}

/**
 * Veränderung gegenüber dem Vorzeitraum: Beträge mit Vorzeichen (Zuflüsse) als Differenz, Anteile in
 * Prozentpunkten, alles andere relativ. -> { dir, abs | points | rel | isNew } oder null (kein Vergleich möglich)
 */
function delta(cur, prev, { unit, signed } = {}) {
  if (typeof cur !== 'number' || typeof prev !== 'number') return null;
  const dir = cur > prev ? 'up' : cur < prev ? 'down' : 'flat';
  if (unit === 'euro' && signed) return { dir, abs: cur - prev };
  if (unit === 'percent' || unit === 'ratio') return { dir, points: cur - prev };
  if (prev === 0) return cur === 0 ? { dir, rel: 0 } : { dir, isNew: true };
  return { dir, rel: (cur - prev) / Math.abs(prev) };
}

/** Mongo-Ausdruck: Tag eines Datumsfelds in deutscher Zeit */
const dayOf = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: TZ } });
/** Filter: Datumsfeld im Zeitraum */
const inP = (p, field = 'createdAt') => ({ [field]: { $gte: p.since, $lt: p.until } });
/** Werte je Tag aus { day: value } in der Reihenfolge der Tage (fehlende Tage = fallback) */
const byDays = (days, map, fallback = 0) => days.map((d) => (map[d] === undefined ? fallback : map[d]));
/** Liste von { _id, … } zu { _id: wert } */
const toMap = (rows, key = 'n') => Object.fromEntries(rows.map((r) => [r._id, r[key]]));
const pct = (part, total) => (total ? part / total : null);
const sumBy = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
const avg = (sum, n) => (n ? sum / n : null);

// ---------- Retention ----------

/**
 * Anteil der neuen Mitglieder, die n Tage nach der Registrierung wieder aktiv waren (genau an diesem Tag).
 * cohort: [{ user, day }], activeDays: Map userId -> Set(Tage), offsets: z. B. [1, 7, 30].
 * Mitglieder, deren Stichtag noch nicht erreicht ist, zählen nicht mit.
 */
function retention(cohort, activeDays, offsets, today) {
  return offsets.map((n) => {
    const due = cohort.filter((c) => addDays(c.day, n) <= today);
    const kept = due.filter((c) => (activeDays.get(String(c.user)) || new Set()).has(addDays(c.day, n)));
    return { offset: n, eligible: due.length, retained: kept.length, rate: pct(kept.length, due.length) };
  });
}

// ---------- Drop-Raten ----------

/**
 * Tatsächliche Chance je Seltenheit: Gibt es zu einer Seltenheit (noch) keine Karte, fällt die Ziehung auf die
 * nächstniedrigere mit Karten zurück (siehe catalog.drawCard) – ihr Anteil zählt dort mit.
 */
function effectiveChances(rarities, cards) {
  const has = new Set(cards.map((c) => c.rarity));
  const total = rarities.reduce((s, r) => s + r.weight, 0);
  const out = Object.fromEntries(rarities.map((r) => [r.key, 0]));
  rarities.forEach((r, i) => {
    let j = i;
    while (j > 0 && !has.has(rarities[j].key)) j--;
    out[rarities[j].key] += r.weight;
  });
  for (const k of Object.keys(out)) out[k] /= total;
  return out;
}

/**
 * Weicht die gezogene Anzahl auffällig vom Erwartungswert ab? Normalnäherung der Binomialverteilung:
 * |z| > 3 gilt als auffällig. Bei weniger als 5 erwarteten Karten ist keine Aussage möglich.
 * -> 'wenig-daten' | 'im-rahmen' | 'zu-oft' | 'zu-selten'
 */
function pullVerdict(count, total, chance) {
  const expected = total * chance;
  if (expected < 5 || chance <= 0 || chance >= 1) return 'wenig-daten';
  const z = (count - expected) / Math.sqrt(total * chance * (1 - chance));
  return z > 3 ? 'zu-oft' : z < -3 ? 'zu-selten' : 'im-rahmen';
}

// ---------- Markierungen ----------

const AREA_SHORT = { tcg: 'TCG', ihk: 'IHK', handel: 'Handel', bonus: 'Bonus', grading: 'Grading', folie: 'Folie', config: '.env' };

/** Einstellungsänderungen und Patchnotes im Zeitraum – Markierungen in allen Verläufen */
async function markers(p) {
  const patchCat = await ForumCategory.findOne({ key: 'patchnotes' }).select('_id').lean();
  const [changes, patches] = await Promise.all([
    SettingsChange.find(inP(p)).sort({ createdAt: 1 }).lean(),
    patchCat ? ForumThread.find({ category: patchCat._id, deleted: false, ...inP(p) }).select('title createdAt').sort({ createdAt: 1 }).lean() : [],
  ]);
  const list = [
    ...changes.map((c) => ({
      day: dayAndHour(c.createdAt).day,
      at: c.createdAt,
      kind: 'einstellung',
      short: AREA_SHORT[c.area] || c.area,
      label: `${AREA_SHORT[c.area] || c.area}: ${c.changes.length} Wert${c.changes.length === 1 ? '' : 'e'} geändert`,
      detail: c.changes.slice(0, 12).map((x) => `${x.path}: ${JSON.stringify(x.from)} → ${JSON.stringify(x.to)}`),
      by: c.byName || 'Serverstart',
    })),
    ...patches.map((t) => ({ day: dayAndHour(t.createdAt).day, at: t.createdAt, kind: 'patch', short: 'Patch', label: t.title, detail: [], by: null })),
  ];
  return list.sort((a, b) => a.at - b.at);
}

// ---------- Wirtschaft ----------

async function economy(p) {
  const [flows, before, snapshots, players, typeTotals, activeDays] = await Promise.all([
    Ledger.aggregate([{ $match: inP(p) }, { $group: { _id: { d: dayOf('$createdAt'), t: '$type' }, s: { $sum: '$amount' } } }]),
    Ledger.aggregate([{ $match: { createdAt: { $lt: p.since } } }, { $group: { _id: null, s: { $sum: '$amount' } } }]),
    StatDaily.find({ _id: { $gte: p.from, $lte: p.to } }).select('_id wealth').sort({ _id: 1 }).lean(),
    ranking(),
    Ledger.aggregate([{ $match: inP(p) }, { $group: { _id: '$type', s: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    UserActivity.countDocuments({ day: { $gte: p.from, $lte: p.to } }),
  ]);

  // Netto je Bereich und Tag, dazu die Geldmenge (alle Buchungen bis Tagesende)
  const net = Object.fromEntries(LEDGER_GROUPS.map((g) => [g.key, {}]));
  const dayNet = {};
  for (const f of flows) {
    const g = groupOfType[f._id.t];
    if (g) net[g][f._id.d] = (net[g][f._id.d] || 0) + f.s;
    dayNet[f._id.d] = (dayNet[f._id.d] || 0) + f.s;
  }
  let supply = before[0] ? before[0].s : 0;
  const supplySeries = p.days.map((d) => (supply += dayNet[d] || 0));
  const periodNet = Object.values(dayNet).reduce((s, x) => s + x, 0);

  const dist = distribution(players.map((x) => x.total));
  const balanceSum = sumBy(players, 'balance');
  const fromSnap = (fn) => byDays(p.days, Object.fromEntries(snapshots.map((s) => [s._id, fn(s)])), null);

  // Bilanz je Bereich: Quellen (Geld entsteht) und Senken (Geld verschwindet)
  const groupTotals = LEDGER_GROUPS.map((g) => ({ ...g, value: Object.values(net[g.key]).reduce((s, x) => s + x, 0) })).filter((g) => g.value !== 0);
  const supplyNow = supplySeries[supplySeries.length - 1];
  // Ländervergleich erst ab ein paar Mitgliedern sinnvoll
  const giniCompare = dist.count >= 3 ? compareGini(dist.gini, config.appName) : null;

  return [
    {
      id: 'geldmenge',
      title: 'Geldmenge & Geldfluss',
      question: 'Wächst oder schrumpft das Spielgeld – und wo entsteht bzw. verschwindet es?',
      kpis: [
        { id: 'guthaben', label: 'Guthaben gesamt', value: balanceSum, unit: 'euro', hint: 'Summe aller Kontostände (jetzt)' },
        { id: 'zufluss', label: 'Netto-Geldzufluss', value: periodNet, unit: 'euro', signed: true, compare: true, hint: 'Neu entstandenes minus verschwundenes Geld im Zeitraum' },
        { id: 'zufluss-tag', label: 'Zufluss je Tag', value: Math.round(periodNet / p.range), unit: 'euro', signed: true, compare: true },
        {
          id: 'zufluss-spieler',
          label: 'Zufluss je aktivem Spieler und Tag',
          value: activeDays ? Math.round(periodNet / activeDays) : null,
          unit: 'euro',
          signed: true,
          compare: true,
          hint: 'Netto-Zufluss geteilt durch die Summe der aktiven Mitglieder je Tag',
        },
      ],
      flow: {
        sources: groupTotals.filter((g) => g.value > 0).sort((a, b) => b.value - a.value),
        sinks: groupTotals.filter((g) => g.value < 0).sort((a, b) => a.value - b.value),
      },
      charts: [
        { id: 'geldmenge', title: 'Geldmenge', type: 'line', unit: 'euro', agg: 'last', wide: true, series: [{ name: 'Geldmenge', values: supplySeries }] },
        {
          id: 'zufluss',
          title: 'Netto-Geldzufluss je Bereich',
          note: 'Über 0: Geld entsteht. Unter 0: Geld verschwindet.',
          type: 'stacked',
          unit: 'euro',
          agg: 'sum',
          wide: true,
          series: LEDGER_GROUPS.filter((g) => Object.keys(net[g.key]).length).map((g) => ({ name: g.label, values: byDays(p.days, net[g.key]) })),
        },
      ],
      // Abgleich: Kontostände gegen die Summe aller Buchungen (nur sinnvoll, wenn der Zeitraum bis heute reicht)
      warning: balanceSum !== supplyNow && p.to === dayAndHour().day ? { diff: balanceSum - supplyNow } : null,
      tables: [
        {
          title: 'Alle Buchungsarten im Zeitraum',
          collapsed: true,
          head: ['Art', 'Bereich', { label: 'Anzahl', num: true }, { label: 'Summe', num: true }],
          rows: typeTotals
            .sort((a, b) => a.s - b.s)
            .map((t) => [
              ledgerLabels[t._id] || t._id,
              (LEDGER_GROUPS.find((g) => g.key === groupOfType[t._id]) || {}).label || '–',
              { value: t.n, unit: 'count' },
              { value: t.s, unit: 'euro', signed: true },
            ]),
        },
      ],
    },
    {
      id: 'verteilung',
      title: 'Vermögensverteilung',
      question: 'Wie ungleich ist das Vermögen verteilt – auch im Vergleich zu echten Ländern?',
      giniCompare,
      kpis: [
        { id: 'vermoegen', label: 'Gesamtvermögen', value: dist.sum, unit: 'euro', hint: 'Guthaben + offene Einsätze + Coins + Karten und Packs (jetzt)' },
        { id: 'median', label: 'Median-Vermögen', value: dist.median, unit: 'euro', hint: 'Die Hälfte der Mitglieder hat weniger (jetzt)' },
        {
          id: 'gini',
          label: 'Gini-Koeffizient',
          value: dist.gini,
          unit: 'ratio',
          hint: `0 = alle gleich reich, 1 = einer besitzt alles (jetzt).${giniCompare ? ` Im Ländervergleich: ${giniCompare.text}.` : ''}`,
        },
        { id: 'top10', label: 'Anteil reichste 10 %', value: dist.top10Share, unit: 'percent', hint: 'am Gesamtvermögen (jetzt)' },
        { id: 'bonus', label: 'Tagesbonus', value: bonusService.settings.amount, unit: 'euro', hint: 'je Mitglied und Tag, für alle gleich (aktuell eingestellt). Wer im Grading-Shop arbeitet, bekommt keinen.' },
      ],
      charts: [
        { id: 'gini', title: 'Gini-Koeffizient', type: 'line', unit: 'ratio', agg: 'last', series: [{ name: 'Gini', values: fromSnap((s) => s.wealth.total && s.wealth.total.gini) }] },
        { id: 'median', title: 'Median-Vermögen', type: 'line', unit: 'euro', agg: 'last', series: [{ name: 'Median', values: fromSnap((s) => s.wealth.total && s.wealth.total.median) }] },
      ],
      notes: snapshots.length ? [] : ['Gini und Median im Verlauf kommen aus den Tages-Snapshots, die erst seit dem Statistik-Update aufgenommen werden.'],
      tables: [
        {
          title: 'Verteilung und Zusammensetzung (jetzt)',
          head: ['Kennzahl', { label: 'Wert', num: true }],
          rows: [
            ['10. Perzentil', { value: dist.p10, unit: 'euro' }],
            ['Median', { value: dist.median, unit: 'euro' }],
            ['Mittelwert', { value: dist.mean, unit: 'euro' }],
            ['90. Perzentil', { value: dist.p90, unit: 'euro' }],
            ['99. Perzentil', { value: dist.p99, unit: 'euro' }],
            ['Höchstes Vermögen', { value: dist.max, unit: 'euro' }],
            ['Anteil Guthaben', { value: pct(balanceSum, dist.sum), unit: 'percent' }],
            ['Anteil offene Einsätze', { value: pct(sumBy(players, 'inPlay'), dist.sum), unit: 'percent' }],
            ['Anteil Coins', { value: pct(sumBy(players, 'coinValue'), dist.sum), unit: 'percent' }],
            ['Anteil Karten & Packs', { value: pct(sumBy(players, 'cardValue'), dist.sum), unit: 'percent' }],
          ],
        },
      ],
    },
  ];
}

// ---------- Spieler ----------

async function playersSection(p, now = new Date()) {
  const today = dayAndHour(now).day;
  const monthFrom = addDays(today, -29);
  const actFrom = [p.from, monthFrom].sort()[0];
  const [members, banned, signups, cohortUsers, activity] = await Promise.all([
    User.countDocuments({ deletedAt: null }),
    User.countDocuments({ deletedAt: null, bannedUntil: { $gt: now } }),
    User.aggregate([{ $match: inP(p) }, { $group: { _id: dayOf('$createdAt'), n: { $sum: 1 } } }]),
    User.find(inP(p)).select('_id createdAt').lean(),
    // Für die Retention zählt auch Aktivität nach dem Zeitraum (bis heute)
    UserActivity.find({ day: { $gte: actFrom } }).select('user day views actions areas hours').lean(),
  ]);

  const activeByDay = {};
  const activeDays = new Map();
  const areas = {};
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  let views = 0;
  let actions = 0;
  const wau = new Set();
  const mau = new Set();
  for (const a of activity) {
    const uid = String(a.user);
    if (!activeDays.has(uid)) activeDays.set(uid, new Set());
    activeDays.get(uid).add(a.day);
    if (a.day >= addDays(today, -6)) wau.add(uid);
    if (a.day >= monthFrom) mau.add(uid);
    if (a.day < p.from || a.day > p.to) continue;
    activeByDay[a.day] = (activeByDay[a.day] || 0) + 1;
    views += a.views || 0;
    actions += a.actions || 0;
    for (const [k, n] of Object.entries(a.areas || {})) areas[k] = (areas[k] || 0) + n;
    for (const h of a.hours || []) heat[weekday(a.day)][h]++;
  }
  const cohort = cohortUsers.map((u) => ({ user: u._id, day: dayAndHour(u.createdAt).day }));
  const [d1, d7, d30] = retention(cohort, activeDays, [1, 7, 30], today);
  const areaTotal = Object.values(areas).reduce((s, n) => s + n, 0);
  const playerDays = Object.values(activeByDay).reduce((s, n) => s + n, 0);
  const retKpi = (r, id) => ({
    id,
    label: `Wieder aktiv nach ${r.offset} Tag${r.offset === 1 ? '' : 'en'}`,
    value: r.rate,
    unit: 'percent',
    compare: true,
    hint: r.eligible ? `${r.retained} von ${r.eligible} neuen Mitgliedern` : 'noch niemand lange genug dabei',
  });

  return [
    {
      id: 'aktivitaet',
      title: 'Aktive Mitglieder',
      question: 'Wie viele spielen – und wann?',
      kpis: [
        { id: 'mitglieder', label: 'Mitglieder', value: members, unit: 'count', hint: banned ? `davon ${banned} gesperrt (jetzt)` : 'jetzt' },
        { id: 'aktiv-tag', label: 'Aktive Mitglieder pro Tag (Ø)', value: playerDays / p.range, unit: 'number', compare: true },
        { id: 'aktiv-7', label: 'Aktiv letzte 7 Tage', value: wau.size, unit: 'count', hint: members ? `${Math.round((wau.size / members) * 100)} % der Mitglieder` : null },
        { id: 'aktiv-30', label: 'Aktiv letzte 30 Tage', value: mau.size, unit: 'count', hint: members ? `${Math.round((mau.size / members) * 100)} % der Mitglieder` : null },
        { id: 'aufrufe', label: 'Seitenaufrufe', value: views, unit: 'count', compare: true },
        { id: 'aktionen', label: 'Aktionen', value: actions, unit: 'count', compare: true, hint: 'abgeschickte Formulare: setzen, kaufen, posten …' },
      ],
      charts: [{ id: 'dau', title: 'Aktive Mitglieder je Tag', type: 'line', unit: 'number', agg: 'avg', wide: true, series: [{ name: 'Aktiv', values: byDays(p.days, activeByDay) }] }],
      heat: playerDays ? { rows: heat, max: Math.max(1, ...heat.flat()) } : null,
      notes: activity.length ? [] : ['Aktivitätsdaten werden erst seit dem Statistik-Update gesammelt – die Werte füllen sich ab jetzt Tag für Tag.'],
    },
    {
      id: 'wachstum',
      title: 'Neuzugänge & Bindung',
      question: 'Kommen neue Mitglieder dazu – und bleiben sie?',
      kpis: [{ id: 'neu', label: 'Neue Mitglieder', value: cohortUsers.length, unit: 'count', compare: true }, retKpi(d1, 'ret1'), retKpi(d7, 'ret7'), retKpi(d30, 'ret30')],
      charts: [{ id: 'neu', title: 'Registrierungen', type: 'bars', unit: 'count', agg: 'sum', wide: true, series: [{ name: 'Registrierungen', values: byDays(p.days, toMap(signups)) }] }],
    },
    {
      id: 'bereiche',
      title: 'Bereichsnutzung',
      question: 'Welche Bereiche werden genutzt?',
      hbars: {
        items: Object.entries(areas)
          .sort((a, b) => b[1] - a[1])
          .map(([key, n]) => ({ key, share: pct(n, areaTotal), text: `${n} · ${Math.round(pct(n, areaTotal) * 100)} %` })),
      },
      notes: areaTotal ? [] : ['Noch keine Daten im Zeitraum.'],
    },
  ];
}

// ---------- TCG & Handel ----------

const KIND_LABELS = { markt: 'Markt', privat: 'Privat', tausch: 'Tausch' };

async function tcg(p, now = new Date()) {
  const rarities = catalog.RARITIES;
  const [pulls, openingsByDay, inCirculation, packsUnopened, packSales, bankSales, bankPayout, trades, marketSales, bmDays] = await Promise.all([
    TcgOpening.aggregate([{ $match: inP(p) }, { $unwind: '$cards' }, { $group: { _id: '$cards.rarity', n: { $sum: 1 } } }]),
    TcgOpening.aggregate([{ $match: inP(p) }, { $group: { _id: dayOf('$createdAt'), n: { $sum: 1 } } }]),
    TcgCard.aggregate([{ $group: { _id: '$rarity', n: { $sum: 1 } } }]),
    TcgPack.countDocuments(),
    Ledger.aggregate([{ $match: { type: 'tcg_pack', ...inP(p) } }, { $group: { _id: null, s: { $sum: { $abs: '$amount' } } } }]),
    Ledger.aggregate([
      { $match: { type: 'tcg_verkauf', ...inP(p), 'meta.cards': { $exists: true } } },
      { $unwind: '$meta.cards' },
      { $group: { _id: '$meta.cards.rarity', n: { $sum: '$meta.cards.count' } } },
    ]),
    Ledger.aggregate([{ $match: { type: 'tcg_verkauf', ...inP(p) } }, { $group: { _id: null, s: { $sum: '$amount' } } }]),
    Trade.aggregate([
      { $match: inP(p) },
      {
        $group: {
          _id: { kind: '$kind', status: { $cond: [{ $and: [{ $eq: ['$status', 'offen'] }, { $lte: ['$expiresAt', now] }] }, 'abgelaufen', '$status'] } },
          n: { $sum: 1 },
          volume: { $sum: { $cond: [{ $eq: ['$status', 'verkauft'] }, '$price', 0] } },
          tax: { $sum: '$tax' },
        },
      },
    ]),
    Trade.find({ status: 'verkauft', kind: { $in: ['markt', 'privat'] }, ...inP(p, 'closedAt') }).select('card price').lean(),
    BlackMarket.find({ _id: { $gte: p.from, $lte: p.to } }).lean(),
  ]);

  const pullMap = toMap(pulls);
  const pullTotal = sumBy(pulls, 'n');
  const chances = effectiveChances(rarities, catalog.CARDS);
  const circ = toMap(inCirculation);
  const sold = toMap(bankSales);
  const ev = catalog.expectedPackValue();
  const packPrice = tcgSettings.getPackPrice();

  // Marktpreise je Seltenheit gegenüber dem Bankwert
  const prices = {};
  for (const t of marketSales) {
    const c = catalog.cardById[t.card];
    if (c) (prices[c.rarity] = prices[c.rarity] || []).push(t.price);
  }

  const tradeCount = (kind, status) => sumBy(trades.filter((t) => (!kind || t._id.kind === kind) && (!status || t._id.status === status)), 'n');
  const closed = tradeCount(null, 'verkauft');
  const created = tradeCount();

  const bmOffers = bmDays.flatMap((d) => d.offers);
  const bmSold = bmOffers.filter((o) => o.buyer);

  return [
    {
      id: 'packs',
      title: 'Booster Packs',
      question: 'Lohnt sich ein Pack – und wie viele werden gekauft?',
      kpis: [
        { id: 'packpreis', label: 'Packpreis', value: packPrice, unit: 'euro', hint: 'aktuell eingestellt' },
        { id: 'ev', label: 'Erwartungswert je Pack', value: Math.round(ev), unit: 'euro', hint: `Bank-Verkaufswert der ${catalog.CARDS_PER_PACK} Karten im Mittel (aktuelle Chancen und Preise)` },
        { id: 'rueckfluss', label: 'Pack-Rückfluss', value: pct(ev, packPrice), unit: 'percent', hint: 'Erwartungswert ÷ Packpreis. Unter 100 %: Packs ziehen im Mittel Geld aus dem Spiel.' },
        { id: 'pack-umsatz', label: 'Pack-Umsatz', value: packSales[0] ? packSales[0].s : 0, unit: 'euro', compare: true },
        { id: 'geoeffnet', label: 'Packs geöffnet', value: sumBy(openingsByDay, 'n'), unit: 'count', compare: true },
        { id: 'ungeoeffnet', label: 'Ungeöffnete Packs', value: packsUnopened, unit: 'count', hint: 'in allen Inventaren (jetzt)' },
      ],
      charts: [{ id: 'packs', title: 'Geöffnete Packs', type: 'bars', unit: 'count', agg: 'sum', wide: true, series: [{ name: 'Packs', values: byDays(p.days, toMap(openingsByDay)) }] }],
    },
    {
      id: 'drops',
      title: 'Drop-Raten',
      question: 'Stimmen die gezogenen Seltenheiten mit den eingestellten Chancen überein?',
      pulls: {
        total: pullTotal,
        rows: rarities.map((r) => {
          const count = pullMap[r.key] || 0;
          return {
            label: r.label + (r.hidden ? ' (geheim)' : ''),
            chance: chances[r.key],
            share: pct(count, pullTotal),
            expected: pullTotal * chances[r.key],
            count,
            verdict: pullVerdict(count, pullTotal, chances[r.key]),
          };
        }),
      },
    },
    {
      id: 'karten',
      title: 'Karten im Umlauf',
      question: 'Wie viele Karten gibt es – und wie viele gehen an die Bank zurück?',
      kpis: [
        { id: 'umlauf', label: 'Karten im Umlauf', value: sumBy(inCirculation, 'n'), unit: 'count', hint: 'jetzt' },
        { id: 'bank-verkauft', label: 'An die Bank verkauft', value: sumBy(bankSales, 'n'), unit: 'count', compare: true, hint: 'erst seit dem Update mit Karten-Details im Kontoauszug' },
        { id: 'bank-auszahlung', label: 'Bank-Auszahlungen', value: bankPayout[0] ? bankPayout[0].s : 0, unit: 'euro', compare: true },
      ],
      tables: [
        {
          title: 'Je Seltenheit',
          head: ['Seltenheit', { label: 'Bankwert', num: true }, { label: 'Im Umlauf', num: true }, { label: 'An Bank verkauft', num: true }],
          zeroCols: [2, 3],
          rows: rarities.map((r) => [r.label, { value: r.sell, unit: 'euro' }, { value: circ[r.key] || 0, unit: 'count' }, { value: sold[r.key] || 0, unit: 'count' }]),
        },
      ],
    },
    {
      id: 'handel',
      title: 'Handel',
      question: 'Wird gehandelt – und zu welchen Preisen im Vergleich zur Bank?',
      kpis: [
        { id: 'angebote', label: 'Neue Angebote', value: created, unit: 'count', compare: true },
        { id: 'abschluesse', label: 'Abgeschlossene Handelsgeschäfte', value: closed, unit: 'count', compare: true },
        { id: 'abschlussquote', label: 'Abschlussquote', value: pct(closed, created), unit: 'percent', compare: true },
        { id: 'handelsumsatz', label: 'Handelsumsatz', value: sumBy(trades, 'volume'), unit: 'euro', compare: true, hint: 'Kaufpreise und Aufpreise' },
        { id: 'steuer', label: 'Steuer', value: sumBy(trades, 'tax'), unit: 'euro', compare: true, hint: 'verlässt das Spiel' },
      ],
      hbars: {
        title: 'Abschlussquote je Art',
        items: Object.keys(KIND_LABELS)
          .filter((k) => tradeCount(k))
          .map((k) => ({ label: KIND_LABELS[k], share: pct(tradeCount(k, 'verkauft'), tradeCount(k)), text: `${tradeCount(k, 'verkauft')} von ${tradeCount(k)}` })),
      },
      tables: [
        {
          title: 'Marktpreise gegenüber dem Bankwert',
          note: 'Median der Verkaufspreise auf dem Markt und privat. Über 1: Karten sind den Mitgliedern mehr wert als die Bank zahlt.',
          head: ['Seltenheit', { label: 'Bankwert', num: true }, { label: 'Verkäufe', num: true }, { label: 'Median-Preis', num: true }, { label: 'Markt ÷ Bank', num: true }],
          zeroCols: [2],
          rows: rarities.map((r) => {
            const list = (prices[r.key] || []).sort((a, b) => a - b);
            const median = list.length ? quantile(list, 0.5) : null;
            return [r.label, { value: r.sell, unit: 'euro' }, { value: list.length, unit: 'count' }, { value: median, unit: 'euro' }, { value: median === null || !r.sell ? null : median / r.sell, unit: 'ratio' }];
          }),
        },
      ],
      notes: created ? [] : ['Keine Handelsangebote im Zeitraum.'],
    },
    {
      id: 'blackmarket',
      title: 'Black Market',
      question: 'Wird der Black Market angenommen?',
      kpis: [
        { id: 'bm-tage', label: 'Tage mit Angebot', value: bmDays.length, unit: 'count', compare: true },
        { id: 'bm-quote', label: 'Verkaufsquote', value: pct(bmSold.length, bmOffers.length), unit: 'percent', compare: true, hint: `${bmSold.length} von ${bmOffers.length} Karten` },
        { id: 'bm-umsatz', label: 'Black-Market-Umsatz', value: sumBy(bmSold, 'price'), unit: 'euro', compare: true, hint: 'verlässt das Spiel' },
      ],
    },
  ];
}

// ---------- Spiele: Wetten, IHK, Coin, Lotterie ----------

const VIA_LABELS = { einstimmig: 'Einstimmig', dev: 'Dev-Entscheid', system: 'Automatisch annulliert', ersteller: 'Ersteller allein', schiedsrichter: 'Schiedsrichter (Duell)' };

async function games(p) {
  const [newBets, stakes, resolved, betStats, devDisputes, duels, tips, runs, coinDays, coinVol, rounds] = await Promise.all([
    Bet.aggregate([{ $match: inP(p) }, { $group: { _id: dayOf('$createdAt'), n: { $sum: 1 } } }]),
    Ledger.aggregate([{ $match: { type: 'einsatz', ...inP(p) } }, { $group: { _id: dayOf('$createdAt'), s: { $sum: { $abs: '$amount' } } } }]),
    Bet.aggregate([{ $match: inP(p, 'resolvedAt') }, { $group: { _id: { via: '$resolvedVia', status: '$status' }, n: { $sum: 1 } } }]),
    Bet.aggregate([{ $match: inP(p) }, { $lookup: { from: 'positions', localField: '_id', foreignField: 'bet', as: 'pos' } }, { $group: { _id: null, bets: { $sum: 1 }, players: { $sum: { $size: '$pos' } } } }]),
    // Streitfall = beide Stimmen abgegeben, ein Dev hat entschieden
    Bet.countDocuments({ ...inP(p, 'resolvedAt'), 'votes.1': { $exists: true }, resolvedVia: 'dev' }),
    Bet.aggregate([{ $match: { 'duel.state': { $exists: true }, ...inP(p) } }, { $group: { _id: { state: '$duel.state', status: '$status' }, n: { $sum: 1 } } }]),
    DuelTip.countDocuments(inP(p)),
    IhkRun.aggregate([
      { $match: { status: 'fertig', ...inP(p, 'endsAt') } },
      {
        $group: {
          _id: { quest: '$quest', difficulty: '$difficulty' },
          n: { $sum: 1 },
          ok: { $sum: { $cond: ['$success', 1, 0] } },
          reward: { $sum: '$reward' },
          packs: { $sum: { $cond: [{ $ne: ['$pack', null] }, 1, 0] } },
          hybrid: { $max: { $cond: [{ $gt: ['$total2', null] }, 1, 0] } },
        },
      },
    ]),
    CoinHour.aggregate([{ $match: { coin: 'SAM', ...inP(p, 't') } }, { $sort: { t: 1 } }, { $group: { _id: dayOf('$t'), c: { $last: '$c' } } }, { $sort: { _id: 1 } }]),
    CoinTrade.aggregate([{ $match: inP(p) }, { $group: { _id: { d: dayOf('$createdAt'), side: '$side' }, s: { $sum: '$cents' }, users: { $addToSet: '$user' } } }]),
    LotteryRound.find({ status: 'gezogen', ...inP(p, 'drawnAt') }).sort({ drawnAt: 1 }).lean(),
  ]);

  // Wetten
  const resolvedTotal = sumBy(resolved, 'n');
  const bs = betStats[0] || { bets: 0, players: 0 };
  const duelCount = (state, status) => (duels.find((d) => d._id.state === state && d._id.status === status) || {}).n || 0;

  // IHK
  const runTotal = sumBy(runs, 'n');
  const okTotal = sumBy(runs, 'ok');
  const byLevel = DIFFICULTIES.map((d) => {
    const rows = runs.filter((r) => r._id.difficulty === d.level);
    const n = sumBy(rows, 'n');
    const ok = sumBy(rows, 'ok');
    return [
      `${d.level} · ${d.label}`,
      { value: n, unit: 'count' },
      { value: pct(ok, n), unit: 'percent' },
      { value: ok ? Math.round(sumBy(rows, 'reward') / ok) : null, unit: 'euro' },
      { value: pct(sumBy(rows, 'packs'), ok), unit: 'percent' },
      { value: ihk.packChanceFor(d.level) / 100, unit: 'percent' },
    ];
  });
  const questRows = Object.values(
    runs.reduce((acc, r) => {
      const q = (acc[r._id.quest] = acc[r._id.quest] || { quest: r._id.quest, n: 0, ok: 0, reward: 0, hybrid: r.hybrid });
      q.n += r.n;
      q.ok += r.ok;
      q.reward += r.reward;
      return acc;
    }, {})
  )
    .sort((a, b) => b.n - a.n)
    .map((q) => [
      (questById[q.quest] ? questById[q.quest].title : q.quest) + (q.hybrid ? ' (Hybrid)' : ''),
      { value: q.n, unit: 'count' },
      { value: pct(q.ok, q.n), unit: 'percent' },
      { value: q.reward, unit: 'euro' },
    ]);

  // Coin
  const vol = { kauf: {}, verkauf: {} };
  const traders = new Set();
  for (const r of coinVol) {
    vol[r._id.side][r._id.d] = r.s;
    for (const u of r.users) traders.add(String(u));
  }
  const buys = Object.values(vol.kauf).reduce((s, x) => s + x, 0);
  const sells = Object.values(vol.verkauf).reduce((s, x) => s + x, 0);

  // Lotterie
  const pots = {};
  for (const r of rounds) {
    const d = dayAndHour(r.drawnAt).day;
    pots[d] = (pots[d] || 0) + r.pot;
  }
  const forfeited = rounds.filter((r) => r.tickets > 0 && !r.winner);

  return [
    {
      id: 'wetten',
      title: 'Wetten & Duelle',
      question: 'Wie viel wird gewettet – und wie enden die Wetten?',
      kpis: [
        { id: 'wetten-neu', label: 'Neue Wetten', value: bs.bets, unit: 'count', compare: true },
        { id: 'einsaetze', label: 'Einsätze', value: sumBy(stakes, 's'), unit: 'euro', compare: true },
        { id: 'teilnehmer', label: 'Ø Teilnehmer je Wette', value: avg(bs.players, bs.bets), unit: 'number', compare: true },
        { id: 'streitfaelle', label: 'Streitfälle (von Devs entschieden)', value: devDisputes, unit: 'count', compare: true, hint: 'Ersteller und Schiedsrichter uneinig, ein Dev hat entschieden' },
        { id: 'duelle', label: 'Duelle angefragt', value: sumBy(duels, 'n'), unit: 'count', compare: true, hint: `${duelCount('aktiv', 'entschieden')} entschieden, ${duelCount('angefragt', 'annulliert')} abgelehnt oder verfallen` },
        { id: 'tipps', label: 'Zuschauer-Tipps', value: tips, unit: 'count', compare: true },
      ],
      charts: [
        { id: 'einsaetze', title: 'Einsätze', type: 'bars', unit: 'euro', agg: 'sum', series: [{ name: 'Einsätze', values: byDays(p.days, toMap(stakes, 's')) }] },
        { id: 'wetten', title: 'Neue Wetten', type: 'bars', unit: 'count', agg: 'sum', series: [{ name: 'Wetten', values: byDays(p.days, toMap(newBets)) }] },
      ],
      hbars: {
        title: `Entscheidungswege (${resolvedTotal} abgeschlossene Wetten)`,
        items: Object.entries(VIA_LABELS)
          .map(([via, label]) => {
            const rows = resolved.filter((r) => r._id.via === via);
            const n = sumBy(rows, 'n');
            const voided = sumBy(rows.filter((r) => r._id.status === 'annulliert'), 'n');
            return { label, share: pct(n, resolvedTotal), text: `${n}${voided ? ` · ${voided} annulliert` : ''}`, n };
          })
          .filter((x) => x.n),
      },
    },
    {
      id: 'ihk',
      title: 'IHK-Quests',
      question: 'Sind Quests zu leicht oder zu schwer – und was werfen sie ab?',
      kpis: [
        { id: 'ihk-laeufe', label: 'Abgeschlossene Läufe', value: runTotal, unit: 'count', compare: true },
        { id: 'ihk-erfolg', label: 'IHK-Erfolgsquote', value: pct(okTotal, runTotal), unit: 'percent', compare: true },
        { id: 'ihk-loehne', label: 'Ausgezahlte Löhne', value: sumBy(runs, 'reward'), unit: 'euro', compare: true, hint: 'Geldquelle' },
        { id: 'ihk-packs', label: 'Packs als Quest-Fund', value: sumBy(runs, 'packs'), unit: 'count', compare: true },
      ],
      tables: [
        {
          title: 'Nach Schwierigkeit',
          head: ['Schwierigkeit', { label: 'Läufe', num: true }, { label: 'Erfolg', num: true }, { label: 'Ø Lohn', num: true }, { label: 'Pack-Drops', num: true }, { label: 'Pack-Chance (Soll)', num: true }],
          zeroCols: [1],
          rows: byLevel,
        },
        { title: 'Nach Quest', head: ['Quest', { label: 'Läufe', num: true }, { label: 'Erfolg', num: true }, { label: 'Löhne', num: true }], rows: questRows },
      ],
      notes: runTotal ? [] : ['Keine abgeschlossenen Quests im Zeitraum.'],
    },
    {
      id: 'coin',
      title: 'Broker (Coins & ETF)',
      question: 'Wie entwickelt sich der Kurs – und gewinnen oder verlieren die Spieler?',
      kpis: [
        { id: 'kurs', label: 'SAM-Kurs am Ende des Zeitraums', value: coinDays.length ? coinDays[coinDays.length - 1].c : null, unit: 'price' },
        { id: 'coin-netto', label: 'Coin: Gewinn/Verlust der Spieler', value: sells - buys, unit: 'euro', signed: true, compare: true, hint: 'Verkäufe − Käufe im Zeitraum. Positiv: Coins bringen Geld ins Spiel.' },
        { id: 'coin-kaeufe', label: 'Käufe', value: buys, unit: 'euro', compare: true },
        { id: 'coin-verkaeufe', label: 'Verkäufe', value: sells, unit: 'euro', compare: true },
        { id: 'coin-haendler', label: 'Aktive Coin-Händler', value: traders.size, unit: 'count', compare: true },
      ],
      charts: [
        { id: 'kurs', title: 'SAM-Kurs (Tagesschluss)', type: 'line', unit: 'price', agg: 'last', series: [{ name: 'Kurs', values: byDays(p.days, toMap(coinDays, 'c'), null) }] },
        {
          id: 'coinvolumen',
          title: 'Handelsvolumen',
          type: 'bars',
          unit: 'euro',
          agg: 'sum',
          series: [
            { name: 'Käufe', values: byDays(p.days, vol.kauf) },
            { name: 'Verkäufe', values: byDays(p.days, vol.verkauf) },
          ],
        },
      ],
    },
    {
      id: 'lotterie',
      title: 'Lotterie',
      question: 'Wie groß sind die Töpfe – und wie viele machen mit?',
      kpis: [
        { id: 'runden', label: 'Ziehungen', value: rounds.length, unit: 'count', compare: true },
        { id: 'topf', label: 'Ø Topf', value: rounds.length ? Math.round(sumBy(rounds, 'pot') / rounds.length) : null, unit: 'euro', compare: true },
        { id: 'lose', label: 'Ø Lose je Ziehung', value: avg(sumBy(rounds, 'tickets'), rounds.length), unit: 'number', compare: true },
        { id: 'lotto-teilnehmer', label: 'Ø Teilnehmer', value: avg(sumBy(rounds, 'participants'), rounds.length), unit: 'number', compare: true },
        { id: 'verfallen', label: 'Verfallene Töpfe', value: sumBy(forfeited, 'pot'), unit: 'euro', compare: true, hint: 'alle Lose gehörten gelöschten Konten' },
      ],
      charts: [{ id: 'lotterie', title: 'Topf je Ziehung', type: 'bars', unit: 'euro', agg: 'sum', wide: true, series: [{ name: 'Topf', values: byDays(p.days, pots) }] }],
    },
  ];
}

// ---------- Übersicht ----------

// Kennzahlen der Übersicht: [Reiter, Kennzahl-ID]
const OVERVIEW_KPIS = [
  ['spieler', 'aktiv-tag'],
  ['spieler', 'neu'],
  ['spieler', 'ret7'],
  ['wirtschaft', 'zufluss'],
  ['wirtschaft', 'zufluss-spieler'],
  ['wirtschaft', 'gini'],
  ['tcg', 'rueckfluss'],
  ['tcg', 'abschluesse'],
  ['spiele', 'einsaetze'],
  ['spiele', 'ihk-erfolg'],
  ['spiele', 'coin-netto'],
  ['spiele', 'topf'],
];

async function overview(p, now) {
  const [wirtschaft, spieler, tcgBlocks, spiele] = await Promise.all([economy(p), playersSection(p, now), tcg(p, now), games(p)]);
  const parts = { wirtschaft, spieler, tcg: tcgBlocks, spiele };
  const find = (section, id) => {
    for (const b of parts[section]) {
      const k = (b.kpis || []).find((x) => x.id === id);
      if (k) return { ...k, href: { bereich: section, block: b.id } };
    }
    return null;
  };
  const chart = (section, id) => parts[section].flatMap((b) => b.charts || []).find((c) => c.id === id);
  return [
    {
      id: 'auf-einen-blick',
      title: 'Kennzahlen auf einen Blick',
      question: 'Die wichtigsten Werte im Vergleich zum Zeitraum davor. Ein Klick auf eine Kachel führt zum Bereich.',
      kpis: OVERVIEW_KPIS.map(([s, id]) => find(s, id)).filter(Boolean),
      charts: [
        { ...chart('wirtschaft', 'geldmenge'), wide: false },
        { ...chart('spieler', 'dau'), wide: false },
      ],
    },
    { id: 'aenderungen', title: 'Änderungen im Zeitraum', question: 'Was wurde wann geändert? Änderungen erscheinen als Markierungen in allen Verläufen.', timeline: true },
  ];
}

const LOADERS = {
  uebersicht: overview,
  wirtschaft: economy,
  spieler: playersSection,
  tcg,
  spiele: games,
  // Einzelnes Mitglied (eigene Datei; erst hier laden, weil sie die Hilfsfunktionen dieser Datei nutzt)
  mitglied: (p, now, opts) => require('./memberStats').member(p, now, opts),
};

// Feste Liste [Schlüssel, Funktion]: der Reiter aus der Adresse wird nur verglichen, nie als Name nachgeschlagen
const LOADER_LIST = Object.entries(LOADERS);

/** Zeitreihen eines Diagramms auf die Abschnitte (Tag/Woche/Monat) bündeln */
function bucketChart(chart, p, list) {
  const series = chart.series.map((s) => ({ name: s.name, values: aggregate(s.values, p.days, list, chart.agg) }));
  const empty = !series.some((s) => s.values.some((v) => v !== null && v !== 0));
  return { ...chart, series, empty };
}

/**
 * Daten eines Reiters: Blöcke mit Vergleichswerten, gebündelten Verläufen und Markierungen.
 * opts: { user } für "mitglied", { raw: true } lässt die Verläufe tagesgenau (für den Export).
 */
async function section(key, rangeDays, now = new Date(), opts = {}) {
  // Ein Schlüssel wie "constructor" aus der Adresse trifft so keine fremde Funktion
  const found = LOADER_LIST.find(([k]) => k === key);
  const load = found ? found[1] : LOADERS.uebersicht;
  const p = period(rangeDays, now);
  const prev = period(rangeDays, now, 1);
  const [blocks, prevBlocks, marks] = await Promise.all([load(p, now, opts), load(prev, now, opts), markers(p)]);

  const prevKpis = new Map(prevBlocks.flatMap((b) => (b.kpis || []).map((k) => [k.id, k.value])));
  const { unit, list } = buckets(p.days);
  const bucketOf = Object.fromEntries(list.flatMap((b, i) => b.days.map((d) => [d, i])));

  for (const b of blocks) {
    for (const k of b.kpis || []) {
      if (!k.compare) continue;
      k.prev = prevKpis.has(k.id) ? prevKpis.get(k.id) : null;
      k.delta = delta(k.value, k.prev, k);
    }
    b.charts = (b.charts || []).map((c) => (opts.raw ? { ...c, empty: !c.series.some((x) => x.values.some((v) => v !== null && v !== 0)) } : bucketChart(c, p, list)));
  }
  return {
    period: p,
    previous: prev,
    bucketUnit: unit,
    labels: list.map((b) => b.label),
    longLabels: list.map((b) => b.long),
    markers: marks.map((m) => ({ ...m, i: bucketOf[m.day] })),
    blocks,
  };
}

module.exports = {
  SECTIONS,
  RANGES,
  DEFAULT_RANGE,
  LEDGER_GROUPS,
  addDays,
  dayList,
  weekday,
  isoWeek,
  period,
  buckets,
  aggregate,
  delta,
  retention,
  effectiveChances,
  pullVerdict,
  section,
  // Für memberStats
  groupOfType,
  inP,
  dayOf,
  byDays,
  pct,
  sumBy,
};

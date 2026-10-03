// Auswertungen für die Statistik-Seite (Admin/Dev). Jede Funktion liefert für einen Bereich Kennzahlen,
// Diagramm-Daten (je Tag) und Tabellen. Zeiträume und Tage gelten in deutscher Zeit.
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
const { bonusFor } = require('../services/bonusService');
const { parseZonedLocal } = require('../lib/time');
const { ledgerLabels } = require('../lib/viewHelpers');
const { dayAndHour } = require('./activity');
const { distribution, quantile } = require('./snapshot');

const TZ = config.timezone;
const RANGES = [7, 30, 90, 365];
const DEFAULT_RANGE = 30;
const SECTIONS = [
  { key: 'wirtschaft', label: 'Wirtschaft' },
  { key: 'spieler', label: 'Spieler & Aktivität' },
  { key: 'tcg', label: 'TCG & Handel' },
  { key: 'spiele', label: 'Wetten, IHK, Coin, Lotterie' },
];

// Buchungsarten nach Bereich: Die Summe je Bereich zeigt, wie viel Geld dort entsteht (+) oder verschwindet (−)
const LEDGER_GROUPS = [
  { key: 'start', label: 'Startguthaben', types: ['startguthaben'] },
  { key: 'bonus', label: 'Tagesbonus', types: ['bonus'] },
  { key: 'ihk', label: 'IHK-Löhne', types: ['ihk_lohn'] },
  { key: 'tcg', label: 'TCG (Bank)', types: ['tcg_pack', 'tcg_verkauf', 'black_market'] },
  { key: 'coin', label: 'Coin', types: ['coin_kauf', 'coin_verkauf'] },
  { key: 'wetten', label: 'Wetten', types: ['einsatz', 'auszahlung', 'erstattung', 'provision', 'provision_schiri'] },
  { key: 'lotterie', label: 'Lotterie', types: ['lotto_los', 'lotto_gewinn'] },
  { key: 'handel', label: 'Handel (Steuer)', types: ['handel_kauf', 'handel_verkauf', 'handel_tausch_zahlung', 'handel_tausch_erhalt'] },
  { key: 'loeschung', label: 'Gelöschte Konten', types: ['konto_geloescht'] },
];
const groupOfType = Object.fromEntries(LEDGER_GROUPS.flatMap((g) => g.types.map((t) => [t, g.key])));

// ---------- Tage ----------

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

/** Zeitraum aus der Anzahl Tage: { days, from, to, since } – since = Beginn des ersten Tages */
function period(rangeDays, now = new Date()) {
  const n = RANGES.includes(rangeDays) ? rangeDays : DEFAULT_RANGE;
  const to = dayAndHour(now).day;
  const from = addDays(to, -(n - 1));
  return { range: n, from, to, days: dayList(from, to), since: parseZonedLocal(`${from}T00:00`, TZ) };
}

/** Mongo-Ausdruck: Tag eines Datumsfelds in deutscher Zeit */
const dayOf = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: TZ } });

/** Werte je Tag aus { day: value } in der Reihenfolge der Tage (fehlende Tage = 0 bzw. fallback) */
const byDays = (days, map, fallback = 0) => days.map((d) => (map[d] === undefined ? fallback : map[d]));

/** Liste von { _id, … } zu { _id: wert } */
const toMap = (rows, key = 'n') => Object.fromEntries(rows.map((r) => [r._id, r[key]]));

const pct = (part, total) => (total ? part / total : null);

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

// ---------- Markierungen ----------

const AREA_LABELS = { tcg: 'TCG', ihk: 'IHK', handel: 'Handel', config: '.env' };

/** Einstellungsänderungen und Patchnotes im Zeitraum – Markierungen in allen Verläufen */
async function markers(p) {
  const patchCat = await ForumCategory.findOne({ key: 'patchnotes' }).select('_id').lean();
  const [changes, patches] = await Promise.all([
    SettingsChange.find({ createdAt: { $gte: p.since } }).sort({ createdAt: 1 }).lean(),
    patchCat ? ForumThread.find({ category: patchCat._id, deleted: false, createdAt: { $gte: p.since } }).select('title createdAt').sort({ createdAt: 1 }).lean() : [],
  ]);
  const list = [
    ...changes.map((c) => ({
      day: dayAndHour(c.createdAt).day,
      at: c.createdAt,
      kind: 'einstellung',
      label: `${AREA_LABELS[c.area] || c.area}: ${c.changes.length} Wert${c.changes.length === 1 ? '' : 'e'} geändert`,
      detail: c.changes.slice(0, 12).map((x) => `${x.path}: ${JSON.stringify(x.from)} → ${JSON.stringify(x.to)}`),
      by: c.byName || 'Serverstart',
    })),
    ...patches.map((t) => ({ day: dayAndHour(t.createdAt).day, at: t.createdAt, kind: 'patch', label: `Patchnotes: ${t.title}`, detail: [], by: null })),
  ];
  return list.sort((a, b) => a.at - b.at);
}

// ---------- Wirtschaft ----------

async function economy(p) {
  const [flows, before, snapshots, players, typeTotals] = await Promise.all([
    Ledger.aggregate([{ $match: { createdAt: { $gte: p.since } } }, { $group: { _id: { d: dayOf('$createdAt'), t: '$type' }, s: { $sum: '$amount' } } }]),
    Ledger.aggregate([{ $match: { createdAt: { $lt: p.since } } }, { $group: { _id: null, s: { $sum: '$amount' } } }]),
    StatDaily.find({ _id: { $gte: p.from } }).select('_id wealth users').sort({ _id: 1 }).lean(),
    ranking(),
    Ledger.aggregate([{ $match: { createdAt: { $gte: p.since } } }, { $group: { _id: '$type', s: { $sum: '$amount' }, n: { $sum: 1 } } }]),
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

  const totals = players.map((x) => x.total);
  const dist = distribution(totals);
  const balanceSum = players.reduce((s, x) => s + x.balance, 0);
  const fromSnap = (fn) => byDays(p.days, Object.fromEntries(snapshots.map((s) => [s._id, fn(s)])), null);
  const periodNet = Object.values(dayNet).reduce((s, x) => s + x, 0);

  return {
    kpis: [
      { label: 'Guthaben gesamt', value: balanceSum, unit: 'euro', hint: 'Summe aller Kontostände' },
      { label: 'Gesamtvermögen', value: dist.sum, unit: 'euro', hint: 'Guthaben + Einsätze + Coins + Karten' },
      { label: 'Median-Vermögen', value: dist.median, unit: 'euro' },
      { label: 'Gini', value: dist.gini, unit: 'ratio', hint: '0 = alle gleich, 1 = einer besitzt alles' },
      { label: 'Reichste 10 %', value: dist.top10Share, unit: 'percent', hint: 'Anteil am Gesamtvermögen' },
      { label: 'Netto-Geldzufluss', value: periodNet, unit: 'euro', signed: true, hint: `im Zeitraum (${p.range} Tage)` },
      { label: 'Bonusberechtigt', value: players.filter((x) => bonusFor(x.total) > 0).length, unit: 'count', hint: `von ${players.length} Mitgliedern` },
    ],
    charts: [
      {
        id: 'geldmenge',
        title: 'Geldmenge (Summe aller Buchungen)',
        // Abgleich: Kontostände (ohne gelöschte Konten) gegen die Summe aller Buchungen
        diff: balanceSum - supplySeries[supplySeries.length - 1],
        type: 'line',
        unit: 'euro',
        series: [{ name: 'Geldmenge', values: supplySeries }],
      },
      {
        id: 'zufluss',
        title: 'Netto-Geldzufluss je Bereich und Tag',
        note: 'Über 0: Geld entsteht (Quelle). Unter 0: Geld verschwindet (Senke).',
        type: 'stacked',
        unit: 'euro',
        series: LEDGER_GROUPS.filter((g) => Object.keys(net[g.key]).length).map((g) => ({ name: g.label, values: byDays(p.days, net[g.key]) })),
      },
      { id: 'gini', title: 'Gini-Koeffizient (Tages-Snapshot)', type: 'line', unit: 'ratio', series: [{ name: 'Gini', values: fromSnap((s) => s.wealth.total && s.wealth.total.gini) }] },
      {
        id: 'median',
        title: 'Median-Vermögen (Tages-Snapshot)',
        type: 'line',
        unit: 'euro',
        series: [{ name: 'Median', values: fromSnap((s) => s.wealth.total && s.wealth.total.median) }],
      },
    ],
    tables: [
      {
        title: 'Buchungen im Zeitraum',
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
      {
        title: 'Vermögensverteilung jetzt',
        head: ['Kennzahl', { label: 'Wert', num: true }],
        rows: [
          ['Mitglieder', { value: dist.count, unit: 'count' }],
          ['Mittelwert', { value: dist.mean, unit: 'euro' }],
          ['10. Perzentil', { value: dist.p10, unit: 'euro' }],
          ['Median', { value: dist.median, unit: 'euro' }],
          ['90. Perzentil', { value: dist.p90, unit: 'euro' }],
          ['99. Perzentil', { value: dist.p99, unit: 'euro' }],
          ['Höchstes', { value: dist.max, unit: 'euro' }],
          ['davon Coins', { value: players.reduce((s, x) => s + x.coinValue, 0), unit: 'euro' }],
          ['davon Karten & Packs', { value: players.reduce((s, x) => s + x.cardValue, 0), unit: 'euro' }],
          ['davon offene Einsätze', { value: players.reduce((s, x) => s + x.inPlay, 0), unit: 'euro' }],
        ],
      },
    ],
  };
}

// ---------- Spieler & Aktivität ----------

async function players(p, now = new Date()) {
  const today = p.to;
  const monthFrom = addDays(today, -29);
  const actFrom = p.from < monthFrom ? p.from : monthFrom;
  const [members, banned, signups, cohortUsers, activity] = await Promise.all([
    User.countDocuments({ deletedAt: null }),
    User.countDocuments({ deletedAt: null, bannedUntil: { $gt: now } }),
    User.aggregate([{ $match: { createdAt: { $gte: p.since } } }, { $group: { _id: dayOf('$createdAt'), n: { $sum: 1 } } }]),
    User.find({ createdAt: { $gte: p.since } }).select('_id createdAt').lean(),
    UserActivity.find({ day: { $gte: actFrom } }).select('user day views actions logins areas hours').lean(),
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
    if (a.day < p.from) continue;
    activeByDay[a.day] = (activeByDay[a.day] || 0) + 1;
    views += a.views || 0;
    actions += a.actions || 0;
    for (const [k, n] of Object.entries(a.areas || {})) areas[k] = (areas[k] || 0) + n;
    for (const h of a.hours || []) heat[weekday(a.day)][h]++;
  }
  const cohort = cohortUsers.map((u) => ({ user: u._id, day: dayAndHour(u.createdAt).day }));
  const ret = retention(cohort, activeDays, [1, 7, 30], today);
  const areaTotal = Object.values(areas).reduce((s, n) => s + n, 0);
  const firstActivity = activity.reduce((m, a) => (!m || a.day < m ? a.day : m), null);

  return {
    kpis: [
      { label: 'Mitglieder', value: members, unit: 'count', hint: banned ? `davon ${banned} gesperrt` : null },
      { label: 'Neu im Zeitraum', value: cohortUsers.length, unit: 'count' },
      { label: 'Aktiv heute', value: activeByDay[today] || 0, unit: 'count' },
      { label: 'Aktiv 7 Tage', value: wau.size, unit: 'count', hint: members ? `${Math.round((wau.size / members) * 100)} % der Mitglieder` : null },
      { label: 'Aktiv 30 Tage', value: mau.size, unit: 'count', hint: members ? `${Math.round((mau.size / members) * 100)} % der Mitglieder` : null },
      { label: 'Aufrufe / Aktionen', value: `${views} / ${actions}`, unit: 'text', hint: 'im Zeitraum' },
    ],
    since: firstActivity,
    charts: [
      { id: 'dau', title: 'Aktive Mitglieder je Tag', type: 'line', unit: 'count', series: [{ name: 'Aktiv', values: byDays(p.days, activeByDay) }] },
      { id: 'neu', title: 'Registrierungen je Tag', type: 'bars', unit: 'count', series: [{ name: 'Registrierungen', values: byDays(p.days, toMap(signups)) }] },
    ],
    retention: ret,
    areas: Object.entries(areas)
      .sort((a, b) => b[1] - a[1])
      .map(([key, n]) => ({ key, n, share: pct(n, areaTotal) })),
    heat,
    heatMax: Math.max(1, ...heat.flat()),
  };
}

// ---------- TCG & Handel ----------

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

async function tcg(p, now = new Date()) {
  const rarities = catalog.RARITIES;
  const [pulls, openingsByDay, inCirculation, packsUnopened, sales, trades, marketSales, bmDays] = await Promise.all([
    TcgOpening.aggregate([{ $match: { createdAt: { $gte: p.since } } }, { $unwind: '$cards' }, { $group: { _id: '$cards.rarity', n: { $sum: 1 } } }]),
    TcgOpening.aggregate([{ $match: { createdAt: { $gte: p.since } } }, { $group: { _id: dayOf('$createdAt'), n: { $sum: 1 } } }]),
    TcgCard.aggregate([{ $group: { _id: '$rarity', n: { $sum: 1 } } }]),
    TcgPack.countDocuments(),
    Ledger.aggregate([
      { $match: { type: 'tcg_verkauf', createdAt: { $gte: p.since }, 'meta.cards': { $exists: true } } },
      { $unwind: '$meta.cards' },
      { $group: { _id: '$meta.cards.rarity', n: { $sum: '$meta.cards.count' } } },
    ]),
    Trade.aggregate([
      { $match: { createdAt: { $gte: p.since } } },
      {
        $group: {
          _id: { kind: '$kind', status: { $cond: [{ $and: [{ $eq: ['$status', 'offen'] }, { $lte: ['$expiresAt', now] }] }, 'abgelaufen', '$status'] } },
          n: { $sum: 1 },
          volume: { $sum: { $cond: [{ $eq: ['$status', 'verkauft'] }, '$price', 0] } },
          tax: { $sum: '$tax' },
        },
      },
    ]),
    Trade.find({ status: 'verkauft', kind: { $in: ['markt', 'privat'] }, closedAt: { $gte: p.since } }).select('card price').lean(),
    BlackMarket.find({ _id: { $gte: p.from } }).lean(),
  ]);

  const pullMap = toMap(pulls);
  const pullTotal = pulls.reduce((s, r) => s + r.n, 0);
  const chances = effectiveChances(rarities, catalog.CARDS);
  const circ = toMap(inCirculation);
  const sold = toMap(sales);
  const ev = catalog.expectedPackValue();
  const packPrice = tcgSettings.getPackPrice();

  // Marktpreise je Seltenheit gegenüber dem Bankwert
  const prices = {};
  for (const t of marketSales) {
    const c = catalog.cardById[t.card];
    if (c) (prices[c.rarity] = prices[c.rarity] || []).push(t.price);
  }

  const kinds = { markt: 'Markt', privat: 'Privat', tausch: 'Tausch' };
  const tradeRow = (kind) => {
    const rows = trades.filter((t) => t._id.kind === kind);
    const n = (status) => (rows.find((r) => r._id.status === status) || {}).n || 0;
    const all = rows.reduce((s, r) => s + r.n, 0);
    return [
      kinds[kind],
      { value: all, unit: 'count' },
      { value: n('verkauft'), unit: 'count' },
      { value: pct(n('verkauft'), all), unit: 'percent' },
      { value: n('abgelehnt') + n('zurueckgezogen'), unit: 'count' },
      { value: n('abgelaufen'), unit: 'count' },
      { value: rows.reduce((s, r) => s + r.volume, 0), unit: 'euro' },
      { value: rows.reduce((s, r) => s + r.tax, 0), unit: 'euro' },
    ];
  };

  const bmOffers = bmDays.flatMap((d) => d.offers);
  const bmSold = bmOffers.filter((o) => o.buyer);
  const openingsTotal = openingsByDay.reduce((s, r) => s + r.n, 0);

  return {
    kpis: [
      { label: 'Packpreis', value: packPrice, unit: 'euro' },
      { label: 'Erwartungswert je Pack', value: Math.round(ev), unit: 'euro', hint: 'Bank-Verkaufswert der 3 Karten' },
      { label: 'Rückfluss', value: pct(ev, packPrice), unit: 'percent', hint: 'Erwartungswert ÷ Packpreis' },
      { label: 'Packs geöffnet', value: openingsTotal, unit: 'count', hint: 'im Zeitraum' },
      { label: 'Karten im Umlauf', value: inCirculation.reduce((s, r) => s + r.n, 0), unit: 'count' },
      { label: 'Ungeöffnete Packs', value: packsUnopened, unit: 'count' },
    ],
    charts: [{ id: 'packs', title: 'Geöffnete Packs je Tag', type: 'bars', unit: 'count', series: [{ name: 'Packs', values: byDays(p.days, toMap(openingsByDay)) }] }],
    tables: [
      {
        title: 'Pull-Raten: Ist gegen Soll',
        note: `${pullTotal} gezogene Karten im Zeitraum. Soll = aktuell eingestellte Chance (fehlen Karten einer Seltenheit, zählt sie zur nächstniedrigeren). Wurden die Chancen im Zeitraum geändert, siehe Markierungen.`,
        head: ['Seltenheit', { label: 'Soll', num: true }, { label: 'Ist', num: true }, { label: 'Abweichung', num: true }, { label: 'Gezogen', num: true }],
        rows: rarities.map((r) => {
          const ist = pct(pullMap[r.key] || 0, pullTotal);
          return [
            r.label + (r.hidden ? ' (geheim)' : ''),
            { value: chances[r.key], unit: 'percent', digits: 2 },
            { value: ist, unit: 'percent', digits: 2 },
            { value: ist === null || !chances[r.key] ? null : ist / chances[r.key] - 1, unit: 'percent', signed: true },
            { value: pullMap[r.key] || 0, unit: 'count' },
          ];
        }),
      },
      {
        title: 'Karten je Seltenheit',
        note: 'Bank-Verkäufe erst ab dem Update mit Karten-Details im Kontoauszug.',
        head: ['Seltenheit', { label: 'Bankwert', num: true }, { label: 'Im Umlauf', num: true }, { label: 'An Bank verkauft', num: true }, { label: 'Ø Marktpreis', num: true }, { label: 'Markt ÷ Bank', num: true }],
        rows: rarities.map((r) => {
          const list = (prices[r.key] || []).sort((a, b) => a - b);
          const median = list.length ? quantile(list, 0.5) : null;
          return [
            r.label,
            { value: r.sell, unit: 'euro' },
            { value: circ[r.key] || 0, unit: 'count' },
            { value: sold[r.key] || 0, unit: 'count' },
            { value: median, unit: 'euro', hint: list.length ? `Median aus ${list.length}` : null },
            { value: median === null || !r.sell ? null : median / r.sell, unit: 'ratio' },
          ];
        }),
      },
      {
        title: 'Handel im Zeitraum (nach Erstellung)',
        head: ['Art', { label: 'Erstellt', num: true }, { label: 'Abgeschlossen', num: true }, { label: 'Quote', num: true }, { label: 'Abgelehnt/zurück', num: true }, { label: 'Abgelaufen', num: true }, { label: 'Umsatz', num: true }, { label: 'Steuer', num: true }],
        rows: Object.keys(kinds).map(tradeRow),
      },
      {
        title: 'Black Market',
        head: ['Kennzahl', { label: 'Wert', num: true }],
        rows: [
          ['Tage mit Angebot', { value: bmDays.length, unit: 'count' }],
          ['Angebote', { value: bmOffers.length, unit: 'count' }],
          ['Verkauft', { value: bmSold.length, unit: 'count', hint: bmOffers.length ? `${Math.round((bmSold.length / bmOffers.length) * 100)} %` : null }],
          ['Umsatz', { value: bmSold.reduce((s, o) => s + o.price, 0), unit: 'euro' }],
        ],
      },
    ],
  };
}

// ---------- Wetten, IHK, Coin, Lotterie ----------

async function games(p) {
  const [newBets, stakes, resolved, betStats, duels, tips, runs, coinDays, coinVol, coinNet, rounds] = await Promise.all([
    Bet.aggregate([{ $match: { createdAt: { $gte: p.since } } }, { $group: { _id: dayOf('$createdAt'), n: { $sum: 1 } } }]),
    Ledger.aggregate([{ $match: { type: 'einsatz', createdAt: { $gte: p.since } } }, { $group: { _id: dayOf('$createdAt'), s: { $sum: { $abs: '$amount' } } } }]),
    Bet.aggregate([
      { $match: { resolvedAt: { $gte: p.since } } },
      { $group: { _id: { via: '$resolvedVia', status: '$status' }, n: { $sum: 1 }, refunded: { $sum: { $cond: ['$refunded', 1, 0] } } } },
    ]),
    Bet.aggregate([
      { $match: { createdAt: { $gte: p.since } } },
      { $lookup: { from: 'positions', localField: '_id', foreignField: 'bet', as: 'pos' } },
      { $group: { _id: null, bets: { $sum: 1 }, players: { $sum: { $size: '$pos' } } } },
    ]),
    Bet.aggregate([{ $match: { 'duel.state': { $exists: true }, createdAt: { $gte: p.since } } }, { $group: { _id: { state: '$duel.state', status: '$status' }, n: { $sum: 1 } } }]),
    DuelTip.countDocuments({ createdAt: { $gte: p.since } }),
    IhkRun.aggregate([
      { $match: { status: 'fertig', endsAt: { $gte: p.since } } },
      {
        $group: {
          _id: { quest: '$quest', difficulty: '$difficulty' },
          n: { $sum: 1 },
          ok: { $sum: { $cond: ['$success', 1, 0] } },
          reward: { $sum: '$reward' },
          packs: { $sum: { $cond: [{ $ne: ['$pack', null] }, 1, 0] } },
          hybrid: { $max: { $cond: [{ $ne: ['$total2', null] }, 1, 0] } },
        },
      },
    ]),
    CoinHour.aggregate([{ $match: { t: { $gte: p.since } } }, { $sort: { t: 1 } }, { $group: { _id: dayOf('$t'), c: { $last: '$c' } } }]),
    CoinTrade.aggregate([{ $match: { createdAt: { $gte: p.since } } }, { $group: { _id: { d: dayOf('$createdAt'), side: '$side' }, s: { $sum: '$cents' }, users: { $addToSet: '$user' } } }]),
    Ledger.aggregate([{ $match: { type: { $in: ['coin_kauf', 'coin_verkauf'] }, createdAt: { $gte: p.since } } }, { $group: { _id: null, s: { $sum: '$amount' } } }]),
    LotteryRound.find({ status: 'gezogen', drawnAt: { $gte: p.since } }).sort({ drawnAt: 1 }).lean(),
  ]);

  // Wetten
  const disputedEver = await Bet.countDocuments({ createdAt: { $gte: p.since }, 'votes.1': { $exists: true }, resolvedVia: 'dev' });
  const viaLabels = { einstimmig: 'Einstimmig', dev: 'Dev-Entscheid', system: 'Automatisch (System)', ersteller: 'Ersteller allein', schiedsrichter: 'Schiedsrichter (Duell)' };
  const resolvedTotal = resolved.reduce((s, r) => s + r.n, 0);
  const viaRows = Object.entries(viaLabels).map(([via, label]) => {
    const rows = resolved.filter((r) => r._id.via === via);
    const n = rows.reduce((s, r) => s + r.n, 0);
    return [
      label,
      { value: n, unit: 'count' },
      { value: pct(n, resolvedTotal), unit: 'percent' },
      { value: rows.filter((r) => r._id.status === 'annulliert').reduce((s, r) => s + r.n, 0), unit: 'count' },
      { value: rows.reduce((s, r) => s + r.refunded, 0), unit: 'count' },
    ];
  });
  const bs = betStats[0] || { bets: 0, players: 0 };
  const stakeTotal = stakes.reduce((s, r) => s + r.s, 0);

  // IHK
  const runTotal = runs.reduce((s, r) => s + r.n, 0);
  const okTotal = runs.reduce((s, r) => s + r.ok, 0);
  const byLevel = DIFFICULTIES.map((d) => {
    const rows = runs.filter((r) => r._id.difficulty === d.level);
    const n = rows.reduce((s, r) => s + r.n, 0);
    const ok = rows.reduce((s, r) => s + r.ok, 0);
    return [
      `${d.level} · ${d.label}`,
      { value: n, unit: 'count' },
      { value: pct(ok, n), unit: 'percent' },
      { value: ok ? Math.round(rows.reduce((s, r) => s + r.reward, 0) / ok) : null, unit: 'euro' },
      { value: pct(rows.reduce((s, r) => s + r.packs, 0), ok), unit: 'percent' },
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
  const coinPlayerNet = coinNet[0] ? coinNet[0].s : 0;

  // Lotterie
  const lotteryDays = {};
  for (const r of rounds) lotteryDays[dayAndHour(r.drawnAt).day] = (lotteryDays[dayAndHour(r.drawnAt).day] || 0) + r.pot;
  const forfeitedPots = rounds.filter((r) => r.tickets > 0 && !r.winner);

  return {
    kpis: [
      { label: 'Neue Wetten', value: bs.bets, unit: 'count' },
      { label: 'Einsätze', value: stakeTotal, unit: 'euro' },
      { label: 'Ø Teilnehmer je Wette', value: bs.bets ? Math.round((bs.players / bs.bets) * 10) / 10 : null, unit: 'number' },
      { label: 'Per Dev entschieden', value: disputedEver, unit: 'count', hint: 'Streitfälle mit beiden Stimmen' },
      { label: 'IHK-Läufe', value: runTotal, unit: 'count', hint: runTotal ? `${Math.round((okTotal / runTotal) * 100)} % geschafft` : null },
      { label: 'Coin: Netto der Spieler', value: coinPlayerNet, unit: 'euro', signed: true, hint: 'Verkäufe − Käufe (realisiert)' },
      { label: 'Lotterie-Runden', value: rounds.length, unit: 'count', hint: forfeitedPots.length ? `${forfeitedPots.length} Topf verfallen` : null },
    ],
    charts: [
      { id: 'einsaetze', title: 'Einsätze je Tag', type: 'bars', unit: 'euro', series: [{ name: 'Einsätze', values: byDays(p.days, toMap(stakes, 's')) }] },
      { id: 'wetten', title: 'Neue Wetten je Tag', type: 'bars', unit: 'count', series: [{ name: 'Wetten', values: byDays(p.days, toMap(newBets)) }] },
      { id: 'kurs', title: 'Coin-Kurs (Tagesschluss)', type: 'line', unit: 'price', series: [{ name: 'Kurs', values: byDays(p.days, toMap(coinDays, 'c'), null) }] },
      {
        id: 'coinvolumen',
        title: 'Coin-Handelsvolumen je Tag',
        type: 'bars',
        unit: 'euro',
        series: [
          { name: 'Käufe', values: byDays(p.days, vol.kauf) },
          { name: 'Verkäufe', values: byDays(p.days, vol.verkauf) },
        ],
      },
      { id: 'lotterie', title: 'Lotterie-Topf je Ziehung', type: 'bars', unit: 'euro', series: [{ name: 'Topf', values: byDays(p.days, lotteryDays) }] },
    ],
    tables: [
      {
        title: 'Abgeschlossene Wetten nach Entscheidungsweg',
        head: ['Weg', { label: 'Wetten', num: true }, { label: 'Anteil', num: true }, { label: 'davon annulliert', num: true }, { label: 'Einsätze erstattet', num: true }],
        rows: viaRows,
      },
      {
        title: 'Duelle',
        head: ['Status', { label: 'Anzahl', num: true }],
        rows: [
          ...[
            ['Wartet auf Zusage', 'angefragt', 'offen'],
            ['Abgelehnt oder verfallen', 'angefragt', 'annulliert'],
            ['Läuft', 'aktiv', 'offen'],
            ['Entschieden', 'aktiv', 'entschieden'],
            ['Annulliert', 'aktiv', 'annulliert'],
          ].map(([label, state, status]) => [label, { value: (duels.find((d) => d._id.state === state && d._id.status === status) || {}).n || 0, unit: 'count' }]),
          ['Zuschauer-Tipps', { value: tips, unit: 'count' }],
        ],
      },
      {
        title: 'IHK nach Schwierigkeit',
        head: ['Schwierigkeit', { label: 'Läufe', num: true }, { label: 'Erfolg', num: true }, { label: 'Ø Lohn', num: true }, { label: 'Pack-Drops', num: true }, { label: 'Pack-Chance (Soll)', num: true }],
        rows: byLevel,
      },
      { title: 'IHK nach Quest', head: ['Quest', { label: 'Läufe', num: true }, { label: 'Erfolg', num: true }, { label: 'Löhne', num: true }], rows: questRows },
      {
        title: 'Coin & Lotterie',
        head: ['Kennzahl', { label: 'Wert', num: true }],
        rows: [
          ['Coin-Händler im Zeitraum', { value: traders.size, unit: 'count' }],
          ['Coin-Käufe', { value: Object.values(vol.kauf).reduce((s, x) => s + x, 0), unit: 'euro' }],
          ['Coin-Verkäufe', { value: Object.values(vol.verkauf).reduce((s, x) => s + x, 0), unit: 'euro' }],
          ['Ø Lotterie-Topf', { value: rounds.length ? Math.round(rounds.reduce((s, r) => s + r.pot, 0) / rounds.length) : null, unit: 'euro' }],
          ['Ø Lose je Runde', { value: rounds.length ? Math.round((rounds.reduce((s, r) => s + r.tickets, 0) / rounds.length) * 10) / 10 : null, unit: 'number' }],
          ['Ø Teilnehmer je Runde', { value: rounds.length ? Math.round((rounds.reduce((s, r) => s + r.participants, 0) / rounds.length) * 10) / 10 : null, unit: 'number' }],
          ['Verfallene Töpfe', { value: forfeitedPots.reduce((s, r) => s + r.pot, 0), unit: 'euro' }],
        ],
      },
    ],
  };
}

const LOADERS = { wirtschaft: economy, spieler: players, tcg, spiele: games };

/** Daten eines Bereichs samt Markierungen */
async function section(key, rangeDays) {
  const p = period(rangeDays);
  const load = LOADERS[key] || LOADERS.wirtschaft;
  const [data, marks] = await Promise.all([load(p), markers(p)]);
  return { period: p, markers: marks, ...data };
}

module.exports = { SECTIONS, RANGES, DEFAULT_RANGE, LEDGER_GROUPS, addDays, dayList, weekday, period, retention, effectiveChances, section };

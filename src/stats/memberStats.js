// Statistik eines einzelnen Mitglieds (Reiter "Mitglied" der Statistik-Seite): Vermögen, Geldfluss, Aktivität,
// Wetten, TCG & Handel, IHK, Coin und Lotterie – nach demselben Muster wie die übrigen Reiter (Themenblöcke,
// Vergleich mit dem Vorzeitraum).
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const StatDaily = require('../models/StatDaily');
const UserActivity = require('../models/UserActivity');
const { TcgCard, TcgOpening } = require('../models/Tcg');
const { Trade } = require('../models/Trade');
const { IhkRun } = require('../models/Ihk');
const { CoinTrade, CoinHolding } = require('../models/Coin');
const { LotteryRound, LotteryEntry } = require('../models/Lottery');
const catalog = require('../tcg/catalog');
const { DIFFICULTIES } = require('../ihk/quests');
const { ranking } = require('../services/rankService');
const { dayAndHour } = require('./activity');
const s = require('./statsService');

/**
 * Pack-Glück: Bankwert der gezogenen Karten im Verhältnis zum Erwartungswert derselben Anzahl Karten.
 * 1 = genau der Durchschnitt, über 1 = mehr Glück. cards: [{ rarity }], rarities: [{ key, sell, weight }]
 */
function packLuck(cards, rarities) {
  if (!cards.length) return null;
  const total = rarities.reduce((a, r) => a + r.weight, 0);
  const ev = rarities.reduce((a, r) => a + (r.weight / total) * r.sell, 0);
  const sell = Object.fromEntries(rarities.map((r) => [r.key, r.sell]));
  const value = cards.reduce((a, c) => a + (sell[c.rarity] || 0), 0);
  return ev ? value / (ev * cards.length) : null;
}

async function member(p, now, { user }) {
  const uid = user._id;
  const mine = { user: uid };
  const [rank, flows, before, snapshots, activity, positionsSettled, staked, created, refereed, openings, cardsNow, trades, runs, coinTrades, holding, entries, wins, duels] =
    await Promise.all([
      ranking({ team: true }), // mit Team, damit auch Admin und Devs ihre Werte sehen
      Ledger.aggregate([{ $match: { ...mine, ...s.inP(p) } }, { $group: { _id: { d: s.dayOf('$createdAt'), t: '$type' }, s: { $sum: '$amount' }, n: { $sum: 1 }, meta: { $push: '$meta' } } }]),
      Ledger.aggregate([{ $match: { ...mine, createdAt: { $lt: p.since } } }, { $group: { _id: null, s: { $sum: '$amount' } } }]),
      StatDaily.find({ _id: { $gte: p.from, $lte: p.to } }, { players: { $elemMatch: { user: uid } } }).lean(),
      UserActivity.find({ ...mine, day: { $gte: p.from, $lte: p.to } }).lean(),
      Position.find({ ...mine, payout: { $ne: null }, ...s.inP(p, 'settledAt') }).select('amount payout').lean(),
      Ledger.aggregate([{ $match: { ...mine, type: 'einsatz', ...s.inP(p) } }, { $group: { _id: null, s: { $sum: { $abs: '$amount' } }, n: { $sum: 1 } } }]),
      Bet.countDocuments({ creator: uid, 'duel.state': { $exists: false }, ...s.inP(p) }),
      Bet.countDocuments({ referee: uid, ...s.inP(p) }),
      TcgOpening.find({ ...mine, ...s.inP(p) }).select('cards createdAt').lean(),
      TcgCard.aggregate([{ $match: mine }, { $group: { _id: '$rarity', n: { $sum: 1 } } }]),
      Trade.find({ status: 'verkauft', ...s.inP(p, 'closedAt'), $or: [{ seller: uid }, { buyer: uid }, { to: uid }] }).select('kind seller buyer to price extraFrom tax').lean(),
      IhkRun.find({ ...mine, status: 'fertig', ...s.inP(p, 'endsAt') }).select('difficulty success reward pack').lean(),
      CoinTrade.aggregate([{ $match: { ...mine, ...s.inP(p) } }, { $group: { _id: '$side', s: { $sum: '$cents' }, n: { $sum: 1 } } }]),
      CoinHolding.findOne({ ...mine, coin: 'SAM' }).lean(),
      LotteryEntry.find({ ...mine, ...s.inP(p) }).select('tickets').lean(),
      LotteryRound.find({ winner: uid, ...s.inP(p, 'drawnAt') }).select('pot prizeCash').lean(),
      Bet.countDocuments({ 'duel.state': { $exists: true }, $or: [{ creator: uid }, { 'duel.opponent': uid }], ...s.inP(p) }),
    ]);

  // ---------- Vermögen und Geldfluss ----------
  const row = rank.find((r) => r._id.equals(uid)) || { balance: 0, inPlay: 0, coinValue: 0, cardValue: 0, total: 0 };
  // Platz nur unter den Spielern – das Team ist nicht in der Wertung
  const ranked = rank.filter((r) => !r.team);
  const index = ranked.findIndex((r) => r._id.equals(uid));
  const net = Object.fromEntries(s.LEDGER_GROUPS.map((g) => [g.key, {}]));
  const dayNet = {};
  const byType = {};
  for (const f of flows) {
    const g = s.groupOfType[f._id.t];
    if (g) net[g][f._id.d] = (net[g][f._id.d] || 0) + f.s;
    dayNet[f._id.d] = (dayNet[f._id.d] || 0) + f.s;
    const t = (byType[f._id.t] = byType[f._id.t] || { s: 0, n: 0, meta: [] });
    t.s += f.s;
    t.n += f.n;
    t.meta.push(...f.meta.filter(Boolean));
  }
  let balance = before[0] ? before[0].s : 0;
  const balanceSeries = p.days.map((d) => (balance += dayNet[d] || 0));
  const totalSeries = s.byDays(p.days, Object.fromEntries(snapshots.filter((x) => x.players && x.players[0]).map((x) => [x._id, x.players[0].total])), null);
  const groupTotals = s.LEDGER_GROUPS.map((g) => ({ ...g, value: Object.values(net[g.key]).reduce((a, x) => a + x, 0) })).filter((g) => g.value !== 0);
  const sumType = (...types) => types.reduce((a, t) => a + (byType[t] ? byType[t].s : 0), 0);
  const countType = (...types) => types.reduce((a, t) => a + (byType[t] ? byType[t].n : 0), 0);

  // ---------- Aktivität ----------
  const areas = {};
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const viewsByDay = {};
  let views = 0;
  let actions = 0;
  let logins = 0;
  for (const a of activity) {
    views += a.views || 0;
    actions += a.actions || 0;
    logins += a.logins || 0;
    viewsByDay[a.day] = (a.views || 0) + (a.actions || 0);
    for (const [k, n] of Object.entries(a.areas || {})) areas[k] = (areas[k] || 0) + n;
    for (const h of a.hours || []) heat[s.weekday(a.day)][h]++;
  }
  const areaTotal = Object.values(areas).reduce((a, n) => a + n, 0);
  const lastActive = activity.reduce((m, a) => (!m || a.lastAt > m ? a.lastAt : m), null);

  // ---------- Wetten ----------
  const settledStake = s.sumBy(positionsSettled, 'amount');
  const settledPayout = s.sumBy(positionsSettled, 'payout');
  const won = positionsSettled.filter((x) => x.payout > x.amount).length;
  const lost = positionsSettled.filter((x) => x.payout === 0).length;

  // ---------- TCG ----------
  const pulled = openings.flatMap((o) => o.cards);
  const pullCount = Object.fromEntries(catalog.RARITIES.map((r) => [r.key, 0]));
  for (const c of pulled) if (pullCount[c.rarity] !== undefined) pullCount[c.rarity]++;
  const chances = s.effectiveChances(catalog.RARITIES, catalog.CARDS);
  const circ = Object.fromEntries(cardsNow.map((r) => [r._id, r.n]));
  const soldToBank = {};
  for (const m of byType.tcg_verkauf ? byType.tcg_verkauf.meta : []) for (const c of m.cards || []) soldToBank[c.rarity] = (soldToBank[c.rarity] || 0) + c.count;
  const best = pulled.reduce((b, c) => (catalog.rarityByKey[c.rarity] && (!b || catalog.rarityByKey[c.rarity].rank > catalog.rarityByKey[b].rank) ? c.rarity : b), null);
  const tradesSold = trades.filter((t) => t.seller.equals(uid)).length;
  const tradesBought = trades.length - tradesSold;

  // ---------- IHK ----------
  const ihkOk = runs.filter((r) => r.success).length;

  // ---------- Coin ----------
  const coin = Object.fromEntries(coinTrades.map((c) => [c._id, c]));
  const buys = coin.kauf ? coin.kauf.s : 0;
  const sells = coin.verkauf ? coin.verkauf.s : 0;

  const tickets = s.sumBy(entries, 'tickets');

  return [
    {
      id: 'vermoegen',
      title: 'Vermögen',
      question: `Wie steht ${user.username} da – und woher kommt das Geld?`,
      kpis: [
        { id: 'm-rang', label: 'Rang', value: row.team ? 'Team' : index >= 0 ? `${index + 1}. von ${ranked.length}` : '–', unit: 'text', hint: row.team ? 'Admin und Devs sind nicht in der Wertung' : 'nach Gesamtvermögen (jetzt)' },
        { id: 'm-vermoegen', label: 'Gesamtvermögen', value: row.total, unit: 'euro', hint: 'Guthaben + offene Einsätze + Coins + Karten und Packs (jetzt)' },
        { id: 'm-guthaben', label: 'Guthaben', value: row.balance, unit: 'euro', hint: 'jetzt' },
        { id: 'm-zufluss', label: 'Guthaben-Veränderung', value: Object.values(dayNet).reduce((a, v) => a + v, 0), unit: 'euro', signed: true, compare: true, hint: 'Veränderung des Guthabens im Zeitraum' },
        { id: 'm-einsaetze-offen', label: 'Offene Einsätze', value: row.inPlay, unit: 'euro', hint: 'jetzt' },
        { id: 'm-coins', label: 'Coins (Wert)', value: row.coinValue, unit: 'euro', hint: 'zum aktuellen Kurs (jetzt)' },
        { id: 'm-karten', label: 'Karten & Packs (Wert)', value: row.cardValue, unit: 'euro', hint: 'Bankwert (jetzt)' },
        { id: 'm-bonus', label: 'Tagesbonus erhalten', value: sumType('bonus'), unit: 'euro', compare: true, hint: `${countType('bonus')}× im Zeitraum` },
      ],
      flow: { sources: groupTotals.filter((g) => g.value > 0).sort((a, b) => b.value - a.value), sinks: groupTotals.filter((g) => g.value < 0).sort((a, b) => a.value - b.value) },
      charts: [
        {
          id: 'm-vermoegen',
          title: 'Guthaben und Gesamtvermögen',
          note: 'Guthaben aus dem Kontoauszug, Gesamtvermögen aus den Tages-Snapshots.',
          type: 'line',
          unit: 'euro',
          agg: 'last',
          wide: true,
          series: [
            { name: 'Guthaben', values: balanceSeries },
            { name: 'Gesamtvermögen', values: totalSeries },
          ],
        },
      ],
    },
    {
      id: 'aktivitaet',
      title: 'Aktivität',
      question: 'Wie oft und wann spielt das Mitglied – und wo?',
      kpis: [
        { id: 'm-tage', label: 'Aktive Tage', value: activity.length, unit: 'count', compare: true, hint: p.range === 1 ? 'heute' : `von ${p.range} Tagen` },
        { id: 'm-aufrufe', label: 'Seitenaufrufe', value: views, unit: 'count', compare: true },
        { id: 'm-aktionen', label: 'Aktionen', value: actions, unit: 'count', compare: true },
        { id: 'm-logins', label: 'Anmeldungen', value: logins, unit: 'count', compare: true },
      ],
      charts: [{ id: 'm-aktivitaet', title: 'Aufrufe und Aktionen', type: 'bars', unit: 'count', agg: 'sum', wide: true, series: [{ name: 'Aufrufe + Aktionen', values: s.byDays(p.days, viewsByDay) }] }],
      hbars: {
        title: 'Bereichsnutzung',
        items: Object.entries(areas)
          .sort((a, b) => b[1] - a[1])
          .map(([key, n]) => ({ key, share: s.pct(n, areaTotal), text: `${n} · ${Math.round(s.pct(n, areaTotal) * 100)} %` })),
      },
      heat: activity.length ? { rows: heat, max: Math.max(1, ...heat.flat()) } : null,
      notes: [
        `Mitglied seit ${user.createdAt.toLocaleDateString('de-DE')}${lastActive ? ` · zuletzt aktiv ${dayAndHour(lastActive).day.split('-').reverse().join('.')}` : ''}.`,
        ...(activity.length ? [] : ['Keine Aktivität im Zeitraum (Aktivitätsdaten gibt es erst seit dem Statistik-Update).']),
      ],
    },
    {
      id: 'wetten',
      title: 'Wetten & Duelle',
      question: 'Wie wettet das Mitglied – und mit welchem Erfolg?',
      kpis: [
        { id: 'm-einsaetze', label: 'Einsätze', value: staked[0] ? staked[0].s : 0, unit: 'euro', compare: true, hint: `${staked[0] ? staked[0].n : 0} Einsätze` },
        { id: 'm-wett-ergebnis', label: 'Ergebnis abgerechneter Wetten', value: settledPayout - settledStake, unit: 'euro', signed: true, compare: true, hint: 'Auszahlungen − Einsätze der im Zeitraum abgerechneten Positionen' },
        { id: 'm-rendite', label: 'Rendite', value: settledStake ? (settledPayout - settledStake) / settledStake : null, unit: 'percent', compare: true, hint: 'Ergebnis ÷ Einsätze' },
        { id: 'm-trefferquote', label: 'Trefferquote', value: s.pct(won, won + lost), unit: 'percent', compare: true, hint: `${won} gewonnen, ${lost} verloren` },
        { id: 'm-wetten-erstellt', label: 'Wetten aufgestellt', value: created, unit: 'count', compare: true },
        { id: 'm-schiri', label: 'Als Schiedsrichter', value: refereed, unit: 'count', compare: true },
        { id: 'm-provision', label: 'Provisionen', value: sumType('provision', 'provision_schiri'), unit: 'euro', compare: true },
        { id: 'm-duelle', label: 'Duelle', value: duels, unit: 'count', compare: true, hint: 'herausgefordert oder herausgefordert worden' },
      ],
    },
    {
      id: 'tcg',
      title: 'TCG & Handel',
      question: 'Wie viele Packs öffnet das Mitglied – mit wie viel Glück – und wie handelt es?',
      kpis: [
        { id: 'm-packs', label: 'Packs geöffnet', value: openings.length, unit: 'count', compare: true },
        { id: 'm-pack-ausgaben', label: 'Ausgaben für Packs', value: -sumType('tcg_pack'), unit: 'euro', compare: true },
        { id: 'm-glueck', label: 'Pack-Glück', value: packLuck(pulled, catalog.RARITIES), unit: 'percent', compare: true, hint: 'Bankwert der gezogenen Karten ÷ Erwartungswert. 100 % = Durchschnitt.' },
        { id: 'm-beste', label: 'Beste Ziehung', value: best ? catalog.rarityByKey[best].label : '–', unit: 'text' },
        { id: 'm-bank', label: 'An Bank verkauft', value: sumType('tcg_verkauf'), unit: 'euro', compare: true },
        { id: 'm-handel-verkauft', label: 'Handel: verkauft', value: tradesSold, unit: 'count', compare: true, hint: 'Angebote, die angenommen wurden' },
        { id: 'm-handel-gekauft', label: 'Handel: gekauft', value: tradesBought, unit: 'count', compare: true, hint: 'gekauft oder Tausch angenommen' },
        { id: 'm-blackmarket', label: 'Black Market', value: -sumType('black_market'), unit: 'euro', compare: true, hint: `${countType('black_market')} Karten gekauft` },
      ],
      tables: [
        {
          title: 'Karten je Seltenheit',
          note: 'Gezogen im Zeitraum gegenüber der Erwartung – bei einzelnen Mitgliedern ist die Streuung naturgemäß groß.',
          head: ['Seltenheit', { label: 'Besitzt jetzt', num: true }, { label: 'Gezogen', num: true }, { label: 'Erwartet', num: true }, { label: 'An Bank verkauft', num: true }],
          zeroCols: [1, 2, 4],
          rows: catalog.RARITIES.map((r) => [
            r.label,
            { value: circ[r.key] || 0, unit: 'count' },
            { value: pullCount[r.key], unit: 'count' },
            { value: pulled.length * chances[r.key], unit: 'number' },
            { value: soldToBank[r.key] || 0, unit: 'count' },
          ]),
        },
      ],
    },
    {
      id: 'ihk',
      title: 'IHK-Quests',
      question: 'Welche Quests macht das Mitglied – und schafft es sie?',
      kpis: [
        { id: 'm-ihk', label: 'Abgeschlossene Läufe', value: runs.length, unit: 'count', compare: true },
        { id: 'm-ihk-erfolg', label: 'Erfolgsquote', value: s.pct(ihkOk, runs.length), unit: 'percent', compare: true },
        { id: 'm-ihk-lohn', label: 'Löhne', value: s.sumBy(runs, 'reward'), unit: 'euro', compare: true },
        { id: 'm-ihk-packs', label: 'Packs als Quest-Fund', value: runs.filter((r) => r.pack).length, unit: 'count', compare: true },
      ],
      tables: [
        {
          title: 'Nach Schwierigkeit',
          head: ['Schwierigkeit', { label: 'Läufe', num: true }, { label: 'Erfolg', num: true }, { label: 'Löhne', num: true }],
          zeroCols: [1],
          rows: DIFFICULTIES.map((d) => {
            const list = runs.filter((r) => r.difficulty === d.level);
            return [`${d.level} · ${d.label}`, { value: list.length, unit: 'count' }, { value: s.pct(list.filter((r) => r.success).length, list.length), unit: 'percent' }, { value: s.sumBy(list, 'reward'), unit: 'euro' }];
          }),
        },
      ],
    },
    {
      id: 'coin-lotterie',
      title: 'Coin & Lotterie',
      question: 'Gewinnt oder verliert das Mitglied mit Coins und Losen?',
      kpis: [
        { id: 'm-coin-netto', label: 'Coin: Gewinn/Verlust', value: sells - buys, unit: 'euro', signed: true, compare: true, hint: 'Verkäufe − Käufe im Zeitraum (ohne den aktuellen Bestand)' },
        { id: 'm-coin-trades', label: 'Coin-Trades', value: (coin.kauf ? coin.kauf.n : 0) + (coin.verkauf ? coin.verkauf.n : 0), unit: 'count', compare: true },
        { id: 'm-coin-bestand', label: 'Coin-Bestand', value: holding ? holding.units / 1e8 : 0, unit: 'number', hint: 'SAM (jetzt)' },
        { id: 'm-lose', label: 'Lose gekauft', value: tickets, unit: 'count', compare: true, hint: `für ${(-sumType('lotto_los') / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}` },
        { id: 'm-lotto-gewinne', label: 'Lotterie-Gewinne', value: s.sumBy(wins, 'pot') + s.sumBy(wins, 'prizeCash'), unit: 'euro', compare: true, hint: `${wins.length}× gewonnen` },
      ],
    },
  ];
}

module.exports = { member, packLuck };

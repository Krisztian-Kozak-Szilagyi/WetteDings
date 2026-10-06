// Manipulationserkennung: wertet regelmäßig die vorhandenen Datensätze aus (Pack-Käufe und -Öffnungen,
// Bank-Verkäufe, Broker, IHK, Handel) und legt für Devs und Admin Hinweise an, wenn jemand wie ein Skript spielt
// oder Werte zwischen Konten verschiebt. Die Muster selbst stehen in suspicionLogic.js. Niemand wird automatisch
// gesperrt – die Hinweise erscheinen im Panel unter Moderation → Auffälligkeiten.
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const SuspicionAlert = require('../models/SuspicionAlert');
const { TcgOpening } = require('../models/Tcg');
const { CoinTrade, CoinEvent } = require('../models/Coin');
const Bet = require('../models/Bet');
const Achievement = require('../models/Achievement');
const RankStint = require('../models/RankStint');
const { IhkRun } = require('../models/Ihk');
const { Trade } = require('../models/Trade');
const { DungeonRun } = require('../models/Dungeon');
const { GradingJob } = require('../models/Grading');
const ScriptSignal = require('../models/ScriptSignal');
const ActionTrace = require('../models/ActionTrace');
const { DeviceAlert } = require('../models/Device');
const achievements = require('../achievements/list');
const catalog = require('../tcg/catalog');
const itemService = require('../items/itemService');
const deviceService = require('../device/deviceService');
const dungeonService = require('../dungeon/dungeonService');
const gradingService = require('../grading/gradingService');
const deviceLogic = require('../device/deviceLogic');
const logs = require('../stats/logs');
const config = require('../config');
const { euro } = require('../lib/viewHelpers');
const { toZonedLocalInput } = require('../lib/time');
const logic = require('./suspicionLogic');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WINDOW_MS = DAY; // Tempo, Takt, Broker und Einnahmen: die letzten 24 Stunden
const VALUE_WINDOW_MS = 7 * DAY; // Wertverschiebung und Reaktion auf Kurssprünge
const FLOW_WINDOW_MS = 30 * DAY; // Sammelkonten und Platz 1 mit geliehenem Wert
const CIRC_WINDOW_MS = 60 * DAY; // Kartenkreislauf: Besitzerwechsel aus so langer Zeit
const AWAKE_WINDOW_MS = 2 * DAY; // rund um die Uhr: die letzten 48 Stunden
const DUNGEON_WINDOW_MS = 7 * DAY;
const IHK_WINDOW_MS = 14 * DAY; // IHK und Grading
const KEEP_DONE_DAYS = 30; // erledigte Hinweise werden danach vergessen …
const KEEP_VERDICT_DAYS = 180; // … mit Urteil (bestätigt/Fehlalarm) erst danach – sie bilden die Trefferquote
const VERDICTS = ['bestaetigt', 'fehlalarm'];
const RANK_ACHIEVEMENTS = ['thronfolger']; // Erfolge, die an Platz 1 hängen
const KEEP_SIGNAL_DAYS = 14; // Browser-Merkmale je Tag werden danach vergessen
const LIST_MAX = 200;

/** Datensätze je Mitglied: Map userId -> [map(doc)] */
function groupByUser(docs, map = (d) => d) {
  const out = new Map();
  for (const d of docs) {
    const k = String(d.user);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(map(d));
  }
  return out;
}

const times = (docs) => groupByUser(docs, (d) => d.createdAt);

/** Bankwert einer Karte oder eines Gegenstands in Cent */
function valueOf(cardId) {
  const item = itemService.itemByCardId(cardId);
  if (item) return item.sell || 0;
  const card = catalog.cardById[cardId];
  const r = card && catalog.rarityByKey[card.rarity];
  return r ? r.sell || 0 : 0;
}

/** Geschäft als Text wie im Handel-Protokoll, mit Bankwerten */
function tradeText(t, f) {
  const sellerPays = t.extraFrom === 'seller';
  const what = logs.tradeSide(t.give, sellerPays ? t.price : 0);
  const back = logs.tradeSide(t.want, sellerPays ? 0 : t.price);
  return `${t.sellerName} → ${t.buyerName || t.toName || '–'}: ${what} gegen ${back} (Wert ca. ${euro(f.given)} gegen ${euro(f.received)})`;
}

/** Tage ("YYYY-MM-DD", deutsche Zeit) von since bis now – für die Tages-Dokumente der Browser-Merkmale */
function daysBetween(since, now) {
  const out = new Set();
  for (let t = since.getTime(); t < now.getTime() + DAY; t += 6 * HOUR) out.add(toZonedLocalInput(new Date(Math.min(t, now.getTime())), config.timezone).slice(0, 10));
  return [...out];
}

/** Alle Funde der letzten Zeit: [{ key, kind, action, users, level, summary, details, from, evidenceAt }] */
async function findAll(now = new Date()) {
  const since = new Date(now.getTime() - WINDOW_MS);
  const awakeSince = new Date(now.getTime() - AWAKE_WINDOW_MS);
  const dungeonSince = new Date(now.getTime() - DUNGEON_WINDOW_MS);
  const ihkSince = new Date(now.getTime() - IHK_WINDOW_MS);
  const valueSince = new Date(now.getTime() - VALUE_WINDOW_MS);
  const circSince = new Date(now.getTime() - CIRC_WINDOW_MS);
  const [buys, opens, sells, coins, bets, runs, dungeons, jobs, signals, traces, income, trades, pairs, duels, earned, stints, events, coinsWeek] = await Promise.all([
    Ledger.find({ type: 'tcg_pack', amount: { $lt: 0 }, createdAt: { $gt: awakeSince } }).select('user createdAt').lean(),
    TcgOpening.find({ createdAt: { $gt: awakeSince } }).select('user createdAt').lean(),
    Ledger.find({ type: 'tcg_verkauf', createdAt: { $gt: awakeSince } }).select('user createdAt').lean(),
    CoinTrade.find({ createdAt: { $gt: awakeSince } }).select('user coin side units cents createdAt').lean(),
    Ledger.find({ type: 'einsatz', createdAt: { $gt: awakeSince } }).select('user createdAt').lean(),
    IhkRun.find({ createdAt: { $gt: ihkSince }, collectedAt: { $ne: null } }).select('user createdAt endsAt collectedAt').lean(),
    // mindestens ein echter Spieler ('members.user': { $ne: null } schlösse jeden Durchlauf mit Bot aus)
    DungeonRun.find({ slot: { $gt: dungeonSince }, members: { $elemMatch: { user: { $ne: null } } } }).select('slot status members.user members.joinedAt members.seen').lean(),
    GradingJob.find({ status: 'fertig', doneAt: { $gt: ihkSince } }).select('user createdAt doneAt clean seal spots.x').lean(),
    ScriptSignal.find({ day: { $in: daysBetween(awakeSince, now) } }).lean(),
    ActionTrace.find({ at: { $gt: since } }).select('user dev net at').lean(),
    Ledger.aggregate([
      { $match: { type: { $in: Object.keys(logic.INCOME_SOURCES) }, amount: { $gt: 0 }, createdAt: { $gt: since } } },
      { $group: { _id: { user: '$user', type: '$type' }, amount: { $sum: '$amount' }, from: { $min: '$createdAt' }, to: { $max: '$createdAt' } } },
    ]),
    Trade.find({ status: 'verkauft', closedAt: { $gt: circSince } }).select('kind seller buyer to sellerName buyerName toName give.card give.doc want.card want.doc price extraFrom closedAt').lean(),
    deviceService.flaggedPairs(),
    // Duelle mit Karten: die Karte des Verlierers geht an den Gewinner (betService)
    Bet.find({ status: 'entschieden', 'duel.cards.0': { $exists: true }, resolvedAt: { $gt: circSince } }).select('creator duel.opponent duel.cards outcome resolvedAt').lean(),
    Achievement.find({ earnedAt: { $gt: circSince } }).select('user key earnedAt').lean(),
    RankStint.find({ to: { $gt: new Date(now.getTime() - FLOW_WINDOW_MS) } }).lean(),
    CoinEvent.find({ at: { $gt: valueSince } }).select('coin at type change').lean(),
    CoinTrade.find({ createdAt: { $gt: valueSince } }).select('user coin side createdAt').lean(),
  ]);
  const found = [];
  const recent = (docs, field = 'createdAt') => docs.filter((d) => d[field] > since);

  // Dungeon-Teilnahmen je Mitglied (Bots haben keinen user)
  const dungeonByUser = new Map();
  for (const r of dungeons) {
    for (const m of r.members) {
      if (!m.user) continue;
      const k = String(m.user);
      if (!dungeonByUser.has(k)) dungeonByUser.set(k, []);
      dungeonByUser.get(k).push({ slot: r.slot, joinedAt: m.joinedAt || null, seen: !!m.seen, finished: r.status === 'fertig' });
    }
  }

  // Tempo und Takt je Aktion
  const streams = { kaufen: times(recent(buys)), oeffnen: times(recent(opens)), verkaufen: times(recent(sells)), broker: times(recent(coins)), wetten: times(recent(bets)) };
  for (const [action, users] of Object.entries(streams)) {
    for (const [user, list] of users) {
      const tempo = logic.tempoFinding(list, action);
      if (tempo) found.push({ key: `tempo:${action}:${user}`, kind: 'tempo', action, users: [user], ...pick(tempo, ['count', 'medianMs', 'runs']), ...base(tempo) });
      const takt = logic.rhythmFinding(list, action);
      if (takt) found.push({ key: `takt:${action}:${user}`, kind: 'takt', action, users: [user], ...pick(takt, ['count', 'medianMs', 'spread', 'runs']), ...base(takt) });
    }
  }

  // IHK sekundengenau
  for (const [user, list] of groupByUser(runs)) {
    const f = logic.ihkFinding(list, config.timezone);
    if (f) found.push({ key: `ihk:${user}`, kind: 'ihk', action: null, users: [user], ...pick(f, ['count', 'reactMs', 'restartMs', 'night']), ...base(f) });
  }

  // Broker-Scalping
  for (const [user, list] of groupByUser(recent(coins))) {
    const f = logic.scalpFinding(list);
    if (f) found.push({ key: `scalping:${user}`, kind: 'scalping', action: null, users: [user], ...pick(f, ['count', 'wins', 'rate', 'gain', 'holdMs']), ...base(f) });
  }

  // Dungeon-Automatik
  const dungeonOpts = { intervalMs: dungeonService.settings.intervalHours * HOUR, lockMs: dungeonService.LOCK_SECONDS * 1000, timeZone: config.timezone };
  for (const [user, list] of dungeonByUser) {
    const f = logic.dungeonFinding(list, dungeonOpts);
    if (f) found.push({ key: `dungeon:${user}`, kind: 'dungeon', action: null, users: [user], ...pick(f, ['count', 'joinMs', 'streak', 'night', 'unseen']), ...base(f) });
  }

  // Grading zur Mindestzeit
  const gradingJobs = jobs.map((j) => ({ ...j, spots: (j.spots || []).length }));
  for (const [user, list] of groupByUser(gradingJobs)) {
    const f = logic.gradingFinding(list, gradingService.MS_PER_SPOT);
    if (f) found.push({ key: `grading:${user}`, kind: 'grading', action: null, users: [user], ...pick(f, ['count', 'excessMs', 'perfect']), ...base(f) });
  }

  // Rund um die Uhr: alle Aktionen der letzten 48 Stunden zusammen
  const awake = [buys, opens, sells, coins, bets].flatMap((docs) => docs.map((d) => ({ user: d.user, at: d.createdAt })));
  for (const r of runs) awake.push({ user: r.user, at: r.createdAt }, { user: r.user, at: r.collectedAt });
  for (const j of jobs) awake.push({ user: j.user, at: j.createdAt }, { user: j.user, at: j.doneAt });
  for (const [user, list] of dungeonByUser) for (const r of list) if (r.joinedAt) awake.push({ user, at: r.joinedAt });
  for (const [user, list] of groupByUser(awake.filter((a) => a.at > awakeSince), (a) => a.at)) {
    const f = logic.activityFinding(list, config.timezone);
    if (f) found.push({ key: `dauer:${user}`, kind: 'dauer', action: null, users: [user], ...pick(f, ['count', 'spanMs', 'nightHours']), ...base(f) });
  }

  // Kein normaler Browser, Reaktionszeit, Eingaben, Falle, Rechenzentrum (Tages-Merkmale aus requestSignals.js)
  const signalChecks = [
    ['browser', logic.browserFinding, ['count', 'uas']],
    ['reaktion', logic.reactionFinding, ['count', 'medianMs', 'spread']],
    ['eingabe', logic.inputFinding, ['count']],
    ['falle', logic.trapFinding, ['count']],
    ['rechenzentrum', logic.hostingFinding, ['count', 'nets']],
  ];
  for (const [user, list] of groupByUser(signals)) {
    for (const [kind, check, keys] of signalChecks) {
      const f = check(list);
      if (f) found.push({ key: `${kind}:${user}`, kind, action: null, users: [user], ...pick(f, keys), ...base(f) });
    }
  }

  // Gleichzeitig von zwei Geräten (Herkunft jeder Spiel-Aktion der letzten 24 Stunden)
  for (const [user, list] of groupByUser(traces)) {
    const f = logic.parallelFinding(list);
    if (f) found.push({ key: `parallel:${user}`, kind: 'parallel', action: null, users: [user], ...pick(f, ['count', 'windows', 'devices']), ...base(f) });
  }

  // Ungewöhnliche Einnahmen
  for (const f of logic.incomeFindings(income.map((g) => ({ user: g._id.user, type: g._id.type, amount: g.amount, from: g.from, to: g.to })))) {
    found.push({ key: `ertrag:${f.user}`, kind: 'ertrag', action: null, users: [f.user], ...pick(f, ['total', 'factor']), ...base(f) });
  }

  // Reaktion auf Kurssprünge (Broker, letzte 7 Tage)
  for (const [user, list] of groupByUser(coinsWeek)) {
    const f = logic.marketReactionFinding(list, events, config.timezone);
    if (f) found.push({ key: `markt:${user}`, kind: 'markt', action: null, users: [user], ...pick(f, ['count', 'events', 'medianMs', 'aligned', 'night']), ...base(f) });
  }

  // Kartenkreislauf, Platz 1 mit geliehenem Wert, Sammelkonten
  found.push(...(await valueFlowFindings({ trades, duels, earned, stints, pairs, now })));

  // Wertverschiebung (letzte 7 Tage), zusammengefasst je Konten-Paar
  const byPair = new Map();
  const names = new Map();
  for (const t of trades.filter((x) => x.closedAt > valueSince)) {
    const f = logic.valueFinding(t, valueOf);
    if (!f) continue;
    names.set(String(t.seller), t.sellerName);
    names.set(String(t.buyer || t.to), t.buyerName || t.toName);
    const key = deviceLogic.pairKey(f.from, f.to);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push({ ...f, at: t.closedAt, text: tradeText(t, f) });
  }
  for (const [key, items] of byPair) {
    const f = logic.valuePairFinding(items, names, pairs.has(key));
    found.push({ key: `wert:${key}`, kind: 'wert', action: null, users: key.split(':'), ...pick(f, ['count', 'total', 'winner', 'trades']), ...base(f) });
  }
  return found;
}

/** Namen der Konten ids: aus den Geschäften, fehlende (Duelle) aus der Datenbank. Map userId → Name */
async function namesFor(trades, ids) {
  const names = new Map();
  for (const t of trades) {
    names.set(String(t.seller), t.sellerName);
    if (t.buyer || t.to) names.set(String(t.buyer || t.to), t.buyerName || t.toName);
  }
  const missing = [...new Set(ids.map(String))].filter((id) => !names.has(id));
  if (missing.length) for (const u of await User.find({ _id: { $in: missing } }).select('username').lean()) names.set(String(u._id), u.username);
  return names;
}

/**
 * Funde aus dem Wertfluss zwischen Konten: Kartenkreislauf (ein Exemplar wandert durch mehrere Konten), Platz 1 mit
 * geliehenem Wert und Sammelkonten. trades = abgeschlossene Geschäfte (CIRC_WINDOW_MS, mit Exemplaren),
 * duels = entschiedene Duelle mit Karten, earned = freigeschaltete Erfolge, stints = Abschnitte auf Platz 1.
 */
async function valueFlowFindings({ trades, duels, earned, stints, pairs, now }) {
  const found = [];
  const nowMs = now.getTime();
  const flowSince = nowMs - FLOW_WINDOW_MS;
  const sum = (lines) => (lines || []).reduce((s, l) => s + valueOf(l.card), 0);

  // Besitzerwechsel je Exemplar (die TcgCard-_id bleibt beim Handel und im Duell erhalten)
  const moves = new Map();
  const move = (doc, card, from, to, at, via, counter) => {
    if (!doc || !from || !to || !catalog.cardById[card]) return;
    const k = String(doc);
    if (!moves.has(k)) moves.set(k, { card, chain: [] });
    moves.get(k).chain.push({ from: String(from), to: String(to), at, via, counter });
  };
  for (const t of trades) {
    const other = t.buyer || t.to;
    if (!other) continue;
    const sellerPays = t.extraFrom === 'seller';
    const giveValue = sum(t.give) + (sellerPays ? t.price || 0 : 0);
    const wantValue = sum(t.want) + (sellerPays ? 0 : t.price || 0);
    for (const l of t.give || []) move(l.doc, l.card, t.seller, other, t.closedAt, 'handel', wantValue);
    for (const l of t.want || []) move(l.doc, l.card, other, t.seller, t.closedAt, 'handel', giveValue);
  }
  for (const b of duels) {
    const winner = b.outcome === 'o1' ? b.creator : b.duel && b.duel.opponent;
    for (const c of (b.duel && b.duel.cards) || []) if (c.side !== b.outcome) move(c.doc, c.card, c.user, winner, b.resolvedAt, 'duell', 0);
  }
  const chains = [...moves].filter(([, m]) => m.chain.length >= 2 && valueOf(m.card) >= logic.CIRC_MIN_CENTS);

  // Wertfluss je Geschäft: from gibt mehr, als es bekommt
  const flows = trades.map((t) => ({ ...logic.tradeFlow(t, valueOf), at: t.closedAt })).filter((f) => f.from && f.shifted > 0);
  const recentFlows = flows.filter((f) => new Date(f.at).getTime() > flowSince);

  const label = (key) => (achievements.byKey[key] ? achievements.byKey[key].name : key);
  const perks = earned.map((e) => ({ user: e.user, key: e.key, label: label(e.key), at: e.earnedAt }));
  const names = await namesFor(trades, [...chains.flatMap(([, m]) => m.chain.flatMap((c) => [c.from, c.to])), ...recentFlows.flatMap((f) => [f.from, f.to])]);

  for (const [doc, m] of chains) {
    const card = catalog.cardById[m.card];
    const rarity = catalog.rarityByKey[card.rarity];
    const f = logic.circulationFinding(m.chain, { value: valueOf(m.card), card: `${card.name} (${rarity ? rarity.label : card.rarity})`, earned: perks, names, now: nowMs, timeZone: config.timezone });
    if (f) found.push({ key: `kreislauf:${doc}`, kind: 'kreislauf', action: null, users: f.users, ...pick(f, ['count', 'owners', 'returns', 'perks', 'total', 'trades']), ...base(f) });
  }

  // Platz 1 mit geliehenem Wert: netto erhaltener Wert je Geschäft (positiv = bekommen)
  const netByUser = new Map();
  const addNet = (user, at, net) => {
    const k = String(user);
    if (!netByUser.has(k)) netByUser.set(k, []);
    netByUser.get(k).push({ at, net });
  };
  for (const f of flows) {
    addNet(f.to, f.at, f.shifted);
    addNet(f.from, f.at, -f.shifted);
  }
  for (const [user, list] of groupByUser(stints)) {
    const f = logic.rankFinding(list, netByUser.get(user) || [], perks.filter((p) => String(p.user) === user && RANK_ACHIEVEMENTS.includes(p.key)));
    if (f) found.push({ key: `rang:${user}`, kind: 'rang', action: null, users: [user], ...pick(f, ['count', 'spanMs', 'total']), ...base(f) });
  }

  // Sammelkonten (letzte 30 Tage)
  for (const f of logic.funnelFindings(recentFlows, { names, flagged: pairs, pairKey: deviceLogic.pairKey })) {
    found.push({ key: `netz:${f.user}`, kind: 'netz', action: null, users: [f.user], ...pick(f, ['count', 'total', 'back', 'trades']), ...base(f) });
  }
  return found;
}

const pick = (obj, keys) => ({ details: Object.fromEntries(keys.map((k) => [k, obj[k]])) });
const base = (f) => ({ level: f.level, summary: f.summary, from: f.from, evidenceAt: f.to });

/**
 * Hinweis anlegen bzw. auf den neuen Stand bringen. Ein erledigter Hinweis öffnet sich wieder, wenn es danach neue
 * Belege gibt oder die Stufe steigt – sonst bleibt er erledigt (wie bei den Mehrfach-Konten).
 */
async function upsert(f) {
  const alert = await SuspicionAlert.findOne({ key: f.key });
  if (!alert) {
    await SuspicionAlert.create(f).catch((err) => {
      if (!err || err.code !== 11000) throw err; // zwei Durchläufe gleichzeitig: der Hinweis existiert schon
    });
    return;
  }
  const newer = new Date(f.evidenceAt) > new Date(alert.evidenceAt);
  const reopen = alert.doneAt && ((newer && new Date(f.evidenceAt) > alert.doneAt) || f.level > alert.level);
  if (!newer && f.level <= alert.level && !reopen) return; // nichts Neues
  Object.assign(alert, { summary: f.summary, details: f.details, level: Math.max(f.level, alert.level), evidenceAt: newer ? f.evidenceAt : alert.evidenceAt });
  if (newer && f.from) alert.from = f.from;
  if (reopen) {
    alert.doneAt = null;
    alert.doneByName = null;
  }
  await alert.save();
}

/** Hinweise zu gelöschten oder fehlenden Konten entfernen – das Panel zeigt sie nicht, das Abzeichen soll sie nicht zählen */
async function forgetGone() {
  const ids = await SuspicionAlert.distinct('users');
  if (!ids.length) return;
  const alive = new Set((await User.find({ _id: { $in: ids }, deletedAt: null }).distinct('_id')).map(String));
  const gone = ids.filter((id) => !alive.has(String(id)));
  if (gone.length) await SuspicionAlert.deleteMany({ users: { $in: gone } });
}

let running = false;

/** Ein Durchlauf (Job alle 10 Minuten, siehe jobs.js): Funde speichern, alte erledigte Hinweise vergessen */
async function scan(now = new Date()) {
  if (running) return 0;
  running = true;
  try {
    const found = await findAll(now);
    for (const f of found) await upsert(f);
    await SuspicionAlert.deleteMany({ doneAt: { $lt: new Date(now.getTime() - KEEP_DONE_DAYS * DAY) }, verdict: null });
    await SuspicionAlert.deleteMany({ verdictAt: { $lt: new Date(now.getTime() - KEEP_VERDICT_DAYS * DAY) } });
    await forgetGone();
    await ScriptSignal.deleteMany({ day: { $lt: toZonedLocalInput(new Date(now.getTime() - KEEP_SIGNAL_DAYS * DAY), config.timezone).slice(0, 10) } });
    return found.length;
  } finally {
    running = false;
  }
}

/** Höchste Stufe offener Mehrfach-Konten-Hinweise je Konto: Map userId → Stufe (für die Gesamtbewertung) */
async function deviceLevels() {
  const alerts = await DeviceAlert.find({ doneAt: null }).select('users level').lean();
  const out = new Map();
  for (const a of alerts) for (const u of a.users) out.set(String(u), Math.max(out.get(String(u)) || 0, a.level));
  return out;
}

/** Spieler (bzw. Konten-Paare) mit Gesamtbewertung ab "Verdacht" – für das Abzeichen am Admin-Menüpunkt */
async function openCount() {
  const alerts = await SuspicionAlert.find({ doneAt: null }).select('kind level users evidenceAt').lean();
  if (!alerts.length) return 0;
  const groups = logic.groupAlerts(alerts.map((a) => ({ ...a, users: a.users.map((id) => ({ _id: id })) })), await deviceLevels());
  return groups.filter((g) => g.rating && g.rating.stage >= logic.STAGE.verdacht).length;
}

/** Hinweise fürs Panel: offene zuerst, dann nach Stufe und Zeit; mit Namen und Link ins passende Protokoll */
async function list() {
  const alerts = await SuspicionAlert.find().sort({ doneAt: 1, level: -1, evidenceAt: -1 }).limit(LIST_MAX).lean();
  const ids = [...new Set(alerts.flatMap((a) => a.users.map(String)))];
  const users = await User.find({ _id: { $in: ids } }).select('username bannedUntil deletedAt').lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const LOG_OF = { ihk: 'ihk', scalping: 'broker', wert: 'handel', dungeon: 'dungeon', grading: 'grading', ertrag: 'konto', kreislauf: 'handel', rang: 'handel', netz: 'handel', markt: 'broker' };
  return alerts
    .map((a) => {
      const list = a.users.map((id) => userById.get(String(id)));
      if (list.some((u) => !u || u.deletedAt)) return null;
      return {
        ...a,
        kindLabel: logic.KIND_LABEL[a.kind] || a.kind,
        levelLabel: deviceLogic.LEVEL_LABEL[a.level],
        actionLabel: a.action && logic.ACTIONS[a.action] ? logic.ACTIONS[a.action].label : null,
        log: a.action && logic.ACTIONS[a.action] ? logic.ACTIONS[a.action].log : LOG_OF[a.kind] || 'gesamt',
        users: list.map((u) => ({ _id: u._id, username: u.username, banned: deviceLogic.isBanned(u) })),
        facts: logic.factsOf(a.kind, a.details),
        extras: logic.extrasOf(a.details),
      };
    })
    .filter(Boolean);
}

/** Hinweise fürs Panel, gebündelt je Spieler mit Gesamtbewertung (siehe suspicionLogic.groupAlerts) */
async function listGroups() {
  const [alerts, levels] = await Promise.all([list(), deviceLevels()]);
  return logic.groupAlerts(alerts, levels);
}

/** Mehrere Hinweise auf einmal erledigen bzw. wieder öffnen ("Alle erledigt" je Spieler) */
async function setDoneMany(ids, done, actor) {
  for (const id of ids) await setDone(id, done, actor);
}

/** Erledigen bzw. wieder öffnen. Wieder öffnen nimmt auch ein Urteil zurück (es war wohl voreilig). */
async function setDone(id, done, actor) {
  const $set = { doneAt: done ? new Date() : null, doneByName: done && actor ? actor.username : null };
  if (!done) Object.assign($set, { verdict: null, verdictByName: null, verdictAt: null });
  await SuspicionAlert.updateOne({ _id: id }, { $set }, { timestamps: false });
}

/** Urteil festhalten (bestätigt oder Fehlalarm) – erledigt den Hinweis zugleich */
async function setVerdict(id, verdict, actor) {
  if (!VERDICTS.includes(verdict)) return;
  const at = new Date();
  const by = actor ? actor.username : null;
  await SuspicionAlert.updateOne({ _id: id }, { $set: { verdict, verdictAt: at, verdictByName: by, doneAt: at, doneByName: by } }, { timestamps: false });
}

/** Trefferquote je Muster aus allen Hinweisen mit Urteil (logic.precisionRows) */
async function precision() {
  const rows = await SuspicionAlert.aggregate([{ $group: { _id: { kind: '$kind', verdict: '$verdict' }, n: { $sum: 1 } } }]);
  return logic.precisionRows(rows.map((r) => ({ kind: r._id.kind, verdict: r._id.verdict, count: r.n })));
}

/** Konto gelöscht: seine Hinweise und Browser-Merkmale entfernen */
const forgetUser = (userId) => Promise.all([SuspicionAlert.deleteMany({ users: userId }), ScriptSignal.deleteMany({ user: userId }), ActionTrace.deleteMany({ user: userId })]);

module.exports = { WINDOW_MS, AWAKE_WINDOW_MS, DUNGEON_WINDOW_MS, IHK_WINDOW_MS, VALUE_WINDOW_MS, FLOW_WINDOW_MS, CIRC_WINDOW_MS, VERDICTS, daysBetween, valueOf, findAll, upsert, scan, openCount, list, listGroups, setDone, setDoneMany, setVerdict, precision, forgetUser };

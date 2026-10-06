// Manipulationserkennung: wertet regelmäßig die vorhandenen Datensätze aus (Pack-Käufe und -Öffnungen,
// Bank-Verkäufe, Broker, IHK, Handel) und legt für Devs und Admin Hinweise an, wenn jemand wie ein Skript spielt
// oder Werte zwischen Konten verschiebt. Die Muster selbst stehen in suspicionLogic.js. Niemand wird automatisch
// gesperrt – die Hinweise erscheinen im Panel unter Moderation → Auffälligkeiten.
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const SuspicionAlert = require('../models/SuspicionAlert');
const { TcgOpening } = require('../models/Tcg');
const { CoinTrade } = require('../models/Coin');
const { IhkRun } = require('../models/Ihk');
const { Trade } = require('../models/Trade');
const { DungeonRun } = require('../models/Dungeon');
const { GradingJob } = require('../models/Grading');
const ScriptSignal = require('../models/ScriptSignal');
const ActionTrace = require('../models/ActionTrace');
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
const WINDOW_MS = DAY; // Tempo, Takt, Broker, Handel und Einnahmen: die letzten 24 Stunden
const AWAKE_WINDOW_MS = 2 * DAY; // rund um die Uhr: die letzten 48 Stunden
const DUNGEON_WINDOW_MS = 7 * DAY;
const IHK_WINDOW_MS = 14 * DAY; // IHK und Grading
const KEEP_DONE_DAYS = 30; // erledigte Hinweise werden danach vergessen
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
  const [buys, opens, sells, coins, bets, runs, dungeons, jobs, signals, traces, income, trades, pairs] = await Promise.all([
    Ledger.find({ type: 'tcg_pack', amount: { $lt: 0 }, createdAt: { $gt: awakeSince } }).select('user createdAt').lean(),
    TcgOpening.find({ createdAt: { $gt: awakeSince } }).select('user createdAt').lean(),
    Ledger.find({ type: 'tcg_verkauf', createdAt: { $gt: awakeSince } }).select('user createdAt').lean(),
    CoinTrade.find({ createdAt: { $gt: awakeSince } }).select('user coin side units cents createdAt').lean(),
    Ledger.find({ type: 'einsatz', createdAt: { $gt: awakeSince } }).select('user createdAt').lean(),
    IhkRun.find({ createdAt: { $gt: ihkSince }, collectedAt: { $ne: null } }).select('user createdAt endsAt collectedAt').lean(),
    DungeonRun.find({ slot: { $gt: dungeonSince }, 'members.user': { $ne: null } }).select('slot status members.user members.joinedAt members.seen').lean(),
    GradingJob.find({ status: 'fertig', doneAt: { $gt: ihkSince } }).select('user createdAt doneAt clean seal spots.x').lean(),
    ScriptSignal.find({ day: { $in: daysBetween(awakeSince, now) } }).lean(),
    ActionTrace.find({ at: { $gt: since } }).select('user dev net at').lean(),
    Ledger.aggregate([
      { $match: { type: { $in: Object.keys(logic.INCOME_SOURCES) }, amount: { $gt: 0 }, createdAt: { $gt: since } } },
      { $group: { _id: { user: '$user', type: '$type' }, amount: { $sum: '$amount' }, from: { $min: '$createdAt' }, to: { $max: '$createdAt' } } },
    ]),
    Trade.find({ status: 'verkauft', closedAt: { $gt: since } }).select('kind seller buyer to sellerName buyerName toName give.card want.card price extraFrom closedAt').lean(),
    deviceService.flaggedPairs(),
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

  // Wertverschiebung, zusammengefasst je Konten-Paar
  const byPair = new Map();
  const names = new Map();
  for (const t of trades) {
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
    await SuspicionAlert.deleteMany({ doneAt: { $lt: new Date(now.getTime() - KEEP_DONE_DAYS * DAY) } });
    await forgetGone();
    await ScriptSignal.deleteMany({ day: { $lt: toZonedLocalInput(new Date(now.getTime() - KEEP_SIGNAL_DAYS * DAY), config.timezone).slice(0, 10) } });
    return found.length;
  } finally {
    running = false;
  }
}

/** Offene Hinweise ab "wahrscheinlich" – für das Abzeichen am Admin-Menüpunkt (wie deviceService.alertCount) */
const openCount = () => SuspicionAlert.countDocuments({ doneAt: null, level: { $gte: deviceLogic.LEVEL.wahrscheinlich } });

/** Hinweise fürs Panel: offene zuerst, dann nach Stufe und Zeit; mit Namen und Link ins passende Protokoll */
async function list() {
  const alerts = await SuspicionAlert.find().sort({ doneAt: 1, level: -1, evidenceAt: -1 }).limit(LIST_MAX).lean();
  const ids = [...new Set(alerts.flatMap((a) => a.users.map(String)))];
  const users = await User.find({ _id: { $in: ids } }).select('username bannedUntil deletedAt').lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const LOG_OF = { ihk: 'ihk', scalping: 'broker', wert: 'handel', dungeon: 'dungeon', grading: 'grading', ertrag: 'konto' };
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
      };
    })
    .filter(Boolean);
}

async function setDone(id, done, actor) {
  await SuspicionAlert.updateOne({ _id: id }, { $set: { doneAt: done ? new Date() : null, doneByName: done && actor ? actor.username : null } }, { timestamps: false });
}

/** Konto gelöscht: seine Hinweise und Browser-Merkmale entfernen */
const forgetUser = (userId) => Promise.all([SuspicionAlert.deleteMany({ users: userId }), ScriptSignal.deleteMany({ user: userId }), ActionTrace.deleteMany({ user: userId })]);

module.exports = { WINDOW_MS, AWAKE_WINDOW_MS, DUNGEON_WINDOW_MS, IHK_WINDOW_MS, daysBetween, valueOf, findAll, upsert, scan, openCount, list, setDone, forgetUser };

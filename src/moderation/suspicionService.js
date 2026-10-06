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
const catalog = require('../tcg/catalog');
const itemService = require('../items/itemService');
const { swapSides } = require('../trade/tradeService');
const deviceService = require('../device/deviceService');
const deviceLogic = require('../device/deviceLogic');
const logs = require('../stats/logs');
const config = require('../config');
const { euro } = require('../lib/viewHelpers');
const logic = require('./suspicionLogic');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WINDOW_MS = DAY; // Tempo, Takt, Broker und Handel: die letzten 24 Stunden
const IHK_WINDOW_MS = 14 * DAY;
const KEEP_DONE_DAYS = 30; // erledigte Hinweise werden danach vergessen
const LIST_MAX = 200;

/** Zeitpunkte je Mitglied: Map userId -> [Date] */
function byUser(docs, field = 'createdAt') {
  const map = new Map();
  for (const d of docs) {
    const k = String(d.user);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(d[field]);
  }
  return map;
}

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
  const to = t.kind === 'tausch' ? t.toName : t.buyerName;
  const what = t.kind === 'tausch' ? logs.swapLabel(t, 'give') : logs.cardLabel(t.card);
  const back = t.kind === 'tausch' ? logs.swapLabel(t, 'take') + (t.price > 0 ? ` + ${euro(t.price)}` : '') : euro(t.price);
  return `${t.sellerName} → ${to || '–'}: ${what} gegen ${back} (Wert ca. ${euro(f.given)} gegen ${euro(f.received)})`;
}

/** Alle Funde der letzten Zeit: [{ key, kind, action, users, level, summary, details, from, evidenceAt }] */
async function findAll(now = new Date()) {
  const since = new Date(now.getTime() - WINDOW_MS);
  const ihkSince = new Date(now.getTime() - IHK_WINDOW_MS);
  const [buys, opens, sells, coins, runs, trades, pairs] = await Promise.all([
    Ledger.find({ type: 'tcg_pack', amount: { $lt: 0 }, createdAt: { $gt: since } }).select('user createdAt').lean(),
    TcgOpening.find({ createdAt: { $gt: since } }).select('user createdAt').lean(),
    Ledger.find({ type: 'tcg_verkauf', createdAt: { $gt: since } }).select('user createdAt').lean(),
    CoinTrade.find({ createdAt: { $gt: since } }).select('user coin side cents createdAt').lean(),
    IhkRun.find({ createdAt: { $gt: ihkSince }, collectedAt: { $ne: null } }).select('user createdAt endsAt collectedAt').lean(),
    Trade.find({ status: 'verkauft', closedAt: { $gt: since } }).select('kind seller buyer to sellerName buyerName toName card cardDoc foiledAt grade wantCard wantCopy wantFoiledAt wantGrade give take price extraFrom closedAt').lean(),
    deviceService.flaggedPairs(),
  ]);
  const found = [];

  // Tempo und Takt je Aktion
  const streams = { kaufen: byUser(buys), oeffnen: byUser(opens), verkaufen: byUser(sells), broker: byUser(coins) };
  for (const [action, users] of Object.entries(streams)) {
    for (const [user, times] of users) {
      const tempo = logic.tempoFinding(times, action);
      if (tempo) found.push({ key: `tempo:${action}:${user}`, kind: 'tempo', action, users: [user], ...pick(tempo, ['count', 'medianMs', 'runs']), ...base(tempo) });
      const takt = logic.rhythmFinding(times, action);
      if (takt) found.push({ key: `takt:${action}:${user}`, kind: 'takt', action, users: [user], ...pick(takt, ['count', 'medianMs', 'spread', 'runs']), ...base(takt) });
    }
  }

  // IHK sekundengenau
  const runsByUser = new Map();
  for (const r of runs) {
    const k = String(r.user);
    if (!runsByUser.has(k)) runsByUser.set(k, []);
    runsByUser.get(k).push(r);
  }
  for (const [user, list] of runsByUser) {
    const f = logic.ihkFinding(list, config.timezone);
    if (f) found.push({ key: `ihk:${user}`, kind: 'ihk', action: null, users: [user], ...pick(f, ['count', 'reactMs', 'restartMs', 'night']), ...base(f) });
  }

  // Broker-Scalping
  const coinByUser = new Map();
  for (const c of coins) {
    const k = String(c.user);
    if (!coinByUser.has(k)) coinByUser.set(k, []);
    coinByUser.get(k).push(c);
  }
  for (const [user, list] of coinByUser) {
    const f = logic.scalpFinding(list);
    if (f) found.push({ key: `scalping:${user}`, kind: 'scalping', action: null, users: [user], ...pick(f, ['count', 'wins', 'rate', 'gain', 'holdMs']), ...base(f) });
  }

  // Wertverschiebung, zusammengefasst je Konten-Paar
  const byPair = new Map();
  const names = new Map();
  for (const t of trades) {
    const sides = t.kind === 'tausch' ? swapSides(t) : {};
    const f = logic.valueFinding({ ...t, give: sides.give, take: sides.take }, valueOf);
    if (!f) continue;
    names.set(String(t.seller), t.sellerName);
    const other = t.kind === 'tausch' ? t.to : t.buyer;
    names.set(String(other), t.kind === 'tausch' ? t.toName : t.buyerName);
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

let running = false;

/** Ein Durchlauf (Job alle 10 Minuten, siehe jobs.js): Funde speichern, alte erledigte Hinweise vergessen */
async function scan(now = new Date()) {
  if (running) return 0;
  running = true;
  try {
    const found = await findAll(now);
    for (const f of found) await upsert(f);
    await SuspicionAlert.deleteMany({ doneAt: { $lt: new Date(now.getTime() - KEEP_DONE_DAYS * DAY) } });
    return found.length;
  } finally {
    running = false;
  }
}

/** Offene Hinweise – für das Abzeichen am Admin-Menüpunkt */
const openCount = () => SuspicionAlert.countDocuments({ doneAt: null });

/** Hinweise fürs Panel: offene zuerst, dann nach Stufe und Zeit; mit Namen und Link ins passende Protokoll */
async function list() {
  const alerts = await SuspicionAlert.find().sort({ doneAt: 1, level: -1, evidenceAt: -1 }).limit(LIST_MAX).lean();
  const ids = [...new Set(alerts.flatMap((a) => a.users.map(String)))];
  const users = await User.find({ _id: { $in: ids } }).select('username bannedUntil deletedAt').lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const LOG_OF = { ihk: 'ihk', scalping: 'broker', wert: 'handel' };
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

/** Konto gelöscht: seine Hinweise entfernen */
const forgetUser = (userId) => SuspicionAlert.deleteMany({ users: userId });

module.exports = { WINDOW_MS, IHK_WINDOW_MS, valueOf, findAll, upsert, scan, openCount, list, setDone, forgetUser };

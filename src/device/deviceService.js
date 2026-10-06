// Geräte-Erkennung: merkt sich, mit welchen Geräten ein Konto benutzt wird, meldet dem Admin Konten,
// die sich ein Gerät teilen, und setzt Sperren durch (Konto und alle seine Geräte).
const User = require('../models/User');
const { Device, DeviceAlert } = require('../models/Device');
const { Trade } = require('../models/Trade');
const { UserError } = require('../lib/util');
const logic = require('./deviceLogic');

const MAX_LOGINS = 20; // so viele Anmeldezeiten bleiben pro Gerät erhalten
const MAX_IPS = 5;
const KEEP_DAYS = 365; // Geräte, die so lange nicht benutzt wurden, werden vergessen
const CACHE_MS = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Gerät für ein Konto festhalten. login = neue Anmeldung/Sitzung (Zeitpunkt wird notiert).
 * Danach wird geprüft, ob andere Konten dasselbe Gerät benutzen.
 */
async function record({ userId, deviceId, fp = null, ip = null, ua = '', login = true }) {
  if (!userId || !deviceId) return;
  const now = new Date();
  let dev = await Device.findOne({ user: userId, deviceId });
  if (!dev) dev = new Device({ user: userId, deviceId, firstAt: now });
  dev.lastAt = now;
  if (ua) dev.ua = logic.uaLabel(ua);
  if (fp) dev.fp = fp;
  if (ip && !dev.ips.includes(ip)) dev.ips = [...dev.ips, ip].slice(-MAX_IPS);
  if (login) dev.logins = [...dev.logins, now].slice(-MAX_LOGINS);
  try {
    await dev.save();
  } catch (err) {
    if (!err || err.code !== 11000) throw err; // zwei Anfragen gleichzeitig: der Eintrag existiert schon
    return;
  }
  await checkMatches(dev);
}

/**
 * Was bei diesen Geräten nicht als Beleg zählt: häufige fp|ip-Kombinationen (baugleiche Geräte im selben Netz, #89)
 * und geteilte Netze (IPs, die viele Konten benutzen, z. B. das Schulnetz)
 */
async function commonFor(devices) {
  const fps = [...new Set(devices.map((d) => d.fp).filter(Boolean))];
  const ips = [...new Set(devices.flatMap((d) => d.ips || []))];
  const [byFp, byIp] = await Promise.all([
    fps.length ? Device.find({ fp: { $in: fps } }).select('user fp ips').lean() : [],
    ips.length ? Device.find({ ips: { $in: ips } }).select('user ips').lean() : [],
  ]);
  return new Set([...logic.commonPrints(byFp), ...logic.crowdedNets(byIp)]);
}

/**
 * Hinweis für ein Konten-Paar anlegen bzw. auf den aktuellen Stand bringen – über alle Geräte beider Konten.
 * Ein stärkerer Treffer zeigt einen erledigten Hinweis wieder als neu; ein schwächerer stuft nur herab (#89).
 */
async function updatePair(userA, userB, common) {
  const [da, db] = await Promise.all([Device.find({ user: userA }).lean(), Device.find({ user: userB }).lean()]);
  const level = logic.pairLevel(da, db, common || (await commonFor([...da, ...db])));
  const key = logic.pairKey(userA, userB);
  const alert = await DeviceAlert.findOne({ key });
  if (!alert) {
    if (!level) return;
    await DeviceAlert.create({ key, users: [userA, userB], level }).catch((err) => {
      if (!err || err.code !== 11000) throw err;
    });
  } else if (!level) {
    await DeviceAlert.deleteOne({ _id: alert._id });
  } else if (level !== alert.level) {
    if (level > alert.level) alert.doneAt = null; // stärkerer Treffer als bisher: wieder als neu anzeigen
    alert.level = level;
    await alert.save();
  }
}

/** Andere Konten mit demselben Gerät suchen und Hinweise anlegen bzw. anpassen */
async function checkMatches(dev) {
  const or = [{ deviceId: dev.deviceId }];
  if (dev.fp) or.push({ fp: dev.fp });
  const others = await Device.find({ user: { $ne: dev.user }, $or: or }).select('user').lean();
  const ids = [...new Set(others.map((o) => String(o.user)))];
  for (const other of ids) await updatePair(dev.user, other);
}

/** Alle Hinweise mit den aktuellen Regeln neu bewerten (beim Start, siehe migrate.js) – z. B. nach #89 und geteilten Netzen */
async function recomputeAlerts() {
  const alerts = await DeviceAlert.find().select('users').lean();
  if (!alerts.length) return 0;
  const ids = [...new Set(alerts.flatMap((a) => a.users.map(String)))];
  const common = await commonFor(await Device.find({ user: { $in: ids } }).select('fp ips').lean());
  for (const a of alerts) await updatePair(a.users[0], a.users[1], common);
  return alerts.length;
}

// ---------- Handel zwischen Mehrfach-Konten ----------
const SUSPICIOUS_DAYS = 30; // so weit zurück zählen Geschäfte fürs Abzeichen

/** Konten-Paare mit Hinweis "sicher" oder "wahrscheinlich" (auch erledigte) als Set von pairKey */
async function flaggedPairs() {
  const alerts = await DeviceAlert.find({ level: { $gte: logic.LEVEL.wahrscheinlich } }).select('key').lean();
  return new Set(alerts.map((a) => a.key));
}

/** Die beiden Seiten eines abgeschlossenen Geschäfts: Anbieter und Gegenseite (buyer = Käufer bzw. Empfänger) */
const tradePartner = (t) => t.buyer || t.to;
const tradePairKey = (t) => logic.pairKey(t.seller, tradePartner(t));

/** Mongo-Filter: Geschäfte zwischen den Konten eines der Paare */
function tradeFilterForPairs(pairs) {
  const or = [];
  for (const key of pairs) {
    const [a, b] = key.split(':');
    for (const [x, y] of [[a, b], [b, a]]) {
      or.push({ seller: x, buyer: y });
    }
  }
  return or.length ? { $or: or } : { _id: null }; // ohne Paare: nichts
}

/** Neue Geschäfte zwischen Mehrfach-Konten seit dem letzten Blick (Abzeichen für Admin und Devs) */
async function suspiciousTradeCount(user) {
  const since = Math.max(user.suspiciousSeenAt ? new Date(user.suspiciousSeenAt).getTime() : 0, Date.now() - SUSPICIOUS_DAYS * 24 * 60 * 60 * 1000);
  const trades = await Trade.find({ status: 'verkauft', closedAt: { $gt: new Date(since) } }).select('kind seller buyer to').lean();
  if (!trades.length) return 0;
  const pairs = await flaggedPairs();
  return trades.filter((t) => pairs.has(tradePairKey(t))).length;
}

/** Offene Hinweise (sicher oder wahrscheinlich) – für das Abzeichen am Admin-Menüpunkt */
const alertCount = () => DeviceAlert.countDocuments({ doneAt: null, level: { $gte: logic.LEVEL.wahrscheinlich } });

/** Hinweise fürs Admin-Panel: je Konten-Paar die gemeinsamen Geräte samt Anmeldezeiten */
async function listAlerts() {
  const alerts = await DeviceAlert.find().sort({ doneAt: 1, level: -1, updatedAt: -1 }).limit(200).lean();
  const ids = [...new Set(alerts.flatMap((a) => a.users.map(String)))];
  const [users, devices] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('username bannedUntil deletedAt createdAt').lean(),
    Device.find({ user: { $in: ids } }).lean(),
  ]);
  const common = await commonFor(devices);
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const devsByUser = new Map();
  for (const d of devices) {
    const k = String(d.user);
    if (!devsByUser.has(k)) devsByUser.set(k, []);
    devsByUser.get(k).push(d);
  }
  return alerts
    .map((a) => {
      const [ua, ub] = a.users.map((id) => userById.get(String(id)));
      if (!ua || !ub || ua.deletedAt || ub.deletedAt) return null;
      const da = devsByUser.get(String(ua._id)) || [];
      const db = devsByUser.get(String(ub._id)) || [];
      // Geräte-Paare, die als dasselbe Gerät gelten – das stärkste zuerst
      const shared = [];
      for (const x of da) {
        for (const y of db) {
          const level = logic.matchLevel(x, y, common);
          if (level) shared.push({ level, ua: x.ua || y.ua, a: x, b: y });
        }
      }
      shared.sort((p, q) => q.level - p.level || q.a.lastAt - p.a.lastAt);
      return {
        _id: a._id,
        level: a.level,
        label: logic.LEVEL_LABEL[a.level],
        doneAt: a.doneAt,
        updatedAt: a.updatedAt,
        users: [ua, ub].map((u) => ({ _id: u._id, username: u.username, createdAt: u.createdAt, banned: logic.isBanned(u) })),
        shared: shared.slice(0, 3).map((s) => ({
          level: s.level,
          label: logic.LEVEL_LABEL[s.level],
          ua: s.ua,
          logins: [s.a, s.b].map((d) => ({ lastAt: d.lastAt, times: [...d.logins].reverse().slice(0, 5) })),
        })),
      };
    })
    .filter(Boolean);
}

async function setAlertDone(id, done) {
  await DeviceAlert.updateOne({ _id: id }, { $set: { doneAt: done ? new Date() : null } }, { timestamps: false });
}

// ---------- Sperren ----------
// Gesperrt ist das Konto selbst und jedes Gerät, mit dem es benutzt wurde. Die gesperrten Geräte liegen im
// Speicher (kurz zwischengespeichert), damit die Prüfung bei jeder Anfrage keine Datenbankabfrage kostet.
let cache = { at: 0, devices: new Map(), prints: new Map() };
let lastPurge = 0;

async function reload() {
  const now = Date.now();
  if (now - lastPurge > DAY) {
    lastPurge = now;
    await Device.deleteMany({ lastAt: { $lt: new Date(now - KEEP_DAYS * DAY) } });
  }
  const banned = await User.find({ bannedUntil: { $gt: new Date() }, deletedAt: null }).select('bannedUntil banReason bannedAt').lean();
  const devices = new Map();
  const prints = new Map();
  if (banned.length) {
    const info = new Map(banned.map((u) => [String(u._id), { until: u.bannedUntil, reason: u.banReason || '', at: u.bannedAt }]));
    const devs = await Device.find({ user: { $in: banned.map((u) => u._id) } }).select('user deviceId fp ips').lean();
    // Fingerabdruck+IP, die andere (nicht gesperrte) Konten schon vor der Sperre benutzt haben: baugleiche Geräte
    // von Freunden im selben WLAN – die dürfen nicht mitgesperrt werden (#89). Ein danach neu angelegtes Konto
    // auf demselben Gerät trifft die Sperre weiterhin.
    const bannedIds = new Set(info.keys());
    const fps = [...new Set(devs.map((d) => d.fp).filter(Boolean))];
    const others = fps.length ? await Device.find({ fp: { $in: fps }, user: { $nin: [...bannedIds] } }).select('user fp ips firstAt').lean() : [];
    const firstUse = new Map(); // fp|ip -> frühester Beginn bei einem anderen Konto
    for (const o of others) for (const ip of o.ips) {
      const k = logic.printKey(o.fp, ip);
      const t = new Date(o.firstAt).getTime();
      if (!firstUse.has(k) || t < firstUse.get(k)) firstUse.set(k, t);
    }
    for (const d of devs) {
      const ban = info.get(String(d.user));
      devices.set(d.deviceId, { until: ban.until, reason: ban.reason });
      // ohne Cookie zählt der Fingerabdruck nur zusammen mit derselben IP – sonst träfe es baugleiche Geräte
      if (d.fp) {
        for (const ip of d.ips) {
          const k = logic.printKey(d.fp, ip);
          const before = firstUse.get(k);
          if (before !== undefined && (!ban.at || before < new Date(ban.at).getTime())) continue;
          prints.set(k, { until: ban.until, reason: ban.reason });
        }
      }
    }
  }
  cache = { at: now, devices, prints };
}

async function ensureFresh() {
  if (Date.now() - cache.at > CACHE_MS) await reload();
}

/** Ist dieses Gerät gesperrt? Liefert { until, reason } oder null. */
function blockedDevice({ deviceId, fp, ip }) {
  const ban = (deviceId && cache.devices.get(deviceId)) || (fp && ip && cache.prints.get(`${fp}|${ip}`)) || null;
  return ban && new Date(ban.until).getTime() > Date.now() ? ban : null;
}

/** Sperre eines Kontos als { until, reason } oder null */
const userBan = (user) => (logic.isBanned(user) ? { until: user.bannedUntil, reason: user.banReason || '' } : null);

/** Text für gesperrte Nutzer – bewusst ohne Hinweis, ob das Konto oder das Gerät gesperrt ist */
function banMessage(ban, date) {
  const until = logic.isForever(ban.until) ? 'dauerhaft' : `bis ${date(ban.until)}`;
  return `Der Zugang ist gesperrt (${until}).${ban.reason ? ` Grund: ${ban.reason}` : ''}`;
}

async function ban({ userId, hours, reason, admin, adminUsernames = [] }) {
  const until = logic.banUntil(hours);
  if (!until) throw new UserError(`Bitte die Dauer in ganzen Stunden angeben (0 = dauerhaft, höchstens ${logic.MAX_BAN_HOURS}).`);
  const user = await User.findOne({ _id: userId, deletedAt: null }).select('username usernameLower role bannedUntil bannedBy bannedByName bannedAt banReason banHistory').lean();
  if (!user) throw new UserError('Bitte ein Mitglied auswählen.');
  // Wer wen wie lange bannen darf (Admin oder Dev), steht in deviceLogic.banError
  const error = logic.banError(admin, { ...user, isAdmin: adminUsernames.includes(user.usernameLower) }, hours);
  if (error) throw new UserError(error);
  const now = new Date();
  const text = String(reason || '').trim().slice(0, 200);
  // Liste aller Bans: ein noch laufender wird durch den neuen ersetzt (als beendet vermerkt)
  const history = logic.closeOpenBans(logic.banHistory(user), now);
  await User.updateOne(
    { _id: user._id },
    {
      $set: { bannedUntil: until, banReason: text, bannedAt: now, bannedByName: admin.username, bannedBy: admin._id, banHistory: [...history, { at: now, until, byName: admin.username, reason: text, liftedAt: null }] },
    }
  );
  await reload();
  return { username: user.username, until };
}

/**
 * Ban aufheben (Admin jeden, Devs nur ihre eigenen). Wer wann und warum gebannt hat, bleibt stehen –
 * das Profil zeigt den Vermerk weiterhin.
 */
async function unban(userId, actor) {
  const target = await User.findById(userId).select('username bannedBy bannedByName bannedAt bannedUntil banReason banHistory').lean();
  if (!target) return null;
  const error = logic.unbanError(actor, target);
  if (error) throw new UserError(error);
  const history = logic.closeOpenBans(logic.banHistory(target), new Date()); // in der Liste als vorzeitig aufgehoben vermerken
  const user = await User.findOneAndUpdate({ _id: userId }, { $set: { bannedUntil: null, banHistory: history } }).select('username').lean();
  await reload();
  return user;
}

/** Aktuell gesperrte Konten samt Zahl ihrer bekannten Geräte */
async function listBans() {
  const users = await User.find({ bannedUntil: { $gt: new Date() }, deletedAt: null }).select('username bannedUntil banReason bannedAt bannedByName bannedBy').sort({ bannedAt: -1 }).lean();
  const counts = await Promise.all(users.map((u) => Device.countDocuments({ user: u._id })));
  return users.map((u, i) => ({ ...u, devices: counts[i], forever: logic.isForever(u.bannedUntil) }));
}

/** Konto gelöscht: Geräte und Hinweise entfernen */
async function forgetUser(userId) {
  await Promise.all([Device.deleteMany({ user: userId }), DeviceAlert.deleteMany({ users: userId })]);
}

module.exports = { recomputeAlerts, flaggedPairs, tradePairKey, tradeFilterForPairs, suspiciousTradeCount, record, alertCount, listAlerts, setAlertDone, ensureFresh, blockedDevice, userBan, banMessage, ban, unban, listBans, forgetUser };

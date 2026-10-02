// Geräte-Erkennung: merkt sich, mit welchen Geräten ein Konto benutzt wird, meldet dem Admin Konten,
// die sich ein Gerät teilen, und setzt Sperren durch (Konto und alle seine Geräte).
const User = require('../models/User');
const { Device, DeviceAlert } = require('../models/Device');
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

/** Andere Konten mit demselben Gerät suchen und Hinweise anlegen bzw. hochstufen */
async function checkMatches(dev) {
  const or = [{ deviceId: dev.deviceId }];
  if (dev.fp) or.push({ fp: dev.fp });
  const others = await Device.find({ user: { $ne: dev.user }, $or: or }).lean();
  const best = new Map(); // anderes Konto -> stärkster Treffer
  for (const o of others) {
    const level = logic.matchLevel(dev, o);
    const id = String(o.user);
    if (level > (best.get(id) || 0)) best.set(id, level);
  }
  for (const [other, level] of best) {
    const key = logic.pairKey(dev.user, other);
    const alert = await DeviceAlert.findOne({ key });
    if (!alert) {
      await DeviceAlert.create({ key, users: [dev.user, other], level }).catch((err) => {
        if (!err || err.code !== 11000) throw err;
      });
    } else if (level > alert.level) {
      // stärkerer Treffer als bisher: wieder als neu anzeigen
      alert.level = level;
      alert.doneAt = null;
      await alert.save();
    }
  }
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
          const level = logic.matchLevel(x, y);
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
  const banned = await User.find({ bannedUntil: { $gt: new Date() }, deletedAt: null }).select('bannedUntil banReason').lean();
  const devices = new Map();
  const prints = new Map();
  if (banned.length) {
    const info = new Map(banned.map((u) => [String(u._id), { until: u.bannedUntil, reason: u.banReason || '' }]));
    const devs = await Device.find({ user: { $in: banned.map((u) => u._id) } }).select('user deviceId fp ips').lean();
    for (const d of devs) {
      const ban = info.get(String(d.user));
      devices.set(d.deviceId, ban);
      // ohne Cookie zählt der Fingerabdruck nur zusammen mit derselben IP – sonst träfe es baugleiche Geräte
      if (d.fp) for (const ip of d.ips) prints.set(`${d.fp}|${ip}`, ban);
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

async function ban({ userId, duration, reason, admin, adminUsernames = [] }) {
  const until = logic.banUntil(duration);
  if (!until) throw new UserError('Bitte eine Dauer auswählen.');
  const user = await User.findOne({ _id: userId, deletedAt: null }).select('username usernameLower');
  if (!user) throw new UserError('Bitte ein Mitglied auswählen.');
  if (adminUsernames.includes(user.usernameLower)) throw new UserError('Der Admin kann nicht gesperrt werden.');
  await User.updateOne({ _id: user._id }, { $set: { bannedUntil: until, banReason: String(reason || '').trim().slice(0, 200), bannedAt: new Date(), bannedByName: admin.username } });
  await reload();
  return { username: user.username, until };
}

async function unban(userId) {
  const user = await User.findOneAndUpdate({ _id: userId }, { $set: { bannedUntil: null, banReason: '', bannedAt: null, bannedByName: null } }).select('username').lean();
  await reload();
  return user;
}

/** Aktuell gesperrte Konten samt Zahl ihrer bekannten Geräte */
async function listBans() {
  const users = await User.find({ bannedUntil: { $gt: new Date() }, deletedAt: null }).select('username bannedUntil banReason bannedAt bannedByName').sort({ bannedAt: -1 }).lean();
  const counts = await Promise.all(users.map((u) => Device.countDocuments({ user: u._id })));
  return users.map((u, i) => ({ ...u, devices: counts[i], forever: logic.isForever(u.bannedUntil) }));
}

/** Konto gelöscht: Geräte und Hinweise entfernen */
async function forgetUser(userId) {
  await Promise.all([Device.deleteMany({ user: userId }), DeviceAlert.deleteMany({ users: userId })]);
}

module.exports = { record, alertCount, listAlerts, setAlertDone, ensureFresh, blockedDevice, userBan, banMessage, ban, unban, listBans, forgetUser };

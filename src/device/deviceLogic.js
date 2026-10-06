// Reine Hilfsfunktionen der Geräte-Erkennung (ohne Datenbank, damit sie sich einfach testen lassen)
const crypto = require('crypto');

const COOKIE = 'bfw.geraet';
const LEVEL = { sicher: 3, wahrscheinlich: 2, moeglich: 1 };
const LEVEL_LABEL = { 3: 'Sicher', 2: 'Wahrscheinlich', 1: 'Möglich' };
// "dauerhaft" = ein Datum weit in der Zukunft, damit überall derselbe Vergleich (bannedUntil > jetzt) reicht
const FOREVER = new Date('9999-12-31T00:00:00Z');
const MAX_BAN_HOURS = 87600; // 10 Jahre

const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');

/** Neue Geräte-Kennung samt Signatur: "<id>.<signatur>" */
function newToken(secret) {
  const id = crypto.randomBytes(16).toString('hex');
  return `${id}.${hmac(secret, `geraet:${id}`).slice(0, 16)}`;
}

/** Geräte-Kennung aus dem Cookie-Wert; null, wenn sie nicht von uns stammt */
function readToken(secret, token) {
  const m = /^([0-9a-f]{32})\.([0-9a-f]{16})$/.exec(typeof token === 'string' ? token : '');
  if (!m) return null;
  const a = Buffer.from(m[2]);
  const b = Buffer.from(hmac(secret, `geraet:${m[1]}`).slice(0, 16));
  return crypto.timingSafeEqual(a, b) ? m[1] : null;
}

/** Einzelnes Cookie aus dem Cookie-Header lesen */
function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** IP-Adressen werden nur als Hash gespeichert */
const ipHash = (secret, ip) => (ip ? hmac(secret, `ip:${ip}`).slice(0, 20) : null);

/** Vom Browser gemeldeter Fingerabdruck: nur Hex-Hashes annehmen */
const cleanFp = (value) => (typeof value === 'string' && /^[0-9a-f]{16,64}$/.test(value) ? value : null);

/** "Chrome · Windows" aus dem User-Agent – nur für die Anzeige im Admin-Panel */
function uaLabel(ua) {
  const s = String(ua || '');
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /Firefox\/|FxiOS/.test(s) ? 'Firefox' : /Chrome\/|CriOS/.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Browser';
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : 'unbekannt';
  return `${browser} · ${os}`;
}

/** Schlüssel für ein Konten-Paar – unabhängig von der Reihenfolge */
const pairKey = (a, b) => [String(a), String(b)].sort().join(':');

// Ab so vielen Konten mit demselben Fingerabdruck im selben Netz (gleiche IP) ist das kein Hinweis auf eine Person,
// sondern auf viele baugleiche Geräte im selben WLAN (#89)
const CROWD = 3;
// Ab so vielen Konten an derselben IP ist das ein geteiltes Netz (Schule, Firma, öffentliches WLAN): dort sagt die
// gemeinsame IP nichts über die Person aus – auch nicht bei zwei baugleichen Handys derselben Klasse
const NET_CROWD = 5;
// Kleine Überschneidung zweier Geräte-Einträge (z. B. Cookie gelöscht und gleich neu angemeldet) gilt nicht als gleichzeitig
const PARALLEL_SLACK_MS = 60 * 60 * 1000;

const printKey = (fp, ip) => `${fp}|${ip}`;

/** fp|ip-Kombinationen, die mindestens min verschiedene Konten benutzt haben (devices: [{ user, fp, ips }]) */
function commonPrints(devices, min = CROWD) {
  const users = new Map();
  for (const d of devices) {
    if (!d.fp) continue;
    for (const ip of d.ips || []) {
      const k = printKey(d.fp, ip);
      if (!users.has(k)) users.set(k, new Set());
      users.get(k).add(String(d.user));
    }
  }
  return new Set([...users].filter(([, u]) => u.size >= min).map(([k]) => k));
}

const netKey = (ip) => `net:${ip}`;

/** IPs, die mindestens min verschiedene Konten benutzt haben, als Set von netKey (devices: [{ user, ips }]) */
function crowdedNets(devices, min = NET_CROWD) {
  const users = new Map();
  for (const d of devices) {
    for (const ip of d.ips || []) {
      if (!users.has(ip)) users.set(ip, new Set());
      users.get(ip).add(String(d.user));
    }
  }
  return new Set([...users].filter(([, u]) => u.size >= min).map(([ip]) => netKey(ip)));
}

/** Wurden zwei Geräte-Einträge gleichzeitig benutzt (Zeiträume überschneiden sich deutlich)? Ohne Zeiten: nein */
function usedInParallel(a, b) {
  if (!a.firstAt || !a.lastAt || !b.firstAt || !b.lastAt) return false;
  const start = Math.max(new Date(a.firstAt).getTime(), new Date(b.firstAt).getTime());
  const end = Math.min(new Date(a.lastAt).getTime(), new Date(b.lastAt).getTime());
  return end - start > PARALLEL_SLACK_MS;
}

/**
 * Wie sicher ist es, dass zwei Geräte-Einträge dasselbe Gerät sind?
 * Gleiches Cookie = sicher. Gleicher Fingerabdruck und gleiche IP = wahrscheinlich – aber nur, wenn die beiden
 * Einträge nacheinander benutzt wurden (typisch: Cookie gelöscht, neues Konto) und die Kombination nicht von vielen
 * Konten stammt. Laufen beide parallel, ist es nur möglich (z. B. Geschwister mit demselben Handymodell, #89).
 * Ohne eine solche gemeinsame IP ist der Fingerabdruck allein kein Beleg: baugleiche Geräte (Schul-PCs mit demselben
 * Image, dasselbe Handymodell) haben denselben. Das gilt auch für fp|ip-Kombinationen vieler Konten (#89) und für
 * IPs, die viele Konten benutzen (Schulnetz) – dann gibt es keinen Hinweis.
 * common = Set aus commonPrints() und crowdedNets().
 */
function matchLevel(a, b, common = new Set()) {
  if (a.deviceId && a.deviceId === b.deviceId) return LEVEL.sicher;
  if (!a.fp || a.fp !== b.fp) return 0;
  const shared = (a.ips || []).filter((ip) => (b.ips || []).includes(ip) && !common.has(printKey(a.fp, ip)) && !common.has(netKey(ip)));
  if (!shared.length) return 0;
  return usedInParallel(a, b) ? LEVEL.moeglich : LEVEL.wahrscheinlich;
}

/** Stärkster Treffer zwischen den Geräten zweier Konten (0 = keiner) */
function pairLevel(devsA, devsB, common = new Set()) {
  let best = 0;
  for (const a of devsA) for (const b of devsB) best = Math.max(best, matchLevel(a, b, common));
  return best;
}

/** Ende eines Bans aus der Dauer in Stunden ("0" = dauerhaft); null bei ungültiger Eingabe */
function banUntil(hours, now = Date.now()) {
  const text = typeof hours === 'number' ? String(hours) : typeof hours === 'string' ? hours.trim() : '';
  if (!/^\d{1,5}$/.test(text)) return null;
  const h = Number(text);
  if (h > MAX_BAN_HOURS) return null;
  return h === 0 ? FOREVER : new Date(now + h * 60 * 60 * 1000);
}

const isForever = (date) => !!date && new Date(date).getTime() >= FOREVER.getTime();
const isBanned = (user, now = Date.now()) => !!(user && user.bannedUntil && new Date(user.bannedUntil).getTime() > now);

// Devs dürfen befristet bannen (höchstens 7 Tage); dauerhafte Bans vergibt nur der Admin
const DEV_MAX_BAN_HOURS = 168;

/**
 * Darf actor das Mitglied target für hours Stunden bannen? Gibt die Fehlermeldung zurück oder null.
 * actor: { _id, isAdmin }, target: { _id, username, isAdmin, role, bannedUntil, bannedBy, bannedByName }
 * Der Admin bannt jeden außer Admins. Devs bannen höchstens DEV_MAX_BAN_HOURS, keine Devs und keinen Admin,
 * und überschreiben keinen laufenden Ban, den jemand anderes vergeben hat.
 */
function banError(actor, target, hours, now = Date.now()) {
  if (target.isAdmin) return 'Der Admin kann nicht gebannt werden.';
  if (String(target._id) === String(actor._id)) return 'Du kannst dich nicht selbst bannen.';
  if (actor.isAdmin) return null;
  if (target.role === 'dev') return 'Devs können keine anderen Devs bannen – das kann nur der Admin.';
  const h = Number(String(hours).trim());
  if (!Number.isInteger(h) || h < 1 || h > DEV_MAX_BAN_HOURS) return `Devs können für 1 bis ${DEV_MAX_BAN_HOURS} Stunden (7 Tage) bannen. Dauerhafte Bans vergibt der Admin.`;
  if (isBanned(target, now) && String(target.bannedBy) !== String(actor._id)) {
    return `${target.username} ist bereits von ${target.bannedByName || 'jemand anderem'} gebannt – das kann nur der Admin ändern.`;
  }
  return null;
}

/** Darf actor den Ban von target aufheben? Admin immer, Devs nur ihre eigenen Bans. Fehlermeldung oder null. */
function unbanError(actor, target) {
  if (actor.isAdmin || String(target.bannedBy) === String(actor._id)) return null;
  return `Diesen Ban hat ${target.bannedByName || 'jemand anderes'} vergeben – aufheben kann ihn nur der Admin oder wer ihn vergeben hat.`;
}

/**
 * Alle Bans eines Kontos, älteste zuerst. Ohne Liste (Bans von vor 2026-10-04) nur der letzte aus den Einzelfeldern;
 * wurde der aufgehoben, ist until null (wann genau, ist nicht bekannt).
 */
function banHistory(user) {
  if (!user) return [];
  const clean = (b) => ({ at: b.at || null, until: b.until || null, byName: b.byName || null, reason: b.reason || '', liftedAt: b.liftedAt || null });
  if (Array.isArray(user.banHistory) && user.banHistory.length) return user.banHistory.map(clean);
  if (!user.bannedAt) return [];
  return [clean({ at: user.bannedAt, until: user.bannedUntil, byName: user.bannedByName, reason: user.banReason })];
}

/** Noch laufende Bans der Liste als beendet vermerken (Aufhebung oder Ersatz durch einen neuen Ban) */
const closeOpenBans = (list, now = new Date()) => list.map((b) => (!b.liftedAt && b.until && new Date(b.until) > now ? { ...b, liftedAt: now } : b));

/** Geplante Dauer eines Bans als Text, z. B. "5 Stunden", "2 Tage 3 Stunden", "dauerhaft" */
function banDurationText(from, to) {
  if (isForever(to)) return 'dauerhaft';
  const h = Math.max(1, Math.round((new Date(to) - new Date(from)) / 3600000));
  if (h < 24) return `${h} ${h === 1 ? 'Stunde' : 'Stunden'}`;
  const d = Math.floor(h / 24);
  const r = h % 24;
  return `${d} ${d === 1 ? 'Tag' : 'Tage'}${r ? ` ${r} ${r === 1 ? 'Stunde' : 'Stunden'}` : ''}`;
}

/** Bans fürs Profil, neueste zuerst: { at, duration, state: 'aktiv' | 'abgelaufen' | 'aufgehoben', until, liftedAt, byName, reason } */
function banTimeline(user, now = Date.now()) {
  return banHistory(user)
    .map((b) => ({
      ...b,
      duration: b.until ? banDurationText(b.at, b.until) : null,
      state: b.liftedAt || !b.until ? 'aufgehoben' : new Date(b.until).getTime() > now ? 'aktiv' : 'abgelaufen',
    }))
    .sort((x, y) => new Date(y.at) - new Date(x.at));
}

module.exports = { CROWD, NET_CROWD, printKey, netKey, commonPrints, crowdedNets, usedInParallel, pairLevel, banHistory, closeOpenBans, banDurationText, banTimeline, COOKIE, LEVEL, LEVEL_LABEL, MAX_BAN_HOURS, DEV_MAX_BAN_HOURS, banError, unbanError, FOREVER, newToken, readToken, cookieValue, ipHash, cleanFp, uaLabel, pairKey, matchLevel, banUntil, isForever, isBanned };

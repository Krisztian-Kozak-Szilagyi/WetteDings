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

/**
 * Wie sicher ist es, dass zwei Geräte-Einträge dasselbe Gerät sind?
 * Gleiches Cookie = sicher. Gleicher Fingerabdruck = wahrscheinlich, wenn auch eine IP übereinstimmt, sonst nur
 * möglich (baugleiche Geräte, z. B. Schulrechner oder dasselbe Handymodell, haben oft denselben Fingerabdruck).
 */
function matchLevel(a, b) {
  if (a.deviceId && a.deviceId === b.deviceId) return LEVEL.sicher;
  if (a.fp && a.fp === b.fp) return (a.ips || []).some((ip) => (b.ips || []).includes(ip)) ? LEVEL.wahrscheinlich : LEVEL.moeglich;
  return 0;
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

module.exports = { COOKIE, LEVEL, LEVEL_LABEL, MAX_BAN_HOURS, DEV_MAX_BAN_HOURS, banError, unbanError, FOREVER, newToken, readToken, cookieValue, ipHash, cleanFp, uaLabel, pairKey, matchLevel, banUntil, isForever, isBanned };

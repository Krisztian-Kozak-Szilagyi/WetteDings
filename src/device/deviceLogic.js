// Reine Hilfsfunktionen der Geräte-Erkennung (ohne Datenbank, damit sie sich einfach testen lassen)
const crypto = require('crypto');

const COOKIE = 'bfw.geraet';
const LEVEL = { sicher: 3, wahrscheinlich: 2, moeglich: 1 };
const LEVEL_LABEL = { 3: 'Sicher', 2: 'Wahrscheinlich', 1: 'Möglich' };
const DAY = 24 * 60 * 60 * 1000;
// "dauerhaft" = ein Datum weit in der Zukunft, damit überall derselbe Vergleich (bannedUntil > jetzt) reicht
const FOREVER = new Date('9999-12-31T00:00:00Z');
const BAN_DURATIONS = [
  { key: '1', label: '1 Tag', days: 1 },
  { key: '3', label: '3 Tage', days: 3 },
  { key: '7', label: '7 Tage', days: 7 },
  { key: '30', label: '30 Tage', days: 30 },
  { key: 'immer', label: 'Dauerhaft', days: null },
];

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

/** Ende einer Sperre aus der gewählten Dauer; null bei ungültiger Auswahl */
function banUntil(key, now = Date.now()) {
  const d = BAN_DURATIONS.find((x) => x.key === key);
  if (!d) return null;
  return d.days === null ? FOREVER : new Date(now + d.days * DAY);
}

const isForever = (date) => !!date && new Date(date).getTime() >= FOREVER.getTime();
const isBanned = (user, now = Date.now()) => !!(user && user.bannedUntil && new Date(user.bannedUntil).getTime() > now);

module.exports = { COOKIE, LEVEL, LEVEL_LABEL, BAN_DURATIONS, FOREVER, newToken, readToken, cookieValue, ipHash, cleanFp, uaLabel, pairKey, matchLevel, banUntil, isForever, isBanned };

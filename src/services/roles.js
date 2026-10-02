// Rollen: Admin (eine Person, über ADMIN_USERNAMES) und Devs (vom Admin im Panel ernannt, Feld "role" am Nutzer).
// Devs dürfen Patchnotes schreiben, alle Wetten entscheiden/annullieren und Booster Packs vergeben.
// Für die Zusätze neben Namen (echter Name in Klammern, DEV-Abzeichen) gibt es ein kleines Verzeichnis im
// Speicher (Name → Rolle / echter Name), damit Listen mit gespeicherten Namen (Kommentare, Wetten, …)
// ohne Datenbankabfrage auskommen.
const config = require('../config');
const User = require('../models/User');

const devs = new Set(); // usernameLower aller Devs
const realNames = new Map(); // usernameLower → echter Name (freiwillige Angabe)

async function load() {
  devs.clear();
  realNames.clear();
  const users = await User.find({ deletedAt: null, $or: [{ role: 'dev' }, { realName: { $nin: [null, ''] } }] }).select('usernameLower role realName').lean();
  for (const u of users) {
    if (u.role === 'dev') devs.add(u.usernameLower);
    if (u.realName) realNames.set(u.usernameLower, u.realName);
  }
}

/** 'admin' | 'dev' | null für einen Benutzernamen */
function roleOf(username) {
  const lower = String(username || '').toLowerCase();
  if (config.adminUsernames.includes(lower)) return 'admin';
  return devs.has(lower) ? 'dev' : null;
}

/** Dev-Rolle vergeben oder entziehen */
async function setDev(userId, on) {
  await User.updateOne({ _id: userId }, { $set: { role: on ? 'dev' : null } });
  await load();
}

const REAL_NAME_MAX = 40;
// Buchstaben (auch Umlaute/Akzente), Leerzeichen, Bindestrich, Apostroph, Punkt
const REAL_NAME_PATTERN = /^[\p{L}][\p{L} .'’-]*$/u;

/** Echten Namen setzen (leer = entfernen). Gibt den gespeicherten Namen zurück oder null. */
async function setRealName(userId, value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (name && (name.length < 2 || name.length > REAL_NAME_MAX || !REAL_NAME_PATTERN.test(name))) return false;
  await User.updateOne({ _id: userId }, { $set: { realName: name || null } });
  await load();
  return name || null;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Zusatz hinter einem Benutzernamen (fertiges HTML): echter Name in Klammern (falls angegeben) und das
 * DEV-Abzeichen – grün für Devs, rot für den Admin (beide als "DEV" markiert).
 */
function roleBadge(username) {
  const lower = String(username || '').toLowerCase();
  const real = realNames.get(lower);
  const role = roleOf(username);
  let out = '';
  if (real) out += ` <span class="real-name">(${esc(real)})</span>`;
  if (role) {
    const title = role === 'admin' ? 'Admin & Dev' : 'Dev';
    out += ` <span class="role-badge role-${role}" data-text="DEV" title="${title}" aria-label="${title}">DEV</span>`;
  }
  return out;
}

/**
 * Benutzername als Link zum Profil samt Zusätzen (echter Name, DEV-Abzeichen) – fertiges HTML.
 * nested = true: innerhalb eines anderen Links (z. B. Wett-Karte) – dort ist ein <a> nicht erlaubt,
 * deshalb ein <span>, den app.js anklickbar macht. Gelöschte Konten haben kein Profil.
 */
function userLink(username, { nested = false } = {}) {
  const name = String(username || '');
  if (!name) return '';
  const extra = roleBadge(name);
  if (/^geloescht-/i.test(name)) return esc(name);
  const href = `/profil/${encodeURIComponent(name)}`;
  return nested
    ? `<span class="user-link" data-user-link="${href}" role="link" tabindex="0">${esc(name)}</span>${extra}`
    : `<a class="user-link" href="${href}">${esc(name)}</a>${extra}`;
}

module.exports = { REAL_NAME_MAX, load, roleOf, setDev, setRealName, roleBadge, userLink };

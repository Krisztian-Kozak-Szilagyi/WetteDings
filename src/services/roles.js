// Rollen: Admin (eine Person, über ADMIN_USERNAMES), Devs und Mods (vom Admin im Panel ernannt, Feld "role").
//  Dev: schreibt im Team-Bereich des Forums, entscheidet/annulliert alle Wetten, vergibt Booster Packs, moderiert.
//  Mod: moderiert das Forum und Kommentare (löschen, bearbeiten, anpinnen, schließen) – sonst nichts.
// Für die Zusätze neben Namen (echter Name in Klammern, Abzeichen) gibt es ein kleines Verzeichnis im
// Speicher (Name → Rolle / echter Name), damit Listen mit gespeicherten Namen (Kommentare, Wetten, …)
// ohne Datenbankabfrage auskommen.
const config = require('../config');
const User = require('../models/User');

const ASSIGNABLE = ['dev', 'mod']; // Rollen, die der Admin vergeben kann
const byRole = { dev: new Set(), mod: new Set() }; // usernameLower je Rolle
const realNames = new Map(); // usernameLower → echter Name (freiwillige Angabe)

async function load() {
  byRole.dev.clear();
  byRole.mod.clear();
  realNames.clear();
  const users = await User.find({ deletedAt: null, $or: [{ role: { $in: ASSIGNABLE } }, { realName: { $nin: [null, ''] } }] }).select('usernameLower role realName').lean();
  for (const u of users) {
    if (byRole[u.role]) byRole[u.role].add(u.usernameLower);
    if (u.realName) realNames.set(u.usernameLower, u.realName);
  }
}

/** 'admin' | 'dev' | 'mod' | null für einen Benutzernamen */
function roleOf(username) {
  const lower = String(username || '').toLowerCase();
  if (config.adminUsernames.includes(lower)) return 'admin';
  if (byRole.dev.has(lower)) return 'dev';
  return byRole.mod.has(lower) ? 'mod' : null;
}

/** Rolle vergeben ('dev' | 'mod') oder entziehen (null) */
async function setRole(userId, role) {
  await User.updateOne({ _id: userId }, { $set: { role: ASSIGNABLE.includes(role) ? role : null } });
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

// Abzeichen: Admin rot und Dev grün (beide "DEV"), Mod orange ("MOD")
const BADGE = { admin: { text: 'DEV', title: 'Admin & Dev' }, dev: { text: 'DEV', title: 'Dev' }, mod: { text: 'MOD', title: 'Moderator' } };

/**
 * Zusatz hinter einem Benutzernamen (fertiges HTML): echter Name in Klammern (falls angegeben) und das Rollen-Abzeichen.
 * realName = false: ohne echten Namen (Admin-Panel und Logs).
 */
function roleBadge(username, { realName = true } = {}) {
  const lower = String(username || '').toLowerCase();
  const real = realNames.get(lower);
  const role = roleOf(username);
  let out = '';
  if (real && realName) out += ` <span class="real-name">(${esc(real)})</span>`;
  if (role) {
    const b = BADGE[role];
    out += ` <span class="role-badge role-${role}" data-text="${b.text}" title="${b.title}" aria-label="${b.title}">${b.text}</span>`;
  }
  return out;
}

/**
 * Benutzername als Link zum Profil samt Zusätzen (echter Name, Abzeichen) – fertiges HTML.
 * nested = true: innerhalb eines anderen Links (z. B. Wett-Karte) – dort ist ein <a> nicht erlaubt,
 * deshalb ein <span>, den app.js anklickbar macht. Gelöschte Konten haben kein Profil.
 * realName = false: ohne echten Namen (Admin-Panel und Logs).
 */
function userLink(username, { nested = false, realName = true } = {}) {
  const name = String(username || '');
  if (!name) return '';
  const extra = roleBadge(name, { realName });
  if (/^geloescht-/i.test(name)) return esc(name);
  const href = `/profil/${encodeURIComponent(name)}`;
  return nested
    ? `<span class="user-link" data-user-link="${href}" role="link" tabindex="0">${esc(name)}</span>${extra}`
    : `<a class="user-link" href="${href}">${esc(name)}</a>${extra}`;
}

module.exports = { REAL_NAME_MAX, ASSIGNABLE, load, roleOf, setRole, setRealName, roleBadge, userLink };

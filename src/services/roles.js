// Rollen: Admin (eine Person, über ADMIN_USERNAMES) und Devs (vom Admin im Panel ernannt, Feld "role" am Nutzer).
// Devs dürfen Patchnotes schreiben, alle Wetten entscheiden/annullieren und Booster Packs vergeben.
// Für das Abzeichen neben Namen gibt es ein kleines Verzeichnis im Speicher (Name → Rolle), damit Listen
// mit gespeicherten Namen (Kommentare, Wetten, …) ohne Datenbankabfrage auskommen.
const config = require('../config');
const User = require('../models/User');

const devs = new Set(); // usernameLower aller Devs

async function load() {
  devs.clear();
  for (const u of await User.find({ role: 'dev', deletedAt: null }).select('usernameLower').lean()) devs.add(u.usernameLower);
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

/** Abzeichen neben einem Namen (fertiges HTML): grün für Devs, rot für den Admin – beide als "DEV" markiert */
function roleBadge(username) {
  const role = roleOf(username);
  if (!role) return '';
  const title = role === 'admin' ? 'Admin & Dev' : 'Dev';
  return ` <span class="role-badge role-${role}" data-text="DEV" title="${title}" aria-label="${title}">DEV</span>`;
}

module.exports = { load, roleOf, setDev, roleBadge };

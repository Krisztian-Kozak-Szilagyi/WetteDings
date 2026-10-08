// Passwort zurücksetzen durch den Admin: Er erzeugt für ein Mitglied einen Einmal-Code. Mit dem Code meldet sich das
// Mitglied einmal an und muss sofort ein neues Passwort wählen. Gespeichert wird nur der Hash des Codes (User.resetHash);
// das bisherige Passwort gilt weiter, bis ein neues gesetzt ist (niemand wird durch einen Fehlklick ausgesperrt).
const crypto = require('crypto');

// Ohne leicht verwechselbare Zeichen (0/O, 1/I/L) – wie bei den Einladungscodes
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;
const VALID_MS = 24 * 60 * 60 * 1000;

// Solange das neue Passwort fehlt, sind nur diese Adressen erlaubt
const CHANGE_PATH = '/passwort-neu';
const ALLOWED_PATHS = [CHANGE_PATH, '/abmelden', '/geraet'];

/** Zufälliger Code; randInt(n) liefert eine Zahl 0…n-1 (für Tests austauschbar) */
function makeCode(randInt = crypto.randomInt) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[randInt(ALPHABET.length)];
  return out;
}

/** " abcd-efgh-jkmn " -> "ABCDEFGHJKMN" */
const normalizeCode = (input) => String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "ABCDEFGHJKMN" -> "ABCD-EFGH-JKMN" */
const formatCode = (code) => code.match(/.{1,4}/g).join('-');

/** Kommt die Eingabe überhaupt als Code in Frage? (spart den Hash-Vergleich bei normalen Passwörtern) */
const looksLikeCode = (input) => normalizeCode(input).length === CODE_LENGTH;

/** Hat das Mitglied einen gültigen, noch nicht benutzten Code? */
const hasValidCode = (user, now = new Date()) => !!(user && user.resetHash && user.resetExpires && user.resetExpires > now);

/** Darf diese Adresse aufgerufen werden, solange das neue Passwort fehlt? */
const allowedWhileForced = (path) => ALLOWED_PATHS.includes(path);

module.exports = { CODE_LENGTH, VALID_MS, CHANGE_PATH, makeCode, normalizeCode, formatCode, looksLikeCode, hasValidCode, allowedWhileForced };

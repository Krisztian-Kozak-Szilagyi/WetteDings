// Regeln für Benutzernamen – gelten gleichermaßen bei der Registrierung und beim Umbenennen.
// Reine Regeln ohne Datenbank, damit beide Wege nicht wieder auseinanderlaufen.
const config = require('../config');
const { UserError, str } = require('../lib/util');

const NAME_PATTERN = /^[A-Za-z0-9_.-]{3,20}$/;
const NAME_HINT = 'Der Benutzername muss 3–20 Zeichen lang sein (Buchstaben, Zahlen, _ . -).';
const DELETED_PREFIX = /^geloescht-/;
const RESERVED_HINT = 'Dieser Benutzername ist nicht verfügbar.';

/**
 * Für Mitglieder gesperrte Namen: An ADMIN_USERNAMES hängen die Admin-Rechte (wer sich so nennen
 * dürfte, wäre Admin), und "geloescht-…" würde ein gelöschtes Konto vortäuschen.
 */
const isReserved = (username) => {
  const lower = str(username).trim().toLowerCase();
  return !!lower && (config.adminUsernames.includes(lower) || DELETED_PREFIX.test(lower));
};

/**
 * Prüft Muster und Sperrliste. Wirft UserError, gibt sonst den getrimmten Namen zurück.
 * Nur echte Strings werden akzeptiert – ein doppeltes Formularfeld liefert ein Array (siehe lib/util).
 */
function assertUsernameAllowed(username) {
  const name = str(username).trim();
  if (!NAME_PATTERN.test(name)) throw new UserError(NAME_HINT);
  if (isReserved(name)) throw new UserError(RESERVED_HINT);
  return name;
}

module.exports = { NAME_PATTERN, NAME_HINT, RESERVED_HINT, isReserved, assertUsernameAllowed };

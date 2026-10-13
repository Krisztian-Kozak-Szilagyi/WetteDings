// Chat: reine Logik ohne Datenbank (getestet in test/chat.test.js).
// Ein Gespräch hat einen Schlüssel: "dm:<kleinere Id>:<größere Id>" (zwei Mitglieder) oder "team:<Team-Id>" (eSports-Team).

const TEXT_MAX = 1000; // Zeichen pro Nachricht
const PAGE = 40; // Nachrichten pro Abruf
const KEEP_DAYS = 180; // danach löscht die Datenbank Nachrichten, Gesprächslisten und Meldungen von selbst
const REASON_MAX = 300;
const CONTEXT_BEFORE = 5; // so viele Nachrichten vor der gemeldeten sieht das Team

const ID = /^[0-9a-f]{24}$/;

/** Schlüssel des Gesprächs zwischen zwei Mitgliedern – unabhängig von der Reihenfolge */
function dmKey(a, b) {
  const [x, y] = [String(a), String(b)].sort();
  return `dm:${x}:${y}`;
}

const teamKey = (teamId) => `team:${teamId}`;

/** Schlüssel zerlegen: { kind: 'dm', ids: [a, b] } | { kind: 'team', id } | null (ungültig) */
function parseKey(key) {
  const parts = String(key || '').split(':');
  if (parts[0] === 'dm' && parts.length === 3 && ID.test(parts[1]) && ID.test(parts[2]) && parts[1] < parts[2]) return { kind: 'dm', ids: [parts[1], parts[2]] };
  if (parts[0] === 'team' && parts.length === 2 && ID.test(parts[1])) return { kind: 'team', id: parts[1] };
  return null;
}

/** Gesprächspartner in einem Zweier-Gespräch (oder null, wenn man nicht dazugehört) */
function partnerOf(parsed, userId) {
  if (!parsed || parsed.kind !== 'dm') return null;
  const me = String(userId);
  if (parsed.ids[0] === me) return parsed.ids[1];
  if (parsed.ids[1] === me) return parsed.ids[0];
  return null;
}

/** Text säubern: Steuerzeichen raus, höchstens zwei Leerzeilen am Stück, gekürzt */
function cleanText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, TEXT_MAX)
    .trim();
}

/** Kurzer Vorschautext für die Gesprächsliste (eine Zeile) */
const preview = (text, max = 80) => {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Ist einer der beiden vom anderen blockiert? (Listen als Strings oder ObjectIds) */
function blockedBetween(a, aBlocks, b, bBlocks) {
  const has = (list, id) => (list || []).some((x) => String(x) === String(id));
  return has(aBlocks, b) || has(bBlocks, a);
}

/**
 * Bremse pro Mitglied: höchstens eine Nachricht pro Sekunde und 30 pro Minute.
 * Gibt eine Fehlermeldung zurück oder null (dann ist die Nachricht gezählt).
 */
function createLimiter({ gapMs = 1000, perMinute = 30 } = {}) {
  const sent = new Map();
  return function check(userId, now = Date.now()) {
    const key = String(userId);
    const list = (sent.get(key) || []).filter((t) => now - t < 60000);
    if (list.length && now - list[list.length - 1] < gapMs) return 'Nicht so schnell.';
    if (list.length >= perMinute) return 'Zu viele Nachrichten – warte kurz.';
    list.push(now);
    sent.set(key, list);
    if (sent.size > 5000) for (const [k, v] of sent) if (!v.length || now - v[v.length - 1] > 60000) sent.delete(k);
    return null;
  };
}

/**
 * Änderungszähler pro Mitglied im Speicher: Der Browser fragt mit seinem Stand nach – ist er gleich,
 * antwortet der Server ohne Datenbankabfrage. Der Startwert ändert sich bei jedem Neustart, damit
 * kein Browser einen alten Stand für aktuell hält.
 */
function createVersions(base = Date.now()) {
  const map = new Map();
  return {
    get: (userId) => map.get(String(userId)) || base,
    bump(userIds) {
      for (const id of userIds) {
        const key = String(id);
        map.set(key, (map.get(key) || base) + 1);
      }
    },
  };
}

module.exports = { TEXT_MAX, PAGE, KEEP_DAYS, REASON_MAX, CONTEXT_BEFORE, dmKey, teamKey, parseKey, partnerOf, cleanText, preview, blockedBetween, createLimiter, createVersions };

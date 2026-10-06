// Manipulationserkennung, Stufe 1 (nur messen): Jede ausgelieferte Seite bekommt ein Aktions-Kennzeichen (Token),
// das für genau eine Spiel-Aktion gilt. Die Antwort auf eine Aktion liefert das nächste mit (Aktionen per fetch,
// z. B. "Nächstes Pack"). So wissen wir, ob vor einer Aktion wirklich eine Seite geladen wurde, und wie viel Zeit
// zwischen Auslieferung und Abschicken lag. Abgelehnt wird noch nichts – siehe requestSignals.js.
const crypto = require('crypto');
const config = require('../config');

const KEEP_MS = 6 * 60 * 60 * 1000; // so lange merken wir verbrauchte Tokens; ältere Tokens zählen als veraltet
const DOUBLE_MS = 2000; // dasselbe Token so kurz danach noch einmal: Doppelklick, kein Verdacht
const PRUNE_MS = 10 * 60 * 1000;

// Verbrauchte Tokens (Zufallsteil → Zeitpunkt). Die App läuft als ein Prozess (ecosystem.config.js); nach einem
// Neustart ist die Liste leer – dann fällt eine Wiederverwendung höchstens einmal nicht auf.
const used = new Map();
let lastPrune = 0;

const sign = (userId, t, n) => crypto.createHmac('sha256', config.sessionSecret).update(`aktion:${userId}:${t}:${n}`).digest('base64url').slice(0, 16);

/** Neues Token für ein Konto: "<Zeit>.<Zufall>.<Signatur>" */
function issue(userId, now = Date.now()) {
  const t = now.toString(36);
  const n = crypto.randomBytes(9).toString('base64url');
  return `${t}.${n}.${sign(String(userId), t, n)}`;
}

function prune(now) {
  if (now - lastPrune < PRUNE_MS) return;
  lastPrune = now;
  for (const [n, at] of used) if (now - at > KEEP_MS) used.delete(n);
}

/**
 * Token einer Aktion prüfen und als verbraucht merken.
 * Liefert { state, ageMs }: state = 'ok' | 'missing' | 'bad' (fremd/gefälscht) | 'stale' (zu alt) | 'reused' | 'double'.
 */
function check(token, userId, now = Date.now()) {
  prune(now);
  if (!token || typeof token !== 'string') return { state: 'missing', ageMs: null };
  const [t, n, sig] = token.split('.');
  if (!t || !n || !sig) return { state: 'bad', ageMs: null };
  const expected = sign(String(userId), t, n);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return { state: 'bad', ageMs: null };
  const ageMs = now - parseInt(t, 36);
  if (!Number.isFinite(ageMs) || ageMs < -60000) return { state: 'bad', ageMs: null };
  if (ageMs > KEEP_MS) return { state: 'stale', ageMs };
  const before = used.get(n);
  if (before !== undefined) return { state: now - before <= DOUBLE_MS ? 'double' : 'reused', ageMs };
  used.set(n, now);
  return { state: 'ok', ageMs: Math.max(0, ageMs) };
}

/** Eingabe-Zähler der Seite ("t3m42u0": echte Eingaben, Mausbewegungen, künstliche Klicks); null ohne Angabe */
function parseInput(value) {
  const m = /^t(\d{1,6})m(\d{1,7})u(\d{1,6})$/.exec(typeof value === 'string' ? value : '');
  return m ? { trusted: Number(m[1]), moves: Number(m[2]), synthetic: Number(m[3]) } : null;
}

module.exports = { issue, check, parseInput, KEEP_MS, DOUBLE_MS, _used: used };

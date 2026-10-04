// Umfragen in Forum-Themen: Eingabe prüfen, Ergebnis berechnen, wer wann abstimmen darf (ohne Datenbank, getestet).
// Das Ergebnis sieht man erst nach der eigenen Stimme oder wenn die Umfrage vorbei ist – so beeinflusst der
// Zwischenstand niemanden. Vorher steht nur die Zahl der Stimmen da.
const { parseZonedLocal } = require('../lib/time');
const { UserError } = require('../lib/util');

const QUESTION_MIN = 3;
const QUESTION_MAX = 200;
const OPTION_MAX = 80;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 10;
const MIN_LEAD_MS = 5 * 60 * 1000; // Enddatum frühestens in 5 Minuten
const MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1000; // und höchstens in einem Jahr

const clean = (s) => String(typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim();

/**
 * Formular → Umfrage oder null (keine Umfrage gewünscht). Wirft UserError bei ungültiger Eingabe.
 * options: Text mit einer Antwort pro Zeile; endsAt: "2026-10-03T18:30" (Ortszeit) oder leer.
 */
function parsePollInput({ question, options, endsAt }, { now = new Date(), timeZone = 'Europe/Berlin' } = {}) {
  const q = clean(question);
  const labels = String(typeof options === 'string' ? options : '')
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean);
  const end = clean(endsAt);
  if (!q && !labels.length) return null;
  if (q.length < QUESTION_MIN || q.length > QUESTION_MAX) throw new UserError(`Die Frage der Umfrage muss ${QUESTION_MIN}–${QUESTION_MAX} Zeichen lang sein.`);
  if (labels.length < OPTIONS_MIN || labels.length > OPTIONS_MAX) throw new UserError(`Eine Umfrage braucht ${OPTIONS_MIN}–${OPTIONS_MAX} Antworten (eine pro Zeile).`);
  if (labels.some((l) => l.length > OPTION_MAX)) throw new UserError(`Jede Antwort darf höchstens ${OPTION_MAX} Zeichen lang sein.`);
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) throw new UserError('Jede Antwort darf nur einmal vorkommen.');
  let ends = null;
  if (end) {
    ends = parseZonedLocal(end, timeZone);
    if (!ends) throw new UserError('Bitte gib ein gültiges Ende der Umfrage an.');
    if (ends.getTime() < now.getTime() + MIN_LEAD_MS) throw new UserError('Das Ende der Umfrage muss mindestens 5 Minuten in der Zukunft liegen.');
    if (ends.getTime() > now.getTime() + MAX_LEAD_MS) throw new UserError('Das Ende der Umfrage darf höchstens ein Jahr in der Zukunft liegen.');
  }
  return { question: q, options: labels.map((label, i) => ({ key: `o${i + 1}`, label })), endsAt: ends };
}

/** Vorbei: Enddatum erreicht oder Thema geschlossen */
const isClosed = (poll, thread, now = new Date()) => !!thread.locked || (!!poll.endsAt && new Date(poll.endsAt) <= now);

/** Warum (nicht) abstimmen? Fehlertext oder null */
function voteError(poll, thread, { option, voted = false, now = new Date() } = {}) {
  if (thread.locked) return 'Das Thema ist geschlossen – die Umfrage ist beendet.';
  if (poll.endsAt && new Date(poll.endsAt) <= now) return 'Die Umfrage ist beendet.';
  if (voted) return 'Du hast schon abgestimmt.';
  if (!poll.options.some((o) => o.key === option)) return 'Bitte wähle eine Antwort.';
  return null;
}

/**
 * Ergebnis: counts = { optionKey: Anzahl }. Prozente ganzzahlig und zusammen genau 100
 * (Verfahren der größten Reste: erst abrunden, dann die größten Nachkommareste aufrunden).
 */
function results(options, counts) {
  const total = options.reduce((s, o) => s + (counts[o.key] || 0), 0);
  const rows = options.map((o, i) => {
    const count = counts[o.key] || 0;
    const exact = total ? (count * 100) / total : 0;
    return { key: o.key, label: o.label, count, percent: Math.floor(exact), rest: exact - Math.floor(exact), i };
  });
  if (total) {
    let missing = 100 - rows.reduce((s, r) => s + r.percent, 0);
    for (const r of [...rows].sort((a, b) => b.rest - a.rest || a.i - b.i)) {
      if (missing <= 0) break;
      r.percent += 1;
      missing -= 1;
    }
  }
  const max = Math.max(0, ...rows.map((r) => r.count));
  return { total, rows: rows.map(({ key, label, count, percent }) => ({ key, label, count, percent, leading: total > 0 && count === max })) };
}

module.exports = { QUESTION_MAX, OPTION_MAX, OPTIONS_MAX, parsePollInput, isClosed, voteError, results };

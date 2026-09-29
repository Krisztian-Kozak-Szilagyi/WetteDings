// Zeitzonen-Hilfen ohne externe Bibliothek. Alle Eingaben/Anzeigen in deutscher Zeit.

function tzOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** "2026-10-03T18:30" (Ortszeit der Zeitzone) -> Date */
function parseZonedLocal(value, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || '');
  if (!m) return null;
  const utcGuess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let offset = tzOffsetMs(new Date(utcGuess), timeZone);
  let date = new Date(utcGuess - offset);
  const offset2 = tzOffsetMs(date, timeZone);
  if (offset2 !== offset) date = new Date(utcGuess - offset2);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Date -> "2026-10-03T18:30" in der Zeitzone (für <input type="datetime-local">) */
function toZonedLocalInput(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

module.exports = { parseZonedLocal, toZonedLocalInput };

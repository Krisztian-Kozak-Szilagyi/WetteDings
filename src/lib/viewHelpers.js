const config = require('../config');
const { quote: rawQuote } = require('./payout');

const euroFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const dateFmt = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: config.timezone,
});
const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });

const euro = (cents) => euroFmt.format((cents || 0) / 100);

const date = (d) => (d ? `${dateFmt.format(new Date(d))} Uhr` : '–');

function relTime(d) {
  const diff = (new Date(d).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, sec] of units) {
    if (abs >= sec) return rtf.format(Math.round(diff / sec), unit);
  }
  return diff >= 0 ? 'gleich' : 'gerade eben';
}

function quote(sideTotal, otherTotal) {
  const q = rawQuote(sideTotal, otherTotal);
  return q === null ? '–' : `${q.toFixed(2).replace('.', ',')}×`;
}

function percent(a, b) {
  const total = a + b;
  return total ? Math.round((a / total) * 100) : 50;
}

const sideLabel = (side) => (side === 'ja' ? 'Ja' : side === 'nein' ? 'Nein' : '–');

function statusInfo(bet) {
  if (bet.status === 'annulliert') return { key: 'annulliert', label: 'Annulliert' };
  if (bet.status === 'entschieden') return { key: 'entschieden', label: `Ergebnis: ${sideLabel(bet.outcome)}` };
  if (new Date(bet.deadline) > new Date()) return { key: 'offen', label: 'Offen' };
  return { key: 'wartend', label: 'Wartet auf Ergebnis' };
}

const ledgerLabels = {
  startguthaben: 'Startguthaben',
  einsatz: 'Einsatz',
  auszahlung: 'Gewinnauszahlung',
  erstattung: 'Erstattung',
};

module.exports = { euro, date, relTime, quote, percent, sideLabel, statusInfo, ledgerLabels };

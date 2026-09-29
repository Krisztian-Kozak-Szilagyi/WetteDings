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

/** Summe aller Einsätze einer Wette */
const pool = (bet) => bet.options.reduce((s, o) => s + o.total, 0);

/** Quote einer Option: (Topf − Provision) ÷ Einsätze auf diese Option */
function quote(bet, opt) {
  const q = rawQuote(opt.total, pool(bet) - opt.total, bet.creatorFeePercent || 0);
  return q === null ? '–' : `${q.toFixed(2).replace('.', ',')}×`;
}

/** Anteil einer Option am Topf in Prozent */
function share(bet, opt) {
  const total = pool(bet);
  return total ? Math.round((opt.total / total) * 100) : 0;
}

/** Voraussichtliche Provision des Wetterstellers nach aktuellem Topf */
const feeEstimate = (bet) => Math.floor((pool(bet) * (bet.creatorFeePercent || 0)) / 100);

const findOption = (bet, key) => bet.options.find((o) => o.key === key) || null;
const optionLabel = (bet, key) => (findOption(bet, key) || { label: '–' }).label;

/** CSS-Farbklasse einer Option: Ja grün, Nein rot, eigene Optionen aus einer Palette */
function optClass(bet, key) {
  if (key === 'ja' || key === 'nein') return `c-${key}`;
  const index = bet.options.findIndex((o) => o.key === key);
  return `c-${Math.max(0, index) % 10}`;
}

function statusInfo(bet) {
  if (bet.status === 'annulliert') return { key: 'annulliert', label: 'Annulliert' };
  if (bet.status === 'entschieden') return { key: 'entschieden', label: `Ergebnis: ${optionLabel(bet, bet.outcome)}` };
  if (new Date(bet.deadline) > new Date()) return { key: 'offen', label: 'Offen' };
  return { key: 'wartend', label: 'Wartet auf Ergebnis' };
}

const ledgerLabels = {
  startguthaben: 'Startguthaben',
  einsatz: 'Einsatz',
  auszahlung: 'Gewinnauszahlung',
  erstattung: 'Erstattung',
  provision: 'Provision (Wettersteller)',
  bonus: 'Tagesbonus',
  coin_kauf: 'Samantha Coin gekauft',
  coin_verkauf: 'Samantha Coin verkauft',
  lotto_los: 'Lotterielos gekauft',
  lotto_gewinn: 'Lotteriegewinn',
};

/** Coin-Kurs mit passender Genauigkeit, z. B. 12,34 € oder 0,004512 € */
function coinPrice(p) {
  const digits = p >= 1 ? 2 : p >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(p);
}

/** Coin-Menge aus Einheiten (1e-8), z. B. "12,3456 SAM" */
function coinAmount(units) {
  return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 6 }).format((units || 0) / 1e8)} SAM`;
}

/** Prozent mit Vorzeichen, z. B. "+4,21 %" */
function signedPercent(x) {
  const v = (x * 100).toFixed(2).replace('.', ',');
  return `${x > 0 ? '+' : ''}${v} %`;
}

const editFieldLabels = { title: 'Titel', description: 'Beschreibung' };

module.exports = {
  euro,
  date,
  relTime,
  pool,
  quote,
  share,
  feeEstimate,
  editFieldLabels,
  findOption,
  optionLabel,
  optClass,
  statusInfo,
  ledgerLabels,
  coinPrice,
  coinAmount,
  signedPercent,
};

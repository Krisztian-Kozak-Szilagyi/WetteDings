const config = require('../config');
const { quote: rawQuote, splitFee } = require('./payout');
const { gradeWord } = require('../grading/condition');
const avatars = require('../profile/avatars');

const euroFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const dateFmt = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: config.timezone,
});
const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });

const euro = (cents) => euroFmt.format((cents || 0) / 100);

const date = (d) => (d ? `${dateFmt.format(new Date(d))} Uhr` : '–');
const escAttr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/**
 * Attribute für einen Auslöser der Großansicht folierter Karten (public/js/foil-view.js), mit <%- %> ausgeben.
 * fav: im Album die Favoriten-ID "f:<Exemplar>", favOn: ist sie schon Favorit?
 * trade: in fremden Sammlungen der Link zum Tauschangebot für dieses Exemplar
 * grade: Note des Exemplars (geheimer Zustand, #73) – steht auf dem Etikett der Folie
 * center: sichtbarer Versatz { x, y } aus der Zentrierung (grading/condition.centerShift)
 */
function foilViewAttrs(card, rarityLabel, foiledAt, { fav = null, favOn = false, trade = null, grade = null, center = null } = {}) {
  let h = ` data-foil-view data-image="${escAttr(card.image)}" data-name="${escAttr(card.name)}" data-rarity="${escAttr(card.rarity)}" data-rarity-label="${escAttr(rarityLabel)}" data-season="${escAttr(card.season || '')}" data-date="${escAttr(dayDate(foiledAt))}"`;
  if (grade) h += ` data-grade="${escAttr(grade)}" data-grade-word="${escAttr(gradeWord(grade))}"`;
  if (center) h += ` data-cx="${escAttr(center.x)}" data-cy="${escAttr(center.y)}"`;
  if (fav) h += ` data-fav="${escAttr(fav)}" data-fav-on="${favOn ? 1 : 0}"`;
  if (trade) h += ` data-trade-href="${escAttr(trade)}"`;
  return h;
}
/** Nur das Datum, z. B. "04.10.2026" (Foliendatum) */
const dayDateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: config.timezone });
const dayDate = (d) => (d ? dayDateFmt.format(new Date(d)) : '–');
// sekundengenau, z. B. für Protokolle
const dateSecFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'medium', timeZone: config.timezone });
const dateSec = (d) => (d ? `${dateSecFmt.format(new Date(d))} Uhr` : '–');

// Zeitraum kompakt, minutengenau: "06.10. 08:54–10:54 Uhr" bzw. "05.10. 22:10 – 06.10. 10:54 Uhr"
const spanDayFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', timeZone: config.timezone });
const spanTimeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: config.timezone });
function timeSpan(from, to) {
  if (!to) return '–';
  const [d2, t2] = [spanDayFmt.format(new Date(to)), spanTimeFmt.format(new Date(to))];
  if (!from) return `${d2} ${t2} Uhr`;
  const [d1, t1] = [spanDayFmt.format(new Date(from)), spanTimeFmt.format(new Date(from))];
  if (d1 === d2) return t1 === t2 ? `${d2} ${t2} Uhr` : `${d2} ${t1}–${t2} Uhr`;
  return `${d1} ${t1} – ${d2} ${t2} Uhr`;
}

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

/** Duell-Einsatz für Listen, z. B. "50,00 € pro Person + je eine Holo-Karte" (#67) */
function duelStakeText(bet) {
  if (!bet || !bet.duel) return '';
  const r = bet.duel.cardRarity ? require('../tcg/catalog').rarityByKey[bet.duel.cardRarity] : null;
  return [bet.duel.stake > 0 ? `${euro(bet.duel.stake)} pro Person` : null, r ? `je eine ${r.label}-Karte` : null].filter(Boolean).join(' + ');
}

/** Anteil einer Option am Topf in Prozent */
function share(bet, opt) {
  const total = pool(bet);
  return total ? Math.round((opt.total / total) * 100) : 0;
}

/** Voraussichtliche Gesamtprovision nach aktuellem Topf */
const feeEstimate = (bet) => Math.floor((pool(bet) * (bet.creatorFeePercent || 0)) / 100);

/** Voraussichtliche Provision je Seite: { creator, referee } */
const feeSplit = (bet) => splitFee(feeEstimate(bet), !!bet.referee, { duel: !!bet.duel });

const findOption = (bet, key) => bet.options.find((o) => o.key === key) || null;
const optionLabel = (bet, key) => (findOption(bet, key) || { label: '–' }).label;

/** CSS-Farbklasse einer Option: Ja grün, Nein rot, eigene Optionen aus einer Palette */
function optClass(bet, key) {
  if (key === 'ja' || key === 'nein') return `c-${key}`;
  const index = bet.options.findIndex((o) => o.key === key);
  return `c-${Math.max(0, index) % 10}`;
}

/** Beschriftung einer Stimme: Option oder „Annullieren“ */
const voteLabel = (bet, outcome) => (outcome === 'annulliert' ? 'Annullieren' : optionLabel(bet, outcome));

/** Stimmen von Wettersteller und Schiedsrichter (eine je Rolle) */
const voteOf = (bet, role) => (bet.votes || []).find((v) => v.role === role) || null;

function statusInfo(bet) {
  if (bet.status === 'annulliert') return { key: 'annulliert', label: 'Annulliert' };
  if (bet.status === 'entschieden') return { key: 'entschieden', label: `Ergebnis: ${optionLabel(bet, bet.outcome)}` };
  if (bet.disputed) return { key: 'streitig', label: 'Strittig – Dev entscheidet' };
  if (bet.duel && bet.duel.state === 'angefragt') return { key: 'duell', label: 'Duell angefragt' };
  if (voteOf(bet, 'creator') || voteOf(bet, 'referee')) return { key: 'bestaetigung', label: 'Warte auf Bestätigung' };
  if (new Date(bet.deadline) > new Date()) return { key: 'offen', label: 'Offen' };
  return { key: 'wartend', label: 'Wartet auf Ergebnis' };
}

const ledgerLabels = {
  startguthaben: 'Startguthaben',
  einsatz: 'Einsatz',
  auszahlung: 'Gewinnauszahlung',
  erstattung: 'Erstattung',
  provision: 'Provision (Wettersteller)',
  provision_schiri: 'Provision (Schiedsrichter)',
  bonus: 'Tagesbonus',
  coin_kauf: 'Broker: Kauf',
  coin_verkauf: 'Broker: Verkauf',
  lotto_los: 'Lotterielos gekauft',
  lotto_gewinn: 'Lotteriegewinn',
  tcg_pack: 'Booster Pack gekauft',
  tcg_verkauf: 'TCG-Karte verkauft',
  tcg_zerkleinert: 'TCG-Karten zerkleinert',
  kosmetik_kauf: 'Kosmetik gekauft',
  item_verkauf: 'Gegenstand verkauft',
  ihk_lohn: 'IHK-Quest geschafft',
  dungeon_lohn: 'Dungeon-Beute',
  erfolg: 'Erfolg freigeschaltet',
  esports_gruendung: 'eSports: Team gegründet',
  esports_austritt: 'eSports: Austritt',
  esports_anteil: 'eSports: Anteil an einer Austrittsgebühr',
  esports_konkurs: 'eSports: Konkurs',
  esports_auszahlung: 'eSports: Auszahlung nach Auflösung',
  schuld_tilgung: 'Schulden getilgt',
  team_gutschrift: 'Gutschrift vom Team',
  team_abzug: 'Abzug durch das Team',
  handel_kauf: 'Karte gekauft (Handel)',
  handel_verkauf: 'Karte verkauft (Handel)',
  handel_tausch_zahlung: 'Aufpreis gezahlt (Tausch)',
  handel_tausch_erhalt: 'Aufpreis erhalten (Tausch)',
  black_market: 'Gekauft (Black Market)', // Karte oder Gegenstand – was genau, steht im Buchungstext
  konto_geloescht: 'Konto gelöscht (Guthaben verfallen)',
  grading_lohn: 'Grading-Auftrag erledigt',
  grading_ausbau: 'Grading-Shop ausgebaut',
};

/** Coin-Kurs mit passender Genauigkeit, z. B. 12,34 € oder 0,004512 € */
function coinPrice(p) {
  const digits = p >= 1 ? 2 : p >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(p);
}

/** Menge eines Broker-Werts aus Einheiten (1e-8), z. B. "12,3456 SAM" */
function coinAmount(units, symbol = 'SAM') {
  return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 6 }).format((units || 0) / 1e8)} ${symbol}`;
}

/** Prozent mit Vorzeichen, z. B. "+4,21 %" */
function signedPercent(x) {
  const v = (x * 100).toFixed(2).replace('.', ',');
  return `${x > 0 ? '+' : ''}${v} %`;
}

/** Profilbild eines Mitglieds (braucht das Feld avatar), ohne Auswahl der Platzhalter */
const avatarUrl = (user) => avatars.urlOf(user && user.avatar);

const editFieldLabels = { title: 'Titel', description: 'Beschreibung' };

module.exports = {
  euro,
  date,
  dayDate,
  foilViewAttrs,
  gradeWord,
  dateSec,
  relTime,
  timeSpan,
  pool,
  quote,
  duelStakeText,
  share,
  feeEstimate,
  feeSplit,
  editFieldLabels,
  findOption,
  optionLabel,
  optClass,
  voteLabel,
  voteOf,
  statusInfo,
  ledgerLabels,
  coinPrice,
  coinAmount,
  signedPercent,
  avatarUrl,
};

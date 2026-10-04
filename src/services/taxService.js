// Steuersätze (Admin): je Bereich ein eigener Satz in Prozent.
// Handel: Markt, Privat, Tausch (auf den Aufpreis). Broker: je Kategorie (Coins, ETFs) auf den Gewinn beim Verkauf.
const { TradeSettings } = require('../models/Trade');
const { logSettingsChange } = require('../stats/settingsLog');

const CATEGORIES = [
  { key: 'markt', group: 'Handel', label: 'Markt', hint: 'vom Verkaufserlös' },
  { key: 'privat', group: 'Handel', label: 'Privat', hint: 'vom Verkaufserlös' },
  { key: 'tausch', group: 'Handel', label: 'Tausch', hint: 'vom Aufpreis, trägt der Empfänger' },
  { key: 'coin', group: 'Broker', label: 'Coins', hint: 'vom Gewinn beim Verkauf' },
  { key: 'etf', group: 'Broker', label: 'ETFs', hint: 'vom Gewinn beim Verkauf' },
];
const KEYS = CATEGORIES.map((c) => c.key);
const MAX_PERCENT = 50;

const rates = Object.fromEntries(KEYS.map((k) => [k, 0]));

/** Satz eines Bereichs in Prozent (unbekannter Bereich: 0) */
const rate = (key) => (KEYS.includes(key) ? rates[key] : 0);

/** Steuer in Cent (abgerundet) auf einen Betrag in Cent, nie mehr als der Betrag */
const taxFor = (cents, percent) => Math.floor((Math.max(0, cents) * Math.min(100, Math.max(0, percent || 0))) / 100);

/** Steuer auf den Gewinn eines Verkaufs (Erlös − Einstand); bei Verlust 0 */
const gainTax = (proceeds, cost, percent) => taxFor(proceeds - cost, percent);

/** Neue Sätze prüfen: Zahlen 0–50, auf eine Nachkommastelle gerundet. Gibt { rates } oder { error } zurück */
function parseRates(input) {
  const out = {};
  for (const key of KEYS) {
    const raw = input && typeof input[key] === 'string' ? input[key] : '';
    const n = Number(raw.trim().replace(',', '.'));
    if (raw.trim() === '' || !Number.isFinite(n) || n < 0 || n > MAX_PERCENT) {
      const cat = CATEGORIES.find((c) => c.key === key);
      return { error: `Steuer ${cat.group} · ${cat.label}: bitte einen Wert zwischen 0 und ${MAX_PERCENT} % angeben.` };
    }
    out[key] = Math.round(n * 10) / 10;
  }
  return { rates: out };
}

async function loadSettings() {
  const [doc, legacy] = await Promise.all([TradeSettings.findById('steuer').lean(), TradeSettings.findById('handel').lean()]);
  // Früher gab es nur eine Handelssteuer: sie gilt für Markt, Privat und Tausch, bis neue Sätze gespeichert sind
  if (legacy && Number.isFinite(legacy.taxPercent)) for (const k of ['markt', 'privat', 'tausch']) rates[k] = legacy.taxPercent;
  if (doc && doc.rates) for (const k of KEYS) if (Number.isFinite(doc.rates[k])) rates[k] = doc.rates[k];
}

async function saveSettings({ rates: next, admin }) {
  await TradeSettings.updateOne({ _id: 'steuer' }, { $set: { rates: next, updatedByName: admin.username } }, { upsert: true });
  const before = { ...rates };
  Object.assign(rates, next);
  await logSettingsChange({ area: 'steuer', before, after: { ...rates }, by: admin });
}

module.exports = { CATEGORIES, KEYS, MAX_PERCENT, rates, rate, taxFor, gainTax, parseRates, loadSettings, saveSettings };

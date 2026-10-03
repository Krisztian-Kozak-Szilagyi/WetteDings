// Vergleichswerte für den Gini-Koeffizienten der Plattform. Unser Gini misst das Vermögen (Guthaben, Einsätze,
// Coins, Karten) – deshalb Vermögens-Gini der Länder, nicht die bekannteren (viel niedrigeren) Einkommens-Gini.
// Quelle: UBS Global Wealth Report 2025, Vermögens-Gini je Erwachsenem, Stand 2024.
const SOURCE = 'UBS Global Wealth Report 2025 (Vermögens-Gini je Erwachsenem, Stand 2024)';

const COUNTRIES = [
  { name: 'Slowakei', gini: 0.38 },
  { name: 'Belgien', gini: 0.47 },
  { name: 'Japan', gini: 0.54 },
  { name: 'Spanien', gini: 0.56 },
  { name: 'Italien', gini: 0.57 },
  { name: 'Vereinigtes Königreich', gini: 0.58 },
  { name: 'Frankreich', gini: 0.59 },
  { name: 'China', gini: 0.62 },
  { name: 'Niederlande', gini: 0.65 },
  { name: 'Schweiz', gini: 0.67 },
  { name: 'Deutschland', gini: 0.68 },
  { name: 'USA', gini: 0.74 },
  { name: 'Schweden', gini: 0.75 },
  { name: 'Südafrika', gini: 0.81 },
  { name: 'Brasilien', gini: 0.82 },
];

const fmt = (g) => g.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Einordnung eines Gini-Werts: Länder samt Plattform, aufsteigend sortiert, und ein Satz zur Einordnung.
 * -> { text, rows: [{ name, gini, self }], source } oder null ohne Wert
 */
function compareGini(value, label = 'Plattform') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const sorted = [...COUNTRIES].sort((a, b) => a.gini - b.gini);
  const same = sorted.filter((c) => Math.abs(c.gini - value) < 0.005);
  const below = sorted.filter((c) => c.gini < value - 0.005).pop();
  const above = sorted.find((c) => c.gini > value + 0.005);
  let text;
  if (same.length) text = `so ungleich wie ${same.map((c) => c.name).join(' und ')} (${fmt(same[0].gini)})`;
  else if (!below) text = `gleicher verteilt als in allen Vergleichsländern (niedrigster: ${above.name}, ${fmt(above.gini)})`;
  else if (!above) text = `ungleicher verteilt als in allen Vergleichsländern (höchster: ${below.name}, ${fmt(below.gini)})`;
  else text = `zwischen ${below.name} (${fmt(below.gini)}) und ${above.name} (${fmt(above.gini)})`;
  const rows = [...sorted.map((c) => ({ ...c, self: false })), { name: label, gini: value, self: true }].sort((a, b) => a.gini - b.gini || (a.self ? 1 : -1));
  return { text, rows, source: SOURCE };
}

module.exports = { SOURCE, COUNTRIES, compareGini };

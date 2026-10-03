// Statistik-Seite für Admin und Devs: Kennzahlen und Verläufe für das Balancing (siehe stats/statsService)
const express = require('express');
const { requireStaff } = require('../middleware');
const { str } = require('../lib/util');
const { euro, date } = require('../lib/viewHelpers');
const stats = require('../stats/statsService');

const router = express.Router();

const numFmt = new Intl.NumberFormat('de-DE');

/**
 * Wert einer Kennzahl oder Tabellenzelle anzeigen. cell: { value, unit, signed, digits } oder ein Text.
 * unit: euro (Cent) | count | number | percent (Anteil 0…1) | ratio | price (€ mit Nachkommastellen) | text
 */
function fmt(cell) {
  if (cell === null || cell === undefined) return '–';
  if (typeof cell !== 'object') return String(cell);
  const { value, unit, signed, digits } = cell;
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  const sign = signed && value > 0 ? '+' : '';
  switch (unit) {
    case 'euro':
      return sign + euro(value);
    case 'percent':
      return sign + (value * 100).toLocaleString('de-DE', { maximumFractionDigits: digits ?? 1 }) + ' %';
    case 'ratio':
      return sign + value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
    case 'number':
      return sign + value.toLocaleString('de-DE', { maximumFractionDigits: 1 });
    case 'count':
      return sign + numFmt.format(value);
    default:
      return String(value);
  }
}

router.get('/admin/statistik', requireStaff, async (req, res) => {
  const key = stats.SECTIONS.some((s) => s.key === req.query.bereich) ? req.query.bereich : stats.SECTIONS[0].key;
  const range = Number(str(req.query.tage)) || stats.DEFAULT_RANGE;
  const data = await stats.section(key, range);
  res.render('statistik', {
    title: 'Statistik',
    sections: stats.SECTIONS,
    ranges: stats.RANGES,
    active: key,
    data,
    fmt,
    date,
    // Für die Diagramme im Browser (public/js/stats.js)
    chartData: { days: data.period.days, markers: data.markers.map((m) => ({ day: m.day, label: m.label, kind: m.kind })), charts: data.charts || [] },
  });
});

module.exports = router;

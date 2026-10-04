// Statistik-Seite für Admin und Devs: Kennzahlen und Verläufe für das Balancing (siehe stats/statsService)
const express = require('express');
const User = require('../models/User');
const { requireStaff } = require('../middleware');
const { str } = require('../lib/util');
const { euro, date } = require('../lib/viewHelpers');
const stats = require('../stats/statsService');
const { ranking } = require('../services/rankService');
const exportCsv = require('../stats/exportCsv');
const { panelNav } = require('./admin');

const router = express.Router();

const numFmt = new Intl.NumberFormat('de-DE');
const dec = (v, max = 1, min = 0) => v.toLocaleString('de-DE', { minimumFractionDigits: min, maximumFractionDigits: max });

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
    case 'price':
      return value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: value >= 1 ? 2 : 4, maximumFractionDigits: value >= 1 ? 2 : 6 });
    case 'percent':
      return sign + dec(value * 100, digits ?? 1) + ' %';
    case 'ratio':
      return sign + dec(value, 3, 2);
    case 'number':
      return sign + dec(value, 1);
    case 'count':
      return sign + numFmt.format(value);
    default:
      return String(value);
  }
}

/** Veränderung gegenüber dem Vorzeitraum als Text, z. B. "+12 %", "+120,00 €" oder "+3,2 Pp." */
function fmtDelta(k) {
  const d = k.delta;
  if (!d) return null;
  if (d.isNew) return 'neu';
  if (d.dir === 'flat') return '± 0';
  const sign = d.dir === 'up' ? '+' : '−';
  if (d.abs !== undefined) return sign + euro(Math.abs(d.abs));
  if (d.points !== undefined) return k.unit === 'percent' ? `${sign}${dec(Math.abs(d.points) * 100, 1)} Pp.` : sign + dec(Math.abs(d.points), 3, 2);
  return `${sign}${dec(Math.abs(d.rel) * 100, 0)} %`;
}

/** Reiter, Zeitraum und (im Reiter "Mitglied") das Mitglied aus der Anfrage */
async function selection(req) {
  const key = stats.SECTIONS.some((s) => s.key === req.query.bereich) ? req.query.bereich : stats.SECTIONS[0].key;
  const range = Number(str(req.query.tage)) || stats.DEFAULT_RANGE;
  const name = str(req.query.spieler).trim();
  const member = key === 'mitglied' && name ? await User.findOne({ usernameLower: name.toLowerCase(), deletedAt: null }).select('username usernameLower createdAt').lean() : null;
  return { key, range, name, member };
}

/**
 * Export: ganzer Reiter oder ein Themenblock (teil=<Block-ID>) als CSV für Excel, der ganze Reiter auch als JSON.
 * Verläufe sind im Export immer tagesgenau.
 */
router.get('/admin/statistik/export', requireStaff, async (req, res) => {
  const { key, range, member } = await selection(req);
  if (key === 'mitglied' && !member) return res.status(404).render('error', { title: 'Export', status: 404, message: 'Dieses Mitglied gibt es nicht.' });
  const data = await stats.section(key, range, new Date(), { user: member, raw: true });
  const section = stats.SECTIONS.find((s) => s.key === key);
  const block = str(req.query.teil) ? data.blocks.find((b) => b.id === str(req.query.teil)) : null;
  if (str(req.query.teil) && !block) return res.status(404).render('error', { title: 'Export', status: 404, message: 'Diesen Teil der Statistik gibt es nicht.' });
  const title = ['Statistik', section.label, member ? member.username : null, block ? block.title : null].filter(Boolean).join(' – ');
  const nameParts = [key, member ? member.username : null, block ? block.id : null];

  if (str(req.query.format) === 'json') {
    res.attachment(exportCsv.fileName(nameParts, data.period, 'json'));
    // Rohwerte: Beträge in Cent, Anteile von 0 bis 1, Verläufe je Tag (period.days)
    return res.json({ title, created: new Date(), units: { euro: 'Cent', percent: 'Anteil 0–1' }, member: member ? member.username : null, ...data });
  }
  res.attachment(exportCsv.fileName(nameParts, data.period, 'csv'));
  res.type('text/csv; charset=utf-8');
  res.send(exportCsv.toCsv(data, { title, blockId: block ? block.id : null }));
});

router.get('/admin/statistik', requireStaff, async (req, res) => {
  const { key, range: requested, name, member } = await selection(req);
  const range = requested;
  // Reiter "Mitglied": ohne (gültiges) Mitglied erst die Auswahl zeigen
  let members = [];
  if (key === 'mitglied') {
    members = await ranking({ team: true }); // Auswahl und Namensvorschläge – auch das Team (ohne Platz)
    if (name && !member) res.locals.flash = { type: 'error', message: `Das Mitglied „${name}“ gibt es nicht.` };
  }
  // Reiterleiste des Panels (die Statistik ist ein Reiter im Panel)
  const nav = await panelNav(req.user, res.locals);
  if (key === 'mitglied' && !member) {
    return res.render('statistik', { ...nav, title: 'Statistik', sections: stats.SECTIONS, ranges: stats.RANGES, rangeLabel: stats.rangeLabel, active: key, data: null, range, member, members, fmt, fmtDelta, date, chartData: null });
  }
  const data = await stats.section(key, range, new Date(), { user: member });
  res.render('statistik', {
    ...nav,
    title: 'Statistik',
    sections: stats.SECTIONS,
    ranges: stats.RANGES,
    rangeLabel: stats.rangeLabel,
    active: key,
    range: data.period.range,
    member,
    members,
    data,
    fmt,
    fmtDelta,
    date,
    // Für die Diagramme im Browser (public/js/stats.js)
    chartData: {
      labels: data.labels,
      longLabels: data.longLabels,
      markers: data.markers.filter((m) => m.i !== undefined).map((m) => ({ i: m.i, short: m.short, label: m.label, kind: m.kind })),
      // Heute: keine Verläufe (je Diagramm nur ein Wert)
      charts: data.period.range === 1 ? [] : data.blocks.flatMap((b) => b.charts).filter((c) => !c.empty),
    },
  });
});

module.exports = router;

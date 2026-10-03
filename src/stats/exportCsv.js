// Export der Statistik als CSV für Excel (deutsche Einstellungen): Semikolon als Trennzeichen, Dezimalkomma,
// Datum als TT.MM.JJJJ, UTF-8 mit BOM (sonst zeigt Excel Umlaute falsch an). Zahlen bleiben Zahlen – Euro-Beträge
// in Euro, Anteile in Prozent –, damit man in Excel direkt weiterrechnen kann; die Einheit steht in der Spalte.

const BOM = '﻿';
const SEP = ';';
const NL = '\r\n';

const AREA_NAMES = { start: 'Startseite', wetten: 'Wetten', tcg: 'TCG', handel: 'Handel', ihk: 'IHK', coin: 'Coin', lotterie: 'Lotterie', forum: 'Forum', profil: 'Profil & Rangliste', konto: 'Mein Konto', support: 'Support', admin: 'Admin/Dev', info: 'Regeln & Hilfe', sonstiges: 'Sonstiges' };
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const VERDICTS = { 'im-rahmen': 'Im Rahmen', 'zu-oft': 'Auffällig oft', 'zu-selten': 'Auffällig selten', 'wenig-daten': 'Zu wenig Daten' };
const UNIT_LABELS = { euro: '€', price: '€', percent: '%', count: 'Anzahl', number: 'Zahl', ratio: 'Verhältnis', text: '' };

/** Ein Feld: in Anführungszeichen, wenn es Trennzeichen, Anführungszeichen oder Zeilenumbrüche enthält */
function field(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Zahl mit Dezimalkomma, ohne Tausenderpunkte (Excel liest sie so als Zahl) */
function num(v, digits = 2) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  return String(Math.round(v * 10 ** digits) / 10 ** digits).replace('.', ',');
}

/** Wert in der Einheit der Spalte: Euro aus Cent, Prozent aus Anteil */
function value(v, unit) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'number') return v;
  switch (unit) {
    case 'euro':
      return num(v / 100, 2);
    case 'percent':
      return num(v * 100, 2);
    case 'ratio':
      return num(v, 4);
    case 'price':
      return num(v, 6);
    case 'count':
      return num(v, 0);
    default:
      return num(v, 2);
  }
}

/** Tabellenzelle aus der Statistik ({ value, unit } oder Text) */
const cell = (c) => (c && typeof c === 'object' ? value(c.value, c.unit) : c);
const day = (d) => d.split('-').reverse().join('.');
const row = (cells) => cells.map(field).join(SEP);
const withUnit = (label, unit) => (UNIT_LABELS[unit] ? `${label} (${UNIT_LABELS[unit]})` : label);

/** Abschnitte eines Themenblocks als Liste von { title, rows } (rows: Arrays von Zellen, erste Zeile = Kopf) */
function blockParts(block, days) {
  const parts = [];
  if (block.kpis && block.kpis.length) {
    parts.push({
      title: 'Kennzahlen',
      rows: [
        ['Kennzahl', 'Einheit', 'Wert', 'Vorzeitraum', 'Erklärung'],
        ...block.kpis.map((k) => [k.label, UNIT_LABELS[k.unit] || '', value(k.value, k.unit), k.compare ? value(k.prev, k.unit) : '', k.hint || '']),
      ],
    });
  }
  if (block.flow) {
    parts.push({
      title: 'Geldfluss-Bilanz',
      rows: [['Bereich', 'Art', 'Betrag (€)', 'Erklärung'], ...[...block.flow.sources, ...block.flow.sinks].map((g) => [g.label, g.value > 0 ? 'Quelle' : 'Senke', value(g.value, 'euro'), g.hint || ''])],
    });
  }
  if (block.giniCompare) {
    parts.push({
      title: 'Ländervergleich (Vermögens-Gini)',
      rows: [['Land', 'Gini', 'Quelle'], ...block.giniCompare.rows.map((r) => [r.name, value(r.gini, 'ratio'), r.self ? 'Plattform (jetzt)' : block.giniCompare.source])],
    });
  }
  if (block.pulls) {
    parts.push({
      title: 'Drop-Raten',
      rows: [
        ['Seltenheit', 'Chance (%)', 'Erwartet', 'Gezogen', 'Ist (%)', 'Bewertung'],
        ...block.pulls.rows.map((r) => [r.label, value(r.chance, 'percent'), num(r.expected, 2), r.count, value(r.share, 'percent'), VERDICTS[r.verdict] || r.verdict]),
      ],
    });
  }
  for (const c of block.charts || []) {
    if (c.empty) continue;
    parts.push({
      title: `Verlauf: ${c.title}`,
      rows: [['Tag', ...c.series.map((s) => withUnit(s.name, c.unit))], ...days.map((d, i) => [day(d), ...c.series.map((s) => value(s.values[i], c.unit))])],
    });
  }
  if (block.hbars && block.hbars.items.length) {
    parts.push({
      title: block.hbars.title || 'Verteilung',
      rows: [['Bezeichnung', 'Anteil (%)', 'Angabe'], ...block.hbars.items.map((x) => [x.label || AREA_NAMES[x.key] || x.key, value(x.share, 'percent'), x.text || ''])],
    });
  }
  if (block.heat) {
    parts.push({
      title: 'Aktivität nach Wochentag und Stunde',
      rows: [['Wochentag', ...Array.from({ length: 24 }, (_, h) => `${h} Uhr`)], ...block.heat.rows.map((r, i) => [WEEKDAYS[i], ...r])],
    });
  }
  for (const t of block.tables || []) {
    if (!t.rows.length) continue;
    // Einheit je Spalte aus der ersten Zeile mit Wert übernehmen
    const units = t.head.map((_, i) => {
      const c = t.rows.map((r) => r[i]).find((x) => x && typeof x === 'object' && x.unit);
      return c ? c.unit : null;
    });
    parts.push({
      title: t.title,
      rows: [t.head.map((h, i) => withUnit(h.label || h, units[i])), ...t.rows.map((r) => r.map(cell))],
    });
  }
  return parts;
}

/** Änderungen (Einstellungen, Patchnotes) als Abschnitt */
function markerPart(markers) {
  return {
    title: 'Änderungen im Zeitraum',
    rows: [['Tag', 'Art', 'Beschreibung', 'Von', 'Details'], ...markers.map((m) => [day(m.day), m.kind === 'patch' ? 'Patchnotes' : 'Einstellung', m.label, m.by || '', m.detail.join(' | ')])],
  };
}

/**
 * Ganze CSV-Datei: Kopf mit Zeitraum, dann die Abschnitte – jeweils mit Überschrift, durch Leerzeilen getrennt.
 * data: Ergebnis von statsService.section (mit raw: true), blockId: nur diesen Block (sonst alle).
 */
function toCsv(data, { title, blockId = null } = {}) {
  const blocks = blockId ? data.blocks.filter((b) => b.id === blockId) : data.blocks;
  const lines = [
    row([title]),
    row(['Zeitraum', `${day(data.period.from)} – ${day(data.period.to)}`]),
    row(['Vorzeitraum', `${day(data.previous.from)} – ${day(data.previous.to)}`]),
    row(['Erstellt', new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })]),
  ];
  const sections = [];
  for (const b of blocks) for (const part of blockParts(b, data.period.days)) sections.push({ title: blocks.length > 1 ? `${b.title} – ${part.title}` : part.title, rows: part.rows });
  if (!blockId && data.markers.length) sections.push(markerPart(data.markers));
  for (const s of sections) lines.push('', row([s.title]), ...s.rows.map(row));
  return BOM + lines.join(NL) + NL;
}

/** Dateiname, z. B. "statistik-tcg-2026-09-04_2026-10-03.csv" */
function fileName(parts, period, ext) {
  const slug = parts
    .filter(Boolean)
    .map((p) => String(p).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    .join('-');
  return `statistik-${slug}-${period.from}_${period.to}.${ext}`;
}

module.exports = { field, num, value, blockParts, toCsv, fileName };

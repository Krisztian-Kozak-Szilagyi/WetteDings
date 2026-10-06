// Karten mit gezeichnetem Rahmen als SVG: Bild (eingebettet) + Werte + Fähigkeitstext, passend zum Rahmen-Layout
// (src/tcg/frames.js). Ausgeliefert unter /img/tcg/karte/<id>.svg – überall nutzbar wie ein normales Kartenbild (<img>).
// Abweichende Werte (Boost im Kampf, ?fia=110) werden farbig gezeigt: höher = grün ▲, niedriger = rot ▼.
const fs = require('fs');
const path = require('path');
const FRAMES = require('./frames');

const STAT_KEYS = ['speed', 'fia', 'fis', 'bwl'];
const FONT = "Georgia, 'Times New Roman', 'Noto Serif', serif";
// mittlere Zeichenbreite von Georgia in em – für den Zeilenumbruch (SVG bricht nicht selbst um)
const CHAR_EM = 0.5;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Bilder als data-URI: SVGs in <img> dürfen keine weiteren Dateien nachladen.
// Zwischengespeichert je Datei samt Änderungszeit – ein ausgetauschtes Bild gilt sofort, ohne Neustart.
const artCache = new Map(); // file -> { mtime, data }
function artData(file) {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    // Datei fehlt – readFileSync wirft gleich die eigentliche Fehlermeldung
  }
  const hit = artCache.get(file);
  if (hit && hit.mtime === mtime) return hit.data;
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
  const data = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  artCache.set(file, { mtime, data });
  return data;
}

/** Text in Zeilen umbrechen, die bei dieser Schriftgröße ungefähr in maxWidth passen */
function wrap(text, maxWidth, size) {
  const maxChars = Math.max(8, Math.floor(maxWidth / (size * CHAR_EM)));
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** Größte Schrift, bei der der Text in die Box passt */
function fitText(text, box) {
  for (let size = box.size; size > box.minSize; size--) {
    const lines = wrap(text, box.w, size);
    if (lines.length * size * box.lineHeight <= box.h) return { size, lines };
  }
  return { size: box.minSize, lines: wrap(text, box.w, box.minSize) };
}

const colorFor = (value, base, c) => (value > base ? c.up : value < base ? c.down : c.value);
// kleines Dreieck neben einem geänderten Wert: ▲ Buff, ▼ Debuff (Mittelpunkt x/y, Größe r)
function arrow(x, y, value, base, c, r = 8) {
  if (value === base) return '';
  const up = value > base;
  const pts = up ? [[x - r, y + r * 0.7], [x + r, y + r * 0.7], [x, y - r * 0.9]] : [[x - r, y - r * 0.7], [x + r, y - r * 0.7], [x, y + r * 0.9]];
  return `<path d="M${pts.map((p) => p.map((n) => n.toFixed(1)).join(' ')).join(' L')} Z" fill="${up ? c.up : c.down}" stroke="${c.outline}" stroke-width="2" stroke-linejoin="round"/>`;
}
const textAttrs = (c) => `font-family="${esc(FONT)}" paint-order="stroke" stroke="${c.outline}" stroke-linejoin="round"`;

function statsSvg(frame, values, base) {
  const c = frame.colors;
  return frame.stats
    .map((s) => {
      const v = values[s.key];
      return (
        `<text x="${s.x}" y="${s.y - 18}" text-anchor="middle" font-size="16" font-weight="700" letter-spacing="3" fill="${c.label}" stroke-width="3" ${textAttrs(c)}>${s.label}</text>` +
        `<text x="${s.x}" y="${s.y + 26}" text-anchor="middle" font-size="${v >= 100 ? 36 : 42}" font-weight="700" fill="${colorFor(v, base[s.key], c)}" stroke-width="4" ${textAttrs(c)}>${v}</text>` +
        arrow(s.x + 39, s.y - 24, v, base[s.key], c)
      );
    })
    .join('');
}

function speedSvg(frame, value, base) {
  const p = frame.speed;
  const c = frame.colors;
  const cy = p.y + p.h / 2;
  // Blitz wie auf den Pre-Season-Karten, 24er-Pfad auf Plakettenhöhe skaliert
  const k = (p.h * 0.5) / 24;
  const bx = p.x + p.h * 0.32;
  return (
    `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${p.h / 2}" fill="${c.plate}" stroke="${c.plateBorder}" stroke-width="3"/>` +
    `<path transform="translate(${bx} ${cy - 12 * k}) scale(${k})" d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" fill="${c.value}"/>` +
    `<text x="${p.x + p.w * 0.62}" y="${cy + 12}" text-anchor="middle" font-size="34" font-weight="700" fill="${colorFor(value, base, c)}" stroke-width="3" ${textAttrs(c)}>${value}</text>` +
    arrow(p.x + p.w + 14, cy, value, base, c, 9)
  );
}

// title = Name der Fähigkeit (fett, über dem Text); der Text passt sich dem restlichen Platz an
function abilitySvg(frame, text, title) {
  if (!text && !title) return '';
  const b = frame.text;
  const c = frame.colors;
  const titleSize = title ? b.size + 3 : 0;
  const titleLh = titleSize * 1.25;
  const { size, lines } = text ? fitText(text, { ...b, h: b.h - titleLh }) : { size: b.size, lines: [] };
  const lh = size * b.lineHeight;
  // Block (Titel + Text) senkrecht mittig; die Grundlinie liegt etwa 0,8 Schriftgrößen unter der Zeilenoberkante
  const blockTop = b.y + (b.h - titleLh - lines.length * lh) / 2;
  const top = blockTop + titleLh + size * 0.8 + (lh - size) / 2;
  const cx = b.x + b.w / 2;
  const head = title
    ? `<text x="${cx}" y="${(blockTop + titleSize * 0.95).toFixed(1)}" text-anchor="middle" font-size="${titleSize}" font-weight="700" letter-spacing="1" fill="${c.value}" stroke-width="3" ${textAttrs(c)}>${esc(title)}</text>`
    : '';
  const tspans = lines.map((l, i) => `<tspan x="${cx}" y="${(top + i * lh).toFixed(1)}">${esc(l)}</tspan>`).join('');
  return head + (lines.length ? `<text text-anchor="middle" font-size="${size}" font-style="italic" fill="${c.text}" stroke-width="2" ${textAttrs(c)}>${tspans}</text>` : '');
}

/**
 * SVG einer Karte. card: Katalogkarte mit frame, artFile, stats, ability.
 * values: abweichende Werte { speed, fia, fis, bwl } (fehlende = Grundwert).
 */
function render(card, values = {}) {
  const frame = FRAMES[card.frame];
  if (!frame) throw new Error(`Unbekannter Kartenrahmen: ${card.frame}`);
  const base = card.stats || { speed: 0, fia: 0, fis: 0, bwl: 0 };
  const v = Object.fromEntries(STAT_KEYS.map((k) => [k, Number.isInteger(values[k]) ? values[k] : base[k]]));
  const { width: w, height: h } = frame;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<title>${esc(card.name)}</title>` +
    `<image width="${w}" height="${h}" xlink:href="${artData(card.artFile)}"/>` +
    (frame.speed ? speedSvg(frame, v.speed, base.speed) : '') +
    statsSvg(frame, v, base) +
    abilitySvg(frame, card.ability, card.abilityName) +
    '</svg>'
  );
}

/** Abweichende Werte aus der Query lesen (?speed=…&fia=…): nur ganze Zahlen 0 … 999 */
function valuesFromQuery(query) {
  const out = {};
  for (const k of STAT_KEYS) {
    const raw = query && query[k];
    if (typeof raw === 'string' && /^\d{1,3}$/.test(raw)) out[k] = Number(raw);
  }
  return out;
}

module.exports = { render, wrap, fitText, valuesFromQuery, STAT_KEYS };

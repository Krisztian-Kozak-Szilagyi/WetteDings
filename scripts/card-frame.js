// Karten-Overhaul: Vollbild-Karte im Layout von St. Ivan, the Forsaken (Motiv über die ganze Karte, Namensbalken oben
// links, Speed-Plakette oben rechts, drei Wertefenster links, Textfenster unten) – Farben und Effekte je Seltenheit:
//   crumpled  Sepia, Risse und Kaffeering        bfwler    kühles Blaugrau
//   gold      Gold mit Glanz                     holo      Regenbogen-Schimmer
//   bockhaber Violett                            glitch    Neongrün, verschobene Bildstreifen, Scanlines, Farbbalken
// Name, Werte und Fähigkeitstext setzt der Code (src/tcg/frames.js „rar-<seltenheit>“, src/tcg/cardSvg.js) – hier
// entstehen nur Motiv und Rahmen (720 × 1008, WebP).
//
// node scripts/card-frame.js <bild> <seltenheit> <ziel.webp> [vorschau.png] [--spell]
// --spell: Karte ohne Werte (Hunde wie Hugo und Lilly) – keine Wertefenster, größeres Textfenster (Rahmen „rar-<s>-spell“)
const sharp = require('sharp');
const SPELL = process.argv.includes('--spell');
const [SRC, RARITY, DEST, PREVIEW] = process.argv.slice(2).filter((a) => a !== '--spell');
const W = 720;
const H = 1008;

// Farben je Seltenheit: accent = Rahmenlinien, light/dark = Verlauf und Schatten, pane = Fenster, band = Außenband,
// gem = Edelsteine, tint = Färbung des Motivs (null = Farben behalten), hue = holografischer Verlauf
const STYLE = {
  crumpled: { duo: ['#33281b', '#f2e6cc'], accent: '#d8c3a0', light: '#f4e8cf', dark: '#6e5a3e', pane: ['#3a3024', '#1f1912'], band: ['#5a4a35', '#2b2219'], gem: '#c8ae84', tint: '#d9c19a', brightness: 1.02, saturation: 0.9 },
  bfwler: { duo: ['#161e2d', '#dfe9f8'], accent: '#9fb3d6', light: '#e1eaf8', dark: '#3e4d68', pane: ['#212a3a', '#11161f'], band: ['#33405a', '#151b27'], gem: '#a9bde0', tint: '#a7b9db', brightness: 1.0, saturation: 1 },
  gold: { duo: ['#2a1500', '#ffd65c'], accent: '#e3b341', light: '#ffe9a8', dark: '#8c5f16', pane: ['#3a2a0c', '#1c1406'], band: ['#5e4314', '#271b07'], gem: '#ffd36b', tint: '#e9c25e', brightness: 1.04, saturation: 1.1 },
  holo: { accent: '#bfe3ff', light: '#ffffff', dark: '#5a6fa0', pane: ['#1f2644', '#12142a'], band: ['#2d3560', '#141836'], gem: '#bfe3ff', tint: null, brightness: 1.12, saturation: 0.85, hue: ['#a8d8ff', '#ffb3e6', '#fff3a3', '#b3ffd9', '#a8d8ff'] },
  bockhaber: { duo: ['#170b2b', '#e6d8ff'], accent: '#b48cf2', light: '#e8dcff', dark: '#4a3078', pane: ['#2a1a45', '#140b24'], band: ['#3d2566', '#180d2c'], gem: '#cbb0ff', tint: '#b893f0', brightness: 0.98, saturation: 1 },
  glitch: { duo: ['#010e07', '#86ffb8'], accent: '#4ade80', light: '#c8fbdc', dark: '#14633a', pane: ['#0b2116', '#050d09'], band: ['#0e2c1c', '#04100a'], gem: '#4ade80', tint: '#54e08b', brightness: 0.9, saturation: 1.2 },
};
const S = STYLE[RARITY];
if (!S) throw new Error(`Unbekannte Seltenheit: ${RARITY} (${Object.keys(STYLE).join(', ')})`);

// ---------- Motiv je Seltenheit ----------
async function art() {
  const base = sharp(SRC).resize(W, H, { fit: 'cover', position: 'centre' });
  let buf;
  if (S.duo) {
    // Duoton wie auf den bisherigen Karten: Helligkeit des Motivs → Verlauf von Schatten- zu Lichtfarbe
    const { data } = await base.clone().greyscale().linear(1.1, -8).raw().toBuffer({ resolveWithObject: true });
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [a, b] = S.duo.map(hex);
    const rgb = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const t = Math.pow(data[i] / 255, 1 / S.brightness);
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(a[c] + (b[c] - a[c]) * t);
    }
    buf = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  } else {
    buf = await base.clone().modulate({ brightness: S.brightness, saturation: S.saturation }).png().toBuffer();
  }
  if (RARITY === 'glitch') {
    // verschobene Bildstreifen (Glitch): einige waagerechte Bänder seitlich versetzt
    const bands = [[178, 22, 18], [262, 10, -26], [318, 14, 14], [446, 26, -12], [520, 8, 30], [612, 18, -20]];
    const layers = await Promise.all(bands.map(async ([y, h, dx]) => ({ input: await sharp(buf).extract({ left: Math.max(0, -dx), top: y, width: W - Math.abs(dx), height: h }).toBuffer(), left: Math.max(0, dx), top: y })));
    buf = await sharp(buf).composite(layers).png().toBuffer();
  }
  return buf;
}

// ---------- Rahmen und Effekte (SVG) ----------
const accentStops = S.hue
  ? S.hue.map((c, i) => `<stop offset="${(i / (S.hue.length - 1)).toFixed(2)}" stop-color="${c}"/>`).join('')
  : `<stop offset="0" stop-color="${S.accent}"/><stop offset=".5" stop-color="${S.light}"/><stop offset="1" stop-color="${S.accent}"/>`;
const gem = (x, y, r = 11) =>
  `<g transform="translate(${x} ${y})"><path d="M0 ${-r} L${r} 0 L0 ${r} L${-r} 0 Z" fill="url(#acc)" stroke="${S.dark}" stroke-width="1.5"/>` +
  `<path d="M0 ${-r + 4} L${r - 4} 0 L0 ${r - 4} L${-r + 4} 0 Z" fill="${S.pane[1]}"/><circle r="${r * 0.32}" fill="${S.gem}"/><circle r="${r * 0.14}" cx="-1.5" cy="-1.5" fill="#fff" opacity=".85"/></g>`;
const pane = (x, y, w, h, r) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#pane)" stroke="${S.pane[1]}" stroke-width="6"/>` +
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="none" stroke="url(#acc)" stroke-width="3"/>` +
  `<rect x="${x + 7}" y="${y + 7}" width="${w - 14}" height="${h - 14}" rx="${Math.max(4, r - 7)}" fill="none" stroke="${S.dark}" stroke-width="1.5" opacity=".9"/>`;
const border = () => {
  let d = '';
  for (let x = 40; x <= W - 40; x += 24) d += `<path d="M${x} 6 l6 6 l-6 6 l-6 -6 Z M${x} ${H - 18} l6 6 l-6 6 l-6 -6 Z"/>`;
  for (let y = 40; y <= H - 40; y += 24) d += `<path d="M12 ${y - 6} l6 6 l-6 6 l-6 -6 Z M${W - 12} ${y - 6} l6 6 l-6 6 l-6 -6 Z"/>`;
  return `<g fill="none" stroke="${S.dark}" stroke-width="1.4" opacity=".85">${d}</g>`;
};
// Halbton-Raster über dem Motiv (wie auf den bisherigen Karten), nicht bei Glitch
const halftone = RARITY === 'glitch' ? '' : '<rect x="24" y="24" width="672" height="960" fill="url(#dots)" opacity=".16"/>';

const EFFECTS = {
  // Risse über die ganze Karte und ein Kaffeering um das dritte Wertefenster
  crumpled: () =>
    '<g fill="none" stroke="#fff8e8" stroke-width="1.6" opacity=".55" stroke-linecap="round">' +
    '<path d="M0 220 L120 260 L210 248 L330 300 L470 286 L720 340"/><path d="M180 0 L210 120 L250 160 L238 300"/><path d="M720 610 L560 640 L470 700 L330 690 L190 760 L0 740"/>' +
    '<path d="M520 1008 L540 880 L500 800 L520 700"/><path d="M0 520 L90 500 L150 560"/></g>' +
    '<g fill="none" stroke="#3a2a14" stroke-width="1" opacity=".25"><path d="M0 222 L120 262 L210 250 L330 302 L470 288 L720 342"/><path d="M720 612 L560 642 L470 702 L330 692 L190 762 L0 742"/></g>' +
    '<circle cx="113" cy="694" r="58" fill="none" stroke="#7a5a32" stroke-width="5" opacity=".35"/><circle cx="116" cy="690" r="52" fill="none" stroke="#7a5a32" stroke-width="2" opacity=".3"/>',
  bfwler: () => '<rect x="24" y="24" width="672" height="960" fill="url(#cool)" opacity=".18"/>',
  // Glanz quer über die Karte
  gold: () => '<rect x="24" y="24" width="672" height="960" fill="url(#shine)" opacity=".45" style="mix-blend-mode:screen"/>',
  // holografischer Schimmer und kleine Funkel
  holo: () =>
    '<rect x="24" y="24" width="672" height="960" fill="url(#rainbow)" opacity=".5"/>' +
    '<rect x="24" y="24" width="672" height="960" fill="url(#shine)" opacity=".35"/>' +
    [[150, 180], [600, 260], [520, 520], [210, 610], [640, 720], [330, 140]].map(([x, y]) => `<path d="M${x} ${y - 9} L${x + 2.5} ${y - 2.5} L${x + 9} ${y} L${x + 2.5} ${y + 2.5} L${x} ${y + 9} L${x - 2.5} ${y + 2.5} L${x - 9} ${y} L${x - 2.5} ${y - 2.5} Z" fill="#fff" opacity=".85"/>`).join(''),
  bockhaber: () => '<rect x="24" y="24" width="672" height="960" fill="url(#violetGlow)" opacity=".35"/>',
  // Scanlines, Farbbalken an den Seiten (wie die bisherigen Glitch-Karten)
  glitch: () =>
    '<rect x="24" y="24" width="672" height="960" fill="url(#scan)" opacity=".5"/>' +
    '<rect x="0" y="150" width="9" height="58" fill="#ff3b5c"/><rect x="0" y="560" width="7" height="24" fill="#ff3b5c" opacity=".8"/>' +
    '<rect x="711" y="300" width="9" height="74" fill="#22d3ee"/><rect x="713" y="820" width="7" height="30" fill="#22d3ee" opacity=".8"/>',
};

const stats = SPELL ? '' : [432, 563, 691].map((cy) => pane(62, cy - 48, 100, 96, 18) + gem(162, cy)).join('');
const TEXT_Y = SPELL ? 712 : 772; // Spell: Textfenster höher (längerer Text, keine Werte)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="1">${accentStops}</linearGradient>
    <linearGradient id="pane" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${S.pane[0]}" stop-opacity=".93"/><stop offset="1" stop-color="${S.pane[1]}" stop-opacity=".96"/></linearGradient>
    <linearGradient id="band" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${S.band[0]}"/><stop offset=".5" stop-color="${S.band[1]}"/><stop offset="1" stop-color="${S.band[0]}"/></linearGradient>
    <radialGradient id="vignette" cx=".5" cy=".42" r=".78"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="${S.pane[1]}" stop-opacity=".72"/></radialGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="1" y2="1"><stop offset=".25" stop-color="#fff" stop-opacity="0"/><stop offset=".42" stop-color="#fff" stop-opacity=".55"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="rainbow" x1="0" y1="0" x2="1" y2="1">${(S.hue || ['#fff', '#fff']).map((c, i, a) => `<stop offset="${(i / (a.length - 1)).toFixed(2)}" stop-color="${c}"/>`).join('')}</linearGradient>
    <linearGradient id="cool" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe0ff"/><stop offset="1" stop-color="#1b2433"/></linearGradient>
    <radialGradient id="violetGlow" cx=".5" cy=".35" r=".7"><stop offset="0" stop-color="#e3d3ff" stop-opacity=".0"/><stop offset="1" stop-color="#5b2ea6"/></radialGradient>
    <pattern id="dots" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="3.5" cy="3.5" r="1.1" fill="${S.dark}"/></pattern>
    <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1.3" fill="#000"/></pattern>
    <mask id="frameMask"><rect width="${W}" height="${H}" fill="#fff"/><rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="14" fill="#000"/></mask>
  </defs>
  ${halftone}
  ${EFFECTS[RARITY]()}
  <rect width="${W}" height="${H}" fill="url(#vignette)"/>
  <rect width="${W}" height="${H}" fill="url(#band)" mask="url(#frameMask)"/>
  ${border()}
  <rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="10" fill="none" stroke="url(#acc)" stroke-width="2.5"/>
  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="14" fill="none" stroke="url(#acc)" stroke-width="3"/>
  <rect x="30" y="30" width="${W - 60}" height="${H - 60}" rx="10" fill="none" stroke="${S.dark}" stroke-width="1.5"/>
  ${gem(24, 24, 13)}${gem(W - 24, 24, 13)}${gem(24, H - 24, 13)}${gem(W - 24, H - 24, 13)}${gem(12, H / 2, 9)}${gem(W - 12, H / 2, 9)}
  <rect x="40" y="40" width="400" height="66" rx="26" fill="url(#pane)" stroke="${S.pane[1]}" stroke-width="6"/>
  <rect x="40" y="40" width="400" height="66" rx="26" fill="none" stroke="url(#acc)" stroke-width="3"/>
  <rect x="47" y="47" width="386" height="52" rx="20" fill="none" stroke="${S.dark}" stroke-width="1.5"/>
  ${stats}
  ${pane(62, TEXT_Y, 580, 952 - TEXT_Y, 24)}
  ${gem(352, TEXT_Y, 12)}
  <path d="M120 ${TEXT_Y} H330 M374 ${TEXT_Y} H584" stroke="${S.light}" stroke-width="1" opacity=".5"/>
  ${RARITY === 'crumpled' ? EFFECTS.crumpled().replace(/<circle[\s\S]*$/, '') : ''}
</svg>`;

(async () => {
  const out = sharp(await art()).composite([{ input: Buffer.from(svg) }]);
  await out.clone().webp({ quality: 88, effort: 6 }).toFile(DEST);
  if (PREVIEW) await out.clone().png().toFile(PREVIEW);
  console.log(`${RARITY}: ${DEST}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

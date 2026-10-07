// Seltenheits-Varianten einer Season-1-Karte mit türkisem Rahmen (720 × 1008) erzeugen:
// Footman (Original), Gold, Holo, Arcane. Die Rahmen-Geometrie unten ist an „Mark Suntouched“ gemessen.
// node scripts/rarity-variants.js <bild> <ausgabe-ordner> <karten-name>  ->  <name>-1-footman.webp … <name>-4-arcane.webp
const path = require('path');
const sharp = require('sharp');
const [SRC, OUT, BASE] = process.argv.slice(2);
const W = 720;
const H = 1008;

// Rahmen-Geometrie (gemessen): Außenband, Namensbalken, 3 Wertefenster, Textfenster, Edelsteine
const rr = (x1, y1, x2, y2, r) => `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" rx="${r}"/>`;
const gem = (cx, cy, r) => `<path d="M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z"/>`;
const GEMS = [[551, 97], [551, 216], [553, 334], [362, 792]];
const FRAME_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#000"/><g fill="#fff">` +
  `<path fill-rule="evenodd" d="M0 0H${W}V${H}H0Z M29 28H691V980H29Z"/>` +
  rr(39, 44, 444, 113, 32) +
  rr(546, 46, 658, 148, 22) + rr(546, 164, 658, 266, 22) + rr(546, 281, 658, 386, 22) +
  rr(74, 779, 653, 968, 26) +
  GEMS.map(([x, y]) => gem(x, y, 19)).join('') +
  '</g></svg>';

const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function rgb2hsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (!s) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
// Farbverlauf über die Helligkeit (Duotone/Tritone)
function ramp(stops, t) {
  t = clamp(t);
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i - 1];
    const [p2, c2] = stops[i];
    if (t <= p2) {
      const k = (t - p1) / (p2 - p1 || 1);
      return c1.map((v, j) => v + (c2[j] - v) * k);
    }
  }
  return stops[stops.length - 1][1];
}
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const screen = (a, b, k) => a.map((v, i) => v + (1 - (1 - v) * (1 - b[i]) - v) * k);

// Pixel-Klassen im Rahmen
const isTeal = (h, s, l) => h > 150 && h < 215 && s > 0.12 && l < 0.75;
const isGoldTrim = (h, s, l) => h > 25 && h < 60 && s > 0.4 && l > 0.3;
const isRedGem = (h, s, l, x, y) => (h < 20 || h > 340) && s > 0.45 && GEMS.some(([gx, gy]) => Math.abs(x - gx) + Math.abs(y - gy) < 20);
const isNameText = (h, s, l, x, y) => x > 80 && x < 400 && y > 55 && y < 102 && l > 0.72 && s < 0.25;

const VARIANTS = {
  // Gold: Bronze-Gold-Rahmen, warm vergoldetes Motiv
  gold: {
    frame(c, [h, s, l], x, y) {
      if (isNameText(h, s, l, x, y)) return hex('#ffe9a8');
      if (isRedGem(h, s, l, x, y)) return null;
      if (!isGoldTrim(h, s, l)) return ramp([[0, hex('#140c02')], [0.18, hex('#4a3208')], [0.38, hex('#a77a22')], [0.6, hex('#f3cf72')], [1, hex('#fff4cf')]], l * 1.55);
      if (isGoldTrim(h, s, l)) return mix(c, hex('#fff0bd'), 0.35);
      return null;
    },
    art(c) {
      const t = lum(...c);
      const g = ramp([[0, hex('#1c1103')], [0.35, hex('#7a5414')], [0.7, hex('#e2b45a')], [1, hex('#fff6d6')]], t);
      return mix(c, g, 0.62);
    },
  },
  // Holo: schillernder Regenbogen-Rahmen, Chrom statt Gold, Regenbogen-Glanz auf dem Motiv
  holo: {
    frame(c, [h, s, l], x, y) {
      const hue = 230 + 70 * Math.sin((x * 0.6 + y * 0.8) / 120);
      if (isNameText(h, s, l, x, y)) return [1, 1, 1];
      if (!isGoldTrim(h, s, l) && !isRedGem(h, s, l, x, y)) return hsl2rgb(hue, 0.45, clamp(0.16 + l * 0.95));
      if (isGoldTrim(h, s, l)) {
        const chrome = hsl2rgb(hue, 0.35, 0.55 + l * 0.35);
        return mix([l, l, l].map((v) => clamp(v * 1.15)), chrome, 0.55);
      }
      return null;
    },
    art(c, x, y) {
      const hue = (x * 0.4 + y * 0.55) % 360;
      const sheen = hsl2rgb(hue, 0.65, 0.7);
      // diagonale Lichtstreifen
      const band = Math.pow(Math.max(0, Math.sin((x + y * 0.8) / 46)), 6);
      let o = mix(c, [lum(...c), lum(...c), lum(...c)], 0.15);
      o = screen(o, sheen, 0.14 + band * 0.16);
      return o;
    },
  },
  // Arcane: violett-mystischer Rahmen, Motiv in Mondlicht-Violett, Runen-Halo und Funken (Overlay)
  arcane: {
    frame(c, [h, s, l], x, y) {
      if (isNameText(h, s, l, x, y)) return hex('#f1e4ff');
      if (isRedGem(h, s, l, x, y)) return hsl2rgb(185, 0.95, Math.min(0.85, 0.35 + l * 0.7));
      if (!isGoldTrim(h, s, l)) return ramp([[0, hex('#07030f')], [0.2, hex('#251046')], [0.42, hex('#5b2aa0')], [0.7, hex('#b48cff')], [1, hex('#f3eaff')]], l * 1.5);
      if (isGoldTrim(h, s, l)) return ramp([[0, hex('#3a1f63')], [0.5, hex('#b98bff')], [1, hex('#f4ecff')]], l);
      return null;
    },
    art(c) {
      const t = lum(...c);
      const v = ramp([[0, hex('#04010a')], [0.22, hex('#1a0938')], [0.48, hex('#4f259a')], [0.72, hex('#a27cf2')], [0.9, hex('#ebe0ff')], [1, hex('#ffffff')]], Math.pow(t, 1.2));
      return mix(c, v, 0.86);
    },
    overlay: arcaneOverlay,
  },
};

// Runen-Halo hinter Marks Kopf + Funken, als SVG (wird per "screen" aufgelegt)
function arcaneOverlay() {
  const cx = 282, cy = 318;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>` +
    `<radialGradient id="g" cx="${cx}" cy="${cy}" r="230" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9b6bff" stop-opacity=".32"/><stop offset=".55" stop-color="#4a1fa0" stop-opacity=".1"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>` +
    `<filter id="b"><feGaussianBlur stdDeviation="5"/></filter></defs>` +
    `<rect width="${W}" height="${H}" fill="#000"/><circle cx="${cx}" cy="${cy}" r="230" fill="url(#g)"/>`;
  const ring = (r, w, o) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#d9c2ff" stroke-width="${w}" stroke-opacity="${o}"/>`;
  let runes = '';
  // Runen aus einfachen Strichen (keine Schrift nötig): 24 Zeichen auf dem Ring
  const R = 150;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
    const deg = (a * 180) / Math.PI + 90;
    const k = i % 4;
    const p = k === 0 ? 'M0 -9 V9 M0 -9 L6 -3 M0 -1 L6 5' : k === 1 ? 'M-5 9 L0 -9 L5 9 M-3 2 H3' : k === 2 ? 'M0 -9 V9 M-6 -9 L6 9' : 'M-5 -9 L5 0 L-5 9 M5 -9 V9';
    runes += `<path transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${deg.toFixed(1)})" d="${p}" fill="none" stroke="#eadcff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  const halo = ring(R + 18, 2, 0.7) + ring(R - 18, 2, 0.7) + ring(R + 26, 1, 0.4) + runes;
  s += `<g filter="url(#b)">${halo}</g><g filter="url(#b)">${halo}</g><g opacity=".85">${halo}</g>`;
  // Funken: kleine Vierstrahl-Sterne, feste Positionen (Pseudo-Zufall mit Seed)
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 46; i++) {
    const x = 40 + rnd() * 640, y = 125 + rnd() * 640, r = 2.5 + rnd() * 7;
    if (x > 540 && y < 395) continue; // nicht auf die Wertefenster
    const op = (0.45 + rnd() * 0.55).toFixed(2);
    s += `<path d="M${x} ${y - r} Q${x} ${y} ${x + r} ${y} Q${x} ${y} ${x} ${y + r} Q${x} ${y} ${x - r} ${y} Q${x} ${y} ${x} ${y - r}Z" fill="#f2e8ff" opacity="${op}"/>`;
    s += `<circle cx="${x}" cy="${y}" r="${(r * 1.6).toFixed(1)}" fill="#a77bff" opacity="${(op * 0.25).toFixed(2)}"/>`;
  }
  return Buffer.from(s + '</svg>');
}

(async () => {
  const { data } = await sharp(SRC).resize(W, H).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = (await sharp(Buffer.from(FRAME_SVG)).blur(0.8).extractChannel(0).raw().toBuffer());
  const FILES = { footman: 1, gold: 2, holo: 3, arcane: 4 };
  const file = (k) => path.join(OUT, `${BASE}-${FILES[k]}-${k}.webp`);
  await sharp(SRC).resize(W, H).webp({ quality: 88 }).toFile(file('footman'));
  for (const [key, v] of Object.entries(VARIANTS)) {
    const buf = Buffer.alloc(W * H * 3);
    let over = null;
    if (v.overlay) over = await sharp(v.overlay()).flatten({ background: '#000' }).removeAlpha().raw().toBuffer();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const c = [data[i * 3] / 255, data[i * 3 + 1] / 255, data[i * 3 + 2] / 255];
        const m = mask[i] / 255;
        let a = v.art(c, x, y);
        if (over && m < 1) {
          const o = [over[i * 3] / 255, over[i * 3 + 1] / 255, over[i * 3 + 2] / 255];
          a = screen(a, o, 1 - m);
        }
        let f = c;
        if (m > 0) {
          const r = v.frame(c, rgb2hsl(...c), x, y);
          f = r || c;
        }
        const px = mix(a, f, m);
        for (let j = 0; j < 3; j++) buf[i * 3 + j] = Math.round(clamp(px[j]) * 255);
      }
    }
    await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).webp({ quality: 88 }).toFile(file(key));
  }
  const keys = Object.keys(FILES);
  const imgs = await Promise.all(keys.map((k) => sharp(file(k)).resize(360, 504).png().toBuffer()));
  await sharp({ create: { width: 360 * keys.length, height: 504, channels: 3, background: '#000' } })
    .composite(imgs.map((b, i) => ({ input: b, left: i * 360, top: 0 })))
    .png()
    .toFile(path.join(OUT, `${BASE}-uebersicht.png`));
  console.log(keys.map(file).join('\n'));
})();

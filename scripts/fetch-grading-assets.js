// Grafiken für den Grading-Schreibtisch (#204) holen und nach public/img/grading legen:
//   Pixel-Icons aus „496 pixel art icons for medieval/fantasy RPG“ (Henrique Lazarini, CC0) für die Stationen,
//   Pixel-Rahmen und -Knöpfe aus Kenneys „Pixel UI Pack“ (CC0) für das Namensschild, Poly Haven (CC0) für das Holz.
// Einmalig bzw. bei neuen Icons ausführen: node scripts/fetch-grading-assets.js – die Dateien werden committet, die
// Seite lädt nichts von außen. Die Icons bleiben in Originalgröße (34 × 34 px); scharf vergrößert wird per CSS
// (image-rendering: pixelated). Quellen und Lizenzen: public/img/grading/LICENSES.md (wird mitgeschrieben).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'public', 'img', 'grading');
const ICONS_ZIP = 'https://opengameart.org/sites/default/files/496_RPG_icons.zip';
// Datei im Projekt → Icon im Set
const ICONS = {
  scroll: 'I_Scroll02', // Eingang: versiegelte Rolle = Auftrag
  'scroll-open': 'I_Scroll', // Aufträge heute
  book: 'W_Book01', // Kassenbuch (Bons)
  coin: 'I_GoldCoin', // Preise, heute verdient
  heart: 'S_Holy01', // Bewertungen
  hammer: 'W_Mace003', // Werkstatt
  medal: 'Ac_Medal01', // Erfolge
  fire: 'S_Fire03', // Bügeln, Profi-Bügeleisen
  chest: 'I_Chest01', // Einreichen
  clock: 'I_Clock', // Feierabend
  key: 'I_Key01', // gesperrt
  diamond: 'I_Diamond', // Vitrine
  fabric: 'I_Fabric', // Mikrofasertuch
  mirror: 'I_Mirror', // Zentrierschablone (Lupe)
  torch: 'I_Torch01', // UV-Lampe
};
// Kenney „Pixel UI Pack“: Datei → Pfad im ZIP (9-Slice-Grafiken, 48 bzw. 44 px; CSS border-image, 3-fach)
const UI_ZIP = 'https://kenney.nl/media/pages/assets/pixel-ui-pack/821e760f21-1677661508/kenney_pixel-ui-pack.zip';
const UI = {
  'ui-plate': '9-Slice/Ancient/tan.png', // Namensschild
  'ui-inlay': '9-Slice/Ancient/brown_inlay.png', // Felder im Schild (Fortschritt, Ressourcen) – abgedunkelt, s. DARKEN
  'ui-button': '9-Slice/Colored/yellow.png', // Knopf „Tour“
  'ui-button-pressed': '9-Slice/Colored/yellow_pressed.png',
  'ui-stamp': '9-Slice/Outline/red.png', // Kürzel-Stempel
};
// Abgedunkelt (Helligkeit), damit helle Schrift darauf den WCAG-Kontrast 4,5:1 erreicht
const DARKEN = { 'ui-inlay': 0.62 };
// Poly Haven: Datei → Asset (Diffuse, 1k) – Tischplatte, per CSS zu dunklem Nussbaum abgedunkelt
const TEXTURES = { wood: 'black_walnut_veneer_02' };

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Dateien aus einem ZIP lesen (zentrales Verzeichnis, stored/deflate) → Map Pfad im ZIP → Buffer */
function unzip(buf) {
  const files = new Map();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('kein ZIP');
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = buf.readUInt16LE(eocd + 10); i > 0; i--) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    p += 46 + nameLen + extra + comment;
  }
  return files;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const rows = [];
  const zip = unzip(await get(ICONS_ZIP));
  for (const [file, icon] of Object.entries(ICONS)) {
    const png = [...zip].find(([name]) => path.basename(name) === `${icon}.png`)?.[1];
    if (!png) throw new Error(`Icon fehlt im Set: ${icon}`);
    await sharp(png).png({ compressionLevel: 9 }).toFile(path.join(OUT, `${file}.png`));
    rows.push(`| ${file}.png | „496 pixel art icons for medieval/fantasy RPG“: ${icon} | CC0 |`);
    console.log('✓', file);
  }
  const ui = unzip(await get(UI_ZIP));
  for (const [file, entry] of Object.entries(UI)) {
    const png = ui.get(entry);
    if (!png) throw new Error(`Datei fehlt im Pixel UI Pack: ${entry}`);
    await (DARKEN[file] ? sharp(png).modulate({ brightness: DARKEN[file] }) : sharp(png)).png({ compressionLevel: 9 }).toFile(path.join(OUT, `${file}.png`));
    rows.push(`| ${file}.png | Kenney „Pixel UI Pack“: ${entry} | CC0${DARKEN[file] ? ` (abgedunkelt auf ${DARKEN[file] * 100} %)` : ''} |`);
    console.log('✓', file);
  }
  for (const [file, asset] of Object.entries(TEXTURES)) {
    const files = await (await fetch(`https://api.polyhaven.com/files/${asset}`)).json();
    await sharp(await get(files.Diffuse['1k'].jpg.url)).resize(1024, 1024).webp({ quality: 78 }).toFile(path.join(OUT, `${file}.webp`));
    rows.push(`| ${file}.webp | Poly Haven „${asset}“ (Diffuse, 1k) | CC0 |`);
    console.log('✓', file);
  }
  const md = `# Grafiken des Grading-Schreibtischs (#204)

Erzeugt mit \`node scripts/fetch-grading-assets.js\`. Pixel-Icons und -Rahmen unverändert in Originalgröße, die
Holztextur auf 1024 px verkleinert und nach WebP umgewandelt.

| Datei | Quelle | Lizenz |
|---|---|---|
${rows.join('\n')}

- Pixel-Icons: Henrique Lazarini (7Soul1), „496 pixel art icons for medieval/fantasy RPG“,
  https://opengameart.org/content/496-pixel-art-icons-for-medievalfantasy-rpg – CC0 1.0 (gemeinfrei).
- Pixel-Rahmen und -Knöpfe: Kenney, „Pixel UI Pack“, https://kenney.nl/assets/pixel-ui-pack – CC0 1.0 (gemeinfrei).
- Holz: Poly Haven, https://polyhaven.com – CC0 1.0 (gemeinfrei).
`;
  fs.writeFileSync(path.join(OUT, 'LICENSES.md'), md);
  console.log('fertig:', OUT);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

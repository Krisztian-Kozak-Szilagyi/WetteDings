// Grafiken für den Grading-Schreibtisch (#204) holen und als WebP nach public/img/grading legen:
//   Fluent Emoji 3D (Microsoft, MIT) für die Objekte, Poly Haven (CC0) für das Holz.
// Einmalig bzw. bei neuen Objekten ausführen: node scripts/fetch-grading-assets.js – die WebP-Dateien werden committet,
// die Seite lädt nichts von außen. Quellen und Lizenzen: public/img/grading/LICENSES.md (wird mitgeschrieben).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'public', 'img', 'grading');
const FLUENT = 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets';
// Datei im Projekt → Ordner bei Fluent (Dateiname dort: <ordner klein, Leerzeichen → _>_3d.png)
const EMOJI = {
  inbox: 'Inbox tray',
  envelope: 'Envelope',
  'envelope-arrow': 'Envelope with arrow',
  receipt: 'Receipt',
  pushpin: 'Pushpin',
  phone: 'Mobile phone',
  clipboard: 'Clipboard',
  toolbox: 'Toolbox',
  trophy: 'Trophy',
  package: 'Package',
  coffee: 'Hot beverage',
  coin: 'Coin',
  sponge: 'Sponge',
  ruler: 'Triangular ruler',
  fire: 'Fire',
  flashlight: 'Flashlight',
  mailbox: 'Open mailbox with lowered flag',
  speech: 'Speech balloon',
  locked: 'Locked',
  star: 'Star',
  'file-box': 'Card file box',
  card: 'Joker', // eigene Karten bügeln (Fluent hat kein Bügeleisen)
};
// Poly Haven: Datei → Asset (Diffuse, 1k) – Tischplatte, per CSS zu dunklem Nussbaum abgedunkelt
const TEXTURES = { wood: 'black_walnut_veneer_02' };

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const rows = [];
  for (const [file, folder] of Object.entries(EMOJI)) {
    const url = `${FLUENT}/${encodeURIComponent(folder)}/3D/${folder.toLowerCase().replace(/ /g, '_')}_3d.png`;
    await sharp(await get(url)).resize(192, 192).webp({ quality: 88, alphaQuality: 90 }).toFile(path.join(OUT, `${file}.webp`));
    rows.push(`| ${file}.webp | Fluent Emoji 3D „${folder}“ | MIT, © Microsoft Corporation |`);
    console.log('✓', file);
  }
  for (const [file, asset] of Object.entries(TEXTURES)) {
    const files = await (await fetch(`https://api.polyhaven.com/files/${asset}`)).json();
    const url = files.Diffuse['1k'].jpg.url;
    await sharp(await get(url)).resize(1024, 1024).webp({ quality: 78 }).toFile(path.join(OUT, `${file}.webp`));
    rows.push(`| ${file}.webp | Poly Haven „${asset}“ (Diffuse, 1k) | CC0 |`);
    console.log('✓', file);
  }
  const md = `# Grafiken des Grading-Schreibtischs (#204)

Erzeugt mit \`node scripts/fetch-grading-assets.js\` (auf 192 px bzw. 1024 px verkleinert, nach WebP umgewandelt,
sonst unverändert).

| Datei | Quelle | Lizenz |
|---|---|---|
${rows.join('\n')}

- Fluent Emoji: https://github.com/microsoft/fluentui-emoji – MIT License, Copyright (c) Microsoft Corporation.
  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
  documentation files, to deal in the Software without restriction, subject to including the copyright notice and
  this permission notice in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
  WITHOUT WARRANTY OF ANY KIND.
- Poly Haven: https://polyhaven.com – CC0 1.0 (gemeinfrei).
`;
  fs.writeFileSync(path.join(OUT, 'LICENSES.md'), md);
  console.log('fertig:', OUT);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

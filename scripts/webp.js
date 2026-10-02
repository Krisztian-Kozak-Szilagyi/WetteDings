// Wandelt PNG/JPG-Bilder in WebP um und entfernt danach das Original: "npm run webp".
// Neue Karten können also weiter als PNG nach public/img/tcg gelegt werden – einmal laufen lassen, fertig.
// Mauszeiger bleiben PNG (Browser unterstützen WebP dort nicht zuverlässig).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', 'public', 'img');
const DIRS = ['tcg', 'ihk'];
const QUALITY = 90;

async function main() {
  let before = 0;
  let after = 0;
  let count = 0;
  for (const sub of DIRS) {
    const dir = path.join(ROOT, sub);
    for (const file of fs.readdirSync(dir)) {
      if (!/\.(png|jpe?g)$/i.test(file)) continue;
      const src = path.join(dir, file);
      const dest = path.join(dir, file.replace(/\.[^.]+$/, '.webp'));
      await sharp(src).webp({ quality: QUALITY, alphaQuality: 100, effort: 6 }).toFile(dest);
      const a = fs.statSync(src).size;
      const b = fs.statSync(dest).size;
      fs.unlinkSync(src);
      before += a;
      after += b;
      count++;
      console.log(`${sub}/${file}: ${(a / 1024).toFixed(0)} KB -> ${(b / 1024).toFixed(0)} KB`);
    }
  }
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  console.log(count ? `${count} Bilder: ${mb(before)} MB -> ${mb(after)} MB` : 'Nichts umzuwandeln.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

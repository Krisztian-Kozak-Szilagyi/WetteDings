// Symbole der Erfolge (src/achievements/icons.js): /img/erfolge/<key>.svg, /img/erfolge/geheim.svg
// Liegt vor Session und Login – wie die Kartenbilder öffentlich (die Symbole verraten keine Bedingung).
const express = require('express');
const config = require('../config');
const icons = require('../achievements/icons');
const { ACHIEVEMENTS } = require('../achievements/list');

const router = express.Router();
const SECRET = { glyph: 'secret', tone: 'silver', frame: 'silver' };
// Alle Symbole einmal beim Start zeichnen (feste Liste)
const files = new Map([...ACHIEVEMENTS.map((a) => [a.key, icons.render(a.icon)]), ['geheim', icons.render(SECRET)]]);

router.get('/img/erfolge/:file', (req, res, next) => {
  const m = /^([a-z0-9-]+)\.svg$/.exec(req.params.file);
  const body = m ? files.get(m[1]) : null;
  if (!body) return next();
  res.set({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'",
    'Cache-Control': config.isProd ? 'public, max-age=604800' : 'no-cache',
  });
  res.send(body);
});

module.exports = router;

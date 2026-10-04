// Bilder der Rahmen-Karten (src/tcg/cardSvg.js): /img/tcg/karte/<id>.svg[?fia=110…]
// Liegt vor Session und Login – wie die übrigen Kartenbilder öffentlich.
const express = require('express');
const config = require('../config');
const catalog = require('../tcg/catalog');
const cardSvg = require('../tcg/cardSvg');

const router = express.Router();
const cache = new Map(); // fertige SVGs je Karte und Werte (wenige Varianten, daher ohne Verfall)
const MAX_CACHE = 500;

router.get('/img/tcg/karte/:file', (req, res, next) => {
  const m = /^([a-z0-9-]+)\.svg$/.exec(req.params.file);
  const card = m && Object.prototype.hasOwnProperty.call(catalog.cardById, m[1]) ? catalog.cardById[m[1]] : null;
  if (!card || !card.frame) return next();
  const values = cardSvg.valuesFromQuery(req.query);
  const key = `${card.id}|${cardSvg.STAT_KEYS.map((k) => values[k] ?? '').join(',')}`;
  let body = cache.get(key);
  if (!body) {
    body = cardSvg.render(card, values);
    if (cache.size < MAX_CACHE) cache.set(key, body);
  }
  res.set({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    // Das SVG lädt nichts nach und führt nichts aus: nur das eingebettete Bild ist erlaubt
    'Content-Security-Policy': "default-src 'none'; img-src data:",
    'Cache-Control': config.isProd ? 'public, max-age=604800' : 'no-cache',
  });
  res.send(body);
});

module.exports = router;

// Shop-Demo: erster Test, wie sich Laufen im eigenen Laden anfühlt (leerer Laden, WASD). Vorerst nur für Admins.
// EJS ist nur der Rahmen, Laden und Figur werden in public/js/shop-demo.js auf ein Canvas gezeichnet.
const express = require('express');
const { requireAdmin } = require('../middleware');

const router = express.Router();

router.get('/shop-demo', requireAdmin, (req, res) => {
  res.render('shop-demo', { title: 'Shop-Demo' });
});

module.exports = router;

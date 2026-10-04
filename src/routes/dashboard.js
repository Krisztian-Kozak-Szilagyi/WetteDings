// Startseite: Gäste sehen die Landing-Page, Mitglieder ihr Dashboard (services/dashboardService)
const express = require('express');
const dashboard = require('../services/dashboardService');
const catalog = require('../tcg/catalog');

const router = express.Router();

router.get('/', async (req, res) => {
  if (!req.user) return res.render('landing', { title: 'Willkommen' });
  // Alte Links auf die Wett-Übersicht (/?tab=…, /?q=…, /?seite=…) zeigen jetzt auf /wetten
  if (['tab', 'q', 'seite'].some((k) => k in req.query)) {
    const qs = new URLSearchParams(Object.entries(req.query).filter(([k, v]) => ['tab', 'q', 'seite'].includes(k) && typeof v === 'string')).toString();
    return res.redirect(301, `/wetten${qs ? `?${qs}` : ''}`);
  }
  res.render('dashboard', { title: 'Dashboard', dash: await dashboard.load(req.user), rarityByKey: catalog.rarityByKey });
});

module.exports = router;

// Startseite: Gäste sehen die Landing-Page, Mitglieder die Taverne (views/hub.ejs, Daten: services/dashboardService)
const express = require('express');
const dashboard = require('../services/dashboardService');

const router = express.Router();

router.get('/', async (req, res) => {
  if (!req.user) return res.render('landing', { title: 'Willkommen' });
  // Alte Links auf die Wett-Übersicht (/?tab=…, /?q=…, /?seite=…) zeigen jetzt auf /wetten
  if (['tab', 'q', 'seite'].some((k) => k in req.query)) {
    const qs = new URLSearchParams(Object.entries(req.query).filter(([k, v]) => ['tab', 'q', 'seite'].includes(k) && typeof v === 'string')).toString();
    return res.redirect(301, `/wetten${qs ? `?${qs}` : ''}`);
  }
  res.render('hub', { title: 'Taverne', dash: await dashboard.load(req.user) });
});

module.exports = router;

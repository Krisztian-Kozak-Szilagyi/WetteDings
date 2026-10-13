// Kosmetik-Shop: Avatare (später Banner, Rahmen, Namensschilder …) gegen Konfetti aus zerkleinerten Karten
const express = require('express');
const { requireLogin } = require('../middleware');
const cosmetics = require('../cosmetics/cosmeticService');
const { str, UserError } = require('../lib/util');

const router = express.Router();
router.use('/kosmetik', requireLogin);

router.get('/kosmetik', (req, res) => {
  res.render('kosmetik', {
    title: 'Kosmetik',
    kinds: cosmetics.shop(req.user),
    konfetti: req.user.konfetti || 0,
  });
});

/** Aktion ausführen, Fehler als Meldung, zurück zum Eintrag im Shop (Anker nur aus der festen Liste) */
async function shopAction(req, res, fn) {
  const it = cosmetics.item(str(req.body.art), str(req.body.key));
  try {
    await fn(it);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect(it ? `/kosmetik#${it.kind}-${it.key}` : '/kosmetik');
}

router.post('/kosmetik/kaufen', (req, res) =>
  shopAction(req, res, async (it) => {
    if (!it) throw new UserError('Diesen Gegenstand gibt es nicht.');
    await cosmetics.buy({ user: req.user, kind: it.kind, key: it.key });
  })
);

// Gekauften Avatar gleich als Profilbild tragen
router.post('/kosmetik/tragen', (req, res) =>
  shopAction(req, res, async (it) => {
    if (!it || it.kind !== 'avatar') throw new UserError('Diesen Avatar gibt es nicht.');
    await cosmetics.wearAvatar({ user: req.user, key: it.key });
  })
);

module.exports = router;

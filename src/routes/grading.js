const express = require('express');
const { requireLogin } = require('../middleware');
const grading = require('../grading/gradingService');
const catalog = require('../tcg/catalog');
const { str, UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');

const router = express.Router();

// Zugang: für alle, wenn im Admin-Panel freigegeben – sonst nur Admins
function requireGrading(req, res, next) {
  if (grading.settings.open || req.user.isAdmin) return next();
  if (req.method !== 'GET') {
    req.flash('error', 'Der Grading-Shop ist derzeit nicht verfügbar.');
    return res.redirect('/grading');
  }
  res.render('error', { title: 'Grading', status: 'Grading', message: 'Der Grading-Shop ist derzeit nicht verfügbar. Schau später wieder vorbei!' });
}
router.use('/grading', requireLogin, requireGrading);

router.get('/grading', async (req, res) => {
  const state = await grading.getState(req.user._id);
  const job = state.open;
  const card = job ? catalog.cardById[job.card] : null;
  res.render('grading', {
    title: 'Grading-Shop',
    ...state,
    levels: grading.LEVELS.map((l) => grading.levelInfo(l.level)),
    pay: grading.PAY,
    contractDays: grading.CONTRACT_DAYS,
    closedForOthers: !grading.settings.open,
    // Für den Arbeitstisch (public/js/grading.js) – die echte Note bleibt auf dem Server
    jobData: job
      ? {
          steps: grading.levelInfo(job.level).steps,
          card: card ? { name: card.name, image: card.image, rarity: card.rarity, rarityLabel: catalog.rarityByKey[card.rarity].label, rank: catalog.rarityByKey[card.rarity].rank } : null,
          customer: job.customer,
          cert: String(parseInt(String(job._id).slice(-7), 16) % 100000000).padStart(8, '0'), // Zertifikatsnummer fürs Slab-Etikett
          spots: job.spots,
          defects: job.defects,
          minMs: job.spots.length * grading.MS_PER_SPOT,
          startedAt: new Date(job.createdAt).getTime(),
          // schon benotet (z. B. nach Neuladen): Note und Auflösung gleich anzeigen
          guess: job.guess,
          grade: job.guess !== null ? job.grade : null,
        }
      : null,
    // Schaukarte für die Vorstellung (eine Holo-Karte, falls vorhanden)
    heroCard: (catalog.cardsByRarity.holo[0] || catalog.CARDS[0] || {}).image || '',
    doneCards: state.done.map((j) => ({ ...j, cardInfo: catalog.cardById[j.card] || null })),
  });
});

async function handle(req, res, fn) {
  try {
    const msg = await fn();
    if (msg) req.flash('success', msg);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/grading');
}

router.post('/grading/annehmen', (req, res) =>
  handle(req, res, async () => {
    if (req.body.confirm !== '1') throw new UserError('Bitte bestätige, dass du die Vertragsbedingungen gelesen hast.');
    await grading.hire({ user: req.user });
    return `Willkommen im Grading-Shop! Dein Vertrag läuft ${grading.CONTRACT_DAYS} Tage – so lange gibt es keinen Tagesbonus, dafür Lohn für jeden Auftrag.`;
  })
);

router.post('/grading/kuendigen', (req, res) =>
  handle(req, res, async () => {
    await grading.quit({ user: req.user });
    return 'Du hast gekündigt. Ab dem nächsten Tag bekommst du wieder den Tagesbonus.';
  })
);

router.post('/grading/ausbauen', (req, res) =>
  handle(req, res, async () => {
    const next = await grading.upgrade({ user: req.user });
    return `Ausgebaut: Stufe ${next.level} – „${next.name}“!`;
  })
);

router.post('/grading/auftrag', (req, res) =>
  handle(req, res, async () => {
    await grading.takeJob({ user: req.user });
    return null;
  })
);

// Note festlegen (vom Arbeitstisch per fetch) – Antwort: echte Note für die Auflösung
router.post('/grading/benoten', async (req, res) => {
  try {
    res.json(await grading.setGuess({ user: req.user, guess: Number.parseInt(str(req.body.grade), 10) }));
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

router.post('/grading/zuruecksenden', (req, res) =>
  handle(req, res, async () => {
    const clean = Number(str(req.body.clean));
    const seal = Number(str(req.body.seal));
    const job = await grading.finishJob({ user: req.user, clean, seal });
    let msg = `Zurück an ${job.customer} – ${euro(job.pay)} Lohn.`;
    if (job.clean < 100) msg += ` Die Karte war erst zu ${job.clean} % sauber – das hat Lohn gekostet.`;
    return msg;
  })
);

module.exports = router;

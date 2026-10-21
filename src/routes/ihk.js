const express = require('express');
const { requireLogin } = require('../middleware');
const catalog = require('../tcg/catalog');
const ihk = require('../ihk/ihkService');
const { questById, difficulty, isHybrid } = require('../ihk/quests');
const { canBoost, isDog, isMatze, isAleks, who, DOG_MATZE, ALEKS } = require('../ihk/abilities');
const { usedCards, pickShortcuts } = require('../lib/pickShortcuts');
const { copiesByCard, lockLabel } = require('../tcg/locks');
const { str, UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');

const router = express.Router();

// Zugang: für alle, wenn im Admin-Panel freigegeben – sonst nur Admins
function requireIhk(req, res, next) {
  if (ihk.settings.open || req.user.isAdmin) return next();
  if (req.method !== 'GET') {
    req.flash('error', 'Die IHK ist derzeit nicht verfügbar.');
    return res.redirect('/ihk');
  }
  res.render('error', { title: 'IHK', status: 'IHK', message: 'Die IHK ist derzeit nicht verfügbar. Schau später wieder vorbei!' });
}
router.use('/ihk', requireLogin, requireIhk);

/** Quest + Schwierigkeit für die Anzeige */
const questView = (questId, level) => {
  const q = questById[questId];
  const d = difficulty(level);
  return { ...q, hybrid: isHybrid(q), difficulty: level, level: d.label, required: ihk.requiredFor(level, q), reward: ihk.rewardFor(level, q), duration: ihk.durationFor(level, q) };
};

router.get('/ihk', async (req, res) => {
  const { running, used, limit } = await ihk.getState(req.user._id);
  let phase = 'offer';
  if (running) phase = new Date(running.endsAt).getTime() <= Date.now() ? 'result' : 'running';

  const offers = running ? [] : (await ihk.getOffers(req.user._id)).map((o) => questView(o.quest, o.difficulty));
  const canReroll = !running && used < limit && (await ihk.canReroll(req.user._id));
  // Gesperrte Exemplare (Dungeon, Handel, Duell) werden markiert – wählbar bleibt eine Karte, solange noch ein
  // Exemplar frei ist (lockInfo: { cardId: { free, n, label } }). Folierte spielen mit (#204, foiled: freie folierte)
  const copies = await copiesByCard(req.user._id, { foil: true });
  const owned = Object.keys(copies);
  const lockInfo = Object.fromEntries(Object.entries(copies).filter(([, e]) => e.locked).map(([id, e]) => [id, { free: e.free + e.foiled, n: e.locked, label: lockLabel(e.reason) }]));
  const foiled = Object.fromEntries(Object.entries(copies).filter(([, e]) => e.foiled).map(([id, e]) => [id, e.foiled]));
  const rank = (c) => catalog.rarityByKey[c.rarity].rank;
  const all = owned.map((id) => catalog.cardById[id]).filter(Boolean);
  const cards = all.filter((c) => c.isCharacter).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name, 'de'));
  const items = all.filter((c) => !c.isCharacter && canBoost(c)).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name, 'de'));

  // Favoriten oben; ohne Favoriten ein Knopf mit den am häufigsten gespielten Karten
  const usage = phase === 'offer' ? await usedCards(req.user._id, 'ihk') : { card: [], boost: [] };
  const shortcuts = { card: pickShortcuts(cards, req.user.tcgFavorites, usage.card), boost: pickShortcuts(items, req.user.tcgFavorites, usage.boost) };

  res.render('ihk', {
    title: 'IHK',
    shortcuts,
    lockInfo,
    foiled,
    phase,
    run: running,
    quest: running ? questView(running.quest, running.difficulty) : null,
    offers,
    canReroll,
    runCard: running ? catalog.cardById[running.card] : null,
    // Kartenbilder mit geänderten Werten (Boost/Debuff) für die Wiedergabe – nur Rahmen-Karten
    runImages: running ? catalog.statImages(catalog.cardById[running.card], running.ticks) : {},
    runBoost: running && running.boost ? catalog.cardById[running.boost] : null,
    runBoost2: running && running.boost2 ? catalog.cardById[running.boost2] : null,
    runDog: running && running.dog ? catalog.cardById[running.dog] : null,
    // Treue Seele an Matze: Bild des Hundes mit den neuen Werten, sobald die Fähigkeit wirkt (je Hund, Karten-ID → Bild)
    dogImages: running ? Object.fromEntries((running.abilities || []).filter((a) => a.dog && catalog.cardById[a.dog]).map((a) => [a.dog, catalog.cardImage(catalog.cardById[a.dog], { fia: DOG_MATZE, fis: DOG_MATZE, bwl: DOG_MATZE })])) : {},
    cards,
    items,
    rarityByKey: catalog.rarityByKey,
    canBoost,
    isDog,
    isMatze,
    isAleks,
    aleksMax: ALEKS.maxMoney / 100,
    aleksCost: ALEKS.cost / 100,
    aleksPlus: ALEKS.plus,
    who,
    used,
    limit,
    closedForOthers: !ihk.settings.open,
    workTime: ihk.WORK_TIME,
  });
});

router.get('/ihk/anleitung', (req, res) => res.render('ihk-anleitung', { title: 'IHK – So funktioniert\'s' }));

async function handle(req, res, fn) {
  try {
    const msg = await fn();
    if (msg) req.flash('success', msg);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/ihk');
}

router.post('/ihk/start', (req, res) =>
  handle(req, res, async () => {
    await ihk.start({
      user: req.user,
      cardId: str(req.body.card),
      boostId: str(req.body.boost) || null,
      boost2Id: str(req.body.boost2) || null,
      dogId: str(req.body.dog) || null,
      coins: Number.parseInt(str(req.body.coins), 10) || 0,
      offerIndex: Number.parseInt(str(req.body.offer), 10),
      foiled: str(req.body.foil) === '1',
    });
    return null;
  })
);

router.post('/ihk/neu-wuerfeln', (req, res) =>
  handle(req, res, async () => {
    await ihk.reroll({ user: req.user });
    return 'Neue Quests ausgewürfelt.';
  })
);

router.post('/ihk/abholen', (req, res) =>
  handle(req, res, async () => {
    const run = await ihk.collect({ user: req.user });
    // Aleks: was er verworfen hat und was zurückkommt
    const c = run.coins;
    const coins = c ? ` Aleks hat ${c.spent / c.budget === 1 ? 'sein ganzes Geld' : euro(c.spent)} verworfen (${c.heads}× Kopf)${run.$locals.coinsBack ? `, ${euro(run.$locals.coinsBack)} kommen zurück` : ''}.` : '';
    if (!run.success) return coins ? coins.trim() : null;
    const pack = run.pack ? ' Außerdem hast du ein Booster Pack gefunden – es liegt bei deinen Packs im TCG!' : '';
    return `Quest geschafft – ${euro(run.reward)} wurden dir gutgeschrieben.${pack}${coins}`;
  })
);

module.exports = router;

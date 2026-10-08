const express = require('express');
const { requireLogin } = require('../middleware');
const esports = require('../esports/esportsService');
const league = require('../esports/league');
const { str, UserError } = require('../lib/util');

const router = express.Router();

// Zugang wie beim Mage Tower: für alle, wenn Dungeon und Turm freigegeben sind – sonst nur Admins
function requireEsports(req, res, next) {
  if (esports.isOpen(req.user)) return next();
  if (req.method !== 'GET') {
    req.flash('error', 'eSports ist derzeit nicht verfügbar.');
    return res.redirect('/');
  }
  res.render('error', { title: 'eSports', status: 'eSports', message: 'eSports ist derzeit nicht verfügbar. Schau später wieder vorbei!' });
}
router.use('/esports', requireLogin, requireEsports);

router.get('/esports', async (req, res) => {
  const [teams, mine, invites, week] = await Promise.all([esports.list(), esports.teamOfUser(req.user._id), esports.invitesFor(req.user._id), esports.lastWeek()]);
  res.render('esports', {
    title: 'eSports',
    teams,
    mine,
    isCaptain: !!mine && mine.captain.equals(req.user._id),
    invites,
    week,
    rules: league,
    prizes: esports.prizeList(),
    minTeams: esports.settings.minTeams,
    nextReport: new Date(esports.weekStart().getTime() + 7 * 24 * 60 * 60 * 1000),
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
  res.redirect('/esports');
}

router.post('/esports/gruenden', (req, res) =>
  handle(req, res, async () => {
    const team = await esports.found({ user: req.user, name: str(req.body.name), ticker: str(req.body.ticker) });
    return `Team „${team.name}“ gegründet.`;
  })
);
router.post('/esports/einladen', (req, res) => handle(req, res, () => esports.invite({ user: req.user, username: str(req.body.username) })));
router.post('/esports/einladung-zurueck', (req, res) => handle(req, res, () => esports.cancelInvite({ user: req.user, userId: str(req.body.user) })));
router.post('/esports/annehmen', (req, res) => handle(req, res, () => esports.accept({ user: req.user, teamId: str(req.body.team) })));
router.post('/esports/ablehnen', (req, res) => handle(req, res, () => esports.decline({ user: req.user, teamId: str(req.body.team) })));
router.post('/esports/austreten', (req, res) =>
  handle(req, res, async () => {
    if (str(req.body.confirm) !== '1') throw new UserError('Bitte bestätige den Austritt.');
    await esports.leave({ user: req.user });
  })
);
// Teamprofil: Mitglieder, Trophäen, Wochen, ETF – der Kapitän bearbeitet Text, Motto, Farbe und Teambild
router.get('/esports/team/:ticker', async (req, res) => {
  const team = await esports.byTicker(req.params.ticker);
  if (!team) return res.status(404).render('error', { title: 'eSports', status: 404, message: 'Dieses Team gibt es nicht.' });
  const isCaptain = team.status !== 'aufgeloest' && team.captain.equals(req.user._id);
  const history = await esports.historyOf(team._id);
  res.render('esports-team', {
    title: team.name,
    team,
    history,
    isCaptain,
    isMember: team.members.some((m) => m.user.equals(req.user._id)),
    teamAvatars: isCaptain ? esports.teamAvatars(team) : null,
    konfetti: req.user.konfetti || 0,
    prizes: esports.prizeList(),
    rules: league,
  });
});

/** Aktion des Kapitäns, zurück auf das Profil des eigenen Teams (Adresse aus der Datenbank, Anker aus fester Liste) */
async function handleProfile(req, res, anchor, fn) {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  const team = await esports.teamOfUser(req.user._id);
  res.redirect(team ? `/esports/team/${team.ticker.toLowerCase()}${anchor === 'teambild' ? '#teambild' : ''}` : '/esports');
}

router.post('/esports/profil', (req, res) =>
  handleProfile(req, res, '', () => esports.updateProfile({ user: req.user, bio: str(req.body.bio), motto: str(req.body.motto), color: str(req.body.color) }))
);
router.post('/esports/teambild/kaufen', (req, res) => handleProfile(req, res, 'teambild', () => esports.buyAvatar({ user: req.user, key: str(req.body.key) })));
router.post('/esports/teambild/setzen', (req, res) => handleProfile(req, res, 'teambild', () => esports.wearAvatar({ user: req.user, key: str(req.body.key) })));
router.post('/esports/kapitaen', (req, res) => handleProfile(req, res, '', () => esports.transferCaptain({ user: req.user, userId: str(req.body.user) })));

router.post('/esports/entfernen', (req, res) => handle(req, res, () => esports.kick({ user: req.user, userId: str(req.body.user) })));

module.exports = router;

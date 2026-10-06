const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const { requireAdmin, requireStaff } = require('../middleware');
const { requireReauth } = require('../middleware/reauth');
const { PackGrant } = require('../models/Tcg');
const roles = require('../services/roles');
const betService = require('../services/betService');
const Ledger = require('../models/Ledger');
const { notify } = require('../services/notifyService');
const { verdictRole } = require('../lib/verdict');
const { UserError, str } = require('../lib/util');
const tcgCatalog = require('../tcg/catalog');
const tcgSettings = require('../tcg/settings');
const tcgService = require('../tcg/tcgService');
const ihk = require('../ihk/ihkService');
const dungeonService = require('../dungeon/dungeonService');
const bonusService = require('../services/bonusService');
const grading = require('../grading/gradingService');
const itemService = require('../items/itemService');
const giftService = require('../services/giftService');
const foil = require('../items/foil');
const lotteryService = require('../services/lotteryService');
const taxService = require('../services/taxService');
const { DIFFICULTIES } = require('../ihk/quests');
const { parseEuro } = require('../lib/util');
const { euro, date } = require('../lib/viewHelpers');
const config = require('../config');
const deviceService = require('../device/deviceService');
const suspicionService = require('../moderation/suspicionService');
const logs = require('../stats/logs');
const { MAX_BAN_HOURS, DEV_MAX_BAN_HOURS, isForever } = require('../device/deviceLogic');
const { ForumReport, ForumPost } = require('../models/Forum');
const { CODE_TTL_OPTIONS, ttlText, remainingText, parseTtl, formatCode, createCode, listActiveCodes, revokeCode } = require('../services/codeService');

const router = express.Router();

// ---------- Reiter des Panels ----------
// adminOnly: Reiter, in dem Devs nichts tun können, wird für sie ausgeblendet
const PANEL_SECTIONS = [
  { key: 'uebersicht', label: 'Übersicht', icon: 'grid', description: 'Offene Aufgaben und die wichtigsten Zahlen.' },
  { key: 'moderation', label: 'Moderation', icon: 'shield', description: 'Streitfälle, Meldungen, Bans, Mehrfach-Konten und Auffälligkeiten.' },
  { key: 'vergaben', label: 'Vergaben', icon: 'gift', description: 'Packs, Karten und Gegenstände vergeben oder Karten entfernen.' },
  { key: 'spielwerte', label: 'Spielwerte', icon: 'sliders', adminOnly: true, description: 'Preise, Chancen, Steuern, Bonus, Grading, Folie, Lotterie, IHK und Dungeon.' },
  { key: 'team', label: 'Team', icon: 'users', description: 'Einladungscodes, Devs und Mods.' },
  { key: 'protokolle', label: 'Protokolle', icon: 'list', description: 'Alles, was im Spiel passiert ist – für alle oder einen Spieler, mit Export.' },
];
const sectionsFor = (user) => PANEL_SECTIONS.filter((s) => !s.adminOnly || user.isAdmin);

// Unterreiter (?teil=…) – je Unterreiter wird nur sein Inhalt geladen und gezeigt
const SUBTABS = {
  moderation: [
    { key: 'streit', label: 'Streitfälle' },
    { key: 'meldungen', label: 'Meldungen' },
    { key: 'bans', label: 'Bans' },
    { key: 'geraete', label: 'Mehrfach-Konten' },
    { key: 'auffaelligkeiten', label: 'Auffälligkeiten' },
  ],
  spielwerte: [
    { key: 'tcg', label: 'TCG' },
    { key: 'steuer', label: 'Steuern' },
    { key: 'bonus', label: 'Tagesbonus' },
    { key: 'grading', label: 'Grading' },
    { key: 'folie', label: 'Folie' },
    { key: 'lotterie', label: 'Lotterie' },
    { key: 'ihk', label: 'IHK' },
    { key: 'dungeon', label: 'Dungeon' },
  ],
};

/** Adresse im Panel, z. B. panelUrl('moderation', 'ban') -> /admin?bereich=moderation#ban */
const panelUrl = (bereich, anchor, extra = {}) => `/admin?${new URLSearchParams({ bereich, ...extra })}${anchor ? `#${anchor}` : ''}`;
/** Adresse eines Unterreiters, z. B. subUrl('spielwerte', 'folie') -> /admin?bereich=spielwerte&teil=folie */
const subUrl = (bereich, teil, extra = {}) => panelUrl(bereich, null, { teil, ...extra });

/** Mitglieder, die der Handelnde bannen kann: nie den Admin oder sich selbst, Devs zusätzlich keine Devs */
const bannableFor = (actor, users) =>
  users.filter((u) => !config.adminUsernames.includes(u.usernameLower) && !u._id.equals(actor._id) && (actor.isAdmin || u.role !== 'dev'));

/** Offene Meldungen aus dem Forum samt gemeldetem Beitrag */
async function openReports() {
  const reports = await ForumReport.find({ done: false }).sort({ createdAt: -1 }).limit(100).lean();
  const posts = await ForumPost.find({ _id: { $in: reports.map((r) => r.post) } }).select('authorName body deleted').lean();
  const byId = new Map(posts.map((p) => [String(p._id), p]));
  return reports.map((r) => ({ ...r, postDoc: byId.get(String(r.post)) || null }));
}

/** Streitfälle mit Hinweis, ob der Dev selbst beteiligt ist oder mitgesetzt hat */
async function disputeList(user) {
  const bets = await Bet.find(betService.disputedFilter()).sort({ updatedAt: 1, _id: 1 }).limit(100).lean();
  // Eigene Einsätze: kein Hinderungsgrund, aber ein Interessenkonflikt, den der Dev sehen soll
  const staked = await Position.find({ user: user._id, bet: { $in: bets.map((b) => b._id) } }).select('bet side').lean();
  const myStake = new Map(staked.map((p) => [String(p.bet), p.side]));
  return bets.map((bet) => ({
    ...bet,
    mine: verdictRole(bet, user) !== 'dev', // selbst Ersteller oder Schiedsrichter
    myStake: myStake.get(String(bet._id)) || null,
  }));
}

/** Letzte Vergaben (für den Reiter "Vergaben") */
const recentGrants = (limit = 15) => PackGrant.find().sort({ createdAt: -1, _id: -1 }).limit(limit).lean();

router.get('/admin', requireStaff, async (req, res) => {
  const me = req.user;
  const isAdmin = me.isAdmin;
  const sections = sectionsFor(me);
  const tab = sections.some((s) => s.key === req.query.bereich) ? req.query.bereich : 'uebersicht';
  const needs = (...tabs) => tabs.includes(tab);

  // Offene Aufgaben – für die Übersicht und die Zähler an den Reitern
  const [reportCount, bans] = await Promise.all([ForumReport.countDocuments({ done: false }), deviceService.listBans()]);
  const counts = {
    disputes: res.locals.betDisputes || 0,
    reports: reportCount,
    deviceAlerts: res.locals.deviceAlerts || 0,
    suspicionAlerts: res.locals.suspicionAlerts || 0,
    suspicious: res.locals.tradeAlerts || 0,
    packLogNew: res.locals.packLogNew || 0,
    bans: bans.length,
  };
  counts.moderation = counts.disputes + counts.reports + counts.deviceAlerts + counts.suspicionAlerts;
  counts.vergaben = counts.packLogNew;
  counts.protokolle = counts.suspicious;
  // Zähler je Unterreiter
  const subCounts = { streit: counts.disputes, meldungen: counts.reports, geraete: counts.deviceAlerts, auffaelligkeiten: counts.suspicionAlerts, bans: counts.bans };

  // Unterreiter: aus der Adresse, sonst der erste mit offenen Aufgaben (Moderation) bzw. der erste
  const subs = SUBTABS[tab] || null;
  const sub = subs ? (subs.find((x) => x.key === req.query.teil) || (tab === 'moderation' && subs.find((x) => x.key !== 'bans' && subCounts[x.key])) || subs[0]).key : null;
  const needsSub = (t, k) => tab === t && sub === k;

  const users =
    needs('vergaben', 'team', 'protokolle') || needsSub('moderation', 'bans') || needsSub('moderation', 'geraete')
      ? await User.find({ deletedAt: null }).select('username usernameLower role').sort({ usernameLower: 1 }).lean()
      : [];
  // Protokolle: auf Wunsch nur ein Spieler (?spieler=Name)
  const player = needs('protokolle') ? await logs.resolvePlayer(req.query) : null;
  const [stats, disputes, reports, deviceMatches, suspicions, codes, grants, log] = await Promise.all([
    needs('uebersicht')
      ? Promise.all([User.countDocuments({ deletedAt: null }), Bet.countDocuments({ status: 'offen' }), Bet.countDocuments()]).then(([userCount, openBets, totalBets]) => ({ userCount, openBets, totalBets }))
      : null,
    needsSub('moderation', 'streit') ? disputeList(me) : [],
    needsSub('moderation', 'meldungen') ? openReports() : [],
    needsSub('moderation', 'geraete') ? deviceService.listAlerts() : [],
    needsSub('moderation', 'auffaelligkeiten') ? suspicionService.listGroups() : [],
    needs('team') ? listActiveCodes() : [],
    needs('vergaben') ? recentGrants() : [],
    // gewählter Log; unbekannter Spieler: nichts laden
    needs('protokolle') && !(player.q && !player.user) ? logs.loadLog(req.query, { player: player.user, seenAt: me.suspiciousSeenAt }) : null,
  ]);
  // Handel-Log angesehen: neue Geschäfte zwischen Mehrfach-Konten gelten als gesehen (Abzeichen verschwindet)
  const newSuspicious = log && log.key === 'handel' ? counts.suspicious : 0;
  if (newSuspicious) {
    await User.updateOne({ _id: me._id }, { $set: { suspiciousSeenAt: new Date() } });
    res.locals.tradeAlerts = 0;
  }
  // Vergaben angesehen (Reiter oder Protokoll): neue Vergaben der Devs gelten für den Admin als gesehen
  const grantsSeenAt = me.packLogSeenAt || new Date(0);
  if (isAdmin && counts.packLogNew && (needs('vergaben') || (log && log.key === 'vergaben'))) {
    await User.updateOne({ _id: me._id }, { $set: { packLogSeenAt: new Date() } });
    res.locals.packLogNew = 0;
  }

  res.render('admin', {
    title: isAdmin ? 'Admin-Panel' : 'Dev-Panel',
    sections,
    tab,
    subs,
    sub,
    subCounts,
    panelUrl,
    subUrl,
    counts,
    stats,
    disputes,
    noteMin: betService.NOTE_MIN,
    noteMax: betService.NOTE_MAX,
    reports,
    deviceMatches, // (deviceAlerts ist der Zähler fürs Menü-Abzeichen)
    suspicionGroups: suspicions, // je Spieler gebündelt, mit Gesamtbewertung
    bans: bans.map((b) => ({ ...b, canUnban: isAdmin || String(b.bannedBy) === String(me._id) })),
    bannable: needs('moderation') ? bannableFor(me, users) : [],
    banPreselect: typeof req.query.ban === 'string' ? req.query.ban : '',
    // Devs bannen befristet (höchstens 7 Tage), der Admin auch dauerhaft
    maxBanHours: isAdmin ? MAX_BAN_HOURS : DEV_MAX_BAN_HOURS,
    users,
    packTypes: tcgCatalog.PACK_TYPES,
    itemTypes: itemService.ITEM_TYPES,
    foilSettings: foil.settings,
    lottoSettings: lotteryService.settings,
    // Karten für "Karte vergeben", nach Seltenheit gruppiert
    lotteryGrantKinds: lotteryService.GRANT_KINDS.map(lotteryService.kindByKey),
    grantCards: tcgCatalog.ALL_RARITIES.map((r) => ({ rarity: r, cards: tcgCatalog.CARDS.filter((c) => c.rarity === r.key) })).filter((g) => g.cards.length),
    grants: grants.map((g) => ({ ...g, isNew: isAdmin && g.createdAt > grantsSeenAt && !g.by.equals(me._id) })),
    reasonMin: giftService.REASON_MIN,
    reasonMax: giftService.REASON_MAX,
    packLogNew: counts.packLogNew,
    codes,
    formatCode,
    ttlOptions: CODE_TTL_OPTIONS,
    ttlText,
    remainingText,
    now: Date.now(),
    tcg:
      needs('spielwerte') && isAdmin
        ? {
            packPrice: tcgSettings.getPackPrice(),
            rarities: tcgCatalog.RARITIES,
            defaults: tcgCatalog.DEFAULT_SELL,
            defaultWeights: tcgCatalog.DEFAULT_WEIGHT,
            totalWeight: tcgCatalog.TOTAL_WEIGHT,
            expectedPack: Math.round(tcgCatalog.expectedPackValue()),
            cardsPerPack: tcgCatalog.CARDS_PER_PACK,
            lastUpdate: await tcgSettings.lastUpdate(),
          }
        : null,
    ihk: { settings: ihk.settings, difficulties: DIFFICULTIES },
    dungeon: { settings: dungeonService.settings, defaults: dungeonService.DEFAULTS },
    gradingSettings: grading.settings,
    gradingLevels: grading.LEVELS,
    // Verdienst-Schätzung pro Tag (live im Browser nachgerechnet) und tatsächliche Werte der letzten 30 Tage
    gradingCalc: needsSub('spielwerte', 'grading') && isAdmin ? { input: grading.estimateInput(), rows: grading.estimateNow(), actual: await grading.actualStats(30) } : null,
    taxCategories: taxService.CATEGORIES,
    taxRates: taxService.rates,
    log, // { key, data } des gewählten Protokolls
    logs: logs.LOGS,
    logGroups: logs.LOG_GROUPS,
    exportMax: logs.EXPORT_MAX,
    player, // { q, user } aus ?spieler=
    logKey: logs.logByKey[req.query.log] ? req.query.log : 'handel',
    newSuspicious,
  });
});

// ---------- Protokolle exportieren: gewählter Log samt Filtern, alle Seiten (CSV für Excel oder JSON) ----------
router.get('/admin/protokolle/export', requireStaff, async (req, res) => {
  const player = await logs.resolvePlayer(req.query);
  if (player.q && !player.user) return res.status(404).render('error', { title: 'Export', status: 404, message: 'Dieses Mitglied gibt es nicht.' });
  const { key, data } = await logs.loadLog(req.query, { player: player.user, all: true });
  const playerName = player.user ? player.user.username : null;
  const title = ['Protokoll', logs.logByKey[key].label, playerName].filter(Boolean).join(' – ');
  if (req.query.format === 'json') {
    res.attachment(logs.exportFileName(key, playerName, 'json'));
    // Beträge in Cent, Zeitpunkte als ISO-Datum
    return res.json({ title, created: new Date(), units: { betrag: 'Cent' }, player: playerName, total: data.total, rows: data.rows });
  }
  res.attachment(logs.exportFileName(key, playerName, 'csv'));
  res.type('text/csv; charset=utf-8');
  res.send(logs.toCsv(key, data, { title }));
});

// ---------- Streitfälle: Wettersteller und Schiedsrichter sind sich nicht einig ----------
// Hier gibt ein Dev die entscheidende Stimme ab. An einem eigenen Streitfall (als Ersteller oder
// Schiedsrichter) darf auch ein Dev nicht entscheiden – dafür braucht es einen anderen Dev.

const DISPUTE_URL = subUrl('moderation', 'streit');

// Frühere eigene Seite – jetzt ein Unterreiter der Moderation
router.get('/admin/streitfaelle', requireStaff, (req, res) => res.redirect(DISPUTE_URL));

router.post('/admin/streitfaelle/:id/entscheiden', requireStaff, requireReauth(DISPUTE_URL), async (req, res) => {
  const outcome = str(req.body.outcome);
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw new UserError('Wette nicht gefunden.');
    if (!outcome) throw new UserError('Bitte wähle aus, welches Ergebnis gilt.');
    const r = await betService.resolveBet({ actor: req.user, betId: req.params.id, outcome, note: str(req.body.note) });
    if (r.kind !== 'entschieden') {
      // Als Beteiligter zählt die Stimme nur als eine von zwei – der Streitfall bleibt offen
      req.flash('info', 'Deine Stimme wurde als Beteiligter gezählt. Diesen Streitfall muss ein anderer Dev entscheiden.');
    } else if (r.outcome === 'annulliert') {
      req.flash('success', 'Die Wette wurde annulliert. Alle Einsätze wurden erstattet.');
    } else {
      // Provision teilen sich Wettersteller und Schiedsrichter
      const fee = r.refereeFee
        ? ` Provision: ${euro(r.creatorFee)} für den Wettersteller und ${euro(r.refereeFee)} für den Schiedsrichter.`
        : r.creatorFee
          ? ` Provision für den Wettersteller: ${euro(r.creatorFee)}.`
          : '';
      req.flash('success', `Ergebnis „${r.label}“ festgelegt. ${euro(r.paidTotal)} wurden an ${r.winnerCount} Gewinner ausgezahlt.${fee}`);
    }
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect(DISPUTE_URL);
});

// ---------- Mehrfach-Konten: Hinweise abhaken (Admin und Devs) ----------
router.post('/admin/geraete/:id', requireStaff, requireReauth('/admin?bereich=moderation'), async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) await deviceService.setAlertDone(req.params.id, req.body.action !== 'oeffnen');
  res.redirect(subUrl('moderation', 'geraete'));
});

// ---------- Auffälligkeiten (Manipulationserkennung): Hinweise abhaken (Admin und Devs) ----------
// "Alle erledigt" je Spieler: die offenen Hinweise der Gruppe (ids durch Komma getrennt)
router.post('/admin/auffaelligkeiten/gruppe', requireStaff, requireReauth('/admin?bereich=moderation'), async (req, res) => {
  const ids = String(req.body.ids || '').split(',').filter((id) => mongoose.isValidObjectId(id)).slice(0, 50);
  await suspicionService.setDoneMany(ids, true, req.user);
  res.redirect(subUrl('moderation', 'auffaelligkeiten'));
});

router.post('/admin/auffaelligkeiten/:id', requireStaff, requireReauth('/admin?bereich=moderation'), async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) await suspicionService.setDone(req.params.id, req.body.action !== 'oeffnen', req.user);
  res.redirect(subUrl('moderation', 'auffaelligkeiten'));
});

// ---------- Sperren: Konto samt allen bekannten Geräten ----------
// Admin und Devs; was ein Dev darf (höchstens 7 Tage, keine Devs, nur eigene Bans aufheben), prüft deviceService
const profilePath = (username) => `/profil/${encodeURIComponent(username)}`;

router.post('/admin/sperren', requireStaff, requireReauth('/admin?bereich=moderation'), async (req, res) => {
  const userId = typeof req.body.user === 'string' ? req.body.user : '';
  let back = subUrl('moderation', 'bans');
  try {
    if (!mongoose.isValidObjectId(userId)) throw new UserError('Bitte ein Mitglied auswählen.');
    const r = await deviceService.ban({ userId, hours: str(req.body.hours), reason: str(req.body.reason), admin: req.user, adminUsernames: config.adminUsernames });
    req.flash('success', `${r.username} ist gebannt (${isForever(r.until) ? 'dauerhaft' : `bis ${date(r.until)}`}) – samt allen Geräten des Kontos.`);
    back = req.body.zurueck === 'profil' ? profilePath(r.username) : subUrl('moderation', 'bans'); // vom Profil aus gebannt: dorthin zurück
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect(back);
});

router.post('/admin/sperren/:id/aufheben', requireStaff, requireReauth('/admin?bereich=moderation'), async (req, res) => {
  let user = null;
  try {
    user = mongoose.isValidObjectId(req.params.id) ? await deviceService.unban(req.params.id, req.user) : null;
    req.flash(user ? 'success' : 'error', user ? `Der Ban von ${user.username} ist aufgehoben.` : 'Mitglied nicht gefunden.');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect(user && req.body.zurueck === 'profil' ? profilePath(user.username) : subUrl('moderation', 'bans'));
});

// ---------- Steuern: je Bereich ein Satz (Handel: Markt, Privat, Tausch; Broker: Coins, ETFs) ----------
router.post('/admin/steuer', requireAdmin, requireReauth('/admin?bereich=spielwerte'), async (req, res) => {
  const { rates, error } = taxService.parseRates(req.body);
  if (error) {
    req.flash('error', error);
  } else {
    await taxService.saveSettings({ rates, admin: req.user });
    req.flash('success', 'Steuersätze gespeichert.');
  }
  res.redirect(subUrl('spielwerte', 'steuer'));
});

// ---------- Tagesbonus und Grading-Shop ----------
// Tagesbonus und Grading-Shop haben je ein eigenes Formular (Unterreiter); teil sagt, welches gespeichert wird
router.post('/admin/bonus', requireAdmin, requireReauth('/admin?bereich=spielwerte'), async (req, res) => {
  // "0" / "0,00" ist erlaubt (parseEuro allein lässt 0 auch zu, aber sicher ist sicher)
  const money = (v) => {
    const raw = typeof v === 'string' ? v.trim() : '';
    return /^0+([.,]0*)?$/.test(raw) ? 0 : centsOrNull(raw);
  };
  const tooBig = (c) => c === null || c > 10000000;
  const part = req.body.teil === 'grading' ? 'grading' : 'bonus';
  if (part === 'bonus') {
    const amount = money(req.body.amount);
    if (tooBig(amount)) req.flash('error', 'Bitte einen gültigen Tagesbonus angeben (0 bis 100.000 €).');
    else {
      await bonusService.saveSettings({ amount, admin: req.user });
      req.flash('success', `Gespeichert: Tagesbonus ${euro(amount)}.`);
    }
    return res.redirect(subUrl('spielwerte', 'bonus'));
  }
  const jobs = Number.parseInt(typeof req.body.gr_jobs === 'string' ? req.body.gr_jobs : '', 10);
  const premium = Number.parseInt(typeof req.body.gr_premium === 'string' ? req.body.gr_premium : '', 10);
  const pay = { clean: money(req.body.gr_pay_clean), grade: money(req.body.gr_pay_grade), slab: money(req.body.gr_pay_slab) };
  const costs = [2, 3, 4].map((l) => money(req.body[`gr_cost_${l}`]));
  if (!Number.isInteger(jobs) || jobs < 0 || jobs > 100) {
    req.flash('error', 'Aufträge pro Tag: 0 bis 100.');
  } else if (Object.values(pay).some(tooBig) || costs.some(tooBig)) {
    req.flash('error', 'Bitte gültige Beträge für Lohn und Ausbau angeben (0 bis 100.000 €).');
  } else if (!Number.isInteger(premium) || premium < 0 || premium > 500) {
    req.flash('error', 'Premium-Aufschlag: 0 bis 500 %.');
  } else {
    await grading.saveSettings({ open: req.body.gradingOpen === '1', jobs, pay, costs, premium, admin: req.user });
    req.flash('success', `Gespeichert: Grading-Shop ${jobs} Aufträge pro Tag.`);
  }
  res.redirect(subUrl('spielwerte', 'grading'));
});

// ---------- Dungeon: Termine, Ziel-Punkte, Lohn, Beute, Bot-Karten ----------
router.post('/admin/dungeon', requireAdmin, requireReauth('/admin?bereich=spielwerte'), async (req, res) => {
  const num = (v) => Number.parseInt(typeof v === 'string' ? v : '', 10);
  const pct = (v) => Number(String(typeof v === 'string' ? v : 'x').replace(',', '.') || 'x');
  const fights = [0, 1, 2];
  try {
    await dungeonService.saveSettings({
      open: req.body.open === '1',
      intervalHours: num(req.body.intervalHours),
      required: fights.map((i) => num(req.body[`required_${i}`])),
      // "0" / "0,00" = kein Lohn für diesen Kampf
      rewards: fights.map((i) => (/^\s*0+([.,]0*)?\s*$/.test(String(req.body[`reward_${i}`] || 'x')) ? 0 : centsOrNull(req.body[`reward_${i}`]))),
      foilChance: pct(req.body.foilChance),
      cardChance: pct(req.body.cardChance),
      botWeights: Object.fromEntries(tcgCatalog.RARITIES.map((r) => [r.key, num(req.body[`bot_${r.key}`])])),
      admin: req.user,
    });
    req.flash('success', 'Dungeon-Einstellungen gespeichert.');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect(subUrl('spielwerte', 'dungeon'));
});

// ---------- IHK (Mini-Game): Tageslimit und Belohnungen ----------
router.post('/admin/ihk', requireAdmin, requireReauth('/admin?bereich=spielwerte'), async (req, res) => {
  const dailyLimit = Number.parseInt(typeof req.body.dailyLimit === 'string' ? req.body.dailyLimit : '', 10);
  const num = (v) => Number.parseInt(typeof v === 'string' ? v : '', 10);
  // Wertetabelle aus dem Formular: prefix '' = normale Quests, 'hybrid_' = Hybrid-Quests
  const table = (prefix) => ({
    durations: DIFFICULTIES.map((d) => num(req.body[`${prefix}duration_${d.level}`])),
    rewards: DIFFICULTIES.map((d) => centsOrNull(req.body[`${prefix}reward_${d.level}`])),
    required: DIFFICULTIES.map((d) => num(req.body[`${prefix}required_${d.level}`])),
    packChances: DIFFICULTIES.map((d) => Number(String(typeof req.body[`${prefix}pack_${d.level}`] === 'string' ? req.body[`${prefix}pack_${d.level}`] : 'x').replace(',', '.') || 'x')),
  });
  const { durations, rewards, required, packChances } = table('');
  const hybrid = table('hybrid_');
  const both = (key) => [...{ durations, rewards, required, packChances }[key], ...hybrid[key]];
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 100) {
    req.flash('error', 'Das Tageslimit muss zwischen 0 und 100 liegen.');
  } else if (both('packChances').some((c) => !Number.isFinite(c) || c < 0 || c > 100)) {
    req.flash('error', 'Die Pack-Chance muss je Schwierigkeit zwischen 0 und 100 % liegen.');
  } else if (both('durations').some((m) => !Number.isInteger(m) || m < 0 || m > 1440)) {
    req.flash('error', 'Die Dauer muss je Schwierigkeit zwischen 0 und 1440 Minuten liegen.');
  } else if (both('required').some((r) => !Number.isInteger(r) || r < 1 || r > 100000)) {
    req.flash('error', 'Bitte für jede Schwierigkeit gültige Ziel-Punkte angeben (1–100000).');
  } else if (both('rewards').some((r) => r === null)) {
    req.flash('error', 'Bitte für jede Schwierigkeit einen gültigen Lohn angeben.');
  } else {
    await ihk.saveSettings({ open: req.body.open === '1', dailyLimit, durations, rewards, required, packChances, hybrid, admin: req.user });
    req.flash('success', 'IHK-Einstellungen gespeichert.');
  }
  res.redirect(subUrl('spielwerte', 'ihk'));
});

// ---------- TCG-Preise und Chancen ----------

/** "12,50" -> Cent; leer/ungültig -> null */
const centsOrNull = (value) => parseEuro(typeof value === 'string' ? value : '');

/** "0,08" / "2.5" / "58" (Prozent, max. 2 Nachkommastellen) -> Gewicht in 1/10.000; ungültig -> null */
function weightOrNull(value) {
  const s = (typeof value === 'string' ? value : '').trim().replace(/\s|%/g, '');
  if (!/^\d{1,3}([.,]\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split(/[.,]/);
  const w = parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  return w <= tcgCatalog.TOTAL_WEIGHT ? w : null;
}

const percentText = (w) => `${(w / 100).toFixed(2).replace('.', ',')} %`;

router.post('/admin/tcg', requireAdmin, requireReauth('/admin?bereich=spielwerte'), async (req, res) => {
  const packCents = centsOrNull(req.body.pack);
  const sell = {};
  const weight = {};
  let error = null;
  if (packCents === null || packCents < 100) error = 'Der Packpreis muss mindestens 1,00 € betragen.';
  for (const r of tcgCatalog.RARITIES) {
    const v = centsOrNull(req.body[`sell_${r.key}`]);
    if (v === null) error = error || `Bitte einen gültigen Verkaufspreis für ${r.label} angeben.`;
    sell[r.key] = v;
    const w = weightOrNull(req.body[`weight_${r.key}`]);
    if (w === null) error = error || `Bitte eine gültige Chance für ${r.label} angeben (z. B. 2,5 oder 0,08).`;
    weight[r.key] = w;
  }
  if (!error) {
    const sum = Object.values(weight).reduce((s, w) => s + w, 0);
    if (sum !== tcgCatalog.TOTAL_WEIGHT) error = `Die Chancen müssen zusammen genau 100 % ergeben (aktuell ${percentText(sum)}).`;
  }
  if (error) {
    req.flash('error', error);
    return res.redirect(subUrl('spielwerte', 'tcg'));
  }

  await tcgSettings.save({ packCents, sell, weight, admin: req.user });
  const ev = Math.round(tcgCatalog.expectedPackValue());
  const ratio = Math.round((ev / packCents) * 100);
  if (ev >= packCents) {
    req.flash('info', `TCG-Einstellungen gespeichert. Achtung: Ein Pack ist jetzt im Schnitt ${euro(ev)} wert (${ratio} % vom Preis) – Packs öffnen lohnt sich also.`);
  } else {
    req.flash('success', `TCG-Einstellungen gespeichert. Ein Pack ist im Schnitt ${euro(ev)} wert (${ratio} % vom Preis ${euro(packCents)}).`);
  }
  res.redirect(subUrl('spielwerte', 'tcg'));
});

// ---------- Folie: Fundchance im Grading-Shop und Wertsteigerung ----------
router.post('/admin/folie', requireAdmin, requireReauth('/admin?bereich=spielwerte'), async (req, res) => {
  // Prozent mit Komma oder Punkt, z. B. "0,9"
  const percent = (v) => {
    const raw = str(v).trim().replace(',', '.');
    return /^\d{1,4}(\.\d{1,2})?$/.test(raw) ? Number(raw) : NaN;
  };
  const chance = percent(req.body.chance);
  const bonusPercent = percent(req.body.bonus);
  const dailyPercent = percent(req.body.daily);
  if (!(chance >= 0 && chance <= 100)) {
    req.flash('error', 'Fundchance: 0 bis 100 % (höchstens zwei Nachkommastellen).');
  } else if (!(bonusPercent >= 0 && bonusPercent <= 1000) || !(dailyPercent >= 0 && dailyPercent <= 1000)) {
    req.flash('error', 'Wertsteigerung: 0 bis 1000 % (höchstens zwei Nachkommastellen).');
  } else {
    await foil.saveSettings({ admin: req.user, gradingChance: Math.round(chance * 100), bonusPercent, dailyPercent });
    req.flash('success', `Folie gespeichert: ${String(chance).replace('.', ',')} % Fundchance, +${String(bonusPercent).replace('.', ',')} % sofort, +${String(dailyPercent).replace('.', ',')} % pro Tag.`);
  }
  res.redirect(subUrl('spielwerte', 'folie'));
});

// Lotterien (täglich, Woche, Monat): Lospreis und Gewinn aus der Bank (gilt sofort, auch für die offene Runde)
router.post('/admin/lotterie', requireAdmin, requireReauth('/admin?bereich=spielwerte'), async (req, res) => {
  const k = lotteryService.KINDS.find((x) => x.key === str(req.body.kind));
  const count = (v) => (/^\d{1,6}$/.test(str(v).trim()) ? Number(str(v).trim()) : NaN);
  if (!k) {
    req.flash('error', 'Diese Lotterie gibt es nicht.');
  } else {
    const values = {
      ticketPrice: parseEuro(str(req.body.price)),
      prizeCash: parseEuro(str(req.body.cash)),
      prizePacks: count(req.body.packs),
      prizeFoils: count(req.body.foils),
    };
    const err = lotteryService.settingsError(values);
    if (err) {
      req.flash('error', `${k.name}: ${err}`);
    } else {
      await lotteryService.saveSettings({ admin: req.user, key: k.key, values });
      req.flash('success', `${k.name} gespeichert: Los ${euro(values.ticketPrice)}, Bank-Gewinn ${lotteryService.prizeText({ cash: values.prizeCash, packs: values.prizePacks, foils: values.prizeFoils })}.`);
    }
  }
  res.redirect(subUrl('spielwerte', 'lotterie'));
});

// ---------- Vergaben: Booster Packs und Karten (nur für Bugfixes, Tests und Aktionen) ----------
const GRANT_URL = panelUrl('vergaben');

/** Grund der Vergabe (Pflicht): steht im Protokoll und im Fenster "Geschenk vom Team" beim Mitglied */
const grantReason = (req) => giftService.cleanReason(req.body.grund);
const REASON_ERROR = `Bitte einen Grund angeben (mindestens ${giftService.REASON_MIN} Zeichen) – das Mitglied sieht ihn im Geschenk-Fenster.`;

// Gegenstände (Folie) an ein Mitglied oder an alle
async function grantItemsTo(req) {
  const reason = grantReason(req);
  if (!reason) return req.flash('error', REASON_ERROR);
  const type = itemService.ITEM_TYPES.find((t) => t.key === str(req.body.type));
  const target = str(req.body.user);
  const count = Number.parseInt(str(req.body.count), 10);
  const toAll = target === 'alle';
  const user = !toAll && mongoose.isValidObjectId(target) ? await User.findOne({ _id: target, deletedAt: null }).select('username').lean() : null;
  if (!type) {
    req.flash('error', 'Bitte einen Gegenstand auswählen.');
  } else if (!toAll && !user) {
    req.flash('error', 'Bitte ein Mitglied oder „Alle Mitglieder“ auswählen.');
  } else if (!Number.isInteger(count) || count < 1 || count > (toAll ? 5 : itemService.MAX_GRANT)) {
    req.flash('error', `Die Anzahl muss zwischen 1 und ${toAll ? 5 : itemService.MAX_GRANT} liegen.`);
  } else {
    const ids = toAll ? await allMemberIds() : [user._id];
    await itemService.grantItems({ userIds: ids, type: type.key, count, source: 'admin' });
    await itemService.notifyGift(ids, type, count);
    await giftService.record({ userIds: ids, kind: 'item', key: type.key, label: type.label, count, reason, byName: req.user.username });
    await PackGrant.create({ by: req.user._id, byName: req.user.username, to: toAll ? null : user._id, toName: toAll ? `Alle Mitglieder (${ids.length})` : user.username, all: toAll, recipients: ids.length, kind: 'item', type: type.key, typeLabel: type.label, count, reason });
    req.flash('success', toAll ? `${ids.length} Mitglieder haben je ${count}× ${type.label} bekommen.` : `${count}× ${type.label} an ${user.username} vergeben.`);
  }
}
router.post('/admin/items', requireStaff, requireReauth(GRANT_URL), async (req, res) => {
  await grantItemsTo(req);
  res.redirect(GRANT_URL);
});

async function grantPacksTo(req) {
  const reason = grantReason(req);
  if (!reason) return req.flash('error', REASON_ERROR);
  const userId = typeof req.body.user === 'string' ? req.body.user : '';
  const type = tcgCatalog.packTypeByKey[req.body.type];
  const count = Number.parseInt(typeof req.body.count === 'string' ? req.body.count : '', 10);
  const user = mongoose.isValidObjectId(userId) ? await User.findById(userId).select('username').lean() : null;
  if (!user) {
    req.flash('error', 'Bitte ein Mitglied auswählen.');
  } else if (!type) {
    req.flash('error', 'Bitte ein Booster Pack auswählen.');
  } else if (!Number.isInteger(count) || count < 1 || count > 50) {
    req.flash('error', 'Die Anzahl muss zwischen 1 und 50 liegen.');
  } else {
    await tcgService.grantPacks({ userId: user._id, type: type.key, count, source: 'admin' });
    await giftService.record({ userIds: [user._id], kind: 'pack', key: type.key, label: type.label, count, reason, byName: req.user.username });
    // Protokoll: wer, wem, was, wann, warum
    await PackGrant.create({ by: req.user._id, byName: req.user.username, to: user._id, toName: user.username, type: type.key, typeLabel: type.label, count, reason });
    req.flash('success', `${count}× ${type.label} an ${user.username} vergeben.`);
  }
}
router.post('/admin/tcg/packs', requireStaff, requireReauth(GRANT_URL), async (req, res) => {
  await grantPacksTo(req);
  res.redirect(GRANT_URL);
});

/** Alle Mitglieder, die bei einer Vergabe "an alle" etwas bekommen (gelöschte Konten nicht) */
const allMemberIds = async () => (await User.find({ deletedAt: null }).select('_id').lean()).map((u) => u._id);

// "Bless everyone": jedes Mitglied bekommt count Booster Packs
async function blessEveryone(req) {
  const reason = grantReason(req);
  if (!reason) return req.flash('error', REASON_ERROR);
  const type = tcgCatalog.packTypeByKey[req.body.type];
  const count = Number.parseInt(str(req.body.count), 10);
  if (!type) {
    req.flash('error', 'Bitte ein Booster Pack auswählen.');
  } else if (!Number.isInteger(count) || count < 1 || count > 10) {
    req.flash('error', 'Pro Mitglied können 1 bis 10 Packs vergeben werden.');
  } else {
    const ids = await allMemberIds();
    await tcgService.grantPacksToMany({ userIds: ids, type: type.key, count });
    await giftService.record({ userIds: ids, kind: 'pack', key: type.key, label: type.label, count, reason, byName: req.user.username });
    await PackGrant.create({ by: req.user._id, byName: req.user.username, to: null, toName: `Alle Mitglieder (${ids.length})`, all: true, recipients: ids.length, kind: 'pack', type: type.key, typeLabel: type.label, count, reason });
    req.flash('success', `Bless everyone: ${ids.length} Mitglieder haben je ${count}× ${type.label} bekommen.`);
  }
}
router.post('/admin/tcg/bless', requireStaff, requireReauth(GRANT_URL), async (req, res) => {
  await blessEveryone(req);
  res.redirect(GRANT_URL);
});

// Bestimmte Karte an ein Mitglied oder an alle vergeben
async function grantCardTo(req) {
  const reason = grantReason(req);
  if (!reason) return req.flash('error', REASON_ERROR);
  const card = tcgCatalog.cardById[str(req.body.card)];
  const target = str(req.body.user);
  const count = Number.parseInt(str(req.body.count), 10);
  const toAll = target === 'alle';
  const user = !toAll && mongoose.isValidObjectId(target) ? await User.findOne({ _id: target, deletedAt: null }).select('username').lean() : null;
  if (!card) {
    req.flash('error', 'Bitte eine Karte auswählen.');
  } else if (!toAll && !user) {
    req.flash('error', 'Bitte ein Mitglied oder „Alle Mitglieder“ auswählen.');
  } else if (!Number.isInteger(count) || count < 1 || count > 5) {
    req.flash('error', 'Pro Mitglied können 1 bis 5 Exemplare vergeben werden.');
  } else {
    const ids = toAll ? await allMemberIds() : [user._id];
    await tcgService.grantCards({ userIds: ids, cardId: card.id, count });
    const label = `${card.name} (${tcgCatalog.rarityByKey[card.rarity].label})`;
    await giftService.record({ userIds: ids, kind: 'karte', key: card.id, label, count, reason, byName: req.user.username });
    await PackGrant.create({
      by: req.user._id,
      byName: req.user.username,
      to: toAll ? null : user._id,
      toName: toAll ? `Alle Mitglieder (${ids.length})` : user.username,
      all: toAll,
      recipients: ids.length,
      kind: 'karte',
      type: card.id,
      typeLabel: label,
      count,
      reason,
    });
    req.flash('success', toAll ? `${ids.length} Mitglieder haben je ${count}× ${label} bekommen.` : `${count}× ${label} an ${user.username} vergeben.`);
  }
}
router.post('/admin/tcg/karte', requireStaff, requireReauth(GRANT_URL), async (req, res) => {
  await grantCardTo(req);
  res.redirect(GRANT_URL);
});

// Karte aus der Sammlung eines Mitglieds entfernen (z. B. versehentlich vergeben) – landet wie jede Vergabe im Log
// und beim Admin als Hinweis am Menüpunkt
async function revokeCardFrom(req) {
  const card = tcgCatalog.cardById[str(req.body.card)];
  const target = str(req.body.user);
  const count = Number.parseInt(str(req.body.count), 10);
  const user = mongoose.isValidObjectId(target) ? await User.findOne({ _id: target, deletedAt: null }).select('username').lean() : null;
  if (!card) {
    req.flash('error', 'Bitte eine Karte auswählen.');
  } else if (!user) {
    req.flash('error', 'Bitte ein Mitglied auswählen.');
  } else if (!Number.isInteger(count) || count < 1 || count > 50) {
    req.flash('error', 'Es können 1 bis 50 Exemplare entfernt werden.');
  } else {
    try {
      const { removed, remaining } = await tcgService.revokeCards({ userId: user._id, cardId: card.id, count });
      const label = `${card.name} (${tcgCatalog.rarityByKey[card.rarity].label})`;
      await PackGrant.create({ by: req.user._id, byName: req.user.username, to: user._id, toName: user.username, kind: 'entzug', type: card.id, typeLabel: label, count: removed });
      req.flash('success', `${removed}× ${label} bei ${user.username} entfernt (noch ${remaining} im Besitz).`);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      req.flash('error', err.message);
    }
  }
}
router.post('/admin/tcg/karte-entziehen', requireStaff, requireReauth(GRANT_URL), async (req, res) => {
  await revokeCardFrom(req);
  res.redirect(GRANT_URL);
});

// Ein Formular für alle Vergaben (Reiter "Vergaben"): art = pack | karte | item | entzug; user = Mitglied oder "alle".
// Die Felder heißen je Art anders (pack, card, item) und werden für die einzelnen Vergaben umbenannt.
// ---------- Spielgeld gutschreiben oder abziehen (Bugfixes, Tests, Aktionen) ----------
const MONEY_MAX = 10000000; // 100.000 € je Mitglied und Vorgang

/** Betrag aus dem Formular in Cent (1 Cent bis MONEY_MAX) oder null */
function moneyAmount(value) {
  const cents = parseEuro(str(value).trim());
  return Number.isInteger(cents) && cents >= 1 && cents <= MONEY_MAX ? cents : null;
}

async function grantMoneyTo(req) {
  const reason = grantReason(req);
  if (!reason) return req.flash('error', REASON_ERROR);
  const cents = moneyAmount(req.body.amount);
  const target = str(req.body.user);
  const toAll = target === 'alle';
  const user = !toAll && mongoose.isValidObjectId(target) ? await User.findOne({ _id: target, deletedAt: null }).select('username').lean() : null;
  if (cents === null) return req.flash('error', `Bitte einen Betrag zwischen 0,01 € und ${euro(MONEY_MAX)} angeben.`);
  if (!toAll && !user) return req.flash('error', 'Bitte ein Mitglied oder „Alle Mitglieder“ auswählen.');
  const ids = toAll ? await allMemberIds() : [user._id];
  await betService.inTransaction(async (session) => {
    await User.updateMany({ _id: { $in: ids } }, { $inc: { balance: cents } }, { session });
    await Ledger.insertMany(ids.map((id) => ({ user: id, type: 'team_gutschrift', amount: cents, betTitle: `vom Team (${req.user.username})` })), { session });
  });
  await notify(ids, { area: 'Konto', href: '/konto/auszug', text: `Das Team hat dir ${euro(cents)} gutgeschrieben.` });
  await giftService.record({ userIds: ids, kind: 'geld', label: 'Spielgeld', count: cents, reason, byName: req.user.username });
  await PackGrant.create({ by: req.user._id, byName: req.user.username, to: toAll ? null : user._id, toName: toAll ? `Alle Mitglieder (${ids.length})` : user.username, all: toAll, recipients: ids.length, kind: 'geld', type: 'geld', typeLabel: euro(cents), count: cents, reason });
  req.flash('success', toAll ? `${ids.length} Mitglieder haben je ${euro(cents)} bekommen.` : `${euro(cents)} an ${user.username} gutgeschrieben.`);
}

// Lotterielose (Wochen- oder Monats-Lotterie) an ein Mitglied oder an alle – kostenlos, der Topf wächst nicht
const TICKETS_MAX = { one: 50, all: 10 };
async function grantTicketsTo(req) {
  const reason = grantReason(req);
  if (!reason) return req.flash('error', REASON_ERROR);
  const kind = lotteryService.GRANT_KINDS.find((k) => k === str(req.body.lotterie));
  const target = str(req.body.user);
  const count = Number.parseInt(str(req.body.count), 10);
  const toAll = target === 'alle';
  const user = !toAll && mongoose.isValidObjectId(target) ? await User.findOne({ _id: target, deletedAt: null }).select('username').lean() : null;
  const max = toAll ? TICKETS_MAX.all : TICKETS_MAX.one;
  if (!kind) return req.flash('error', 'Bitte die Wochen- oder Monats-Lotterie auswählen.');
  if (!toAll && !user) return req.flash('error', 'Bitte ein Mitglied oder „Alle Mitglieder“ auswählen.');
  if (!Number.isInteger(count) || count < 1 || count > max) return req.flash('error', `Die Anzahl muss zwischen 1 und ${max} liegen.`);
  try {
    const r = await lotteryService.grantTickets({ userIds: toAll ? await allMemberIds() : [user._id], count, kind });
    const lose = count === 1 ? '1 Los' : `${count} Lose`;
    const label = `${r.kind.name} #${r.round}`;
    await notify(r.recipients, { area: 'Lotterie', href: r.kind.path, text: `Das Team hat dir ${lose} für die ${label} geschenkt.` });
    await giftService.record({ userIds: r.recipients, kind: 'los', key: kind, label: `Los – ${label}`, count, reason, byName: req.user.username });
    await PackGrant.create({ by: req.user._id, byName: req.user.username, to: toAll ? null : user._id, toName: toAll ? `Alle Mitglieder (${r.recipients.length})` : user.username, all: toAll, recipients: r.recipients.length, kind: 'los', type: kind, typeLabel: label, count, reason });
    req.flash('success', toAll ? `${r.recipients.length} Mitglieder haben je ${lose} für die ${r.kind.name} bekommen.` : `${lose} für die ${r.kind.name} an ${user.username} vergeben.`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
}

async function revokeMoneyFrom(req) {
  const cents = moneyAmount(req.body.amount);
  const target = str(req.body.user);
  const user = mongoose.isValidObjectId(target) ? await User.findOne({ _id: target, deletedAt: null }).select('username balance').lean() : null;
  if (cents === null) return req.flash('error', `Bitte einen Betrag zwischen 0,01 € und ${euro(MONEY_MAX)} angeben.`);
  if (!user) return req.flash('error', 'Bitte ein Mitglied auswählen – Geld lässt sich nur bei einem einzelnen Mitglied abziehen.');
  // nie unter 0 €: nur abziehen, wenn das Guthaben reicht (gleichzeitige Buchungen eingeschlossen)
  const done = await betService.inTransaction(async (session) => {
    const res = await User.updateOne({ _id: user._id, balance: { $gte: cents } }, { $inc: { balance: -cents } }, { session });
    if (!res.modifiedCount) return false;
    await Ledger.create([{ user: user._id, type: 'team_abzug', amount: -cents, betTitle: `durch das Team (${req.user.username})` }], { session });
    return true;
  });
  if (!done) return req.flash('error', `${user.username} hat nur ${euro(user.balance)} Guthaben – so viel lässt sich nicht abziehen.`);
  await notify([user._id], { area: 'Konto', href: '/konto/auszug', text: `Das Team hat dir ${euro(cents)} abgezogen.` });
  await PackGrant.create({ by: req.user._id, byName: req.user.username, to: user._id, toName: user.username, kind: 'geldabzug', type: 'geld', typeLabel: euro(cents), count: cents });
  req.flash('success', `${euro(cents)} bei ${user.username} abgezogen.`);
}

// "alle" oder der Vorschlag "Alle Mitglieder (12)" – genau so, damit ein Name wie "Allessandro" nicht passt
const ALL_MEMBERS = /^alle(\s+mitglieder(\s*\(\d+\))?)?$/i;

// Aktion (vergeben/entfernen) und Was (pack, karte, item, geld) -> Art der Vergabe
const GRANT_ART = {
  'vergeben:pack': 'pack',
  'vergeben:karte': 'karte',
  'vergeben:item': 'item',
  'vergeben:geld': 'geld',
  'vergeben:los': 'los',
  'entfernen:pack': 'packentzug',
  'entfernen:karte': 'entzug',
  'entfernen:item': 'itementzug',
  'entfernen:geld': 'geldabzug',
};
const SINGLE_ARTS = ['entzug', 'geldabzug', 'packentzug', 'itementzug']; // nur bei einem einzelnen Mitglied

router.post('/admin/vergeben', requireStaff, requireReauth(GRANT_URL), async (req, res) => {
  const art = str(req.body.art) || GRANT_ART[`${str(req.body.aktion)}:${str(req.body.was)}`] || '';
  // Empfänger kommt als Name (Eingabefeld mit Vorschlägen): in die ID umwandeln, "Alle Mitglieder" -> "alle"
  const target = str(req.body.user).trim();
  let user = target;
  if (ALL_MEMBERS.test(target)) user = 'alle';
  else if (target && !mongoose.isValidObjectId(target)) {
    const found = await User.findOne({ usernameLower: target.toLowerCase(), deletedAt: null }).select('_id').lean();
    if (!found) {
      req.flash('error', `Es gibt kein Mitglied „${target.slice(0, 40)}“.`);
      return res.redirect(GRANT_URL);
    }
    user = String(found._id);
  }
  const body = { ...req.body, user };
  if (user === 'alle' && SINGLE_ARTS.includes(art)) {
    req.flash('error', 'Entfernen geht nur bei einem einzelnen Mitglied.');
    return res.redirect(GRANT_URL);
  }
  if (art === 'pack') {
    req.body = { ...body, type: str(body.pack) };
    await (str(body.user) === 'alle' ? blessEveryone(req) : grantPacksTo(req));
  } else if (art === 'karte') {
    req.body = { ...body, card: str(body.card) };
    await grantCardTo(req);
  } else if (art === 'item') {
    req.body = { ...body, type: str(body.item) };
    await grantItemsTo(req);
  } else if (art === 'geld') {
    req.body = body;
    await grantMoneyTo(req);
  } else if (art === 'los') {
    req.body = body;
    await grantTicketsTo(req);
  } else if (art === 'geldabzug') {
    req.body = body;
    await revokeMoneyFrom(req);
  } else if (art === 'entzug') {
    req.body = body;
    await revokeCardFrom(req);
  } else if (art === 'packentzug' || art === 'itementzug') {
    req.body = body;
    await revokeInventory(req, art);
  } else if (str(req.body.was) === 'los') {
    req.flash('error', 'Vergebene Lotterielose lassen sich nicht entfernen.');
  } else {
    req.flash('error', 'Bitte auswählen, was vergeben werden soll.');
  }
  res.redirect(GRANT_URL);
});

// Booster Packs oder Gegenstände aus dem Inventar eines Mitglieds entfernen (z. B. versehentlich vergeben)
async function revokeInventory(req, kind) {
  const target = str(req.body.user);
  const count = Number.parseInt(str(req.body.count), 10);
  const user = mongoose.isValidObjectId(target) ? await User.findOne({ _id: target, deletedAt: null }).select('username').lean() : null;
  if (!user) return req.flash('error', 'Bitte ein Mitglied auswählen – entfernen geht nur bei einem einzelnen Mitglied.');
  if (!Number.isInteger(count) || count < 1 || count > 50) return req.flash('error', 'Es können 1 bis 50 Stück entfernt werden.');
  try {
    const r = kind === 'packentzug'
      ? await tcgService.revokePacks({ userId: user._id, type: str(req.body.pack), count })
      : await itemService.revokeItems({ userId: user._id, type: str(req.body.item), count });
    await PackGrant.create({ by: req.user._id, byName: req.user.username, to: user._id, toName: user.username, kind, type: r.type.key, typeLabel: r.type.label, count: r.removed });
    req.flash('success', `${r.removed}× ${r.type.label} bei ${user.username} entfernt (noch ${r.remaining} übrig).`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
}

/** Neue Vergaben anderer seit dem letzten Blick (Abzeichen für den Admin) */
const packLogNewCount = (user) => PackGrant.countDocuments({ by: { $ne: user._id }, createdAt: { $gt: user.packLogSeenAt || new Date(0) } });

// Frühere eigene Seite – jetzt ein Protokoll im Reiter "Protokolle" (Suche nach Namen -> Spieler-Filter)
router.get('/admin/pack-log', requireStaff, (req, res) => {
  const q = str(req.query.suche).trim().slice(0, 40);
  res.redirect(panelUrl('protokolle', 'protokoll', { log: 'vergaben', ...(q ? { spieler: q } : {}) }));
});

// ---------- Rollen vergeben / entziehen: Devs und Mods (nur Admin) ----------
const ROLE_LABEL = { dev: 'Dev', mod: 'Mod' };

router.post('/admin/rollen', requireAdmin, async (req, res) => {
  const userId = typeof req.body.user === 'string' ? req.body.user : '';
  const role = roles.ASSIGNABLE.includes(req.body.role) ? req.body.role : null;
  const on = req.body.action !== 'entfernen';
  const user = mongoose.isValidObjectId(userId) ? await User.findOne({ _id: userId, deletedAt: null }).select('username role').lean() : null;
  if (!user || !role) req.flash('error', 'Bitte ein Mitglied auswählen.');
  else if (roles.roleOf(user.username) === 'admin') req.flash('error', 'Der Admin braucht keine weitere Rolle.');
  else if (!on && user.role !== role) req.flash('error', `${user.username} ist kein ${ROLE_LABEL[role]}.`);
  else {
    await roles.setRole(user._id, on ? role : null);
    req.flash('success', on ? `${user.username} ist jetzt ${ROLE_LABEL[role]}.` : `${user.username} ist kein ${ROLE_LABEL[role]} mehr.`);
  }
  res.redirect(panelUrl('team', role === 'mod' ? 'mods' : 'devs'));
});

// ---------- Einladungen: Registrierungscodes (Admin und Devs) ----------
router.post('/admin/codes', requireStaff, async (req, res) => {
  const ttl = parseTtl(req.body.ttl);
  const code = await createCode(req.user, ttl);
  req.flash('success', `Neuer Einladungscode: ${formatCode(code.code)} – gültig für ${ttlText(ttl)} und eine Person.`);
  res.redirect(panelUrl('team', 'codes'));
});

// Der Admin löscht jeden Code, Devs nur ihre eigenen
router.post('/admin/codes/:id/loeschen', requireStaff, async (req, res) => {
  const ok = mongoose.isValidObjectId(req.params.id) && (await revokeCode(req.params.id, req.user));
  req.flash(ok ? 'info' : 'error', ok ? 'Code gelöscht.' : 'Diesen Code kannst du nicht löschen – nur der Admin oder wer ihn erzeugt hat.');
  res.redirect(panelUrl('team', 'codes'));
});

/** Reiterleiste des Panels für andere Seiten im Panel-Rahmen (Statistik): sichtbare Reiter und Zähler */
async function panelNav(user, locals) {
  const reports = await ForumReport.countDocuments({ done: false });
  return {
    panelSections: sectionsFor(user),
    panelBadges: {
      moderation: (locals.betDisputes || 0) + reports + (locals.deviceAlerts || 0) + (locals.suspicionAlerts || 0),
      vergaben: locals.packLogNew || 0,
      protokolle: locals.tradeAlerts || 0,
    },
    panelUrl,
  };
}

module.exports = router;
module.exports.panelNav = panelNav;
module.exports.packLogNewCount = packLogNewCount;

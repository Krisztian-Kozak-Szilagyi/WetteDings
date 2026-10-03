const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const { requireAdmin, requireStaff } = require('../middleware');
const { requireReauth } = require('../middleware/reauth');
const { PackGrant } = require('../models/Tcg');
const { Trade } = require('../models/Trade');
const roles = require('../services/roles');
const betService = require('../services/betService');
const { verdictRole } = require('../lib/verdict');
const { UserError, str } = require('../lib/util');
const tcgCatalog = require('../tcg/catalog');
const tcgSettings = require('../tcg/settings');
const tcgService = require('../tcg/tcgService');
const ihk = require('../ihk/ihkService');
const tradeService = require('../trade/tradeService');
const { DIFFICULTIES } = require('../ihk/quests');
const { parseEuro } = require('../lib/util');
const { euro, date } = require('../lib/viewHelpers');
const config = require('../config');
const deviceService = require('../device/deviceService');
const { MAX_BAN_HOURS, DEV_MAX_BAN_HOURS, isForever } = require('../device/deviceLogic');
const { ForumReport, ForumPost } = require('../models/Forum');
const { CODE_TTL_MINUTES, formatCode, createCode, listActiveCodes, revokeCode } = require('../services/codeService');

const router = express.Router();

// ---------- Reiter des Panels ----------
// adminOnly: Reiter, in dem Devs nichts tun können, wird für sie ausgeblendet
const PANEL_SECTIONS = [
  { key: 'uebersicht', label: 'Übersicht', icon: 'grid', description: 'Offene Aufgaben und die wichtigsten Zahlen auf einen Blick.' },
  { key: 'moderation', label: 'Moderation', icon: 'shield', description: 'Streitfälle, gemeldete Beiträge, Bans und Hinweise auf Mehrfach-Konten.' },
  { key: 'spielwerte', label: 'Spielwerte', icon: 'sliders', description: 'Packs und Karten vergeben (nur für Bugfixes, Tests und Aktionen) und – als Admin – Preise, Chancen, Steuer und IHK einstellen.' },
  { key: 'team', label: 'Team & Zugang', icon: 'users', description: 'Devs und Mods ernennen und Registrierungscodes erzeugen.', adminOnly: true },
  { key: 'protokolle', label: 'Protokolle', icon: 'list', description: 'Handel-Log und Vergabe-Log: wer wem welche Karte oder welches Pack gegeben hat.' },
];
const sectionsFor = (user) => PANEL_SECTIONS.filter((s) => !s.adminOnly || user.isAdmin);

/** Adresse im Panel, z. B. panelUrl('moderation', 'ban') -> /admin?bereich=moderation#ban */
const panelUrl = (bereich, anchor, extra = {}) => `/admin?${new URLSearchParams({ bereich, ...extra })}${anchor ? `#${anchor}` : ''}`;

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

// ---------- Handel-Log (Admin und Devs): wer wem welche Karte gegeben hat und wann ----------
const TRADE_LOG_PAGE = 50;
const KIND_LABEL = { markt: 'Markt', privat: 'Privatverkauf', tausch: 'Tausch' };

/**
 * Abgeschlossene Geschäfte, neueste zuerst; Suche nach Namen (Anbieter, Käufer, Empfänger) oder Karte.
 * Geschäfte zwischen Mehrfach-Konten (Hinweis "sicher"/"wahrscheinlich") sind markiert, neue seit seenAt zusätzlich "Neu";
 * mit ?verdacht=1 nur diese.
 */
async function tradeLog(query, seenAt) {
  const q = (typeof query.handelsuche === 'string' ? query.handelsuche : '').trim().slice(0, 40);
  const onlySuspicious = query.verdacht === '1';
  const pairs = await deviceService.flaggedPairs();
  const filter = { status: 'verkauft' };
  if (onlySuspicious) filter.$and = [deviceService.tradeFilterForPairs(pairs)];
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    // Karten über ihren angezeigten Namen finden (z. B. "St. Ivan") – gespeichert ist nur die Karten-ID
    const cardIds = tcgCatalog.CARDS.filter((c) => rx.test(c.name) || rx.test(c.id)).map((c) => c.id);
    filter.$or = [{ sellerName: rx }, { buyerName: rx }, { toName: rx }, { card: { $in: cardIds } }, { wantCard: { $in: cardIds } }];
  }
  const total = await Trade.countDocuments(filter);
  const pages = Math.max(1, Math.ceil(total / TRADE_LOG_PAGE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(query.handelseite, 10) || 1));
  const rows = await Trade.find(filter)
    .select('kind seller buyer to sellerName buyerName toName card wantCard price extraFrom tax closedAt')
    .sort({ closedAt: -1, _id: -1 })
    .skip((page - 1) * TRADE_LOG_PAGE)
    .limit(TRADE_LOG_PAGE)
    .lean();
  const card = (id) => {
    const c = tcgCatalog.cardById[id];
    return c ? `${c.name} (${tcgCatalog.rarityByKey[c.rarity].label})` : id;
  };
  const seen = seenAt ? new Date(seenAt).getTime() : 0;
  return {
    q,
    onlySuspicious,
    total,
    page,
    pages,
    rows: rows.map((t) => {
      // "An" ist beim Verkauf der Käufer, beim Tausch der Empfänger des Angebots
      const to = t.kind === 'tausch' ? t.toName : t.buyerName;
      let back = euro(t.price); // Gegenleistung
      if (t.kind === 'tausch') {
        back = card(t.wantCard);
        if (t.price > 0) back += ` + ${euro(t.price)} von ${t.extraFrom === 'to' ? to : t.sellerName}`;
      }
      const flagged = pairs.has(deviceService.tradePairKey(t));
      const isNew = flagged && new Date(t.closedAt).getTime() > seen;
      return { at: t.closedAt, kind: KIND_LABEL[t.kind] || t.kind, from: t.sellerName, to: to || '–', card: card(t.card), back, tax: t.tax, flagged, isNew };
    }),
  };
}

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
    suspicious: res.locals.tradeAlerts || 0,
    packLogNew: res.locals.packLogNew || 0,
    bans: bans.length,
  };
  counts.moderation = counts.disputes + counts.reports + counts.deviceAlerts;
  counts.protokolle = counts.suspicious + counts.packLogNew;

  const users = needs('moderation', 'spielwerte', 'team')
    ? await User.find({ deletedAt: null }).select('username usernameLower role').sort({ usernameLower: 1 }).lean()
    : [];
  const [stats, reports, deviceMatches, codes, trades] = await Promise.all([
    needs('uebersicht')
      ? Promise.all([User.countDocuments({ deletedAt: null }), Bet.countDocuments({ status: 'offen' }), Bet.countDocuments()]).then(([userCount, openBets, totalBets]) => ({ userCount, openBets, totalBets }))
      : null,
    needs('moderation') ? openReports() : [],
    needs('moderation') ? deviceService.listAlerts() : [],
    needs('team') ? listActiveCodes() : [],
    // Handel-Log: abgeschlossene Verkäufe und Tausche
    needs('protokolle') ? tradeLog(req.query, me.suspiciousSeenAt) : null,
  ]);
  // Handel-Log angesehen: neue Geschäfte zwischen Mehrfach-Konten gelten als gesehen (Abzeichen verschwindet)
  const newSuspicious = needs('protokolle') ? counts.suspicious : 0;
  if (newSuspicious) {
    await User.updateOne({ _id: me._id }, { $set: { suspiciousSeenAt: new Date() } });
    res.locals.tradeAlerts = 0;
  }

  res.render('admin', {
    title: isAdmin ? 'Admin-Panel' : 'Dev-Panel',
    sections,
    tab,
    panelUrl,
    counts,
    stats,
    reports,
    deviceMatches, // (deviceAlerts ist der Zähler fürs Menü-Abzeichen)
    bans: bans.map((b) => ({ ...b, canUnban: isAdmin || String(b.bannedBy) === String(me._id) })),
    bannable: needs('moderation') ? bannableFor(me, users) : [],
    banPreselect: typeof req.query.ban === 'string' ? req.query.ban : '',
    // Devs bannen befristet (höchstens 7 Tage), der Admin auch dauerhaft
    maxBanHours: isAdmin ? MAX_BAN_HOURS : DEV_MAX_BAN_HOURS,
    users,
    packTypes: tcgCatalog.PACK_TYPES,
    // Karten für "Karte vergeben", nach Seltenheit gruppiert
    grantCards: tcgCatalog.RARITIES.map((r) => ({ rarity: r, cards: tcgCatalog.CARDS.filter((c) => c.rarity === r.key) })).filter((g) => g.cards.length),
    packLogNew: counts.packLogNew,
    codes,
    formatCode,
    ttlMinutes: CODE_TTL_MINUTES,
    now: Date.now(),
    tcg: needs('spielwerte') && isAdmin
      ? {
          packPrice: tcgSettings.getPackPrice(),
          rarities: tcgCatalog.RARITIES,
          defaults: tcgCatalog.DEFAULT_SELL,
          defaultWeights: tcgCatalog.DEFAULT_WEIGHT,
          totalWeight: tcgCatalog.TOTAL_WEIGHT,
          expectedPack: Math.round(tcgCatalog.expectedPackValue()),
          lastUpdate: await tcgSettings.lastUpdate(),
        }
      : null,
    ihk: { settings: ihk.settings, difficulties: DIFFICULTIES },
    tradeTax: tradeService.settings.taxPercent,
    trades,
    newSuspicious,
  });
});

// ---------- Streitfälle: Wettersteller und Schiedsrichter sind sich nicht einig ----------
// Hier gibt ein Dev die entscheidende Stimme ab. An einem eigenen Streitfall (als Ersteller oder
// Schiedsrichter) darf auch ein Dev nicht entscheiden – dafür braucht es einen anderen Dev.

router.get('/admin/streitfaelle', requireStaff, async (req, res) => {
  const bets = await Bet.find(betService.disputedFilter()).sort({ updatedAt: 1, _id: 1 }).limit(100).lean();
  // Eigene Einsätze: kein Hinderungsgrund, aber ein Interessenkonflikt, den der Dev sehen soll
  const staked = await Position.find({ user: req.user._id, bet: { $in: bets.map((b) => b._id) } }).select('bet side').lean();
  const myStake = new Map(staked.map((p) => [String(p.bet), p.side]));
  res.render('streitfaelle', {
    title: 'Streitfälle',
    bets: bets.map((bet) => ({
      ...bet,
      mine: verdictRole(bet, req.user) !== 'dev', // selbst Ersteller oder Schiedsrichter
      myStake: myStake.get(String(bet._id)) || null,
    })),
    noteMin: betService.NOTE_MIN,
    noteMax: betService.NOTE_MAX,
  });
});

router.post('/admin/streitfaelle/:id/entscheiden', requireStaff, requireReauth('/admin/streitfaelle'), async (req, res) => {
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
  res.redirect('/admin/streitfaelle');
});

// ---------- Mehrfach-Konten: Hinweise abhaken (Admin und Devs) ----------
router.post('/admin/geraete/:id', requireStaff, requireReauth('/admin?bereich=moderation'), async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) await deviceService.setAlertDone(req.params.id, req.body.action !== 'oeffnen');
  res.redirect(panelUrl('moderation', 'geraete'));
});

// ---------- Sperren: Konto samt allen bekannten Geräten ----------
// Admin und Devs; was ein Dev darf (höchstens 7 Tage, keine Devs, nur eigene Bans aufheben), prüft deviceService
const profilePath = (username) => `/profil/${encodeURIComponent(username)}`;

router.post('/admin/sperren', requireStaff, requireReauth('/admin?bereich=moderation'), async (req, res) => {
  const userId = typeof req.body.user === 'string' ? req.body.user : '';
  let back = panelUrl('moderation', 'ban');
  try {
    if (!mongoose.isValidObjectId(userId)) throw new UserError('Bitte ein Mitglied auswählen.');
    const r = await deviceService.ban({ userId, hours: str(req.body.hours), reason: str(req.body.reason), admin: req.user, adminUsernames: config.adminUsernames });
    req.flash('success', `${r.username} ist gebannt (${isForever(r.until) ? 'dauerhaft' : `bis ${date(r.until)}`}) – samt allen Geräten des Kontos.`);
    back = req.body.zurueck === 'profil' ? profilePath(r.username) : panelUrl('moderation', 'banliste'); // vom Profil aus gebannt: dorthin zurück
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
  res.redirect(user && req.body.zurueck === 'profil' ? profilePath(user.username) : panelUrl('moderation', 'banliste'));
});

// ---------- Handel: Steuer ----------
router.post('/admin/handel', requireAdmin, requireReauth('/admin?bereich=spielwerte'), async (req, res) => {
  const tax = Number(String(typeof req.body.tax === 'string' ? req.body.tax : '').replace(',', '.'));
  if (!Number.isFinite(tax) || tax < 0 || tax > 50) {
    req.flash('error', 'Die Steuer muss zwischen 0 und 50 % liegen.');
  } else {
    const taxPercent = Math.round(tax * 10) / 10;
    await tradeService.saveSettings({ taxPercent, admin: req.user });
    req.flash('success', `Handelssteuer auf ${String(taxPercent).replace('.', ',')} % gesetzt.`);
  }
  res.redirect(panelUrl('spielwerte', 'handel'));
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
  res.redirect(panelUrl('spielwerte', 'ihk'));
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
    return res.redirect(panelUrl('spielwerte', 'tcg'));
  }

  await tcgSettings.save({ packCents, sell, weight, admin: req.user });
  const ev = Math.round(tcgCatalog.expectedPackValue());
  const ratio = Math.round((ev / packCents) * 100);
  if (ev >= packCents) {
    req.flash('info', `TCG-Einstellungen gespeichert. Achtung: Ein Pack ist jetzt im Schnitt ${euro(ev)} wert (${ratio} % vom Preis) – Packs öffnen lohnt sich also.`);
  } else {
    req.flash('success', `TCG-Einstellungen gespeichert. Ein Pack ist im Schnitt ${euro(ev)} wert (${ratio} % vom Preis ${euro(packCents)}).`);
  }
  res.redirect(panelUrl('spielwerte', 'tcg'));
});

// ---------- Vergaben: Booster Packs und Karten (nur für Bugfixes, Tests und Aktionen) ----------
const GRANT_URL = panelUrl('spielwerte', 'vergeben');

router.post('/admin/tcg/packs', requireStaff, requireReauth(GRANT_URL), async (req, res) => {
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
    // Protokoll: wer, wem, was, wann
    await PackGrant.create({ by: req.user._id, byName: req.user.username, to: user._id, toName: user.username, type: type.key, typeLabel: type.label, count });
    req.flash('success', `${count}× ${type.label} an ${user.username} vergeben.`);
  }
  res.redirect(GRANT_URL);
});

/** Alle Mitglieder, die bei einer Vergabe "an alle" etwas bekommen (gelöschte Konten nicht) */
const allMemberIds = async () => (await User.find({ deletedAt: null }).select('_id').lean()).map((u) => u._id);

// "Bless everyone": jedes Mitglied bekommt count Booster Packs
router.post('/admin/tcg/bless', requireStaff, requireReauth(GRANT_URL), async (req, res) => {
  const type = tcgCatalog.packTypeByKey[req.body.type];
  const count = Number.parseInt(str(req.body.count), 10);
  if (!type) {
    req.flash('error', 'Bitte ein Booster Pack auswählen.');
  } else if (!Number.isInteger(count) || count < 1 || count > 10) {
    req.flash('error', 'Pro Mitglied können 1 bis 10 Packs vergeben werden.');
  } else {
    const ids = await allMemberIds();
    await tcgService.grantPacksToMany({ userIds: ids, type: type.key, count });
    await PackGrant.create({ by: req.user._id, byName: req.user.username, to: null, toName: `Alle Mitglieder (${ids.length})`, all: true, recipients: ids.length, kind: 'pack', type: type.key, typeLabel: type.label, count });
    req.flash('success', `Bless everyone: ${ids.length} Mitglieder haben je ${count}× ${type.label} bekommen.`);
  }
  res.redirect(GRANT_URL);
});

// Bestimmte Karte an ein Mitglied oder an alle vergeben
router.post('/admin/tcg/karte', requireStaff, requireReauth(GRANT_URL), async (req, res) => {
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
    });
    req.flash('success', toAll ? `${ids.length} Mitglieder haben je ${count}× ${label} bekommen.` : `${count}× ${label} an ${user.username} vergeben.`);
  }
  res.redirect(GRANT_URL);
});

// ---------- Vergabe-Log (Packs und Karten): eigene Seite, 50 Einträge pro Seite, mit Suche ----------
const LOG_PAGE = 50;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Neue Vergaben anderer seit dem letzten Blick ins Log (Abzeichen für den Admin) */
const packLogNewCount = (user) => PackGrant.countDocuments({ by: { $ne: user._id }, createdAt: { $gt: user.packLogSeenAt || new Date(0) } });

router.get('/admin/pack-log', requireStaff, async (req, res) => {
  const q = (typeof req.query.suche === 'string' ? req.query.suche : '').trim().slice(0, 40);
  const rx = q ? new RegExp(escapeRegex(q), 'i') : null;
  const filter = rx ? { $or: [{ byName: rx }, { toName: rx }, { typeLabel: rx }] } : {};
  const total = await PackGrant.countDocuments(filter);
  const pages = Math.max(1, Math.ceil(total / LOG_PAGE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.seite, 10) || 1));
  const entries = await PackGrant.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * LOG_PAGE).limit(LOG_PAGE).lean();
  const seen = req.user.packLogSeenAt || new Date(0);
  if (req.user.isAdmin) {
    // Besuch merken: das Abzeichen am Menüpunkt verschwindet
    await User.updateOne({ _id: req.user._id }, { $set: { packLogSeenAt: new Date() } });
    res.locals.packLogNew = 0;
  }
  res.render('pack-log', {
    title: 'Vergabe-Log',
    q,
    total,
    page,
    pages,
    entries: entries.map((e) => ({ ...e, isNew: req.user.isAdmin && e.createdAt > seen && !e.by.equals(req.user._id) })),
  });
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

router.post('/admin/codes', requireAdmin, async (req, res) => {
  const code = await createCode(req.user);
  req.flash('success', `Neuer Registrierungscode: ${formatCode(code.code)} – gültig für ${CODE_TTL_MINUTES} Minuten und eine Person.`);
  res.redirect(panelUrl('team', 'codes'));
});

router.post('/admin/codes/:id/loeschen', requireAdmin, async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) await revokeCode(req.params.id);
  req.flash('info', 'Code gelöscht.');
  res.redirect(panelUrl('team', 'codes'));
});

module.exports = router;
module.exports.packLogNewCount = packLogNewCount;

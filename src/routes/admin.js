const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Bet = require('../models/Bet');
const { requireAdmin, requireStaff } = require('../middleware');
const { PackGrant } = require('../models/Tcg');
const roles = require('../services/roles');
const tcgCatalog = require('../tcg/catalog');
const tcgSettings = require('../tcg/settings');
const tcgService = require('../tcg/tcgService');
const ihk = require('../ihk/ihkService');
const tradeService = require('../trade/tradeService');
const { DIFFICULTIES } = require('../ihk/quests');
const { parseEuro } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');
const { CODE_TTL_MINUTES, formatCode, createCode, listActiveCodes, revokeCode } = require('../services/codeService');

const router = express.Router();

router.get('/admin', requireStaff, async (req, res) => {
  const [codes, userCount, openBets, totalBets, users] = await Promise.all([
    listActiveCodes(),
    User.countDocuments(),
    Bet.countDocuments({ status: 'offen' }),
    Bet.countDocuments(),
    User.find({ deletedAt: null }).select('username role').sort({ usernameLower: 1 }).lean(),
  ]);
  res.render('admin', {
    title: req.user.isAdmin ? 'Admin' : 'Dev',
    packLogNew: res.locals.packLogNew || 0,
    codes,
    formatCode,
    ttlMinutes: CODE_TTL_MINUTES,
    stats: { userCount, openBets, totalBets },
    now: Date.now(),
    users,
    packTypes: tcgCatalog.PACK_TYPES,
    tcg: {
      packPrice: tcgSettings.getPackPrice(),
      rarities: tcgCatalog.RARITIES,
      defaults: tcgCatalog.DEFAULT_SELL,
      defaultWeights: tcgCatalog.DEFAULT_WEIGHT,
      totalWeight: tcgCatalog.TOTAL_WEIGHT,
      expectedPack: Math.round(tcgCatalog.expectedPackValue()),
      lastUpdate: await tcgSettings.lastUpdate(),
    },
    ihk: { settings: ihk.settings, difficulties: DIFFICULTIES },
    tradeTax: tradeService.settings.taxPercent,
  });
});

// ---------- Handel: Steuer ----------
router.post('/admin/handel', requireAdmin, async (req, res) => {
  const tax = Number(String(typeof req.body.tax === 'string' ? req.body.tax : '').replace(',', '.'));
  if (!Number.isFinite(tax) || tax < 0 || tax > 50) {
    req.flash('error', 'Die Steuer muss zwischen 0 und 50 % liegen.');
  } else {
    const taxPercent = Math.round(tax * 10) / 10;
    await tradeService.saveSettings({ taxPercent, admin: req.user });
    req.flash('success', `Handelssteuer auf ${String(taxPercent).replace('.', ',')} % gesetzt.`);
  }
  res.redirect('/admin#handel');
});

// ---------- IHK (Mini-Game): Tageslimit und Belohnungen ----------
router.post('/admin/ihk', requireAdmin, async (req, res) => {
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
  res.redirect('/admin#ihk');
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

router.post('/admin/tcg', requireAdmin, async (req, res) => {
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
    return res.redirect('/admin#tcg');
  }

  await tcgSettings.save({ packCents, sell, weight, admin: req.user });
  const ev = Math.round(tcgCatalog.expectedPackValue());
  const ratio = Math.round((ev / packCents) * 100);
  if (ev >= packCents) {
    req.flash('info', `TCG-Einstellungen gespeichert. Achtung: Ein Pack ist jetzt im Schnitt ${euro(ev)} wert (${ratio} % vom Preis) – Packs öffnen lohnt sich also.`);
  } else {
    req.flash('success', `TCG-Einstellungen gespeichert. Ein Pack ist im Schnitt ${euro(ev)} wert (${ratio} % vom Preis ${euro(packCents)}).`);
  }
  res.redirect('/admin#tcg');
});

// ---------- TCG: Booster Packs an Mitglieder vergeben ----------
router.post('/admin/tcg/packs', requireStaff, async (req, res) => {
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
  res.redirect('/admin#packs');
});

// ---------- Pack-Log: eigene Seite, 50 Einträge pro Seite, mit Suche ----------
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
    title: 'Pack-Log',
    q,
    total,
    page,
    pages,
    entries: entries.map((e) => ({ ...e, isNew: req.user.isAdmin && e.createdAt > seen && !e.by.equals(req.user._id) })),
  });
});

// ---------- Devs ernennen / abberufen (nur Admin) ----------
router.post('/admin/devs', requireAdmin, async (req, res) => {
  const userId = typeof req.body.user === 'string' ? req.body.user : '';
  const on = req.body.action !== 'entfernen';
  const user = mongoose.isValidObjectId(userId) ? await User.findOne({ _id: userId, deletedAt: null }).select('username usernameLower').lean() : null;
  if (!user) req.flash('error', 'Bitte ein Mitglied auswählen.');
  else if (roles.roleOf(user.username) === 'admin') req.flash('error', 'Der Admin braucht keine Dev-Rolle.');
  else {
    await roles.setDev(user._id, on);
    req.flash('success', on ? `${user.username} ist jetzt Dev.` : `${user.username} ist kein Dev mehr.`);
  }
  res.redirect('/admin#devs');
});

router.post('/admin/codes', requireAdmin, async (req, res) => {
  const code = await createCode(req.user);
  req.flash('success', `Neuer Registrierungscode: ${formatCode(code.code)} – gültig für ${CODE_TTL_MINUTES} Minuten und eine Person.`);
  res.redirect('/admin');
});

router.post('/admin/codes/:id/loeschen', requireAdmin, async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) await revokeCode(req.params.id);
  req.flash('info', 'Code gelöscht.');
  res.redirect('/admin');
});

module.exports = router;
module.exports.packLogNewCount = packLogNewCount;

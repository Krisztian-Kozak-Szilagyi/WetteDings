const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Bet = require('../models/Bet');
const { requireAdmin } = require('../middleware');
const coinEngine = require('../coin/engine');
const tcgCatalog = require('../tcg/catalog');
const tcgSettings = require('../tcg/settings');
const ihk = require('../ihk/ihkService');
const tradeService = require('../trade/tradeService');
const { DIFFICULTIES } = require('../ihk/quests');
const { parseEuro } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');
const { CODE_TTL_MINUTES, formatCode, createCode, listActiveCodes, revokeCode } = require('../services/codeService');

const router = express.Router();

router.get('/admin', requireAdmin, async (req, res) => {
  const [codes, userCount, openBets, totalBets] = await Promise.all([
    listActiveCodes(),
    User.countDocuments(),
    Bet.countDocuments({ status: 'offen' }),
    Bet.countDocuments(),
  ]);
  res.render('admin', {
    title: 'Admin',
    codes,
    formatCode,
    ttlMinutes: CODE_TTL_MINUTES,
    stats: { userCount, openBets, totalBets },
    now: Date.now(),
    coin: coinEngine.isRunning() ? coinEngine.snapshot() : null,
    manipulation: coinEngine.manipulationStatus(),
    durations: DURATIONS,
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
  const durations = DIFFICULTIES.map((d) => num(req.body[`duration_${d.level}`]));
  const rewards = DIFFICULTIES.map((d) => centsOrNull(req.body[`reward_${d.level}`]));
  const required = DIFFICULTIES.map((d) => Number.parseInt(typeof req.body[`required_${d.level}`] === 'string' ? req.body[`required_${d.level}`] : '', 10));
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 100) {
    req.flash('error', 'Das Tageslimit muss zwischen 0 und 100 liegen.');
  } else if (durations.some((m) => !Number.isInteger(m) || m < 0 || m > 1440)) {
    req.flash('error', 'Die Dauer muss je Schwierigkeit zwischen 0 und 1440 Minuten liegen.');
  } else if (required.some((r) => !Number.isInteger(r) || r < 1 || r > 100000)) {
    req.flash('error', 'Bitte für jede Schwierigkeit gültige Ziel-Punkte angeben (1–100000).');
  } else if (rewards.some((r) => r === null)) {
    req.flash('error', 'Bitte für jede Schwierigkeit einen gültigen Lohn angeben.');
  } else {
    await ihk.saveSettings({ open: req.body.open === '1', dailyLimit, durations, rewards, required, admin: req.user });
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

// ---------- Samantha Coin steuern (nur Admins, für Nutzer unsichtbar) ----------

const DURATIONS = [0, 1, 5, 15, 30, 60];

router.post('/admin/coin', requireAdmin, async (req, res) => {
  const percent = Number(String(req.body.percent || '').replace(',', '.').replace('−', '-'));
  const minutes = Number(req.body.minutes);
  if (!Number.isFinite(percent) || percent === 0 || percent < -99 || percent > 1000) {
    req.flash('error', 'Bitte eine Änderung zwischen −99 % und +1000 % angeben (nicht 0).');
  } else if (!DURATIONS.includes(minutes)) {
    req.flash('error', 'Ungültige Dauer.');
  } else if (!coinEngine.isRunning()) {
    req.flash('error', 'Die Kurs-Engine läuft nicht.');
  } else {
    await coinEngine.startManipulation({ percent, minutes });
    const sign = percent > 0 ? '+' : '';
    req.flash('success', minutes
      ? `Kurssteuerung aktiv: ${sign}${percent} % über ${minutes} Min. (zusätzlich zur normalen Schwankung).`
      : `Kurs sofort um ${sign}${percent} % verändert.`);
  }
  res.redirect('/admin');
});

router.post('/admin/coin/stopp', requireAdmin, async (req, res) => {
  if (coinEngine.isRunning()) await coinEngine.cancelManipulation();
  req.flash('info', 'Kurssteuerung beendet – der Kurs bewegt sich wieder nur zufällig.');
  res.redirect('/admin');
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

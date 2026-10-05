/**
 * Lotterien: täglich, wöchentlich und monatlich – alle nach denselben Regeln.
 *  - Ein Los kostet bei der täglichen Lotterie config.lotteryTicketPrice (100 €), bei Wochen-/Monats-Lotterie
 *    den im Admin-Panel eingestellten Preis. Man kann mehrere Lose kaufen (mehr Lose = höhere Chance).
 *  - Jedes Los bekommt eine fortlaufende Nummer. Bei der Ziehung wird eine Losnummer zufällig gezogen
 *    (kryptografisch sicherer Zufall); der Besitzer bekommt den gesamten Topf – bei Wochen-/Monats-Lotterie
 *    dazu den Gewinn aus der Bank (Geld, Booster Packs, Folien; Admin-Einstellung). Ohne verkaufte Lose
 *    verfällt der Bank-Gewinn (kein Übertrag, die nächste Runde bietet ihn neu an).
 *  - Täglich: Ziehung 1 Minute vor Beginn der nächsten Lotterie (Standard: Ziehung 19:59, Start 20:00).
 *  - Wöchentlich: Ziehung sonntags, monatlich: am 28. – jeweils 30 Minuten nach der täglichen Ziehung (20:29).
 *    Fallen beide auf denselben Tag, werden sie im selben Durchlauf gezogen.
 */
const crypto = require('crypto');
const config = require('../config');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { LotteryRound, LotteryEntry, LotterySettings } = require('../models/Lottery');
const { TcgPack } = require('../models/Tcg');
const { Item } = require('../models/Item');
const catalog = require('../tcg/catalog');
const { inTransaction } = require('./betService');
const { parseZonedLocal, toZonedLocalInput } = require('../lib/time');
const { UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');
const { notify } = require('./notifyService');
const { logSettingsChange } = require('../stats/settingsLog');

const MIN = 60 * 1000;
const BIG_DRAW_DELAY = 30; // Minuten nach der täglichen Ziehung

// Lotterie-Arten. filter = Abfrage auf LotteryRound.kind (tägliche Runden haben kein kind-Feld).
const KINDS = [
  { key: 'taeglich', kind: undefined, filter: { kind: null }, path: '/lotterie', title: 'Lotterie', name: 'Tages-Lotterie', short: 'Täglich' },
  { key: 'woche', kind: 'woche', filter: { kind: 'woche' }, path: '/lotterie/woche', title: 'Wochen-Lotterie', name: 'Wochen-Lotterie', short: 'Wöchentlich' },
  { key: 'monat', kind: 'monat', filter: { kind: 'monat' }, path: '/lotterie/monat', title: 'Monats-Lotterie', name: 'Monats-Lotterie', short: 'Monatlich' },
];
const kindByKey = (key) => KINDS.find((k) => k.key === key) || null;
/** Art einer Runde (aus ihrem kind-Feld) */
const kindOfRound = (round) => KINDS.find((k) => k.kind === (round.kind || undefined));

// ---------- Einstellungen aller Lotterien (Admin-Panel): Lospreis und Bank-Gewinn ("Topf" der Bank) ----------
const MAX = { ticketPrice: 100000000, prizeCash: 100000000000, prizePacks: 500, prizeFoils: 100 };
const DEFAULTS = {
  taeglich: { ticketPrice: config.lotteryTicketPrice, prizeCash: 0, prizePacks: 0, prizeFoils: 0 },
  woche: { ticketPrice: 10000, prizeCash: 0, prizePacks: 50, prizeFoils: 0 },
  monat: { ticketPrice: 10000, prizeCash: 1000000, prizePacks: 50, prizeFoils: 2 },
};
const settings = { taeglich: { ...DEFAULTS.taeglich }, woche: { ...DEFAULTS.woche }, monat: { ...DEFAULTS.monat } };
const validInt = (v, max, min = 0) => Number.isInteger(v) && v >= min && v <= max;

/** Prüft die Werte; gibt eine Fehlermeldung zurück oder null */
function settingsError(v) {
  if (!validInt(v.ticketPrice, MAX.ticketPrice, 1)) return 'Lospreis: mindestens 0,01 €.';
  if (!validInt(v.prizeCash, MAX.prizeCash)) return 'Geld aus der Bank: 0 bis 1.000.000.000 €.';
  if (!validInt(v.prizePacks, MAX.prizePacks)) return `Booster Packs: 0 bis ${MAX.prizePacks}.`;
  if (!validInt(v.prizeFoils, MAX.prizeFoils)) return `Folien: 0 bis ${MAX.prizeFoils}.`;
  return null;
}

function apply(key, doc) {
  if (!doc) return;
  for (const f of Object.keys(MAX)) {
    if (validInt(doc[f], MAX[f], f === 'ticketPrice' ? 1 : 0)) settings[key][f] = doc[f];
  }
}

async function loadSettings() {
  const docs = await LotterySettings.find().lean();
  for (const d of docs) if (settings[d._id]) apply(d._id, d);
}

const PRIZE_FIELDS = ['prizeCash', 'prizePacks', 'prizeFoils'];
const prizesOf = (key) => (settings[key] ? Object.fromEntries(PRIZE_FIELDS.map((f) => [f, settings[key][f]])) : { prizeCash: 0, prizePacks: 0, prizeFoils: 0 });

/** Neue Werte speichern – gelten sofort, auch für die gerade offene Runde */
async function saveSettings({ admin, key, values }) {
  if (!settings[key]) throw new Error('Unbekannte Lotterie.');
  const err = settingsError(values);
  if (err) throw new UserError(err);
  const clean = Object.fromEntries(Object.keys(MAX).map((f) => [f, values[f]]));
  await LotterySettings.updateOne({ _id: key }, { $set: { ...clean, updatedByName: admin.username } }, { upsert: true });
  const before = { ...settings[key] };
  apply(key, clean);
  await LotteryRound.updateOne({ ...kindByKey(key).filter, status: 'offen' }, { $set: prizesOf(key) }); // tägliche Runden: ohne kind
  await logSettingsChange({ area: 'lotterie', before: { [key]: before }, after: { [key]: { ...settings[key] } }, by: admin });
}

/** Lospreis einer Lotterie-Art in Cent */
const ticketPrice = (key) => (settings[key] ? settings[key].ticketPrice : config.lotteryTicketPrice);

// ---------- Termine ----------
function shiftTime(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Uhrzeit der täglichen Ziehung: 1 Minute vor dem Lotterie-Start, z. B. "19:59" */
const drawTime = () => shiftTime(config.lotteryTime, -1);
/** Uhrzeit der Wochen-/Monats-Ziehung: 30 Minuten nach der täglichen, z. B. "20:29" */
const bigDrawTime = () => shiftTime(drawTime(), BIG_DRAW_DELAY);

function addDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
const weekday = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 0 = Sonntag
const localDay = (ms) => toZonedLocalInput(new Date(ms), config.timezone).slice(0, 10);
const at = (ymd, t) => parseZonedLocal(`${ymd}T${t}`, config.timezone);

/** Nächste tägliche Ziehung nach startMs (deutsche Zeit, sommerzeitsicher) */
function nextDrawAfter(startMs) {
  const day = localDay(startMs);
  const t = drawTime();
  let candidate = at(day, t);
  if (candidate.getTime() <= startMs) candidate = at(addDays(day, 1), t);
  return candidate;
}

/** Nächste Wochen-Ziehung (sonntags) nach startMs */
function nextWeeklyDrawAfter(startMs) {
  const day = localDay(startMs);
  const t = bigDrawTime();
  for (let i = 0; i <= 7; i++) {
    const d = addDays(day, i);
    if (weekday(d) !== 0) continue;
    const candidate = at(d, t);
    if (candidate.getTime() > startMs) return candidate;
  }
  return null; // nicht erreichbar
}

/** Nächste Monats-Ziehung (am 28.) nach startMs */
function nextMonthlyDrawAfter(startMs) {
  const [y, m] = localDay(startMs).split('-').map(Number);
  const t = bigDrawTime();
  for (let i = 0; i <= 1; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 28)).toISOString().slice(0, 10);
    const candidate = at(d, t);
    if (candidate.getTime() > startMs) return candidate;
  }
  return null; // nicht erreichbar
}

function nextDrawFor(key, startMs) {
  if (key === 'woche') return nextWeeklyDrawAfter(startMs);
  if (key === 'monat') return nextMonthlyDrawAfter(startMs);
  return nextDrawAfter(startMs);
}

// ---------- Runden ----------
/** Sorgt dafür, dass es eine offene Runde der Art gibt (beim Start und nach jeder Ziehung) */
async function ensureOpenRound(startMs = Date.now(), key = 'taeglich') {
  const k = kindByKey(key);
  const open = await LotteryRound.findOne({ ...k.filter, status: 'offen' }).lean();
  if (open) return open;
  const last = await LotteryRound.findOne(k.filter).sort({ number: -1 }).select('number').lean();
  try {
    const round = await LotteryRound.create({
      ...(k.kind ? { kind: k.kind } : {}),
      number: last ? last.number + 1 : 1,
      startsAt: new Date(startMs),
      drawAt: nextDrawFor(key, startMs),
      ...prizesOf(key),
    });
    return round.toObject();
  } catch (err) {
    if (err.code === 11000) return LotteryRound.findOne({ ...k.filter, status: 'offen' }).lean(); // parallel angelegt
    throw err;
  }
}

async function buyTickets({ user, count, kind = 'taeglich' }) {
  const k = kindByKey(kind);
  if (!k) throw new UserError('Diese Lotterie gibt es nicht.');
  if (!Number.isInteger(count) || count < 1 || count > config.lotteryMaxTicketsPerPurchase) {
    throw new UserError(`Du kannst 1 bis ${config.lotteryMaxTicketsPerPurchase} Lose auf einmal kaufen.`);
  }
  const cost = count * ticketPrice(k.key);

  return inTransaction(async (session) => {
    const now = new Date();
    const current = await LotteryRound.findOne({ ...k.filter, status: 'offen' }).session(session);
    if (!current) throw new UserError('Gerade läuft keine Lotterie. Bitte versuche es gleich noch einmal.');
    if (current.startsAt > now) {
      throw new UserError('Die Ziehung läuft gerade – die nächste Lotterie startet in Kürze.');
    }

    const round = await LotteryRound.findOneAndUpdate(
      { _id: current._id, status: 'offen', drawAt: { $gt: now } },
      { $inc: { tickets: count, pot: cost } },
      { new: true, session }
    );
    if (!round) throw new UserError('Der Losverkauf für diese Ziehung ist beendet.');

    const debited = await User.findOneAndUpdate(
      { _id: user._id, balance: { $gte: cost } },
      { $inc: { balance: -cost } },
      { new: true, session }
    );
    if (!debited) throw new UserError('Dein Guthaben reicht dafür nicht aus.');

    const range = { from: round.tickets - count + 1, to: round.tickets };
    const existing = await LotteryEntry.findOne({ round: round._id, user: user._id }).session(session);
    if (existing) {
      await LotteryEntry.updateOne({ _id: existing._id }, { $inc: { tickets: count }, $push: { ranges: range } }, { session });
    } else {
      await LotteryEntry.create([{ round: round._id, user: user._id, username: user.username, tickets: count, ranges: [range] }], {
        session,
      });
      await LotteryRound.updateOne({ _id: round._id }, { $inc: { participants: 1 } }, { session });
    }
    await Ledger.create([{ user: user._id, type: 'lotto_los', amount: -cost, meta: { ...(k.kind ? { kind: k.kind } : {}), count, round: round.number } }], { session });
    return { count, cost, range, round: round.number };
  });
}

/** Lotterien, für die das Team Lose vergeben kann (Vergaben im Panel) */
const GRANT_KINDS = ['woche', 'monat'];

/**
 * Lose vom Team (Vergaben): jedes Mitglied in userIds bekommt count kostenlose Lose der offenen Wochen- bzw.
 * Monats-Runde. Der Topf wächst dadurch nicht (es wurde nichts bezahlt), keine Buchung im Kontoauszug.
 */
async function grantTickets({ userIds, count, kind }) {
  const k = GRANT_KINDS.includes(kind) ? kindByKey(kind) : null;
  if (!k) throw new UserError('Lose lassen sich nur für die Wochen- oder Monats-Lotterie vergeben.');
  if (!Number.isInteger(count) || count < 1) throw new UserError('Bitte eine gültige Anzahl Lose angeben.');
  if (!userIds.length) throw new UserError('Es gibt niemanden, der Lose bekommen könnte.');
  const users = await User.find({ _id: { $in: userIds }, deletedAt: null }).select('_id username').lean();
  return inTransaction(async (session) => {
    const now = new Date();
    const current = await LotteryRound.findOne({ ...k.filter, status: 'offen' }).session(session);
    if (!current || current.startsAt > now || current.drawAt <= now) throw new UserError(`Für die ${k.name} läuft gerade kein Losverkauf – bitte nach der Ziehung noch einmal versuchen.`);
    const round = await LotteryRound.findOneAndUpdate(
      { _id: current._id, status: 'offen', drawAt: { $gt: now } },
      { $inc: { tickets: count * users.length } },
      { new: true, session }
    );
    if (!round) throw new UserError(`Der Losverkauf der ${k.name} ist gerade beendet.`);
    // Losnummern direkt im Anschluss an die bisher vergebenen, der Reihe nach je Mitglied
    let next = round.tickets - count * users.length + 1;
    const existing = new Set((await LotteryEntry.find({ round: round._id, user: { $in: users.map((u) => u._id) } }).select('user').session(session).lean()).map((e) => String(e.user)));
    let newcomers = 0;
    for (const u of users) {
      const range = { from: next, to: next + count - 1 };
      next += count;
      if (existing.has(String(u._id))) {
        await LotteryEntry.updateOne({ round: round._id, user: u._id }, { $inc: { tickets: count }, $push: { ranges: range } }, { session });
      } else {
        await LotteryEntry.create([{ round: round._id, user: u._id, username: u.username, tickets: count, ranges: [range] }], { session });
        newcomers += 1;
      }
    }
    if (newcomers) await LotteryRound.updateOne({ _id: round._id }, { $inc: { participants: newcomers } }, { session });
    return { kind: k, round: round.number, recipients: users.map((u) => u._id), count };
  });
}

/** Losnummer des k-ten Loses (1-basiert) über die Losnummern-Bereiche mehrerer Einträge, der Reihe nach */
function ticketAt(entries, k) {
  let left = k;
  for (const e of entries) {
    for (const r of e.ranges) {
      const n = r.to - r.from + 1;
      if (left <= n) return r.from + left - 1;
      left -= n;
    }
  }
  return null;
}

/**
 * Gewinner unter den Losen noch bestehender Konten auslosen – Lose gelöschter Konten nehmen nicht teil.
 * Gibt { entry, ticket } zurück oder null, wenn kein Los mehr im Spiel ist (der Topf verfällt dann).
 */
async function drawAmongActive(round, session) {
  const entries = await LotteryEntry.find({ round: round._id }).sort({ _id: 1 }).session(session);
  const goneDocs = await User.find({ _id: { $in: entries.map((e) => e.user) }, deletedAt: { $ne: null } }).select('_id').session(session).lean();
  const gone = new Set(goneDocs.map((u) => String(u._id)));
  const active = entries.filter((e) => !gone.has(String(e.user)) && e.tickets > 0);
  const total = active.reduce((s, e) => s + e.tickets, 0);
  if (!total) return null;
  const ticket = ticketAt(active, crypto.randomInt(1, total + 1));
  return { entry: active.find((e) => e.ranges.some((r) => r.from <= ticket && ticket <= r.to)), ticket };
}

/** Gewinn als Text, z. B. "12.345,00 €, 50 Booster Packs und 2 Folien" */
function prizeText({ cash, packs = 0, foils = 0 }) {
  const parts = cash || (!packs && !foils) ? [euro(cash)] : [];
  if (packs) parts.push(`${packs} ${packs === 1 ? 'Booster Pack' : 'Booster Packs'}`);
  if (foils) parts.push(`${foils} ${foils === 1 ? 'Folie' : 'Folien'}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} und ${parts[parts.length - 1]}` : parts[0];
}

/** Zieht eine fällige Runde der Art. Gibt das Ergebnis zurück oder null, wenn nichts fällig war. */
async function drawDueRound(now = new Date(), key = 'taeglich') {
  const k = kindByKey(key);
  const result = await inTransaction(async (session) => {
    const round = await LotteryRound.findOne({ ...k.filter, status: 'offen', drawAt: { $lte: now } }).session(session);
    if (!round) return null;

    let winner = null;
    let winningTicket = null;
    const cash = round.pot + (round.prizeCash || 0);
    const packs = round.prizePacks || 0;
    const foils = round.prizeFoils || 0;
    const drawn = round.tickets > 0 ? await drawAmongActive(round, session) : null;
    if (drawn) {
      winner = drawn.entry;
      winningTicket = drawn.ticket;
      if (cash) {
        await User.updateOne({ _id: winner.user }, { $inc: { balance: cash } }, { session });
        // Runde und Gewinnlos für die Protokolle im Panel
        const meta = { ...(k.kind ? { kind: k.kind, bank: round.prizeCash || 0 } : {}), round: round.number, ticket: winningTicket };
        await Ledger.create([{ user: winner.user, type: 'lotto_gewinn', amount: cash, meta }], { session });
      }
      if (packs) {
        await TcgPack.insertMany(Array.from({ length: packs }, () => ({ user: winner.user, type: catalog.DEFAULT_PACK, source: 'lotto', cost: 0 })), { session });
      }
      if (foils) await Item.insertMany(Array.from({ length: foils }, () => ({ user: winner.user, type: 'folie', source: 'lotto' })), { session });
    }

    const updated = await LotteryRound.updateOne(
      { _id: round._id, status: 'offen' },
      {
        $set: {
          status: 'gezogen',
          drawnAt: now,
          winningTicket,
          winner: winner ? winner.user : null,
          winnerName: winner ? winner.username : null,
        },
      },
      { session }
    );
    if (updated.modifiedCount !== 1) return null;
    return { kind: k.key, number: round.number, drawAt: round.drawAt, pot: round.pot, cash, packs, foils, tickets: round.tickets, winningTicket, winnerName: winner ? winner.username : null, winnerId: winner ? winner.user : null };
  });

  if (result && result.winnerId) {
    const label = k.key === 'taeglich' ? 'die Lotterie' : `die ${k.name}`;
    await notify(result.winnerId, { area: 'Lotterie', href: k.path, text: `Glückwunsch! Dein Los ${result.winningTicket} hat ${label} #${result.number} gewonnen – ${prizeText(result)} gehen an dich.` });
  }

  if (result) {
    // Nächste Runde startet 1 Minute nach der (geplanten) Ziehung – bzw. sofort, falls die Ziehung verspätet war
    await ensureOpenRound(Math.max(result.drawAt.getTime() + MIN, Date.now()), key);
  }
  return result;
}

/** Wird regelmäßig aufgerufen: fällige Ziehungen aller Arten durchführen und offene Runden sicherstellen */
async function runLottery() {
  for (const k of KINDS) {
    let r;
    while ((r = await drawDueRound(new Date(), k.key))) {
      const name = `${k.name} #${r.number}`;
      console.log(
        r.winnerName
          ? `${name}: Los ${r.winningTicket} von ${r.tickets} gewinnt – ${r.winnerName} erhält ${(r.cash / 100).toFixed(2)} €${r.packs ? `, ${r.packs} Packs` : ''}${r.foils ? `, ${r.foils} Folien` : ''}.`
          : r.tickets
            ? `${name}: alle Lose gehören gelöschten Konten – der Topf verfällt.`
            : `${name}: keine Lose verkauft.`
      );
    }
    await ensureOpenRound(Date.now(), k.key);
  }
}

module.exports = {
  KINDS,
  GRANT_KINDS,
  grantTickets,
  kindByKey,
  kindOfRound,
  settings,
  DEFAULTS,
  loadSettings,
  saveSettings,
  settingsError,
  ticketPrice,
  prizeText,
  ticketAt,
  drawTime,
  bigDrawTime,
  nextDrawAfter,
  nextWeeklyDrawAfter,
  nextMonthlyDrawAfter,
  ensureOpenRound,
  buyTickets,
  drawDueRound,
  runLottery,
};

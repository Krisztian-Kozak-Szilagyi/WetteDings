/**
 * Täglicher Börsenbericht um 18:45 Uhr deutscher Zeit: sammelt die Kennzahlen der letzten 24 Stunden (und der
 * Vortage zum Vergleich), lässt den BfW-TCG ETF entsprechend springen und veröffentlicht den Bericht im Forum
 * (Bereich „Börsenbericht“, Verfasser „Börse“). Die Rechnung steht in marketReport.js.
 * Läuft höchstens einmal pro Tag (MarketReport mit dem Tag als _id); war der Server um 18:45 aus, folgt der
 * Bericht beim nächsten Start desselben Tages.
 */
const config = require('../config');
const Ledger = require('../models/Ledger');
const ActivityPulse = require('../models/ActivityPulse');
const MarketReport = require('../models/MarketReport');
const { ForumPost, ForumThread } = require('../models/Forum');
const { UserError } = require('../lib/util');
const { toZonedLocalInput, parseZonedLocal } = require('../lib/time');
const report = require('./marketReport');
const markets = require('./markets');
const { BOERSE } = require('../forum/systemAuthors');

const REPORT_TIME = '18:45';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const HISTORY_DAYS = 30;
const ETF = 'BTCG';
const MOOD_SCALE = 0.3; // Sprung (Log) → Stimmung −1 … +1 für die Anzeige „Bullisch/Bärisch“

const TYPE_METRIC = new Map(report.METRICS.flatMap((m) => (m.types || []).map((t) => [t, m.key])));

/** Fenster-Nummer als Ausdruck: 0 = die 24 Stunden vor end, 1 = der Tag davor … */
const windowExpr = (end) => ({ $floor: { $divide: [{ $subtract: [end, '$createdAt'] }, DAY] } });

/**
 * Kennzahlen je Tag aus Buchungen, Forum-Beiträgen und der Aktivitätszählung (ActivityPulse).
 * Aktionen je Mitglied und Kennzahl zählen höchstens PER_USER_CAP-mal am Tag.
 * Anleger/Aktionen gibt es erst, seit die Aktivitätszählung läuft – davor stehen sie auf null (kein Vergleichswert,
 * statt künstlicher Nullen); Buchungen und Forum reichen die ganzen 30 Tage zurück.
 * @returns {{today: object, history: object[]}}  history: neuester Vortag zuerst
 */
async function collect(endMs) {
  const end = new Date(endMs);
  const since = new Date(endMs - (HISTORY_DAYS + 1) * DAY);
  const [ledger, posts, pulses, first] = await Promise.all([
    Ledger.aggregate([
      { $match: { type: { $in: [...TYPE_METRIC.keys()] }, createdAt: { $gte: since, $lt: end } } },
      { $group: { _id: { t: '$type', u: '$user', i: windowExpr(end) }, n: { $sum: 1 } } },
    ]),
    ForumPost.aggregate([
      { $match: { createdAt: { $gte: since, $lt: end }, deleted: false, author: { $ne: BOERSE.id } } },
      { $group: { _id: { u: '$author', i: windowExpr(end) }, n: { $sum: 1 } } },
    ]),
    ActivityPulse.find({ t: { $gte: since, $lt: end } }).lean(),
    ActivityPulse.findOne().sort({ t: 1 }).select('t').lean(),
  ]);
  const rows = [
    ...ledger.map((r) => ({ i: r._id.i, key: TYPE_METRIC.get(r._id.t), u: String(r._id.u), n: r.n })),
    ...posts.map((r) => ({ i: r._id.i, key: 'forum', u: String(r._id.u), n: r.n })),
  ];
  const pulseDocs = pulses.map((p) => ({ i: Math.floor((endMs - p.t.getTime()) / DAY), n: p.n || 0, users: (p.users || []).map(String) }));
  const complete = first ? Math.max(0, Math.floor((endMs - first.t.getTime() + HOUR) / DAY) - 1) : 0;
  return tally(rows, pulseDocs, complete);
}

/** Zählt Zeilen { i, key, u, n } und Stunden { i, n, users } zu Tagen zusammen (rein, testbar) */
function tally(rows, pulseDocs, complete) {
  const days = Array.from({ length: HISTORY_DAYS + 1 }, () => Object.fromEntries(report.METRICS.map((m) => [m.key, 0])));
  const perUser = new Map();
  for (const r of rows) {
    if (r.i < 0 || r.i > HISTORY_DAYS || !r.key) continue;
    const k = `${r.i}|${r.key}|${r.u}`;
    perUser.set(k, (perUser.get(k) || 0) + r.n);
  }
  for (const [k, n] of perUser) {
    const [i, key] = k.split('|');
    days[i][key] += Math.min(n, report.PER_USER_CAP);
  }
  const users = days.map(() => new Set());
  for (const p of pulseDocs) {
    if (p.i < 0 || p.i > HISTORY_DAYS) continue;
    days[p.i].aktionen += p.n;
    for (const u of p.users) users[p.i].add(u);
  }
  users.forEach((s, i) => {
    const counted = i === 0 || i <= complete;
    days[i].anleger = counted ? s.size : null;
    if (!counted) days[i].aktionen = null;
  });
  return { today: days[0], history: days.slice(1) };
}

/** Tag ("YYYY-MM-DD") und Zeitpunkt des Berichts in deutscher Zeit */
function dueOf(now) {
  const day = toZonedLocalInput(now, config.timezone).slice(0, 10);
  return { day, due: parseZonedLocal(`${day}T${REPORT_TIME}`, config.timezone) };
}

/** Ist der Bericht des Tages fällig und noch nicht da? Dann auswerten, ETF springen lassen, im Forum veröffentlichen. */
async function runDue(now = new Date()) {
  const { day, due } = dueOf(now);
  if (!due || now < due) return null;
  const etf = markets.get(ETF);
  if (!etf || !etf.isRunning()) return null;
  try {
    await MarketReport.create({ _id: day, at: now });
  } catch (err) {
    if (err.code === 11000) return null; // schon erledigt (oder läuft gerade)
    throw err;
  }
  return publish({ day, due, etf, prev: null });
}

/**
 * Admin: den heutigen Bericht neu auswerten (z. B. nach einer Korrektur der Rechnung). Der frühere Sprung wird dabei
 * verrechnet (der ETF springt nur um die Differenz), der alte Forum-Beitrag verschwindet, ein neuer erscheint.
 */
async function redoToday(now = new Date()) {
  const { day, due } = dueOf(now);
  if (!due || now < due) throw new UserError(`Der heutige Bericht ist erst ab ${REPORT_TIME} Uhr fällig.`);
  const etf = markets.get(ETF);
  if (!etf || !etf.isRunning()) throw new UserError('Der ETF läuft gerade nicht.');
  const prev = await MarketReport.findOneAndUpdate({ _id: day, status: 'fertig' }, { $set: { status: 'laeuft' } }).lean();
  if (!prev) {
    const res = await runDue(now);
    if (!res) throw new UserError('Der Bericht wird gerade erstellt – bitte kurz warten.');
    return res;
  }
  return publish({ day, due, etf, prev });
}

async function publish({ day, due, etf, prev }) {
  let res;
  let jump = null;
  try {
    const { today, history } = await collect(due.getTime());
    res = report.evaluate(today, history);
    jump = await etf.jump(res.log - (prev ? prev.log || 0 : 0), Math.max(-1, Math.min(1, res.log / MOOD_SCALE)));
    await MarketReport.updateOne(
      { _id: day },
      { $set: { status: 'fertig', at: new Date(), rows: res.rows, sentiment: res.sentiment, records: res.records, log: res.log, change: res.change, mood: res.mood, priceBefore: prev && prev.priceBefore !== null ? prev.priceBefore : jump.before, priceAfter: jump.after } }
    );
  } catch (err) {
    if (!jump) {
      if (prev) await MarketReport.updateOne({ _id: day }, { $set: { status: 'fertig' } }).catch(() => {});
      else await MarketReport.deleteOne({ _id: day, status: 'laeuft' }).catch(() => {}); // beim nächsten Durchlauf neu versuchen
    }
    throw err;
  }
  console.log(`Börsenbericht ${day}: ${res.mood}, ETF ${(res.change * 100).toFixed(1)} %${prev ? ' (neu ausgewertet)' : ''}`);
  // Forum zuletzt: scheitert es, bleibt der Sprung trotzdem gültig
  const [y, m, d] = day.split('-');
  const text = report.reportText(res, `${d}.${m}.${y}`);
  if (prev && prev.thread) await ForumThread.updateOne({ _id: prev.thread }, { $set: { deleted: true } });
  const forumService = require('../forum/forumService'); // erst hier laden: zieht viele Module nach sich
  const thread = await forumService.systemThread({ author: BOERSE, categoryKey: 'boersenbericht', title: text.title, body: text.body });
  await MarketReport.updateOne({ _id: day }, { $set: { thread: thread._id } });
  return res;
}

/** Die letzten Berichte (Admin-Panel) */
const latest = (limit = 14) => MarketReport.find({ status: 'fertig' }).sort({ _id: -1 }).limit(limit).lean();

module.exports = { REPORT_TIME, collect, tally, dueOf, runDue, redoToday, latest };

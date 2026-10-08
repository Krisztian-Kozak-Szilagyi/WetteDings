/**
 * Wochenrückblick jeden Freitag um 11:30 Uhr deutscher Zeit: Top-Gewinner, seltenste Ziehung, bester Trade und
 * größter Aufsteiger der letzten sieben Tage – als Thema im Forum (Allgemein → „Wochenrückblick“, Verfasser
 * „Wochenrückblick“). Die Auswertung steht in weeklyReview.js. Das Team (Admin, Devs, Mods) und gelöschte Konten
 * kommen nicht vor – wie in der Rangliste. Läuft höchstens einmal pro Freitag (WeeklyReview mit dem Tag als _id);
 * war der Server um 11:30 aus, folgt der Rückblick beim nächsten Start desselben Freitags.
 */
const config = require('../config');
const User = require('../models/User');
const StatDaily = require('../models/StatDaily');
const WeeklyReview = require('../models/WeeklyReview');
const { TcgOpening } = require('../models/Tcg');
const { Trade } = require('../models/Trade');
const { toZonedLocalInput, parseZonedLocal } = require('../lib/time');
const { ranking, teamIds } = require('../services/rankService');
const { bestCard } = require('../forum/hallOfFame');
const catalog = require('../tcg/catalog');
const { lineLabel } = require('../trade/lines');
const { WOCHENRUECKBLICK } = require('../forum/systemAuthors');
const review = require('./weeklyReview');

const DAY = 24 * 60 * 60 * 1000;
const SNAPSHOT_SLACK_DAYS = 3; // fehlt der Tagesstand von vor einer Woche, darf er bis zu 3 Tage älter sein

/** Tag ("YYYY-MM-DD") und Zeitpunkt des Rückblicks; due = null, wenn heute kein Freitag ist */
function dueOf(now) {
  const day = toZonedLocalInput(now, config.timezone).slice(0, 10);
  if (review.weekdayOf(day) !== review.REVIEW_WEEKDAY) return { day, due: null };
  return { day, due: parseZonedLocal(`${day}T${review.REVIEW_TIME}`, config.timezone) };
}

/** Alle Höhepunkte der Woche bis end (Date) – day = Tag des Rückblicks */
async function collect(day, end) {
  const since = new Date(end.getTime() - 7 * DAY);
  const weekAgo = review.shiftDay(day, -7);
  const [team, gone, now, snap, openings, trades] = await Promise.all([
    teamIds(),
    User.distinct('_id', { deletedAt: { $ne: null } }),
    ranking(),
    StatDaily.findOne({ _id: { $lte: weekAgo, $gte: review.shiftDay(weekAgo, -SNAPSHOT_SLACK_DAYS) } }).sort({ _id: -1 }).select('players').lean(),
    TcgOpening.find({ createdAt: { $gte: since, $lt: end } }).sort({ best: -1, createdAt: 1 }).limit(50).select('user username cards createdAt').lean(),
    Trade.find({ status: 'verkauft', kind: { $in: ['markt', 'privat'] }, closedAt: { $gte: since, $lt: end }, price: { $gt: 0 } })
      .sort({ price: -1, closedAt: 1 })
      .limit(50)
      .select('seller sellerName buyer buyerName give want extraFrom price closedAt')
      .lean(),
  ]);
  const out = new Set([...team, ...gone].map(String));
  const ok = (id) => id && !out.has(String(id));
  const { gainers, climber } = snap ? review.standings(now.map((p) => ({ user: p._id, username: p.username, total: p.total })), snap.players) : { gainers: [], climber: null };
  const pull = review.rarestPull(openings.filter((o) => ok(o.user)), bestCard);
  // reine Verkäufe: Karten/Gegenstände gegen Geld vom Käufer (kein Tausch mit Gegenleistung)
  const trade = review.bestTrade(trades.filter((t) => ok(t.seller) && ok(t.buyer) && !(t.want || []).length && t.extraFrom !== 'seller' && (t.give || []).length));
  // aktuelle Namen (für @Erwähnungen) – gespeicherte Namen könnten seit einer Umbenennung veraltet sein
  const ids = [pull && pull.user, trade && trade.seller, trade && trade.buyer].filter(Boolean);
  const names = new Map((ids.length ? await User.find({ _id: { $in: ids } }).select('username').lean() : []).map((u) => [String(u._id), u.username]));
  const nameOf = (id, fallback) => names.get(String(id)) || fallback;
  const cardName = (id) => (catalog.cardById[id] ? catalog.cardById[id].name : id);
  return {
    from: review.shiftDay(day, -7),
    to: day,
    gainers,
    climber,
    pull: pull && { name: nameOf(pull.user, pull.name), card: pull.card, cardName: cardName(pull.card), rarity: { key: pull.rarity.key, label: pull.rarity.label, rank: pull.rarity.rank } },
    trade: trade && { sellerName: nameOf(trade.seller, trade.sellerName), buyerName: nameOf(trade.buyer, trade.buyerName), price: trade.price, label: lineLabel(trade.give) },
    compared: !!snap,
  };
}

/** Ist der Rückblick dieses Freitags fällig und noch nicht da? Dann auswerten und im Forum veröffentlichen. */
async function runDue(now = new Date()) {
  const { day, due } = dueOf(now);
  if (!due || now < due) return null;
  try {
    await WeeklyReview.create({ _id: day, at: now });
  } catch (err) {
    if (err.code === 11000) return null; // schon erledigt (oder läuft gerade)
    throw err;
  }
  let data;
  try {
    data = await collect(day, due);
    await WeeklyReview.updateOne({ _id: day }, { $set: { status: 'fertig', at: new Date(), data } });
  } catch (err) {
    await WeeklyReview.deleteOne({ _id: day, status: 'laeuft' }).catch(() => {}); // beim nächsten Durchlauf neu versuchen
    throw err;
  }
  const text = review.reviewText(data);
  const forumService = require('../forum/forumService'); // erst hier laden: zieht viele Module nach sich
  const thread = await forumService.systemThread({ author: WOCHENRUECKBLICK, categoryKey: 'wochenrueckblick', title: text.title, body: text.body });
  await WeeklyReview.updateOne({ _id: day }, { $set: { thread: thread._id } });
  console.log(`Wochenrückblick ${day} veröffentlicht.`);
  return data;
}

module.exports = { dueOf, collect, runDue };

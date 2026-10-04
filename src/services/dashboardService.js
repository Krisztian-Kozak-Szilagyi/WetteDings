// Dashboard (Startseite nach der Anmeldung): sammelt, was für ein Mitglied gerade wichtig ist.
// Alles wird parallel geladen; die reinen Hilfsfunktionen (Kurven, Termine) sind ohne Datenbank getestet.
const config = require('../config');
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const StatDaily = require('../models/StatDaily');
const { ForumThread } = require('../models/Forum');
const { LotteryEntry } = require('../models/Lottery');
const { DungeonParty } = require('../models/Dungeon');
const { GradingShop } = require('../models/Grading');
const rankService = require('./rankService');
const bonusService = require('./bonusService');
const lottery = require('./lotteryService');
const markets = require('../coin/markets');
const blackMarket = require('../tcg/blackMarket');
const { favoriteList, inventory } = require('../tcg/tcgService');
const forumService = require('../forum/forumService');
const ihk = require('../ihk/ihkService');
const grading = require('../grading/gradingService');
const dungeon = require('../dungeon/dungeonService');
const { toZonedLocalInput } = require('../lib/time');

const CURVE_DAYS = 7;
const BETS_MAX = 5;
const THREADS_MAX = 5;
const NOTES_MAX = 5;

// ---------- Reine Hilfsfunktionen ----------

/** "YYYY-MM-DD" days Tage vor day */
function dayBefore(day, days) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

/**
 * Kurve als SVG-Pfad (Breite w, Höhe h, etwas Luft oben/unten): { line, area, min, max } oder null bei < 2 Punkten.
 * area ist die geschlossene Fläche unter der Linie (für den Verlauf).
 */
function curve(values, w = 300, h = 80, pad = 6) {
  if (!values || values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - pad - ((v - min) / span) * (h - 2 * pad)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return { line, area: `${line} L${w},${h} L0,${h} Z`, min, max, last: pts[pts.length - 1] };
}

/** Veränderung in Cent und Prozent zwischen erstem und letztem Wert (null, wenn es nichts zu vergleichen gibt) */
function change(values) {
  if (!values || values.length < 2) return null;
  const first = values[0];
  const diff = values[values.length - 1] - first;
  return { diff, pct: first > 0 ? diff / first : null };
}

/** Tageszeit-Gruß (deutsche Zeit) */
function greeting(now = new Date()) {
  const h = Number(toZonedLocalInput(now, config.timezone).slice(11, 13));
  if (h < 5) return 'Gute Nacht';
  if (h < 11) return 'Guten Morgen';
  if (h < 18) return 'Guten Tag';
  return 'Guten Abend';
}

/** Termine sortieren, vergangene weglassen */
const upcoming = (list, now = Date.now()) => list.filter((e) => e && e.at && e.at.getTime() > now).sort((a, b) => a.at - b.at);

// ---------- Laden ----------

/** Vermögen jetzt (aus der Rangliste, damit es exakt dieselbe Rechnung ist), Platz und Kurve der letzten Tage */
async function wealth(user) {
  const today = bonusService.today();
  const [list, days] = await Promise.all([
    rankService.ranking(),
    StatDaily.aggregate([
      { $match: { _id: { $gte: dayBefore(today, CURVE_DAYS - 1), $lt: today } } },
      { $project: { p: { $filter: { input: '$players', cond: { $eq: ['$$this.user', user._id] } } } } },
      { $sort: { _id: 1 } },
    ]),
  ]);
  const i = list.findIndex((r) => r._id.equals(user._id));
  const me = i >= 0 ? list[i] : { balance: user.balance, inPlay: 0, coinValue: 0, cardValue: 0, total: user.balance };
  const points = days.filter((d) => d.p.length).map((d) => ({ day: d._id, total: d.p[0].total }));
  points.push({ day: today, total: me.total });
  const values = points.map((p) => p.total);
  return { ...me, rank: i >= 0 ? i + 1 : null, players: list.length, points, curve: curve(values), change: change(values) };
}

/** Eigene offene Einsätze, nach der nächsten Frist sortiert */
async function openBets(user) {
  const mine = await Position.aggregate([{ $match: { user: user._id, payout: null } }, { $group: { _id: '$bet', stake: { $sum: '$amount' }, side: { $first: '$side' } } }]);
  if (!mine.length) return { list: [], total: 0, count: 0 };
  const bets = await Bet.find({ _id: { $in: mine.map((m) => m._id) }, status: 'offen' }).select('title deadline resultAt options duel').lean();
  const now = Date.now();
  const byId = new Map(mine.map((m) => [String(m._id), m]));
  const list = bets
    .map((b) => {
      const m = byId.get(String(b._id));
      const pot = (b.options || []).reduce((s, o) => s + (o.total || 0), 0);
      const open = b.deadline && b.deadline.getTime() > now;
      const picked = ((b.options || []).find((o) => o.key === m.side) || {}).label || null;
      return { id: b._id, title: b.title, stake: m.stake, pot, picked, duel: !!b.duel, open, at: open ? b.deadline : b.resultAt || null };
    })
    .sort((a, b) => (a.open === b.open ? (a.at || 0) - (b.at || 0) : a.open ? -1 : 1));
  return { list: list.slice(0, BETS_MAX), total: list.reduce((s, b) => s + b.stake, 0), count: list.length };
}

/** Was heute ansteht: Tagesbonus, IHK, Grading, Dungeon, Tages-Lotterie */
async function todayStatus(user) {
  const isAdmin = user.isAdmin;
  const show = { ihk: ihk.settings.open || isAdmin, grading: grading.settings.open || isAdmin, dungeon: dungeon.settings.open || isAdmin };
  const round = await lottery.ensureOpenRound(Date.now(), 'taeglich');
  const [working, ihkState, gradingState, party, entry] = await Promise.all([
    GradingShop.exists({ _id: user._id, active: true }),
    show.ihk ? ihk.getState(user._id) : null,
    show.grading ? grading.getState(user._id) : null,
    show.dungeon ? DungeonParty.findOne({ 'members.user': user._id }).select('slot').lean() : null,
    LotteryEntry.findOne({ round: round._id, user: user._id }).select('tickets').lean(),
  ]);
  const items = [];
  const bonus = bonusService.settings.amount;
  if (bonus) {
    const got = !working && user.lastBonusDay === bonusService.today();
    items.push({ key: 'bonus', label: 'Tagesbonus', href: '/konto/auszug', done: got, text: working ? 'Entfällt – du arbeitest im Grading-Shop' : got ? `${(bonus / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })} gutgeschrieben` : `Ab ${config.bonusTime} Uhr` });
  }
  if (ihkState) {
    const run = ihkState.running;
    items.push({ key: 'ihk', label: 'IHK-Quests', href: '/ihk', done: ihkState.used >= ihkState.limit && !run, progress: [ihkState.used, ihkState.limit], text: run ? 'Quest läuft' : ihkState.used >= ihkState.limit ? 'Für heute erledigt' : `Noch ${ihkState.limit - ihkState.used} offen`, at: run ? run.endsAt : null });
  }
  if (gradingState) {
    const active = gradingState.shop && gradingState.shop.active;
    items.push({ key: 'grading', label: 'Grading-Shop', href: '/grading', done: active && gradingState.used >= gradingState.limit, progress: active ? [gradingState.used, gradingState.limit] : null, text: !active ? 'Kein Job – jetzt bewerben' : gradingState.open ? 'Auftrag offen' : gradingState.used >= gradingState.limit ? 'Alle Aufträge erledigt' : `${gradingState.limit - gradingState.used} Aufträge warten` });
  }
  if (show.dungeon) {
    const slot = party ? party.slot : dungeon.registrationSlot();
    items.push({ key: 'dungeon', label: 'Dungeon', href: '/dungeon', done: !!party, text: party ? 'Angemeldet' : 'Noch nicht angemeldet', at: slot });
  }
  const tickets = entry ? entry.tickets : 0;
  items.push({ key: 'lotto', label: 'Tages-Lotterie', href: '/lotterie', done: tickets > 0, text: tickets ? `${tickets} ${tickets === 1 ? 'Los' : 'Lose'} im Topf` : 'Noch kein Los', at: round.drawAt });
  return { items, done: items.filter((i) => i.done).length };
}

/** Termine: Black Market, Ziehungen der Lotterien, nächster Dungeon */
async function countdowns(user) {
  const [week, month] = await Promise.all(['woche', 'monat'].map((k) => lottery.ensureOpenRound(Date.now(), k)));
  const bm = blackMarket.windowAt();
  const list = [
    { key: 'bm', label: bm.open ? 'Black Market schließt' : 'Black Market öffnet', href: '/handel#blackmarket', at: bm.open ? bm.closesAt : bm.opensAt, live: bm.open },
    { key: 'woche', label: 'Wochen-Lotterie', href: '/lotterie/woche', at: week.drawAt },
    { key: 'monat', label: 'Monats-Lotterie', href: '/lotterie/monat', at: month.drawAt },
  ];
  if (dungeon.settings.open || user.isAdmin) list.push({ key: 'dungeon', label: 'Nächster Dungeon', href: '/dungeon', at: dungeon.slotAfter() });
  return upcoming(list);
}

/** Zuletzt aktive Forum-Themen mit Ungelesen-Markierung */
async function forumLatest(user) {
  const [threads, reads] = await Promise.all([
    ForumThread.find({ deleted: false }).sort({ lastPostAt: -1 }).limit(THREADS_MAX).select('title lastPostAt lastPostByName replyCount pinned').lean(),
    forumService.readMap(user._id),
  ]);
  return threads.map((t) => ({ ...t, unread: forumService.isUnread(reads, t) }));
}

/** Broker-Werte mit Mini-Kurve (24 h) */
async function ticker() {
  const histories = await Promise.all(markets.LIST.map((e) => e.history('24h').catch(() => [])));
  return markets.LIST.map((e, i) => {
    const s = e.snapshot();
    const c = curve(histories[i].map((p) => p[1]), 120, 32, 2);
    return { ...s, href: `/broker/${s.symbol.toLowerCase()}`, spark: c ? c.line : '' };
  });
}

/** Lieblingskarten (wie im Profil) */
async function favorites(user) {
  if (!(user.tcgFavorites || []).length) return [];
  const owned = await inventory(user._id);
  return favoriteList(user, Object.fromEntries(owned.map((o) => [o._id, o.n - (o.foiled || 0)])));
}

async function load(user) {
  const [w, bets, today, cds, threads, tick, favs] = await Promise.all([wealth(user), openBets(user), todayStatus(user), countdowns(user), forumLatest(user), ticker(), favorites(user)]);
  return { greeting: greeting(), wealth: w, bets, today, countdowns: cds, threads, ticker: tick, favorites: favs, notesMax: NOTES_MAX };
}

module.exports = { CURVE_DAYS, dayBefore, curve, change, greeting, upcoming, load };

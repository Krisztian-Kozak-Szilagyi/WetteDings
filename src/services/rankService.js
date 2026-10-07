// Rangliste nach Gesamtvermögen – und die Zeit, die ein Mitglied auf Platz 1 verbracht hat
const User = require('../models/User');
const RankStint = require('../models/RankStint');
const markets = require('../coin/markets');
const tcgSettings = require('../tcg/settings');
const { sellValueExpr } = require('../tcg/tcgService');
const config = require('../config');

const TICK_MS = 60 * 1000; // so oft wird Platz 1 geprüft
const MAX_GAP_MS = 5 * 60 * 1000; // längere Pausen (Neustart, Ausfall) zählen nicht als Zeit auf Platz 1
// Per Handel bekommene Karten zählen für die Platzierung so viele Tage höchstens mit dem, was man dafür gegeben hat
// (TcgCard.tradedCost) – eine geschenkte oder billig weitergereichte teure Karte bringt niemanden auf Platz 1
const FRESH_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- Team (Admin und Devs) ----------
// Das Team spielt mit, zählt aber nicht in der Rangliste und nicht in der Wirtschaft (Statistik): Seine Konten
// entstehen durch Tests und Vergaben und würden Platzierungen, Geldmenge und Verteilung verfälschen.

/** Gehört das Konto zum Team? (braucht role und usernameLower) */
const isTeam = (user) => !!user && (user.role === 'dev' || config.adminUsernames.includes(user.usernameLower));
/** Filter für Konten außerhalb des Teams */
const notTeam = () => ({ role: { $ne: 'dev' }, usernameLower: { $nin: config.adminUsernames } });
/** IDs aller Team-Konten (auch gelöschte) – zum Ausschließen ihrer Buchungen */
const teamIds = () => User.distinct('_id', { $or: [{ role: 'dev' }, { usernameLower: { $in: config.adminUsernames } }] });

/**
 * Alle Mitglieder nach Gesamtvermögen, bestes zuerst – ohne das Team; mit team: true auch das Team (Feld team). Gesamtvermögen = Kontostand + offene Einsätze + Wert der
 * Broker-Bestände (Coins, ETF) zum aktuellen Kurs + Verkaufswert der TCG-Karten (inkl. ungeöffneter Packs zum Packpreis)
 * + Wert des Grading-Shops (Hälfte der Ausbaukosten, gradingService.shopValue).
 * Sortiert wird nach rankTotal = total − fresh: fresh ist der Mehrwert frisch gehandelter Karten über dem, was dafür
 * gegeben wurde (FRESH_DAYS). Statistiken der Wirtschaft nutzen weiter total.
 */
function ranking({ limit = 0, team = false, userId = null } = {}) {
  // Cent je Einheit (1e-8) für jeden laufenden Broker-Wert
  const prices = markets.prices();
  const branches = Object.entries(prices).map(([sym, p]) => ({ case: { $eq: ['$$h.coin', sym] }, then: (p * 100) / 1e8 }));
  const centsPerUnit = branches.length ? { $switch: { branches, default: 0 } } : 0;
  // erst hier laden: gradingService zieht viele Module nach sich
  const shopValues = require('../grading/gradingService').shopValues();
  const freshSince = new Date(Date.now() - FRESH_DAYS * DAY_MS);
  const pipeline = [
    // gelöschte Konten erscheinen nicht, das Team nur auf Wunsch; mit userId nur dieses Mitglied (Profil-Statistik)
    { $match: { deletedAt: null, ...(team ? {} : notTeam()), ...(userId ? { _id: userId } : {}) } },
    {
      $lookup: {
        from: 'positions',
        let: { uid: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$user', '$$uid'] }, payout: null } },
          { $group: { _id: null, s: { $sum: '$amount' } } },
        ],
        as: 'open',
      },
    },
    {
      $lookup: {
        from: 'coinholdings',
        localField: '_id',
        foreignField: 'user',
        as: 'coins',
      },
    },
    {
      $lookup: {
        from: 'tcgcards',
        let: { uid: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$user', '$$uid'] } } },
          { $group: { _id: null, s: { $sum: sellValueExpr() }, fresh: { $sum: freshExcessExpr(freshSince) } } },
        ],
        as: 'cards',
      },
    },
    // ungeöffnete Booster Packs zählen zum aktuellen Packpreis bei den Karten mit
    { $lookup: { from: 'tcgpacks', localField: '_id', foreignField: 'user', as: 'packs' } },
    // Grading-Shop (_id = User-ID): Wert nach Ausbaustufe
    { $lookup: { from: 'gradingshops', localField: '_id', foreignField: '_id', as: 'shop' } },
    {
      $addFields: {
        inPlay: { $ifNull: [{ $first: '$open.s' }, 0] },
        coinValue: { $floor: { $sum: { $map: { input: '$coins', as: 'h', in: { $multiply: ['$$h.units', centsPerUnit] } } } } },
        cardValue: { $add: [{ $ifNull: [{ $first: '$cards.s' }, 0] }, { $multiply: [{ $size: '$packs' }, tcgSettings.getPackPrice()] }] },
        shopValue: {
          $ifNull: [{ $arrayElemAt: [shopValues, { $subtract: [{ $min: [shopValues.length, { $max: [1, { $ifNull: [{ $first: '$shop.level' }, 1] }] }] }, 1] }] }, 0],
        },
      },
    },
    { $addFields: { total: { $add: ['$balance', '$inPlay', '$coinValue', '$cardValue', '$shopValue'] }, fresh: { $ifNull: [{ $first: '$cards.fresh' }, 0] } } },
    { $addFields: { rankTotal: { $subtract: ['$total', '$fresh'] } } },
    { $sort: { rankTotal: -1, createdAt: 1 } },
    { $project: { username: 1, avatar: 1, balance: 1, inPlay: 1, coinValue: 1, cardValue: 1, shopValue: 1, total: 1, fresh: 1, rankTotal: 1, team: { $or: [{ $eq: ['$role', 'dev'] }, { $in: ['$usernameLower', config.adminUsernames] }] } } },
  ];
  if (limit) pipeline.push({ $limit: limit });
  return User.aggregate(pipeline);
}

/**
 * MongoDB-Ausdruck je Karte: Mehrwert über dem Anschaffungswert, wenn sie seit since per Handel kam (sonst 0).
 * Karten ohne tradedAt (aus Packs, Dungeon, Duell oder vor dieser Regel gehandelt) zählen voll.
 */
function freshExcessExpr(since) {
  return {
    $cond: [
      { $and: [{ $gt: ['$tradedAt', since] }, { $ne: [{ $type: '$tradedCost' }, 'missing'] }] },
      { $max: [0, { $subtract: [sellValueExpr(), '$tradedCost'] }] },
      0,
    ],
  };
}

// ---------- Zeit auf Platz 1 ----------
let lastTick = 0;

/** Dem aktuellen Ersten die seit der letzten Prüfung vergangene Zeit gutschreiben */
async function trackTop1(now = Date.now()) {
  const gap = now - lastTick;
  const first = !lastTick;
  lastTick = now;
  if (first || gap <= 0 || gap > MAX_GAP_MS) return;
  const [top, second] = await ranking({ limit: 2 });
  if (!top) return;
  await User.updateOne({ _id: top._id }, { $inc: { top1Seconds: Math.round(gap / 1000) } }, { timestamps: false });
  await recordStint(top, second, now);
}

/**
 * Abschnitt auf Platz 1 festhalten (Manipulationserkennung "Platz 1 mit geliehenem Wert"): Der letzte Abschnitt wird
 * verlängert, wenn er demselben Spieler gehört und nicht zu lange her ist, sonst beginnt ein neuer.
 */
async function recordStint(top, second, now = Date.now()) {
  const lead = Math.max(0, Math.round(top.rankTotal - (second ? second.rankTotal : 0)));
  const last = await RankStint.findOne().sort({ to: -1 }).select('user to').lean();
  if (last && last.user.equals(top._id) && now - last.to.getTime() <= MAX_GAP_MS) {
    await RankStint.updateOne({ _id: last._id }, { $set: { to: new Date(now) }, $min: { minLead: lead } });
  } else {
    await RankStint.create({ user: top._id, from: new Date(now), to: new Date(now), minLead: lead });
  }
}

/**
 * "2 Tage 3 Stunden 5 Minuten" – Tage nur ab 24 Stunden, Stunden nur ab 60 Minuten.
 * Unter einer Minute: leer (dann wird nichts angezeigt).
 */
function top1Text(seconds) {
  const minutes = Math.floor((Number(seconds) || 0) / 60);
  if (minutes < 1) return '';
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const parts = [];
  if (d) parts.push(`${d} ${d === 1 ? 'Tag' : 'Tage'}`);
  if (d || h) parts.push(`${h} ${h === 1 ? 'Stunde' : 'Stunden'}`);
  parts.push(`${m} ${m === 1 ? 'Minute' : 'Minuten'}`);
  return parts.join(' ');
}

module.exports = { ranking, isTeam, notTeam, teamIds, trackTop1, recordStint, top1Text, TICK_MS, FRESH_DAYS };

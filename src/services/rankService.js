// Rangliste nach Gesamtvermögen – und die Zeit, die ein Mitglied auf Platz 1 verbracht hat
const User = require('../models/User');
const coinEngine = require('../coin/engine');
const tcgSettings = require('../tcg/settings');
const { sellValueExpr } = require('../tcg/tcgService');

const TICK_MS = 60 * 1000; // so oft wird Platz 1 geprüft
const MAX_GAP_MS = 5 * 60 * 1000; // längere Pausen (Neustart, Ausfall) zählen nicht als Zeit auf Platz 1

/**
 * Alle Mitglieder nach Gesamtvermögen, bestes zuerst. Gesamtvermögen = Kontostand + offene Einsätze + Wert der
 * Samantha Coins zum aktuellen Kurs + Verkaufswert der TCG-Karten (inkl. ungeöffneter Packs zum Packpreis).
 */
function ranking({ limit = 0 } = {}) {
  const centsPerUnit = coinEngine.isRunning() ? (coinEngine.getPrice() * 100) / 1e8 : 0;
  const pipeline = [
    { $match: { deletedAt: null } }, // gelöschte Konten erscheinen nicht
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
          { $group: { _id: null, s: { $sum: sellValueExpr() } } },
        ],
        as: 'cards',
      },
    },
    // ungeöffnete Booster Packs zählen zum aktuellen Packpreis bei den Karten mit
    { $lookup: { from: 'tcgpacks', localField: '_id', foreignField: 'user', as: 'packs' } },
    {
      $addFields: {
        inPlay: { $ifNull: [{ $first: '$open.s' }, 0] },
        coinValue: { $floor: { $multiply: [{ $ifNull: [{ $sum: '$coins.units' }, 0] }, centsPerUnit] } },
        cardValue: { $add: [{ $ifNull: [{ $first: '$cards.s' }, 0] }, { $multiply: [{ $size: '$packs' }, tcgSettings.getPackPrice()] }] },
      },
    },
    { $addFields: { total: { $add: ['$balance', '$inPlay', '$coinValue', '$cardValue'] } } },
    { $sort: { total: -1, createdAt: 1 } },
    { $project: { username: 1, balance: 1, inPlay: 1, coinValue: 1, cardValue: 1, total: 1 } },
  ];
  if (limit) pipeline.push({ $limit: limit });
  return User.aggregate(pipeline);
}

// ---------- Zeit auf Platz 1 ----------
let lastTick = 0;

/** Dem aktuellen Ersten die seit der letzten Prüfung vergangene Zeit gutschreiben */
async function trackTop1(now = Date.now()) {
  const gap = now - lastTick;
  const first = !lastTick;
  lastTick = now;
  if (first || gap <= 0 || gap > MAX_GAP_MS) return;
  const [top] = await ranking({ limit: 1 });
  if (top) await User.updateOne({ _id: top._id }, { $inc: { top1Seconds: Math.round(gap / 1000) } }, { timestamps: false });
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

module.exports = { ranking, trackTop1, top1Text, TICK_MS };

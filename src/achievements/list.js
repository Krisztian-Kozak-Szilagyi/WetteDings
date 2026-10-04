// Alle Erfolge. Feste Liste: Schlüssel, Name, Text und Symbol (gezeichnet in icons.js).
// - unique: von Hand vergebene Einzelstücke (nur bestimmte Mitglieder, siehe SPECIAL). Andere sehen sie nicht als "gesperrt".
// - secret: solange gesperrt, steht statt Name und Text nur "Geheimer Erfolg".
// - holders(): liefert alle Mitglieder (IDs), die die Bedingung erfüllen – der Job in achievementService vergibt
//   den Erfolg dann an alle, die ihn noch nicht haben. Bedingungen bewusst so gewählt, dass sie Einsatz verlangen.
const Position = require('../models/Position');
const Bet = require('../models/Bet');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgOpening } = require('../models/Tcg');
const { IhkRun } = require('../models/Ihk');
const { Trade } = require('../models/Trade');
const { LotteryRound } = require('../models/Lottery');
const { GradingJob } = require('../models/Grading');
const { DungeonRun } = require('../models/Dungeon');
const catalog = require('../tcg/catalog');

const REWARD = 10000; // 100 € für jeden Erfolg (einmalig beim Freischalten)

/** Mitglieder mit mindestens `min` Treffern einer Aggregation (Gruppe nach `by`) */
async function countAtLeast(model, match, min, by = '$user') {
  const rows = await model.aggregate([{ $match: match }, { $group: { _id: by, n: { $sum: 1 } } }, { $match: { _id: { $ne: null }, n: { $gte: min } } }]);
  return rows.map((r) => r._id);
}

const won = { payout: { $ne: null }, $expr: { $gt: ['$payout', '$amount'] } };

const ACHIEVEMENTS = [
  // ---- Einzelstücke (von Hand vergeben) ----
  {
    key: 'hermann',
    name: 'Zu stark für diese Welt',
    text: 'Die Verkörperung der ersten gebannten Karte. Sie war schlicht zu stark für diese Welt – und musste deshalb gehen.',
    unique: true,
    icon: { glyph: 'hermann', tone: 'gold', frame: 'legend' },
  },
  {
    key: 'oemer',
    name: 'König der 21 %',
    text: 'Der allererste Spieler auf Platz 1 der Rangliste – mit 21 % des gesamten Vermögens aller Mitglieder in der eigenen Tasche.',
    unique: true,
    icon: { glyph: 'oemer', tone: 'gold', frame: 'legend' },
  },
  {
    key: 'aleks',
    name: 'Genosse Nummer eins',
    text: 'Der erste Russe bei BfW Holdings. Mehr muss man dazu nicht sagen.',
    unique: true,
    icon: { glyph: 'aleks', tone: 'gold', frame: 'legend' },
  },

  // ---- Wetten ----
  {
    key: 'volltreffer',
    name: 'Volltreffer',
    text: 'Gewinne eine Wette, die mindestens das Fünffache deines Einsatzes auszahlt.',
    icon: { glyph: 'target', tone: 'red', frame: 'silver' },
    holders: () => Position.distinct('user', { payout: { $gt: 0 }, $expr: { $gte: ['$payout', { $multiply: ['$amount', 5] }] } }),
  },
  {
    key: 'orakel',
    name: 'Das Orakel',
    text: 'Gewinne insgesamt 25 Wetten.',
    icon: { glyph: 'orb', tone: 'violet', frame: 'gold' },
    holders: () => countAtLeast(Position, won, 25),
  },
  {
    key: 'alles-auf-rot',
    name: 'Alles auf Rot',
    text: 'Setze in einer einzigen Wette mindestens 1.000 €.',
    icon: { glyph: 'dice', tone: 'red', frame: 'bronze' },
    holders: () => Position.distinct('user', { amount: { $gte: 100000 } }),
  },
  {
    key: 'high-noon',
    name: 'High Noon',
    text: 'Gewinne 5 Duelle.',
    icon: { glyph: 'sabers', tone: 'silver', frame: 'gold' },
    holders: async () => {
      const duels = await Bet.distinct('_id', { duel: { $exists: true }, status: 'entschieden' });
      return duels.length ? countAtLeast(Position, { bet: { $in: duels }, ...won }, 5) : [];
    },
  },
  {
    key: 'unbestechlich',
    name: 'Unbestechlich',
    text: 'Entscheide als Schiedsrichter 10 Wetten, ohne dass ein Streitfall daraus wird.',
    icon: { glyph: 'scales', tone: 'blue', frame: 'silver' },
    holders: () => countAtLeast(Bet, { referee: { $ne: null }, status: 'entschieden', disputed: { $ne: true } }, 10, '$referee'),
  },

  // ---- Lotterie & Broker ----
  {
    key: 'glueckspilz',
    name: 'Glückspilz',
    text: 'Gewinne eine Ziehung der Lotterie.',
    icon: { glyph: 'clover', tone: 'green', frame: 'bronze' },
    holders: () => LotteryRound.distinct('winner', { winner: { $ne: null } }),
  },
  {
    key: 'wolf',
    name: 'Der Wolf der BfW Street',
    text: 'Verdiene beim Broker insgesamt 500 € (alle Verkäufe minus alle Käufe).',
    icon: { glyph: 'chart', tone: 'green', frame: 'gold' },
    holders: async () => {
      const rows = await Ledger.aggregate([
        { $match: { type: { $in: ['coin_kauf', 'coin_verkauf'] } } },
        { $group: { _id: '$user', sum: { $sum: '$amount' } } },
        { $match: { sum: { $gte: 50000 } } },
      ]);
      return rows.map((r) => r._id);
    },
  },

  // ---- TCG ----
  {
    key: 'glitch',
    name: 'Glitch in der Matrix',
    text: 'Ziehe eine Glitch-Karte oder etwas noch Selteneres aus einem Booster Pack.',
    icon: { glyph: 'glitch', tone: 'green', frame: 'silver' },
    holders: () => TcgOpening.distinct('user', { best: { $gte: catalog.RARITIES.findIndex((r) => r.key === 'glitch') } }),
  },
  {
    key: 'archivar',
    name: 'Der Archivar',
    text: 'Halte mindestens die Hälfte aller Karten einmal in den Händen (dein Album zählt jede Karte, die du je besessen hast).',
    icon: { glyph: 'cards', tone: 'gold', frame: 'bronze' },
    holders: async () => {
      const ids = catalog.CARDS.filter((c) => !(catalog.rarityByKey[c.rarity] || {}).dropOnly && !(catalog.rarityByKey[c.rarity] || {}).hidden).map((c) => c.id);
      const half = Math.ceil(ids.length / 2);
      if (!half) return [];
      return User.distinct('_id', { deletedAt: null, $expr: { $gte: [{ $size: { $setIntersection: [{ $ifNull: ['$tcgSeen', []] }, ids] } }, half] } });
    },
  },
  {
    key: 'haendler',
    name: 'Hart verhandelt',
    text: 'Schließe 10 Geschäfte im Handel ab – als Käufer, Verkäufer oder Tauschpartner.',
    icon: { glyph: 'swap', tone: 'blue', frame: 'bronze' },
    holders: async () => {
      const rows = await Trade.aggregate([
        { $match: { status: 'verkauft' } },
        { $project: { users: { $setUnion: [['$seller'], [{ $ifNull: ['$buyer', '$to'] }]] } } },
        { $unwind: '$users' },
        { $group: { _id: '$users', n: { $sum: 1 } } },
        { $match: { _id: { $ne: null }, n: { $gte: 10 } } },
      ]);
      return rows.map((r) => r._id);
    },
  },

  // ---- Arbeit ----
  {
    key: 'feierabend',
    name: 'Ausgelernt',
    text: 'Schließe 50 IHK-Quests erfolgreich ab.',
    icon: { glyph: 'briefcase', tone: 'gold', frame: 'silver' },
    holders: () => countAtLeast(IhkRun, { status: 'fertig', success: true }, 50),
  },
  {
    key: 'ruhige-hand',
    name: 'Adlerauge',
    text: 'Triff im Grading-Shop 10-mal genau die richtige Note.',
    icon: { glyph: 'loupe', tone: 'silver', frame: 'bronze' },
    holders: () => countAtLeast(GradingJob, { status: 'fertig', $expr: { $eq: ['$guess', '$grade'] } }, 10),
  },

  // ---- Rangliste & Dungeon ----
  {
    key: 'thronfolger',
    name: 'Thronfolger',
    text: 'Stehe insgesamt 24 Stunden auf Platz 1 der Rangliste.',
    icon: { glyph: 'hourglass', tone: 'gold', frame: 'gold' },
    holders: () => User.distinct('_id', { deletedAt: null, top1Seconds: { $gte: 24 * 60 * 60 } }),
  },
  {
    key: 'st-ivan',
    name: 'Der Fall von St. Ivan',
    text: 'Besiege St. Ivan im Dungeon.',
    secret: true,
    icon: { glyph: 'halo', tone: 'red', frame: 'gold' },
    holders: async () => {
      const rows = await DungeonRun.aggregate([
        { $match: { dungeon: 'st-ivan', status: 'fertig', success: true } },
        { $unwind: '$members' },
        { $match: { 'members.user': { $ne: null } } },
        { $group: { _id: '$members.user' } },
      ]);
      return rows.map((r) => r._id);
    },
  },
];

// Einzelstücke: Erfolg → Benutzername (klein geschrieben). Wird beim Start vergeben, sobald es das Konto gibt.
const SPECIAL = [
  ['hermann', 'hermichu-sensei'],
  ['oemer', 'oemer'],
  ['aleks', 'kingdom'],
];

const byKey = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.key, a]));
/** Erfolg zu einem (vom Nutzer gesendeten) Schlüssel – nur aus der festen Liste */
const find = (key) => ACHIEVEMENTS.find((a) => a.key === key) || null;

module.exports = { ACHIEVEMENTS, SPECIAL, REWARD, byKey, find };

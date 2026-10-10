// Alle Erfolge. Feste Liste: Schlüssel, Name, Text und Symbol (gezeichnet in icons.js).
// - unique: von Hand vergebene Einzelstücke (nur bestimmte Mitglieder, siehe SPECIAL). Andere sehen sie nicht als "gesperrt".
// - secret: solange gesperrt, steht statt Name und Text nur "Geheimer Erfolg".
// - holders(): liefert alle Mitglieder (IDs), die die Bedingung erfüllen – der Job in achievementService vergibt
//   den Erfolg dann an alle, die ihn noch nicht haben. Bedingungen bewusst so gewählt, dass sie Einsatz verlangen.
const Position = require('../models/Position');
const Bet = require('../models/Bet');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgOpening, TcgCard } = require('../models/Tcg');
const { IhkRun } = require('../models/Ihk');
const { Trade } = require('../models/Trade');
const { LotteryRound } = require('../models/Lottery');
const { GradingJob } = require('../models/Grading');
const { DungeonRun } = require('../models/Dungeon');
const { EsportsTeam } = require('../models/Esports');
const { ItemLog } = require('../models/Item');
const { GradingShop } = require('../models/Grading');
const BlackMarket = require('../models/BlackMarket');
const catalog = require('../tcg/catalog');
const cosmetics = require('../cosmetics/catalog');
const dungeons = require('../dungeon/dungeons');

const REWARD = 10000; // 100 € für jeden Erfolg (einmalig beim Freischalten), außer ein Eintrag hat eigenes reward
/** Belohnung eines Erfolgs in Cent */
const rewardOf = (a) => (a && Number.isInteger(a.reward) ? a.reward : REWARD);

/** Mitglieder mit mindestens `min` Treffern einer Aggregation (Gruppe nach `by`) */
async function countAtLeast(model, match, min, by = '$user') {
  const rows = await model.aggregate([{ $match: match }, { $group: { _id: by, n: { $sum: 1 } } }, { $match: { _id: { $ne: null }, n: { $gte: min } } }]);
  return rows.map((r) => r._id);
}

/** Karten, die im Album zählen: sichtbare Seltenheiten (wie views/tcg-album.ejs) */
const albumCardIds = () => catalog.CARDS.filter((c) => !(catalog.rarityByKey[c.rarity] || {}).hidden).map((c) => c.id);

/** Mitglieder mit mindestens min Shop-Avataren (nur Einträge, die es im Shop gibt) */
const avatarOwners = (min) => {
  const keys = cosmetics.AVATARS.map((a) => cosmetics.ownedKey('avatar', a.key));
  if (!min || min > keys.length) return [];
  return User.distinct('_id', { deletedAt: null, $expr: { $gte: [{ $size: { $setIntersection: [{ $ifNull: ['$cosmetics', []] }, keys] } }, min] } });
};

const won = { payout: { $ne: null }, $expr: { $gt: ['$payout', '$amount'] } };

/** Mitglieder (Teilnehmer, keine Bots) aus Läufen, die zu `match` passen; memberMatch filtert die Teilnehmer weiter */
async function runMembers(match, memberMatch = {}) {
  const rows = await DungeonRun.aggregate([{ $match: match }, { $unwind: '$members' }, { $match: { 'members.user': { $ne: null }, ...memberMatch } }, { $group: { _id: '$members.user' } }]);
  return rows.map((r) => r._id);
}

// Boss-Karten gibt es als Beute erst seit diesem Update (ältere Läufe tragen nur einen Vermerk, die Karte kam nie an)
const BOSS_DROP_SINCE = new Date('2026-10-04T14:18:18Z');
/** Schlüssel der Dungeons (und des Turms), deren Boss eine Karte fallen lässt */
const bossDropDungeons = () => [...dungeons.DUNGEONS, dungeons.TOWER].filter((d) => d && d.bossCard).map((d) => d.key);
/** Mitglieder eines Teams, das eine Trophäe der Woche geholt hat (nur wer den Preis bekam: schon zu Wochenbeginn im Team) */
async function trophyMembers(places) {
  const rows = await EsportsTeam.aggregate([{ $unwind: '$trophies' }, { $match: { 'trophies.place': { $in: places } } }, { $unwind: '$trophies.members' }, { $group: { _id: '$trophies.members' } }]);
  return rows.map((r) => r._id);
}
/** Höchste Ausbaustufe des Grading-Shops (spät geladen: der Grading-Service zieht viel nach sich) */
const topShopLevel = () => require('../grading/gradingService').LEVELS.length;

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
    text: 'Setze in einer einzigen Wette mindestens 1.000 € – und lass es darauf ankommen (erstattete Einsätze zählen nicht).',
    icon: { glyph: 'dice', tone: 'red', frame: 'bronze' },
    // nur entschiedene Einsätze: Gewinn oder Verlust, keine Erstattung (Auszahlung = Einsatz)
    holders: () => Position.distinct('user', { amount: { $gte: 100000 }, payout: { $ne: null }, $expr: { $ne: ['$payout', '$amount'] } }),
  },
  {
    key: 'high-noon',
    name: 'High Noon',
    text: 'Gewinne 5 Duelle gegen mindestens 3 verschiedene Gegner.',
    icon: { glyph: 'sabers', tone: 'silver', frame: 'gold' },
    holders: async () => {
      const duels = await Bet.distinct('_id', { duel: { $exists: true }, status: 'entschieden' });
      if (!duels.length) return [];
      const rows = await Position.aggregate([
        { $match: { bet: { $in: duels }, ...won } },
        { $lookup: { from: 'bets', localField: 'bet', foreignField: '_id', as: 'b', pipeline: [{ $project: { creator: 1, 'duel.opponent': 1 } }] } },
        { $unwind: '$b' },
        { $project: { user: 1, rival: { $cond: [{ $eq: ['$user', '$b.creator'] }, '$b.duel.opponent', '$b.creator'] } } },
        { $group: { _id: '$user', n: { $sum: 1 }, rivals: { $addToSet: '$rival' } } },
        { $match: { n: { $gte: 5 }, 'rivals.2': { $exists: true } } },
      ]);
      return rows.map((r) => r._id);
    },
  },
  {
    key: 'unbestechlich',
    name: 'Unbestechlich',
    text: 'Entscheide als Schiedsrichter 10 Wetten, in denen auf beiden Seiten Geld lag, ohne dass ein Streitfall daraus wird.',
    icon: { glyph: 'scales', tone: 'blue', frame: 'silver' },
    holders: () =>
      countAtLeast(
        Bet,
        { referee: { $ne: null }, status: 'entschieden', disputed: { $ne: true }, $expr: { $gte: [{ $size: { $filter: { input: '$options', cond: { $gt: ['$$this.total', 0] } } } }, 2] } },
        10,
        '$referee'
      ),
  },

  // ---- Lotterie & Broker ----
  {
    key: 'erster-lottogewinn',
    name: 'Erster Lotteriegewinn',
    text: 'Gewinne zum ersten Mal eine Ziehung der Lotterie (täglich, wöchentlich oder monatlich) mit mindestens zwei Teilnehmern.',
    icon: { glyph: 'ticket', tone: 'gold', frame: 'bronze' },
    // allein gekaufte Lose zählen nicht – sonst wäre es ein gekaufter Erfolg
    holders: () => LotteryRound.distinct('winner', { winner: { $ne: null }, participants: { $gte: 2 } }),
  },
  {
    key: 'glueckspilz',
    name: 'Glückspilz',
    text: 'Gewinne eine Ziehung der Lotterie mit mindestens drei Teilnehmern.',
    icon: { glyph: 'clover', tone: 'green', frame: 'bronze' },
    holders: () => LotteryRound.distinct('winner', { winner: { $ne: null }, participants: { $gte: 3 } }),
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
    key: 'erste-holo',
    name: 'Erste Holo',
    text: 'Ziehe eine Holo-Karte oder etwas noch Selteneres aus einem Booster Pack.',
    icon: { glyph: 'holo', tone: 'blue', frame: 'bronze' },
    holders: () => TcgOpening.distinct('user', { best: { $gte: catalog.RARITIES.findIndex((r) => r.key === 'holo') } }),
  },
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
    text: 'Erbeute mindestens die Hälfte aller Karten selbst – aus Booster Packs, als Boss-Beute oder im Black Market. Karten aus dem Handel zählen nicht.',
    icon: { glyph: 'cards', tone: 'gold', frame: 'bronze' },
    // #127: nur selbst erbeutete Karten (tcgLooted) – nicht Handel, Duell oder Vergabe. Wer ihn schon hat, behält ihn.
    holders: async () => {
      const ids = catalog.CARDS.filter((c) => !(catalog.rarityByKey[c.rarity] || {}).dropOnly && !(catalog.rarityByKey[c.rarity] || {}).hidden).map((c) => c.id);
      const half = Math.ceil(ids.length / 2);
      if (!half) return [];
      return User.distinct('_id', { deletedAt: null, $expr: { $gte: [{ $size: { $setIntersection: [{ $ifNull: ['$tcgLooted', []] }, ids] } }, half] } });
    },
  },
  {
    key: 'album-komplett',
    name: 'Album komplett',
    text: 'Besitze gleichzeitig jede Karte des Albums – mindestens ein Exemplar von allen.',
    icon: { glyph: 'album', tone: 'gold', frame: 'gold' },
    // wie im Album gezählt: alle sichtbaren, erhältlichen Karten (ohne geheime, Test- und noch nicht erschienene Karten)
    holders: async () => {
      const ids = albumCardIds();
      if (!ids.length) return [];
      const rows = await TcgCard.aggregate([
        { $match: { card: { $in: ids } } },
        { $group: { _id: '$user', cards: { $addToSet: '$card' } } },
        { $match: { $expr: { $gte: [{ $size: '$cards' }, ids.length] } } },
      ]);
      return rows.map((r) => r._id);
    },
  },
  {
    key: 'haendler',
    name: 'Hart verhandelt',
    text: 'Schließe 10 Geschäfte im Handel mit mindestens 5 verschiedenen Mitgliedern ab – als Käufer, Verkäufer oder Tauschpartner.',
    icon: { glyph: 'swap', tone: 'blue', frame: 'bronze' },
    holders: async () => {
      const rows = await Trade.aggregate([
        { $match: { status: 'verkauft' } },
        { $project: { pair: [{ me: '$seller', other: { $ifNull: ['$buyer', '$to'] } }, { me: { $ifNull: ['$buyer', '$to'] }, other: '$seller' }] } },
        { $unwind: '$pair' },
        { $match: { 'pair.me': { $ne: null }, 'pair.other': { $ne: null } } },
        { $group: { _id: '$pair.me', n: { $sum: 1 }, partners: { $addToSet: '$pair.other' } } },
        { $match: { n: { $gte: 10 }, 'partners.4': { $exists: true } } },
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
  {
    key: 'grading-profi',
    name: 'Grading-Profi',
    text: 'Triff im Grading-Shop 50-mal genau die richtige Note.',
    icon: { glyph: 'loupe50', tone: 'gold', frame: 'gold' },
    holders: () => countAtLeast(GradingJob, { status: 'fertig', $expr: { $eq: ['$guess', '$grade'] } }, 50),
  },
  {
    key: 'energy',
    name: 'Attack your hearth, before it attacks you',
    text: 'Setze 50-mal BFW Energy ein – in IHK-Quests, im Dungeon oder im Mage Tower, egal wo.',
    icon: { glyph: 'can', tone: 'green', frame: 'silver' },
    // jeder abgeschlossene Lauf, in dem eine BFW-Energy-Karte als Charakter oder Boost dabei war, zählt einmal
    holders: async () => {
      const ids = catalog.CARDS.filter((c) => c.name === 'BFW Energy').map((c) => c.id);
      if (!ids.length) return [];
      const [ihk, dungeon] = await Promise.all([
        IhkRun.aggregate([
          { $match: { status: 'fertig', $or: [{ card: { $in: ids } }, { boost: { $in: ids } }, { boost2: { $in: ids } }] } },
          { $group: { _id: '$user', n: { $sum: 1 } } },
        ]),
        DungeonRun.aggregate([
          { $match: { status: 'fertig' } },
          { $unwind: '$members' },
          { $match: { 'members.user': { $ne: null }, $or: [{ 'members.card': { $in: ids } }, { 'members.boost': { $in: ids } }] } },
          { $group: { _id: '$members.user', n: { $sum: 1 } } },
        ]),
      ]);
      const total = new Map();
      for (const r of [...ihk, ...dungeon]) if (r._id) total.set(String(r._id), (total.get(String(r._id)) || 0) + r.n);
      return [...total].filter(([, n]) => n >= 50).map(([id]) => id);
    },
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
    key: 'dungeon-10',
    name: '10 Dungeons geschafft',
    text: 'Schließe 10 Dungeon-Läufe erfolgreich ab (der Mage Tower zählt nicht).',
    icon: { glyph: 'gate', tone: 'red', frame: 'silver' },
    holders: async () => {
      const rows = await DungeonRun.aggregate([
        { $match: { mode: { $ne: 'tower' }, status: 'fertig', success: true } },
        { $unwind: '$members' },
        { $match: { 'members.user': { $ne: null } } },
        { $group: { _id: '$members.user', n: { $sum: 1 } } },
        { $match: { n: { $gte: 10 } } },
      ]);
      return rows.map((r) => r._id);
    },
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
  // ---- Kosmetik (Konfetti aus zerkleinerten Karten; Käufe sind an das Konto gebunden, also kein Zuschieben) ----
  {
    key: 'erster-avatar',
    name: 'Erster Avatar',
    text: 'Kaufe deinen ersten Avatar im Kosmetik-Shop.',
    icon: { glyph: 'avatar', tone: 'violet', frame: 'bronze' },
    holders: () => User.distinct('_id', { deletedAt: null, cosmetics: { $regex: /^avatar:/ } }),
  },
  {
    key: 'avatar-sammler',
    name: 'Sammler',
    text: 'Besitze 5 Avatare aus dem Kosmetik-Shop.',
    icon: { glyph: 'avatar', tone: 'blue', frame: 'silver' },
    holders: () => avatarOwners(5),
  },
  {
    key: 'avatar-galerie',
    name: 'Die ganze Galerie',
    text: 'Besitze alle Avatare aus dem Kosmetik-Shop.',
    reward: 50000, // 500 € statt der üblichen 100 €
    icon: { glyph: 'avatar', tone: 'gold', frame: 'gold' },
    holders: () => avatarOwners(cosmetics.AVATARS.length),
  },
  {
    key: 'schredder',
    name: 'Schredder',
    text: 'Zerkleinere insgesamt 500 Karten.',
    icon: { glyph: 'shredder', tone: 'silver', frame: 'bronze' },
    holders: async () => {
      const rows = await Ledger.aggregate([
        { $match: { type: 'tcg_zerkleinert' } },
        { $unwind: '$meta.cards' },
        { $group: { _id: '$user', n: { $sum: '$meta.cards.count' } } },
        { $match: { n: { $gte: 500 } } },
      ]);
      return rows.map((r) => r._id);
    },
  },

  // ---- Inventar, Black Market, Grading-Shop ----
  {
    key: 'eingeschweisst',
    name: 'Eingeschweißt',
    text: 'Foliere deine erste Karte im Inventar.',
    icon: { glyph: 'foil', tone: 'blue', frame: 'bronze' },
    holders: () => ItemLog.distinct('user', { type: 'folie', source: 'folieren', delta: { $lt: 0 } }),
  },
  {
    key: 'schattenhaendler',
    name: 'Schattenhändler',
    text: 'Kaufe 5 Angebote im Black Market.',
    icon: { glyph: 'mask', tone: 'violet', frame: 'silver' },
    holders: async () => {
      const rows = await BlackMarket.aggregate([{ $unwind: '$offers' }, { $match: { 'offers.buyer': { $ne: null } } }, { $group: { _id: '$offers.buyer', n: { $sum: 1 } } }, { $match: { n: { $gte: 5 } } }]);
      return rows.map((r) => r._id);
    },
  },
  {
    key: 'ladenkette',
    name: 'Ladenkette',
    text: 'Baue deinen Grading-Shop bis zur höchsten Stufe aus, dem Premium-Labor.',
    icon: { glyph: 'shop', tone: 'gold', frame: 'gold' },
    holders: () => GradingShop.distinct('_id', { level: { $gte: topShopLevel() } }),
  },

  // ---- Dungeon & Mage Tower ----
  {
    key: 'himmelsstuermer',
    name: 'Himmelsstürmer',
    text: 'Schaffe im Mage Tower 10 Stockwerke in einem einzigen Lauf.',
    icon: { glyph: 'tower', tone: 'violet', frame: 'gold' },
    holders: () => runMembers({ mode: 'tower', status: 'fertig', rounds: { $gte: 10 } }),
  },
  {
    key: 'boss-beute',
    name: 'Beute des Bosses',
    text: 'Erbeute eine Boss-Karte als Beute im Dungeon oder im Mage Tower. Karten aus dem Handel zählen nicht.',
    icon: { glyph: 'bosscard', tone: 'red', frame: 'gold' },
    // nur echte Beute: der Vermerk im Lauf (seit es Boss-Karten als Beute gibt), nicht Handel oder Vergabe
    holders: () => runMembers({ dungeon: { $in: bossDropDungeons() }, status: 'fertig', endsAt: { $gte: BOSS_DROP_SINCE } }, { 'members.bossCard': true }),
  },

  // ---- eSports ----
  {
    key: 'esports-team',
    name: 'Teamgeist',
    text: 'Tritt einem eSports-Team bei – oder gründe selbst eins.',
    icon: { glyph: 'team', tone: 'blue', frame: 'bronze' },
    holders: () => EsportsTeam.distinct('members.user', { status: { $ne: 'aufgeloest' } }),
  },
  {
    key: 'esports-turm',
    name: 'Bühne frei',
    text: 'Spiele mit deinem eSports-Team einen Lauf im Mage Tower der Liga.',
    icon: { glyph: 'stage', tone: 'green', frame: 'silver' },
    holders: () => runMembers({ esportsTeam: { $type: 'objectId' }, status: 'fertig' }),
  },
  {
    key: 'esports-podium',
    name: 'Aufs Treppchen',
    text: 'Beende eine Liga-Woche mit deinem eSports-Team auf Platz 1, 2 oder 3. Zählt, wenn du schon zu Wochenbeginn im Team warst.',
    icon: { glyph: 'podium', tone: 'silver', frame: 'silver' },
    holders: () => trophyMembers([1, 2, 3]),
  },
  {
    key: 'esports-sieg',
    name: 'Gekommen, um zu siegen',
    text: 'Werde mit deinem eSports-Team das beste Team der Woche (Platz 1). Zählt, wenn du schon zu Wochenbeginn im Team warst.',
    icon: { glyph: 'trophy', tone: 'gold', frame: 'gold' },
    holders: () => trophyMembers([1]),
  },
];

// ---- Fortschritt (nur für das eigene Profil) ----
// progress(userId) → Teile [{ have, need, label, kind }] (kind: 'euro' = Cent, 'hours' = Sekunden, 'times' = Faktor).
// Erfolge ohne Eintrag sind ein einzelnes Ereignis (geschafft oder nicht) und zeigen keinen Balken.
const part = (have, need, label, kind) => ({ have: have || 0, need, label, ...(kind ? { kind } : {}) });
const sumOf = async (model, pipeline) => ((await model.aggregate(pipeline))[0] || {}).n || 0;
const gradeHits = (user) => GradingJob.countDocuments({ user, status: 'fertig', $expr: { $eq: ['$guess', '$grade'] } });
const avatarCount = async (user) => {
  const u = await User.findById(user).select('cosmetics').lean();
  const keys = new Set(cosmetics.AVATARS.map((a) => cosmetics.ownedKey('avatar', a.key)));
  return ((u && u.cosmetics) || []).filter((k) => keys.has(k)).length;
};

const PROGRESS = {
  volltreffer: async (user) => {
    const best = await sumOf(Position, [{ $match: { user, payout: { $gt: 0 }, amount: { $gt: 0 } } }, { $group: { _id: null, n: { $max: { $divide: ['$payout', '$amount'] } } } }]);
    return [part(Math.floor(best * 10) / 10, 5, 'bester Gewinn', 'times')];
  },
  orakel: async (user) => [part(await Position.countDocuments({ user, ...won }), 25, 'gewonnene Wetten')],
  'alles-auf-rot': async (user) => [
    part(await sumOf(Position, [{ $match: { user, payout: { $ne: null }, $expr: { $ne: ['$payout', '$amount'] } } }, { $group: { _id: null, n: { $max: '$amount' } } }]), 100000, 'höchster Einsatz', 'euro'),
  ],
  'high-noon': async (user) => {
    const duels = await Bet.find({ duel: { $exists: true }, status: 'entschieden', $or: [{ creator: user }, { 'duel.opponent': user }] }).select('_id creator duel.opponent').lean();
    const wins = duels.length ? await Position.find({ user, bet: { $in: duels.map((d) => d._id) }, ...won }).select('bet').lean() : [];
    const byId = new Map(duels.map((d) => [String(d._id), d]));
    const rivals = new Set(
      wins
        .map((w) => byId.get(String(w.bet)))
        .map((d) => (d.creator.equals(user) ? d.duel.opponent : d.creator))
        .filter(Boolean)
        .map(String)
    );
    return [part(wins.length, 5, 'Siege'), part(rivals.size, 3, 'Gegner')];
  },
  unbestechlich: async (user) => [
    part(await Bet.countDocuments({ referee: user, status: 'entschieden', disputed: { $ne: true }, $expr: { $gte: [{ $size: { $filter: { input: '$options', cond: { $gt: ['$$this.total', 0] } } } }, 2] } }), 10, 'entschiedene Wetten'),
  ],
  wolf: async (user) => [part(await sumOf(Ledger, [{ $match: { user, type: { $in: ['coin_kauf', 'coin_verkauf'] } } }, { $group: { _id: null, n: { $sum: '$amount' } } }]), 50000, 'Gewinn', 'euro')],
  archivar: async (user) => {
    const ids = catalog.CARDS.filter((c) => !(catalog.rarityByKey[c.rarity] || {}).dropOnly && !(catalog.rarityByKey[c.rarity] || {}).hidden).map((c) => c.id);
    const u = await User.findById(user).select('tcgLooted').lean();
    const looted = new Set((u && u.tcgLooted) || []);
    return [part(ids.filter((id) => looted.has(id)).length, Math.ceil(ids.length / 2), 'Karten selbst erbeutet')];
  },
  'album-komplett': async (user) => {
    const ids = albumCardIds();
    return [part((await TcgCard.distinct('card', { user, card: { $in: ids } })).length, ids.length, 'Karten')];
  },
  haendler: async (user) => {
    const trades = await Trade.find({ status: 'verkauft', $or: [{ seller: user }, { buyer: user }, { to: user }] }).select('seller buyer to').lean();
    const partners = new Set();
    let n = 0;
    for (const t of trades) {
      const other = t.seller && t.seller.equals(user) ? t.buyer || t.to : t.seller;
      if (!other) continue;
      n++;
      partners.add(String(other));
    }
    return [part(n, 10, 'Geschäfte'), part(partners.size, 5, 'Partner')];
  },
  feierabend: async (user) => [part(await IhkRun.countDocuments({ user, status: 'fertig', success: true }), 50, 'Quests')],
  'ruhige-hand': async (user) => [part(await gradeHits(user), 10, 'richtige Noten')],
  'grading-profi': async (user) => [part(await gradeHits(user), 50, 'richtige Noten')],
  energy: async (user) => {
    const ids = catalog.CARDS.filter((c) => c.name === 'BFW Energy').map((c) => c.id);
    if (!ids.length) return null;
    const [ihk, dungeon] = await Promise.all([
      IhkRun.countDocuments({ user, status: 'fertig', $or: [{ card: { $in: ids } }, { boost: { $in: ids } }, { boost2: { $in: ids } }] }),
      DungeonRun.countDocuments({ status: 'fertig', members: { $elemMatch: { user, $or: [{ card: { $in: ids } }, { boost: { $in: ids } }] } } }),
    ]);
    return [part(ihk + dungeon, 50, 'Einsätze')];
  },
  thronfolger: async (user) => {
    const u = await User.findById(user).select('top1Seconds').lean();
    return [part((u && u.top1Seconds) || 0, 24 * 60 * 60, 'auf Platz 1', 'hours')];
  },
  'dungeon-10': async (user) => [part(await DungeonRun.countDocuments({ mode: { $ne: 'tower' }, status: 'fertig', success: true, 'members.user': user }), 10, 'Dungeons')],
  'avatar-sammler': async (user) => [part(await avatarCount(user), 5, 'Avatare')],
  'avatar-galerie': async (user) => [part(await avatarCount(user), cosmetics.AVATARS.length, 'Avatare')],
  schredder: async (user) => [
    part(await sumOf(Ledger, [{ $match: { user, type: 'tcg_zerkleinert' } }, { $unwind: '$meta.cards' }, { $group: { _id: null, n: { $sum: '$meta.cards.count' } } }]), 500, 'Karten'),
  ],
  schattenhaendler: async (user) => [part(await sumOf(BlackMarket, [{ $unwind: '$offers' }, { $match: { 'offers.buyer': user } }, { $count: 'n' }]), 5, 'Käufe')],
  ladenkette: async (user) => {
    const shop = await GradingShop.findById(user).select('level').lean();
    return [part((shop && shop.level) || 0, topShopLevel(), 'Ausbaustufe')];
  },
  himmelsstuermer: async (user) => [
    part(await sumOf(DungeonRun, [{ $match: { mode: 'tower', status: 'fertig', 'members.user': user } }, { $group: { _id: null, n: { $max: '$rounds' } } }]), 10, 'Stockwerke (bester Lauf)'),
  ],
};
for (const a of ACHIEVEMENTS) if (PROGRESS[a.key]) a.progress = PROGRESS[a.key];

// Einzelstücke: Erfolg → Benutzername (klein geschrieben). Wird beim Start vergeben, sobald es das Konto gibt.
const SPECIAL = [
  ['hermann', 'hermichu-sensei'],
  ['oemer', 'oemer'],
  ['aleks', 'kingdom'],
];

const byKey = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.key, a]));
/** Erfolg zu einem (vom Nutzer gesendeten) Schlüssel – nur aus der festen Liste */
const find = (key) => ACHIEVEMENTS.find((a) => a.key === key) || null;

module.exports = { ACHIEVEMENTS, SPECIAL, REWARD, rewardOf, byKey, find };

// Kleine Statistik auf dem eigenen Profil: Vermögen, Gewinn seit Start, Umsatz und je Bereich Umsatz und Ergebnis
// (über die ganze Zeit). Die Zahlen kommen aus dem Kontoauszug (Ledger), den Einsätzen und dem Broker; das
// Vermögen rechnet wie die Rangliste (rankService.ranking).
const Ledger = require('../models/Ledger');
const Position = require('../models/Position');
const { CoinTrade } = require('../models/Coin');
const { TcgOpening } = require('../models/Tcg');
const rankService = require('../services/rankService');

/**
 * Aus den Rohsummen die Anzeige bauen (rein, ohne Datenbank).
 * ledger: { Buchungsart: Summe in Cent (vorzeichenbehaftet) }, stakes: { staked, settledStake, settledPayout },
 * coin: { kauf, verkauf } (Cent), wealth: { total, coinValue, cardValue }, packsOpened: Anzahl.
 */
function summarize({ ledger, stakes, coin, wealth, packsOpened }) {
  const L = (...types) => types.reduce((s, t) => s + (ledger[t] || 0), 0);
  const abs = (...types) => types.reduce((s, t) => s + Math.abs(ledger[t] || 0), 0);
  const areas = [
    { key: 'wetten', label: 'Wetten', turnover: stakes.staked, result: stakes.settledPayout - stakes.settledStake, hint: 'Einsätze; Ergebnis der abgerechneten Wetten' },
    { key: 'broker', label: 'Broker', turnover: coin.kauf + coin.verkauf, result: coin.verkauf - coin.kauf + wealth.coinValue, hint: 'Käufe und Verkäufe; Ergebnis inkl. heutigem Wert des Bestands' },
    { key: 'lotterie', label: 'Lotterie', turnover: abs('lotto_los'), result: L('lotto_los', 'lotto_gewinn'), hint: 'gekaufte Lose; Ergebnis = Gewinne − Lose' },
    {
      key: 'tcg',
      label: 'Packs & Karten',
      turnover: abs('tcg_pack', 'tcg_verkauf', 'black_market', 'item_verkauf'),
      result: L('tcg_pack', 'tcg_verkauf', 'black_market', 'item_verkauf') + wealth.cardValue,
      hint: 'Pack-Käufe, Bank-Verkäufe, Black Market; Ergebnis inkl. heutigem Wert der Karten und Packs',
    },
    { key: 'handel', label: 'Handel', turnover: abs('handel_kauf', 'handel_verkauf', 'handel_tausch_zahlung', 'handel_tausch_erhalt'), result: L('handel_kauf', 'handel_verkauf', 'handel_tausch_zahlung', 'handel_tausch_erhalt'), hint: 'Geld aus Käufen, Verkäufen und Aufpreisen beim Tausch' },
    { key: 'jobs', label: 'IHK, Dungeon & Grading', turnover: null, result: L('ihk_lohn', 'dungeon_lohn', 'grading_lohn', 'grading_ausbau'), hint: 'Löhne abzüglich Grading-Ausbau' },
    { key: 'boni', label: 'Boni & Provisionen', turnover: null, result: L('bonus', 'erfolg', 'provision', 'provision_schiri'), hint: 'Tagesbonus, Erfolge und Provisionen' },
  ];
  const start = L('startguthaben');
  const team = L('team_gutschrift', 'team_abzug');
  return {
    total: wealth.total,
    // Gewinn seit Start: was man selbst erspielt hat – ohne Startguthaben und Geld vom Team
    profit: wealth.total - start - team,
    turnover: areas.reduce((s, a) => s + (a.turnover || 0), 0),
    packsOpened,
    packSpend: abs('tcg_pack'),
    areas,
  };
}

/** Statistik eines Mitglieds (für das eigene Profil) */
async function profileStats(userId) {
  const [ledgerAgg, stakeAgg, coinAgg, wealthRows, packsOpened] = await Promise.all([
    Ledger.aggregate([{ $match: { user: userId } }, { $group: { _id: '$type', s: { $sum: '$amount' } } }]),
    Position.aggregate([
      { $match: { user: userId } },
      {
        $group: {
          _id: null,
          staked: { $sum: '$amount' },
          settledStake: { $sum: { $cond: [{ $ne: ['$payout', null] }, '$amount', 0] } },
          settledPayout: { $sum: { $ifNull: ['$payout', 0] } },
        },
      },
    ]),
    CoinTrade.aggregate([{ $match: { user: userId } }, { $group: { _id: '$side', s: { $sum: '$cents' } } }]),
    rankService.ranking({ team: true, userId }),
    TcgOpening.countDocuments({ user: userId }),
  ]);
  const coin = Object.fromEntries(coinAgg.map((c) => [c._id, c.s]));
  const wealth = wealthRows[0] || { total: 0, coinValue: 0, cardValue: 0 };
  return summarize({
    ledger: Object.fromEntries(ledgerAgg.map((l) => [l._id, l.s])),
    stakes: stakeAgg[0] || { staked: 0, settledStake: 0, settledPayout: 0 },
    coin: { kauf: coin.kauf || 0, verkauf: coin.verkauf || 0 },
    wealth,
    packsOpened,
  });
}

module.exports = { profileStats, summarize };

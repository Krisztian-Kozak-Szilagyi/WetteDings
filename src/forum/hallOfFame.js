// Hall of Fame: drei Bestenlisten aus vorhandenen Daten, als Kopf über den Themen im Forum-Bereich "Hall of Fame".
//  - größte Wettgewinne (Reingewinn = Auszahlung − Einsatz, nur abgerechnete Positionen)
//  - seltenste Pulls (Pack-Öffnungen ab Glitch, die seltenste Karte der Öffnung)
//  - größte Lottogewinne (Kontoauszug "lotto_gewinn")
// Gelöschte Konten erscheinen nicht. Kurz im Speicher gehalten – die Listen ändern sich selten.
const User = require('../models/User');
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const { TcgOpening } = require('../models/Tcg');
const catalog = require('../tcg/catalog');

const TOP = 10;
const CACHE_MS = 5 * 60 * 1000;

// ---------- Aufbereitung (ohne Datenbank, getestet) ----------
/**
 * Wettgewinne: rows = [{ user, username, bet, profit, settledAt }] (absteigend), bets = Map id → Wette.
 * Gruppen-Wetten und Duell-Anfragen sehen nicht alle – dort ohne Titel und Link.
 */
function mapBetWins(rows, bets) {
  return rows.slice(0, TOP).map((r) => {
    const bet = bets.get(String(r.bet));
    const open = !!bet && !bet.group && !(bet.duel && bet.duel.state === 'angefragt');
    const title = open ? bet.title : bet ? 'Gruppen-Wette' : 'Gelöschte Wette';
    return { name: r.username, profit: r.profit, title, href: open ? `/wetten/${bet._id}` : null, at: r.settledAt || null };
  });
}

/** Die seltenste Karte einer Pack-Öffnung (höchster Rang; unbekannte Seltenheiten zählen nicht) */
function bestCard(cards) {
  let best = null;
  for (const c of cards || []) {
    const r = catalog.rarityByKey[c.rarity];
    if (r && (!best || r.rank > best.rarity.rank)) best = { card: c.card, rarity: r };
  }
  return best;
}

/** Pulls: Pack-Öffnungen (schon nach Seltenheit sortiert) → Name, Karte, Seltenheit, Datum */
function mapPulls(openings) {
  const out = [];
  for (const o of openings) {
    const best = bestCard(o.cards);
    if (!best) continue;
    const info = catalog.cardById[best.card];
    out.push({ name: o.username, card: info ? info.name : best.card, image: info ? info.image : null, rarity: best.rarity.key, rarityLabel: best.rarity.label, at: o.createdAt });
    if (out.length >= TOP) break;
  }
  return out;
}

/** Lottogewinne: Buchungen + Map userId → Name (fehlt der Name, z. B. gelöschtes Konto, entfällt die Zeile) */
function mapLotto(entries, names) {
  return entries
    .filter((e) => names.has(String(e.user)))
    .slice(0, TOP)
    .map((e) => ({ name: names.get(String(e.user)), amount: e.amount, at: e.createdAt }));
}

// ---------- Abfragen ----------
async function query() {
  const gone = await User.find({ deletedAt: { $ne: null } }).distinct('_id'); // gelöschte Konten
  const [wins, openings, lotto] = await Promise.all([
    Position.aggregate([
      { $match: { payout: { $ne: null }, user: { $nin: gone } } },
      { $project: { user: 1, username: 1, bet: 1, settledAt: 1, profit: { $subtract: ['$payout', '$amount'] } } },
      { $match: { profit: { $gt: 0 } } },
      { $sort: { profit: -1, settledAt: 1 } },
      { $limit: TOP },
    ]),
    TcgOpening.find({ best: { $gte: catalog.rarityByKey.glitch.rank }, user: { $nin: gone } })
      .sort({ best: -1, createdAt: -1 })
      .limit(TOP * 2) // Reserve, falls eine Öffnung keine bekannte Seltenheit mehr hat
      .select('username cards createdAt')
      .lean(),
    Ledger.find({ type: 'lotto_gewinn', amount: { $gt: 0 }, user: { $nin: gone } }).sort({ amount: -1, createdAt: 1 }).limit(TOP).select('user amount createdAt').lean(),
  ]);
  const [bets, users] = await Promise.all([
    wins.length ? Bet.find({ _id: { $in: wins.map((w) => w.bet) } }).select('title group duel.state').lean() : [],
    lotto.length ? User.find({ _id: { $in: lotto.map((e) => e.user) }, deletedAt: null }).select('username').lean() : [],
  ]);
  return {
    wins: mapBetWins(wins, new Map(bets.map((b) => [String(b._id), b]))),
    pulls: mapPulls(openings),
    lotto: mapLotto(lotto, new Map(users.map((u) => [String(u._id), u.username]))),
  };
}

let cache = null;
let cacheAt = 0;
/** Alle drei Listen (aus dem Speicher, höchstens CACHE_MS alt) */
async function load({ fresh = false } = {}) {
  if (fresh || !cache || Date.now() - cacheAt > CACHE_MS) {
    cache = await query();
    cacheAt = Date.now();
  }
  return cache;
}

module.exports = { TOP, mapBetWins, bestCard, mapPulls, mapLotto, load };

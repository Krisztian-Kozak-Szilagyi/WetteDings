// Protokolle im Admin-/Dev-Panel: Handel, Pack-Öffnungen, Verkäufe, IHK-Quests und Dungeons.
// Alles wird aus den vorhandenen Datensätzen gelesen (Trade, TcgOpening, Ledger, IhkRun, DungeonRun) –
// global oder nur für einen Spieler (?spieler=Name).
const mongoose = require('mongoose');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { Trade } = require('../models/Trade');
const { TcgOpening } = require('../models/Tcg');
const { IhkRun } = require('../models/Ihk');
const { DungeonRun } = require('../models/Dungeon');
const tcgCatalog = require('../tcg/catalog');
const itemService = require('../items/itemService');
const deviceService = require('../device/deviceService');
const { questById, difficulty } = require('../ihk/quests');
const { dungeonByKey } = require('../dungeon/dungeons');
const { euro } = require('../lib/viewHelpers');

const LOG_PAGE = 50;

// Die Logs im Reiter "Protokolle" (key = ?log=…, page = eigener Seiten-Parameter)
const LOGS = [
  { key: 'handel', label: 'Handel', page: 'handelseite' },
  { key: 'packs', label: 'Pack-Öffnungen', page: 'packseite' },
  { key: 'verkauf', label: 'Verkäufe & Käufe', page: 'verkaufseite' },
  { key: 'ihk', label: 'IHK-Quests', page: 'ihkseite' },
  { key: 'dungeon', label: 'Dungeons', page: 'dungeonseite' },
];
const logByKey = Object.fromEntries(LOGS.map((l) => [l.key, l]));

const KIND_LABEL = { markt: 'Markt', privat: 'Privatverkauf', tausch: 'Tausch' };
const PACK_SOURCE_LABEL = { kauf: 'Gekauft', quest: 'IHK-Fund', admin: 'Geschenk (Team)', lotto: 'Lotterie' };
const SELL_TYPES = ['tcg_verkauf', 'item_verkauf', 'black_market'];
const SELL_LABEL = { tcg_verkauf: 'An die Bank verkauft', item_verkauf: 'Gegenstand verkauft', black_market: 'Black Market gekauft' };

// ab dieser Seltenheit werden gezogene Karten im Log hervorgehoben
const RARE_FROM = tcgCatalog.rarityByKey.holo ? tcgCatalog.rarityByKey.holo.rank : 3;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const queryText = (v, max = 40) => (typeof v === 'string' ? v : '').trim().slice(0, max);

/** Seite aus der Adresse (z. B. ?packseite=3), begrenzt auf 1 … pages */
function pageOf(value, total, perPage = LOG_PAGE) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  return { total, pages, page: Math.min(pages, Math.max(1, Number.parseInt(value, 10) || 1)) };
}

/** Karte oder Gegenstand mit Seltenheit, z. B. "St. Ivan (Glitch)" */
function cardLabel(id) {
  const item = itemService.itemByCardId(id);
  if (item) return `${item.label} (Gegenstand)`;
  const c = tcgCatalog.cardById[id];
  if (!c) return id || '–';
  const r = tcgCatalog.rarityByKey[c.rarity];
  return r ? `${c.name} (${r.label})` : c.name;
}

/** Gezogene Karten zusammenfassen, seltenste zuerst: [{ label, rarity, count }] */
function cardSummary(cards) {
  const byCard = new Map();
  for (const c of cards || []) {
    const entry = byCard.get(c.card) || { card: c.card, rarity: c.rarity, count: 0 };
    entry.count += c.count || 1;
    byCard.set(c.card, entry);
  }
  const rank = (r) => (tcgCatalog.rarityByKey[r] ? tcgCatalog.rarityByKey[r].rank : -1);
  return [...byCard.values()].sort((a, b) => rank(b.rarity) - rank(a.rarity)).map((e) => ({ label: cardLabel(e.card), rarity: e.rarity, count: e.count, rare: rank(e.rarity) >= RARE_FROM }));
}

/** Spieler aus ?spieler=Name: { q, user } – user ist null, wenn der Name unbekannt ist */
async function resolvePlayer(query) {
  const q = queryText(query.spieler);
  if (!q) return { q: '', user: null };
  const user = await User.findOne({ usernameLower: q.toLowerCase() }).select('username').lean();
  return { q, user };
}

/** Namen zu Nutzer-IDs (für Datensätze, die nur die ID speichern) */
async function namesOf(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))].filter((id) => mongoose.isValidObjectId(id));
  if (!unique.length) return new Map();
  const users = await User.find({ _id: { $in: unique } }).select('username').lean();
  return new Map(users.map((u) => [String(u._id), u.username]));
}

/** Gemeinsamer Ablauf: zählen, Seite wählen, Zeilen laden */
async function paged(Model, filter, sort, pageValue, select) {
  const { total, pages, page } = pageOf(pageValue, await Model.countDocuments(filter));
  let q = Model.find(filter).sort(sort).skip((page - 1) * LOG_PAGE).limit(LOG_PAGE);
  if (select) q = q.select(select);
  return { total, pages, page, docs: await q.lean() };
}

// ---------- Handel: wer wem welche Karte gegeben hat ----------

/**
 * Abgeschlossene Geschäfte, neueste zuerst; Suche nach Namen (Anbieter, Käufer, Empfänger) oder Karte.
 * Geschäfte zwischen Mehrfach-Konten (Hinweis "sicher"/"wahrscheinlich") sind markiert, neue seit seenAt zusätzlich "Neu";
 * mit ?verdacht=1 nur diese.
 */
async function tradeLog(query, { player = null, seenAt = null } = {}) {
  const q = queryText(query.handelsuche);
  const onlySuspicious = query.verdacht === '1';
  const pairs = await deviceService.flaggedPairs();
  const and = [{ status: 'verkauft' }];
  if (onlySuspicious) and.push(deviceService.tradeFilterForPairs(pairs));
  if (player) and.push({ $or: [{ seller: player._id }, { buyer: player._id }, { to: player._id }] });
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    // Karten über ihren angezeigten Namen finden (z. B. "St. Ivan") – gespeichert ist nur die Karten-ID
    const cardIds = tcgCatalog.CARDS.filter((c) => rx.test(c.name) || rx.test(c.id)).map((c) => c.id);
    and.push({ $or: [{ sellerName: rx }, { buyerName: rx }, { toName: rx }, { card: { $in: cardIds } }, { wantCard: { $in: cardIds } }] });
  }
  const { docs, ...pg } = await paged(Trade, { $and: and }, { closedAt: -1, _id: -1 }, query.handelseite, 'kind seller buyer to sellerName buyerName toName card wantCard price extraFrom tax closedAt');
  const seen = seenAt ? new Date(seenAt).getTime() : 0;
  return {
    q,
    onlySuspicious,
    ...pg,
    rows: docs.map((t) => {
      // "An" ist beim Verkauf der Käufer, beim Tausch der Empfänger des Angebots
      const to = t.kind === 'tausch' ? t.toName : t.buyerName;
      let back = euro(t.price); // Gegenleistung
      if (t.kind === 'tausch') {
        back = cardLabel(t.wantCard);
        if (t.price > 0) back += ` + ${euro(t.price)} von ${t.extraFrom === 'to' ? to : t.sellerName}`;
      }
      const flagged = pairs.has(deviceService.tradePairKey(t));
      const isNew = flagged && new Date(t.closedAt).getTime() > seen;
      return { at: t.closedAt, kind: KIND_LABEL[t.kind] || t.kind, from: t.sellerName, to: to || '–', card: cardLabel(t.card), back, tax: t.tax, flagged, isNew };
    }),
  };
}

// ---------- Pack-Öffnungen: welche Karten gezogen wurden ----------

function packRow(o) {
  const t = tcgCatalog.packTypeByKey[o.type];
  const best = tcgCatalog.ALL_RARITIES.find((r) => r.rank === o.best);
  return {
    at: o.createdAt,
    player: o.username,
    pack: t ? t.label : o.type || '–',
    source: PACK_SOURCE_LABEL[o.source] || '–',
    cost: o.cost,
    cards: cardSummary(o.cards),
    best: best ? best.label : null,
  };
}

async function packLog(query, { player = null } = {}) {
  const filter = player ? { user: player._id } : {};
  const { docs, ...pg } = await paged(TcgOpening, filter, { createdAt: -1, _id: -1 }, query.packseite);
  return { ...pg, rows: docs.map(packRow) };
}

// ---------- Verkäufe an die Bank, verkaufte Gegenstände, Black-Market-Käufe ----------

/** Eine Buchung als Zeile; name = Spielername */
function sellRow(l, name) {
  const m = l.meta || {};
  let items;
  if (l.type === 'tcg_verkauf') items = cardSummary(m.cards);
  else if (l.type === 'black_market') items = m.card ? cardSummary([{ card: m.card, rarity: m.rarity }]) : [];
  else {
    const t = itemService.itemTypeByKey[m.item];
    items = t ? [{ label: `${t.label} (Gegenstand)`, rarity: 'item', count: m.count || 1 }] : [];
  }
  // ältere Buchungen ohne Details: wenigstens den Buchungstext zeigen
  if (!items.length && l.betTitle) items = [{ label: l.betTitle, rarity: null, count: 1 }];
  return { at: l.createdAt, player: name || '–', kind: SELL_LABEL[l.type] || l.type, items, amount: l.amount };
}

async function sellLog(query, { player = null } = {}) {
  const filter = { type: { $in: SELL_TYPES }, ...(player ? { user: player._id } : {}) };
  const { docs, ...pg } = await paged(Ledger, filter, { createdAt: -1, _id: -1 }, query.verkaufseite);
  const names = await namesOf(docs.map((l) => l.user));
  return { ...pg, rows: docs.map((l) => sellRow(l, names.get(String(l.user)))) };
}

// ---------- IHK-Quests ----------

function ihkRow(r, name) {
  const quest = questById[r.quest];
  const diff = difficulty(r.difficulty);
  const running = r.status === 'laeuft';
  return {
    at: r.createdAt,
    endsAt: r.endsAt,
    player: name || '–',
    quest: quest ? quest.title : r.quest,
    difficulty: diff ? diff.label : String(r.difficulty),
    card: cardLabel(r.card),
    boosts: [r.boost, r.boost2].filter(Boolean).map(cardLabel),
    // laufende Quests: das Ergebnis steht schon fest, wird aber erst nach Ablauf gezeigt
    state: running ? 'laeuft' : r.success ? 'geschafft' : 'gescheitert',
    reward: r.reward,
    pack: r.pack ? (tcgCatalog.packTypeByKey[r.pack] || { label: r.pack }).label : null,
    collectedAt: r.collectedAt,
  };
}

async function ihkLog(query, { player = null } = {}) {
  const filter = player ? { user: player._id } : {};
  const { docs, ...pg } = await paged(IhkRun, filter, { createdAt: -1, _id: -1 }, query.ihkseite, 'user quest difficulty card boost boost2 success reward status endsAt collectedAt pack createdAt');
  const names = await namesOf(docs.map((r) => r.user));
  return { ...pg, rows: docs.map((r) => ihkRow(r, names.get(String(r.user)))) };
}

// ---------- Dungeons ----------

/** Ein Durchlauf als Zeile; playerId markiert den gesuchten Spieler */
function dungeonRow(r, playerId = null) {
  const d = dungeonByKey[r.dungeon];
  const fightTitle = (f) => {
    const def = d && d.fights.find((x) => x.key === f.key);
    return def ? def.title : f.key;
  };
  const won = (r.fights || []).filter((f) => f.success).length;
  return {
    at: r.endsAt,
    startedAt: r.startedAt,
    dungeon: d ? d.title : r.dungeon,
    running: r.status === 'laeuft',
    success: r.success,
    // gespeichert sind nur die ausgetragenen Kämpfe – gezählt wird gegen alle Kämpfe des Dungeons
    progress: `${won} / ${d ? d.fights.length : (r.fights || []).length}`,
    // Kampf, an dem die Gruppe gescheitert ist
    failedAt: (r.fights || []).filter((f) => !f.success).map(fightTitle)[0] || null,
    members: (r.members || []).map((m) => ({
      name: m.name,
      bot: !m.user,
      leader: m.leader,
      highlight: !!(playerId && m.user && String(m.user) === String(playerId)),
      card: cardLabel(m.card),
      boost: m.boost ? cardLabel(m.boost) : null,
      reward: m.reward,
      foil: m.foil,
      bossCard: m.bossCard,
    })),
  };
}

async function dungeonLog(query, { player = null } = {}) {
  const filter = player ? { 'members.user': player._id } : {};
  const { docs, ...pg } = await paged(DungeonRun, filter, { startedAt: -1, _id: -1 }, query.dungeonseite, 'dungeon members success fights.key fights.success startedAt endsAt status');
  return { ...pg, rows: docs.map((r) => dungeonRow(r, player && player._id)) };
}

const LOADERS = { handel: tradeLog, packs: packLog, verkauf: sellLog, ihk: ihkLog, dungeon: dungeonLog };

/** Den gewählten Log laden: { key, data } */
async function loadLog(query, opts = {}) {
  const key = logByKey[query.log] ? query.log : 'handel';
  return { key, data: await LOADERS[key](query, opts) };
}

module.exports = {
  LOG_PAGE,
  LOGS,
  logByKey,
  pageOf,
  cardLabel,
  cardSummary,
  resolvePlayer,
  tradeLog,
  packLog,
  sellLog,
  ihkLog,
  dungeonLog,
  loadLog,
  packRow,
  sellRow,
  ihkRow,
  dungeonRow,
};

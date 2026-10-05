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
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const { CoinTrade } = require('../models/Coin');
const { GradingJob } = require('../models/Grading');
const { PackGrant } = require('../models/Tcg');
const SettingsChange = require('../models/SettingsChange');
const coinMarkets = require('../coin/markets');
const { LEVELS: GRADING_LEVELS } = require('../grading/gradingService');
const tcgCatalog = require('../tcg/catalog');
const itemService = require('../items/itemService');
const deviceService = require('../device/deviceService');
const { questById, difficulty } = require('../ihk/quests');
const { dungeonByKey } = require('../dungeon/dungeons');
const { euro, ledgerLabels, optionLabel, coinAmount } = require('../lib/viewHelpers');
const { field, num } = require('./exportCsv');
const config = require('../config');

const LOG_PAGE = 50;
const EXPORT_MAX = 20000; // Obergrenze für den Export (alle Seiten auf einmal)

// Die Logs im Reiter "Protokolle" (key = ?log=…, page = eigener Seiten-Parameter, group = Gruppe in der Auswahl)
const LOG_GROUPS = [
  { key: 'alle', label: 'Übersicht' },
  { key: 'spiel', label: 'Spiel' },
  { key: 'tcg', label: 'TCG' },
  { key: 'team', label: 'Team' },
];
const LOGS = [
  { key: 'gesamt', label: 'Gesamt (alle Protokolle)', page: 'gesamtseite', group: 'alle' },
  { key: 'wetten', label: 'Wetten', page: 'wettenseite', group: 'spiel' },
  { key: 'einsaetze', label: 'Einsätze', page: 'einsatzseite', group: 'spiel' },
  { key: 'broker', label: 'Broker', page: 'brokerseite', group: 'spiel' },
  { key: 'lotterie', label: 'Lotterie', page: 'lottoseite', group: 'spiel' },
  { key: 'konto', label: 'Alle Buchungen', page: 'kontoseite', group: 'spiel' },
  { key: 'handel', label: 'Handel', page: 'handelseite', group: 'tcg' },
  { key: 'packs', label: 'Pack-Öffnungen', page: 'packseite', group: 'tcg' },
  { key: 'verkauf', label: 'Verkäufe & Käufe', page: 'verkaufseite', group: 'tcg' },
  { key: 'ihk', label: 'IHK-Quests', page: 'ihkseite', group: 'tcg' },
  { key: 'dungeon', label: 'Dungeons', page: 'dungeonseite', group: 'tcg' },
  { key: 'grading', label: 'Grading', page: 'gradingseite', group: 'tcg' },
  { key: 'vergaben', label: 'Vergaben', page: 'vergabeseite', group: 'team' },
  { key: 'registrierungen', label: 'Registrierungen', page: 'registrierungsseite', group: 'team' },
  { key: 'einstellungen', label: 'Einstellungen', page: 'einstellungsseite', group: 'team' },
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
/** Karten einer Tausch-Seite ("give" = Anbieter, "take" = Empfänger), auch alte Angebote mit je einer Karte (#76) */
const swapLabel = (t, side) => {
  const lines = t.give && t.give.length ? t[side] || [] : [{ card: side === 'give' ? t.card : t.wantCard }];
  return lines.map((l) => cardLabel(l.card)).join(', ');
};

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

/** Gemeinsamer Ablauf: zählen, Seite wählen, Zeilen laden – mit all (Export) alle Einträge bis EXPORT_MAX */
async function paged(Model, filter, sort, pageValue, select, all = false) {
  const { total, pages, page } = all ? { total: await Model.countDocuments(filter), pages: 1, page: 1 } : pageOf(pageValue, await Model.countDocuments(filter));
  let q = all ? Model.find(filter).sort(sort).limit(EXPORT_MAX) : Model.find(filter).sort(sort).skip((page - 1) * LOG_PAGE).limit(LOG_PAGE);
  if (select) q = q.select(select);
  return { total, pages, page, docs: await q.lean() };
}

// ---------- Handel: wer wem welche Karte gegeben hat ----------

/**
 * Abgeschlossene Geschäfte, neueste zuerst; Suche nach Namen (Anbieter, Käufer, Empfänger) oder Karte.
 * Geschäfte zwischen Mehrfach-Konten (Hinweis "sicher"/"wahrscheinlich") sind markiert, neue seit seenAt zusätzlich "Neu";
 * mit ?verdacht=1 nur diese.
 */
async function tradeLog(query, { player = null, seenAt = null, all = false } = {}) {
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
    and.push({ $or: [{ sellerName: rx }, { buyerName: rx }, { toName: rx }, { card: { $in: cardIds } }, { wantCard: { $in: cardIds } }, { 'give.card': { $in: cardIds } }, { 'take.card': { $in: cardIds } }] });
  }
  const { docs, ...pg } = await paged(Trade, { $and: and }, { closedAt: -1, _id: -1 }, query.handelseite, 'kind seller buyer to sellerName buyerName toName card wantCard give take price extraFrom tax closedAt', all);
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
        back = swapLabel(t, 'take');
        if (t.price > 0) back += ` + ${euro(t.price)} von ${t.extraFrom === 'to' ? to : t.sellerName}`;
      }
      const flagged = pairs.has(deviceService.tradePairKey(t));
      const isNew = flagged && new Date(t.closedAt).getTime() > seen;
      return { at: t.closedAt, kind: KIND_LABEL[t.kind] || t.kind, from: t.sellerName, to: to || '–', card: t.kind === 'tausch' ? swapLabel(t, 'give') : cardLabel(t.card), back, tax: t.tax, flagged, isNew };
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

async function packLog(query, { player = null, all = false } = {}) {
  const filter = player ? { user: player._id } : {};
  const { docs, ...pg } = await paged(TcgOpening, filter, { createdAt: -1, _id: -1 }, query.packseite, null, all);
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

async function sellLog(query, { player = null, all = false } = {}) {
  const filter = { type: { $in: SELL_TYPES }, ...(player ? { user: player._id } : {}) };
  const { docs, ...pg } = await paged(Ledger, filter, { createdAt: -1, _id: -1 }, query.verkaufseite, null, all);
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

async function ihkLog(query, { player = null, all = false } = {}) {
  const filter = player ? { user: player._id } : {};
  const { docs, ...pg } = await paged(IhkRun, filter, { createdAt: -1, _id: -1 }, query.ihkseite, 'user quest difficulty card boost boost2 success reward status endsAt collectedAt pack createdAt', all);
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

async function dungeonLog(query, { player = null, all = false } = {}) {
  const filter = player ? { 'members.user': player._id } : {};
  const { docs, ...pg } = await paged(DungeonRun, filter, { startedAt: -1, _id: -1 }, query.dungeonseite, 'dungeon members success fights.key fights.success startedAt endsAt status', all);
  return { ...pg, rows: docs.map((r) => dungeonRow(r, player && player._id)) };
}

// ---------- Wetten: erstellt, entschieden, annulliert ----------

const BET_STATUS = { offen: 'Offen', entschieden: 'Entschieden', annulliert: 'Annulliert' };
const RESOLVED_VIA = { ersteller: 'Ersteller allein', einstimmig: 'Ersteller und Schiedsrichter', dev: 'Dev (Streitfall)', system: 'Automatisch', schiedsrichter: 'Schiedsrichter' };

function betRow(b) {
  const pot = (b.options || []).reduce((n, o) => n + (o.total || 0), 0);
  let result = BET_STATUS[b.status] || b.status;
  if (b.status === 'entschieden') result = `Ergebnis: ${optionLabel(b, b.outcome)}${b.refunded ? ' (erstattet)' : ''}`;
  else if (b.status === 'offen' && b.disputed) result = 'Strittig';
  return {
    at: b.createdAt,
    id: String(b._id),
    title: b.title,
    duel: !!b.duel,
    group: b.groupName,
    creator: b.creatorName,
    referee: b.refereeName,
    options: (b.options || []).map((o) => o.label),
    status: b.status,
    result,
    via: RESOLVED_VIA[b.resolvedVia] || null,
    resolvedBy: b.resolvedByName,
    resolvedAt: b.resolvedAt,
    note: b.status === 'annulliert' ? b.voidReason : b.resolutionNote,
    pot,
    participants: b.participants || 0,
    fees: (b.creatorFee || 0) + (b.refereeFee || 0),
    deadline: b.deadline,
  };
}

async function betLog(query, { player = null, all = false } = {}) {
  let filter = {};
  if (player) {
    // erstellt, als Schiedsrichter, als Duell-Gegner oder mit Einsatz dabei
    const joined = await Position.distinct('bet', { user: player._id });
    filter = { $or: [{ creator: player._id }, { referee: player._id }, { 'duel.opponent': player._id }, { _id: { $in: joined } }] };
  }
  const { docs, ...pg } = await paged(Bet, filter, { createdAt: -1, _id: -1 }, query.wettenseite, 'title type options creatorName refereeName groupName duel status outcome disputed resolvedVia resolvedByName resolvedAt voidReason resolutionNote participants creatorFee refereeFee refunded deadline createdAt', all);
  return { ...pg, rows: docs.map(betRow) };
}

// ---------- Einsätze: wer auf was gesetzt hat und was zurückkam ----------

function stakeRow(p, bet) {
  const settled = p.payout !== null && p.payout !== undefined;
  return {
    at: p.createdAt,
    player: p.username,
    betId: String(p.bet),
    bet: bet ? bet.title : '(gelöschte Wette)',
    side: bet ? optionLabel(bet, p.side) : p.side,
    amount: p.amount,
    payout: settled ? p.payout : null,
    net: settled ? p.payout - p.amount : null,
    settledAt: p.settledAt,
    state: !settled ? 'offen' : p.payout > p.amount ? 'gewonnen' : p.payout === p.amount ? 'erstattet' : 'verloren',
  };
}

async function stakeLog(query, { player = null, all = false } = {}) {
  const filter = player ? { user: player._id } : {};
  const { docs, ...pg } = await paged(Position, filter, { createdAt: -1, _id: -1 }, query.einsatzseite, null, all);
  const bets = await Bet.find({ _id: { $in: [...new Set(docs.map((p) => String(p.bet)))] } }).select('title options').lean();
  const byId = new Map(bets.map((b) => [String(b._id), b]));
  return { ...pg, rows: docs.map((p) => stakeRow(p, byId.get(String(p.bet)))) };
}

// ---------- Broker: Käufe und Verkäufe von Coins und ETF ----------

function coinRow(t, name) {
  const engine = coinMarkets.get(t.coin);
  return {
    at: t.createdAt,
    player: name || '–',
    asset: engine ? `${engine.NAME} (${t.coin})` : t.coin,
    side: t.side === 'kauf' ? 'Kauf' : 'Verkauf',
    units: t.units,
    unitsText: coinAmount(t.units, t.coin),
    price: t.price,
    cents: t.side === 'kauf' ? -t.cents : t.cents, // Verkauf: Erlös nach Steuer
    tax: t.tax || 0, // Steuer auf den Gewinn (nur Verkauf)
  };
}

async function coinLog(query, { player = null, all = false } = {}) {
  const filter = player ? { user: player._id } : {};
  const { docs, ...pg } = await paged(CoinTrade, filter, { createdAt: -1, _id: -1 }, query.brokerseite, null, all);
  const names = await namesOf(docs.map((t) => t.user));
  return { ...pg, rows: docs.map((t) => coinRow(t, names.get(String(t.user)))) };
}

// ---------- Lotterie: Lose und Gewinne ----------

const LOTTO_KIND = { woche: 'Wochen-Lotterie', monat: 'Monats-Lotterie' };

function lottoRow(l, name) {
  const m = l.meta || {};
  return {
    at: l.createdAt,
    player: name || '–',
    kind: l.type === 'lotto_gewinn' ? 'Gewinn' : 'Lose gekauft',
    lottery: LOTTO_KIND[m.kind] || 'Tages-Lotterie',
    count: m.count || null, // Zahl der Lose (erst seit diesem Update gespeichert)
    round: m.round || null,
    ticket: m.ticket || null, // Gewinnlos
    amount: l.amount,
  };
}

async function lottoLog(query, { player = null, all = false } = {}) {
  const filter = { type: { $in: ['lotto_los', 'lotto_gewinn'] }, ...(player ? { user: player._id } : {}) };
  const { docs, ...pg } = await paged(Ledger, filter, { createdAt: -1, _id: -1 }, query.lottoseite, null, all);
  const names = await namesOf(docs.map((l) => l.user));
  return { ...pg, rows: docs.map((l) => lottoRow(l, names.get(String(l.user)))) };
}

// ---------- Grading: Aufträge ----------

function gradingRow(j, name) {
  const level = GRADING_LEVELS.find((l) => l.level === j.level);
  return {
    at: j.doneAt || j.createdAt,
    startedAt: j.createdAt,
    player: name || '–',
    shop: level ? level.name : `Stufe ${j.level}`,
    card: cardLabel(j.card),
    customer: j.customer,
    done: j.status === 'fertig',
    grade: j.grade,
    guess: j.guess,
    clean: j.clean,
    seal: j.seal,
    pay: j.pay,
    foil: j.foilFound,
  };
}

async function gradingLog(query, { player = null, all = false } = {}) {
  const filter = player ? { user: player._id } : {};
  const { docs, ...pg } = await paged(GradingJob, filter, { createdAt: -1, _id: -1 }, query.gradingseite, 'user level card customer grade status guess clean seal pay foilFound doneAt createdAt', all);
  const names = await namesOf(docs.map((j) => j.user));
  return { ...pg, rows: docs.map((j) => gradingRow(j, names.get(String(j.user)))) };
}

// ---------- Alle Buchungen (Kontoauszug aller Spieler), optional nur eine Art (?buchung=…) ----------

const LEDGER_TYPES = Object.keys(ledgerLabels);

function ledgerRow(l, name) {
  return { at: l.createdAt, player: name || '–', type: l.type, kind: ledgerLabels[l.type] || l.type, text: l.betTitle || '', betId: l.bet ? String(l.bet) : null, amount: l.amount };
}

async function ledgerLog(query, { player = null, all = false } = {}) {
  const type = LEDGER_TYPES.includes(query.buchung) ? query.buchung : null;
  const filter = { ...(type ? { type } : {}), ...(player ? { user: player._id } : {}) };
  const { docs, ...pg } = await paged(Ledger, filter, { createdAt: -1, _id: -1 }, query.kontoseite, 'user type amount betTitle bet createdAt', all);
  const names = await namesOf(docs.map((l) => l.user));
  return { ...pg, type, types: LEDGER_TYPES.map((k) => ({ key: k, label: ledgerLabels[k] })), rows: docs.map((l) => ledgerRow(l, names.get(String(l.user)))) };
}

// ---------- Vergaben durch Admin und Devs (Packs, Karten, Gegenstände, entfernte Karten) ----------

const GRANT_KIND = { pack: 'Pack', karte: 'Karte', item: 'Gegenstand', entzug: 'Karte entfernt', geld: 'Geld', geldabzug: 'Geld abgezogen', packentzug: 'Pack entfernt', itementzug: 'Gegenstand entfernt', los: 'Lotterielos' };

function grantRow(g) {
  return { at: g.createdAt, by: g.byName, to: g.toName, all: !!g.all, kind: g.kind || 'pack', kindLabel: GRANT_KIND[g.kind || 'pack'] || g.kind, what: g.typeLabel, count: g.count, recipients: g.recipients || 1 };
}

async function grantLog(query, { player = null, all = false } = {}) {
  const filter = player ? { $or: [{ by: player._id }, { to: player._id }] } : {};
  const { docs, ...pg } = await paged(PackGrant, filter, { createdAt: -1, _id: -1 }, query.vergabeseite, null, all);
  return { ...pg, rows: docs.map(grantRow) };
}

// ---------- Registrierungen: wer sich wann mit welchem Code registriert hat ----------

const codeText = (code) => (code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code || null);

function registrationRow(u) {
  return { at: u.createdAt, name: u.username, realName: u.realName || null, code: codeText(u.registrationCode), invitedBy: u.invitedByName || null, deleted: !!u.deletedAt };
}

async function registrationLog(query, { player = null, all = false } = {}) {
  const filter = player ? { _id: player._id } : {};
  const { docs, ...pg } = await paged(User, filter, { createdAt: -1, _id: -1 }, query.registrierungsseite, 'username realName registrationCode invitedByName deletedAt createdAt', all);
  return { ...pg, rows: docs.map(registrationRow) };
}

// ---------- Einstellungen: jede Änderung an Preisen, Chancen, Steuern usw. ----------

const SETTINGS_AREA = { tcg: 'TCG', ihk: 'IHK', handel: 'Steuern', bonus: 'Tagesbonus', grading: 'Grading', folie: 'Folie', dungeon: 'Dungeon', lotterie: 'Lotterie', config: 'Serverstart (.env)' };
const valueText = (v) => (v === null || v === undefined ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function settingsRow(c) {
  return { at: c.createdAt, by: c.byName || 'Serverstart', area: SETTINGS_AREA[c.area] || c.area, changes: (c.changes || []).map((x) => ({ path: x.path, from: valueText(x.from), to: valueText(x.to) })) };
}

async function settingsLog(query, { player = null, all = false } = {}) {
  const filter = player ? { by: player._id } : {};
  const { docs, ...pg } = await paged(SettingsChange, filter, { createdAt: -1, _id: -1 }, query.einstellungsseite, 'area changes byName createdAt', all);
  return { ...pg, rows: docs.map(settingsRow) };
}

// ---------- Gesamt: alle Protokolle in einer Liste, neueste zuerst ----------

// Buchungen, die kein anderes Protokoll zeigt (Lose, Verkäufe, Einsätze, Broker, Quests, Handel, Vergaben,
// Startguthaben usw. stehen schon in ihren eigenen Protokollen und kämen sonst doppelt)
const GESAMT_LEDGER_TYPES = ['auszahlung', 'erstattung', 'provision', 'provision_schiri', 'bonus', 'erfolg', 'tcg_pack', 'grading_ausbau', 'konto_geloescht'];
const GESAMT_PAGES = 40; // tiefer blättern lohnt nicht – dafür gibt es die einzelnen Protokolle und den Export
const GESAMT_EXPORT = 5000;
const itemsText = (items) => items.map((c) => `${c.count > 1 ? c.count + '× ' : ''}${c.label}`).join(', ') || '–';
const IHK_STATE_TEXT = { laeuft: 'läuft', geschafft: 'geschafft', gescheitert: 'gescheitert' };
const withNames = async (docs) => namesOf(docs.map((d) => d.user));

/**
 * Quellen des Gesamtprotokolls: Modell, Filter (optional für einen Spieler), Zeitfeld zum Sortieren und wie aus
 * den Dokumenten einheitliche Zeilen werden: { at, player, text, amount } (amount in Cent oder null).
 * Die Zeilen bauen auf den Zeilen der einzelnen Protokolle auf.
 */
const GESAMT_SOURCES = [
  {
    log: 'wetten',
    Model: Bet,
    time: 'createdAt',
    select: 'title options creatorName refereeName status outcome disputed refunded createdAt',
    filter: async (p) => (p ? { $or: [{ creator: p._id }, { referee: p._id }, { 'duel.opponent': p._id }, { _id: { $in: await Position.distinct('bet', { user: p._id }) } }] } : {}),
    rows: async (docs) =>
      docs.map((b) => {
        const r = betRow(b);
        return { at: r.at, player: r.creator, text: `Wette „${r.title}“ erstellt${r.referee ? ` (Schiedsrichter ${r.referee})` : ''} – ${r.result}`, amount: null };
      }),
  },
  {
    log: 'einsaetze',
    Model: Position,
    time: 'createdAt',
    filter: async (p) => (p ? { user: p._id } : {}),
    rows: async (docs) => {
      const bets = await Bet.find({ _id: { $in: docs.map((d) => d.bet) } }).select('title options').lean();
      const byId = new Map(bets.map((b) => [String(b._id), b]));
      return docs.map((d) => {
        const r = stakeRow(d, byId.get(String(d.bet)));
        return { at: r.at, player: r.player, text: `Setzt auf „${r.side}“ bei „${r.bet}“`, amount: -r.amount };
      });
    },
  },
  {
    log: 'broker',
    Model: CoinTrade,
    time: 'createdAt',
    filter: async (p) => (p ? { user: p._id } : {}),
    rows: async (docs) => {
      const names = await withNames(docs);
      return docs.map((d) => {
        const r = coinRow(d, names.get(String(d.user)));
        return { at: r.at, player: r.player, text: `${r.side}: ${r.unitsText} ${r.asset}`, amount: r.cents };
      });
    },
  },
  {
    log: 'lotterie',
    Model: Ledger,
    time: 'createdAt',
    filter: async (p) => ({ type: { $in: ['lotto_los', 'lotto_gewinn'] }, ...(p ? { user: p._id } : {}) }),
    rows: async (docs) => {
      const names = await withNames(docs);
      return docs.map((d) => {
        const r = lottoRow(d, names.get(String(d.user)));
        const lose = r.count ? ` (${r.count} ${r.count === 1 ? 'Los' : 'Lose'})` : '';
        return { at: r.at, player: r.player, text: `${r.lottery}: ${r.kind}${lose}${r.ticket ? ` mit Los ${r.ticket}` : ''}`, amount: r.amount };
      });
    },
  },
  {
    log: 'konto',
    label: 'Buchung',
    Model: Ledger,
    time: 'createdAt',
    select: 'user type amount betTitle createdAt',
    filter: async (p) => ({ type: { $in: GESAMT_LEDGER_TYPES }, ...(p ? { user: p._id } : {}) }),
    rows: async (docs) => {
      const names = await withNames(docs);
      return docs.map((d) => {
        const r = ledgerRow(d, names.get(String(d.user)));
        return { at: r.at, player: r.player, text: r.text ? `${r.kind}: ${r.text}` : r.kind, amount: r.amount };
      });
    },
  },
  {
    log: 'handel',
    Model: Trade,
    time: 'closedAt',
    select: 'kind sellerName buyerName toName card wantCard give take price closedAt',
    filter: async (p) => ({ status: 'verkauft', ...(p ? { $or: [{ seller: p._id }, { buyer: p._id }, { to: p._id }] } : {}) }),
    rows: async (docs) =>
      docs.map((t) => {
        const to = t.kind === 'tausch' ? t.toName : t.buyerName;
        const back = t.kind === 'tausch' ? swapLabel(t, 'take') + (t.price > 0 ? ` + ${euro(t.price)}` : '') : euro(t.price);
        return { at: t.closedAt, player: t.sellerName, text: `${KIND_LABEL[t.kind] || t.kind}: ${t.kind === 'tausch' ? swapLabel(t, 'give') : cardLabel(t.card)} an ${to || '–'} gegen ${back}`, amount: null };
      }),
  },
  {
    log: 'packs',
    Model: TcgOpening,
    time: 'createdAt',
    filter: async (p) => (p ? { user: p._id } : {}),
    rows: async (docs) =>
      docs.map((d) => {
        const r = packRow(d);
        // ältere Öffnungen ohne Pack-Art und Herkunft (siehe Pack-Protokoll)
        const pack = r.pack === '–' ? 'Booster Pack' : r.pack;
        return { at: r.at, player: r.player, text: `${pack} geöffnet${r.source === '–' ? '' : ` (${r.source})`}: ${itemsText(r.cards)}`, amount: null };
      }),
  },
  {
    log: 'verkauf',
    Model: Ledger,
    time: 'createdAt',
    filter: async (p) => ({ type: { $in: SELL_TYPES }, ...(p ? { user: p._id } : {}) }),
    rows: async (docs) => {
      const names = await withNames(docs);
      return docs.map((d) => {
        const r = sellRow(d, names.get(String(d.user)));
        return { at: r.at, player: r.player, text: `${r.kind}: ${itemsText(r.items)}`, amount: r.amount };
      });
    },
  },
  {
    log: 'ihk',
    Model: IhkRun,
    time: 'createdAt',
    select: 'user quest difficulty card boost boost2 success reward status endsAt collectedAt pack createdAt',
    filter: async (p) => (p ? { user: p._id } : {}),
    rows: async (docs) => {
      const names = await withNames(docs);
      return docs.map((d) => {
        const r = ihkRow(d, names.get(String(d.user)));
        // laufende Quests: Ergebnis und Lohn erst nach Ablauf zeigen (wie im IHK-Protokoll)
        return { at: r.at, player: r.player, text: `IHK-Quest „${r.quest}“ (${r.difficulty}) mit ${r.card} – ${IHK_STATE_TEXT[r.state]}`, amount: r.state === 'laeuft' ? null : r.reward || null };
      });
    },
  },
  {
    log: 'dungeon',
    Model: DungeonRun,
    time: 'startedAt',
    select: 'dungeon members success fights.key fights.success startedAt endsAt status',
    filter: async (p) => (p ? { 'members.user': p._id } : {}),
    rows: async (docs) =>
      docs.map((d) => {
        const r = dungeonRow(d);
        const players = r.members.filter((m) => !m.bot).map((m) => m.name).join(', ') || '–';
        return { at: r.startedAt, player: players, text: `Dungeon ${r.dungeon}: ${r.running ? 'läuft' : r.success ? 'Boss besiegt' : 'Rückzug'} (${r.progress} Kämpfe)`, amount: null };
      }),
  },
  {
    log: 'grading',
    Model: GradingJob,
    time: 'createdAt',
    select: 'user level card customer grade status guess clean seal pay foilFound doneAt createdAt',
    filter: async (p) => (p ? { user: p._id } : {}),
    rows: async (docs) => {
      const names = await withNames(docs);
      return docs.map((d) => {
        const r = gradingRow(d, names.get(String(d.user)));
        return { at: r.startedAt, player: r.player, text: `Grading ${r.shop}: ${r.card} für ${r.customer}${r.done ? ` – Note ${r.grade}` : ' – läuft'}`, amount: r.done ? r.pay || null : null };
      });
    },
  },
  {
    log: 'vergaben',
    Model: PackGrant,
    time: 'createdAt',
    filter: async (p) => (p ? { $or: [{ by: p._id }, { to: p._id }] } : {}),
    rows: async (docs) =>
      docs.map((d) => {
        const r = grantRow(d);
        const what = /geld/.test(r.kind) ? r.what : `${r.count}× ${r.what}`; // Geld: count ist der Betrag
        return { at: r.at, player: r.by, text: `${r.kindLabel} an ${r.to}: ${what}`, amount: null };
      }),
  },
  {
    log: 'registrierungen',
    Model: User,
    time: 'createdAt',
    select: 'username realName registrationCode invitedByName deletedAt createdAt',
    filter: async (p) => (p ? { _id: p._id } : {}),
    rows: async (docs) =>
      docs.map((d) => {
        const r = registrationRow(d);
        const details = [r.code ? `mit Code ${r.code}` : '', r.invitedBy ? `eingeladen von ${r.invitedBy}` : ''].filter(Boolean).join(', ');
        const name = r.realName ? ` (${r.realName})` : '';
        return { at: r.at, player: r.name, text: `Registriert${name}${details ? ' ' + details : ''}${r.deleted ? ' – Konto gelöscht' : ''}`, amount: null };
      }),
  },
  {
    log: 'einstellungen',
    Model: SettingsChange,
    time: 'createdAt',
    select: 'area changes byName createdAt',
    filter: async (p) => (p ? { by: p._id } : {}),
    rows: async (docs) =>
      docs.map((d) => {
        const r = settingsRow(d);
        const shown = r.changes.slice(0, 3).map((x) => `${x.path}: ${x.from} → ${x.to}`).join(', ');
        const more = r.changes.length > 3 ? ` … (+${r.changes.length - 3})` : '';
        return { at: r.at, player: r.by, text: `${r.area} geändert${shown ? ': ' + shown : ''}${more}`, amount: null };
      }),
  },
];

/** Zeilen mehrerer Quellen zusammenführen: neueste zuerst (stabil – bei gleicher Zeit bleibt die Reihenfolge der Quellen) */
const mergeRows = (lists) => lists.flat().sort((a, b) => new Date(b.at) - new Date(a.at));

async function gesamtLog(query, { player = null, all = false } = {}) {
  const sources = await Promise.all(GESAMT_SOURCES.map(async (s) => ({ ...s, where: await s.filter(player) })));
  const total = (await Promise.all(sources.map((s) => s.Model.countDocuments(s.where)))).reduce((a, b) => a + b, 0);
  const { pages, page } = all ? { pages: 1, page: 1 } : pageOf(query.gesamtseite, Math.min(total, GESAMT_PAGES * LOG_PAGE));
  // Für Seite n reichen von jeder Quelle die neuesten n × LOG_PAGE Einträge – ältere können auf Seite 1 … n nicht vorkommen
  const take = all ? GESAMT_EXPORT : page * LOG_PAGE;
  const lists = await Promise.all(
    sources.map(async (s) => {
      let q = s.Model.find(s.where).sort({ [s.time]: -1, _id: -1 }).limit(take);
      if (s.select) q = q.select(s.select);
      const label = s.label || logByKey[s.log].label;
      return (await s.rows(await q.lean())).map((r) => ({ ...r, log: s.log, logLabel: label }));
    })
  );
  const merged = mergeRows(lists);
  const rows = all ? merged.slice(0, GESAMT_EXPORT) : merged.slice((page - 1) * LOG_PAGE, page * LOG_PAGE);
  return { total, pages, page, capped: !all && total > GESAMT_PAGES * LOG_PAGE, rows };
}

// ---------- Export: CSV für Excel (wie die Statistik: Semikolon, Dezimalkomma, UTF-8 mit BOM) ----------

const csvDateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: config.timezone });
/** Zeitpunkt als "TT.MM.JJJJ HH:MM:SS" (Excel erkennt das als Datum) */
const csvDate = (d) => (d ? csvDateFmt.format(new Date(d)).replace(',', '') : '');
const csvEuro = (cents) => (typeof cents === 'number' ? num(cents / 100, 2) : '');
const cardsText = (items) => items.map((c) => `${c.count > 1 ? c.count + '× ' : ''}${c.label}`).join(', ');
const yesNo = (b) => (b ? 'ja' : '');
const STAKE_STATE = { offen: 'Offen', gewonnen: 'Gewonnen', verloren: 'Verloren', erstattet: 'Erstattet' };
const csvNum = (v, digits) => (typeof v === 'number' ? num(v, digits) : '');
const IHK_STATE = { laeuft: 'Läuft', geschafft: 'Geschafft', gescheitert: 'Gescheitert' };

// Kopfzeile und Zeilen je Log (eine Zeile pro Eintrag; Dungeons: eine Zeile pro Teilnehmer, damit Excel filtern kann)
const CSV = {
  gesamt: {
    head: ['Zeitpunkt', 'Bereich', 'Spieler', 'Was', 'Betrag (€)'],
    rows: (r) => [[csvDate(r.at), r.logLabel, r.player, r.text, r.amount === null ? '' : csvEuro(r.amount)]],
  },
  vergaben: {
    head: ['Zeitpunkt', 'Von', 'An', 'Art', 'Was', 'Anzahl je Mitglied', 'Empfänger'],
    rows: (g) => [[csvDate(g.at), g.by, g.to, g.kindLabel, g.what, g.count, g.recipients]],
  },
  registrierungen: {
    head: ['Zeitpunkt', 'Benutzername', 'Klarname', 'Code', 'Eingeladen von', 'Konto gelöscht'],
    rows: (r) => [[csvDate(r.at), r.name, r.realName || '', r.code || '', r.invitedBy || '', yesNo(r.deleted)]],
  },
  einstellungen: {
    head: ['Zeitpunkt', 'Von', 'Bereich', 'Wert', 'Vorher', 'Nachher'],
    rows: (c) => (c.changes.length ? c.changes.map((x) => [csvDate(c.at), c.by, c.area, x.path, x.from, x.to]) : [[csvDate(c.at), c.by, c.area, '', '', '']]),
  },
  wetten: {
    head: ['Erstellt', 'Wette', 'Duell', 'Gruppe', 'Ersteller', 'Schiedsrichter', 'Optionen', 'Einsatzschluss', 'Status', 'Ergebnis', 'Entschieden über', 'Entschieden von', 'Entschieden am', 'Begründung', 'Topf (€)', 'Teilnehmer', 'Provision (€)'],
    rows: (b) => [[csvDate(b.at), b.title, yesNo(b.duel), b.group || '', b.creator, b.referee || '', b.options.join(' / '), csvDate(b.deadline), BET_STATUS[b.status] || b.status, b.result === BET_STATUS[b.status] ? '' : b.result, b.via || '', b.resolvedBy || '', csvDate(b.resolvedAt), b.note || '', csvEuro(b.pot), b.participants, csvEuro(b.fees)]],
  },
  einsaetze: {
    head: ['Zeitpunkt', 'Spieler', 'Wette', 'Gesetzt auf', 'Einsatz (€)', 'Auszahlung (€)', 'Gewinn/Verlust (€)', 'Status', 'Abgerechnet'],
    rows: (p) => [[csvDate(p.at), p.player, p.bet, p.side, csvEuro(p.amount), p.payout === null ? '' : csvEuro(p.payout), p.net === null ? '' : csvEuro(p.net), STAKE_STATE[p.state], csvDate(p.settledAt)]],
  },
  broker: {
    head: ['Zeitpunkt', 'Spieler', 'Wert', 'Art', 'Menge', 'Kurs (€)', 'Betrag (€)', 'Steuer (€)'],
    rows: (t) => [[csvDate(t.at), t.player, t.asset, t.side, csvNum(t.units / 1e8, 8), csvNum(t.price, 6), csvEuro(t.cents), csvEuro(t.tax)]],
  },
  lotterie: {
    head: ['Zeitpunkt', 'Spieler', 'Art', 'Lotterie', 'Lose', 'Runde', 'Gewinnlos', 'Betrag (€)'],
    rows: (l) => [[csvDate(l.at), l.player, l.kind, l.lottery, l.count || '', l.round || '', l.ticket || '', csvEuro(l.amount)]],
  },
  konto: {
    head: ['Zeitpunkt', 'Spieler', 'Buchung', 'Text', 'Betrag (€)'],
    rows: (l) => [[csvDate(l.at), l.player, l.kind, l.text, csvEuro(l.amount)]],
  },
  grading: {
    head: ['Angenommen', 'Erledigt', 'Spieler', 'Shop', 'Karte', 'Kunde', 'Echte Note', 'Geschätzte Note', 'Sauberkeit (%)', 'Versiegelung', 'Lohn (€)', 'Folie gefunden'],
    rows: (j) => [[csvDate(j.startedAt), j.done ? csvDate(j.at) : '', j.player, j.shop, j.card, j.customer, j.done ? j.grade : '', csvNum(j.guess, 0), csvNum(j.clean, 0), csvNum(j.seal, 0), j.done ? csvEuro(j.pay) : '', yesNo(j.foil)]],
  },
  handel: {
    head: ['Zeitpunkt', 'Von', 'An', 'Karte', 'Gegenleistung', 'Steuer (€)', 'Art', 'Mehrfach-Konto'],
    rows: (t) => [[csvDate(t.at), t.from, t.to, t.card, t.back, csvEuro(t.tax), t.kind, yesNo(t.flagged)]],
  },
  packs: {
    head: ['Zeitpunkt', 'Spieler', 'Pack', 'Herkunft', 'Kosten (€)', 'Karten (Anzahl)', 'Gezogene Karten', 'Beste Seltenheit'],
    rows: (o) => [[csvDate(o.at), o.player, o.pack, o.source, csvEuro(o.cost), o.cards.reduce((n, c) => n + c.count, 0), cardsText(o.cards), o.best || '']],
  },
  verkauf: {
    head: ['Zeitpunkt', 'Spieler', 'Art', 'Anzahl', 'Karten / Gegenstände', 'Betrag (€)'],
    rows: (l) => [[csvDate(l.at), l.player, l.kind, l.items.reduce((n, c) => n + c.count, 0), cardsText(l.items), csvEuro(l.amount)]],
  },
  ihk: {
    head: ['Gestartet', 'Ende', 'Spieler', 'Quest', 'Schwierigkeit', 'Karte', 'Boost', 'Ergebnis', 'Lohn (€)', 'Pack-Fund', 'Abgeholt'],
    rows: (r) => [[csvDate(r.at), csvDate(r.endsAt), r.player, r.quest, r.difficulty, r.card, r.boosts.join(', '), IHK_STATE[r.state], r.state === 'laeuft' ? '' : csvEuro(r.reward), r.pack || '', csvDate(r.collectedAt)]],
  },
  dungeon: {
    head: ['Gestartet', 'Ende', 'Dungeon', 'Ergebnis', 'Kämpfe gewonnen', 'Gescheitert an', 'Teilnehmer', 'Bot', 'Anführer', 'Karte', 'Boost', 'Lohn (€)', 'Folie', 'Boss-Karte'],
    rows: (r) =>
      r.members.map((m) => [
        csvDate(r.startedAt),
        csvDate(r.at),
        r.dungeon,
        r.running ? 'Läuft' : r.success ? 'Boss besiegt' : 'Rückzug',
        r.progress,
        r.failedAt || '',
        m.name,
        yesNo(m.bot),
        yesNo(m.leader),
        m.card,
        m.boost || '',
        m.bot || r.running ? '' : csvEuro(m.reward),
        yesNo(m.foil),
        yesNo(m.bossCard),
      ]),
  },
};

/** Einen geladenen Log als CSV-Text (mit Titelzeile) */
function toCsv(key, data, { title } = {}) {
  const spec = CSV[key];
  const lines = [];
  if (title) lines.push([title], [`Erstellt: ${csvDate(new Date())}`, `Einträge: ${data.rows.length}${data.total > data.rows.length ? ` von ${data.total} (gekürzt)` : ''}`], []);
  lines.push(spec.head, ...data.rows.flatMap(spec.rows));
  return '\uFEFF' + lines.map((cells) => cells.map(field).join(';')).join('\r\n') + '\r\n';
}

/** Dateiname, z. B. protokoll-packs-anna-2026-10-04.csv */
function exportFileName(key, playerName, ext, now = new Date()) {
  const slug = (v) => String(v).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(now); // JJJJ-MM-TT
  return `${['protokoll', key, playerName].filter(Boolean).map(slug).join('-')}-${day}.${ext}`;
}

const LOADERS = { gesamt: gesamtLog, wetten: betLog, einsaetze: stakeLog, broker: coinLog, lotterie: lottoLog, konto: ledgerLog, handel: tradeLog, packs: packLog, verkauf: sellLog, ihk: ihkLog, dungeon: dungeonLog, grading: gradingLog, vergaben: grantLog, registrierungen: registrationLog, einstellungen: settingsLog };

/** Den gewählten Log laden: { key, data } */
async function loadLog(query, opts = {}) {
  // Schlüssel mit fester Liste vergleichen (kein Zugriff über den Nutzerwert)
  const [key, loader] = Object.entries(LOADERS).find(([k]) => k === query.log && logByKey[k]) || ['handel', LOADERS.handel];
  return { key, data: await loader(query, opts) };
}

module.exports = {
  LOG_PAGE,
  EXPORT_MAX,
  toCsv,
  exportFileName,
  LOGS,
  LOG_GROUPS,
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
  betRow,
  stakeRow,
  coinRow,
  lottoRow,
  gradingRow,
  ledgerRow,
  registrationRow,
  mergeRows,
  GESAMT_SOURCES,
  GESAMT_LEDGER_TYPES,
  grantRow,
  settingsRow,
};

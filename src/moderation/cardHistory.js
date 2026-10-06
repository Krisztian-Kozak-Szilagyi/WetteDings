// Kartenhistorie (Admin und Devs): der Lebenslauf eines einzelnen Exemplars – wann und wie es entstanden ist (Pack,
// Vergabe, Dungeon-Beute, Black Market), jeder Besitzerwechsel (Handel, Duell), jeder Einsatz (IHK, Dungeon), Folie
// und wie es endete (an die Bank verkauft, vom Team entfernt). Jedes Exemplar ist ein eigenes TcgCard-Dokument; seine
// _id bleibt bei Handel und Duell erhalten, darüber werden alle Stationen gefunden – auch nach dem Verkauf.
// Bank-Verkauf und Entzug speichern die Exemplar-IDs erst seit Einführung dieser Seite; ältere Enden werden aus den
// Buchungen des letzten Besitzers erschlossen und als "vermutlich" gekennzeichnet.
const mongoose = require('mongoose');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const Bet = require('../models/Bet');
const BlackMarket = require('../models/BlackMarket');
const { TcgCard, TcgOpening, PackGrant } = require('../models/Tcg');
const { Trade } = require('../models/Trade');
const { IhkRun } = require('../models/Ihk');
const { DungeonRun } = require('../models/Dungeon');
const catalog = require('../tcg/catalog');
const { questById } = require('../ihk/quests');
const { dungeonByKey } = require('../dungeon/dungeons');
const { euro } = require('../lib/viewHelpers');
const logs = require('../stats/logs');
const { tradeFlow } = require('./suspicionLogic');

const MIN = 60 * 1000;
const ORIGIN_SLACK_MS = 5 * MIN; // Vergabe bzw. Black-Market-Kauf und Anlegen des Exemplars liegen so dicht beieinander
const DUNGEON_SLACK_MS = 15 * MIN; // Boss-Karte: angelegt, wenn der Abschluss-Job den Durchlauf beendet
const SEARCH_CARDS = 12; // so viele Karten zeigt die Suche höchstens
const SEARCH_COPIES = 200; // so viele Exemplare je Karte

const toMs = (t) => new Date(t).getTime();
const near = (a, b, slack) => a && b && Math.abs(toMs(a) - toMs(b)) <= slack;

/** Bankwert eines Exemplars in Cent (ohne Folien-Steigerung) */
function bankValue(cardId) {
  const c = catalog.cardById[cardId];
  const r = c && catalog.rarityByKey[c.rarity];
  return r ? r.sell || 0 : 0;
}

/** "Oliver the Sigrist (Sith)" */
const cardName = (cardId) => logs.cardLabel(cardId);

// ---------- Reine Hilfen (getestet) ----------

/**
 * Herkunft eines Exemplars ohne Pack-Öffnung erschließen: Vergabe vom Team, Boss-Karte aus dem Dungeon oder Kauf im
 * Black Market – jeweils dieselbe Karte, derselbe erste Besitzer und fast derselbe Zeitpunkt wie beim Anlegen.
 * copy: { card, createdAt }, owner: erster Besitzer (ID als Text). Liefert { kind, at, text } oder null.
 */
function matchOrigin(copy, owner, { grants = [], dungeons = [], markets = [] } = {}) {
  const grant = grants.find((g) => g.type === copy.card && (g.all || String(g.to) === owner) && near(g.createdAt, copy.createdAt, ORIGIN_SLACK_MS));
  if (grant) return { kind: 'vergabe', at: grant.createdAt, text: `Vom Team vergeben (${grant.byName})${grant.reason ? `: ${grant.reason}` : ''}` };
  for (const r of dungeons) {
    const d = dungeonByKey[r.dungeon];
    if (!d || d.bossCard !== copy.card || !near(r.updatedAt || r.endsAt, copy.createdAt, DUNGEON_SLACK_MS)) continue;
    if ((r.members || []).some((m) => m.bossCard && String(m.user) === owner)) return { kind: 'dungeon', at: r.endsAt, text: `Boss-Beute im Dungeon „${d.title}“` };
  }
  for (const day of markets) {
    const o = (day.offers || []).find((x) => x.card === copy.card && String(x.buyer) === owner && near(x.soldAt, copy.createdAt, ORIGIN_SLACK_MS));
    if (o) return { kind: 'blackmarket', at: o.soldAt, text: `Im Black Market gekauft für ${euro(o.price)}` };
  }
  return null;
}

/**
 * Zeitleiste ordnen und Haltezeiten eintragen. events: [{ at, type, from?, to?, ... }] – Besitzerwechsel haben from
 * und to. firstOwner = Besitzer ab dem ersten Ereignis. Ergebnis: Ereignisse nach Zeit, Besitzerwechsel mit heldMs
 * (wie lange from die Karte hatte), dazu { owner, ownerSince } = wer sie am Ende hat (null, wenn sie weg ist).
 */
function timeline(events, firstOwner, { gone = false } = {}) {
  const list = [...events].sort((a, b) => toMs(a.at) - toMs(b.at) || (a.order || 0) - (b.order || 0));
  let owner = firstOwner || null;
  // Haltezeit des ersten Besitzers nur, wenn bekannt ist, wann die Karte entstand
  let since = list.length && list[0].type === 'entstanden' ? toMs(list[0].at) : null;
  const out = list.map((e) => {
    if (!e.to) return e;
    const heldMs = since !== null && String(e.from) === String(owner) ? toMs(e.at) - since : null;
    owner = String(e.to);
    since = toMs(e.at);
    return { ...e, heldMs };
  });
  return { events: out, owner: gone ? null : owner, ownerSince: gone ? null : since };
}

/** Dauer als Text: "26 Std.", "3 Tage", "12 Min." */
function durationText(ms) {
  if (ms === null || ms === undefined || ms < 0) return '';
  if (ms < 60 * MIN) return `${Math.max(1, Math.round(ms / MIN))} Min.`;
  if (ms < 48 * 60 * MIN) return `${Math.round(ms / (60 * MIN))} Std.`;
  return `${Math.round(ms / (24 * 60 * MIN))} Tage`;
}

// ---------- Datenbank ----------

/** Namen zu IDs: Map id → Name */
async function namesOf(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))].filter((id) => mongoose.isValidObjectId(id));
  if (!unique.length) return new Map();
  const users = await User.find({ _id: { $in: unique } }).select('username deletedAt').lean();
  return new Map(users.map((u) => [String(u._id), u.username]));
}

/**
 * Verlauf eines Exemplars. Liefert null, wenn es keine Spur davon gibt, sonst
 * { id, card, label, rarity, value, exists, foiledAt, grade, owner, ownerSince, events: [{ at, type, icon, text, from, to, heldMs, guess }] }
 * Namen stehen schon in den Texten; from/to sind Namen (für Links).
 */
async function historyOf(docId) {
  if (!mongoose.isValidObjectId(docId)) return null;
  const id = new mongoose.Types.ObjectId(String(docId));
  const [copy, trades, duels, quests, dungeons, sale, revoke] = await Promise.all([
    TcgCard.findById(id).select('user card rarity opening foiledAt createdAt condition.grade').lean(),
    Trade.find({ status: 'verkauft', $or: [{ 'give.doc': id }, { 'want.doc': id }] }).select('kind seller buyer to sellerName buyerName toName give want price extraFrom tax closedAt').sort({ closedAt: 1 }).lean(),
    Bet.find({ 'duel.cards.doc': id }).select('title status outcome creator duel.opponent duel.cards resolvedAt createdAt').lean(),
    IhkRun.find({ $or: [{ cardDoc: id }, { boostDoc: id }, { boost2Doc: id }] }).select('user quest card cardDoc createdAt endsAt success status').lean(),
    DungeonRun.find({ $or: [{ 'members.cardDoc': id }, { 'members.boostDoc': id }] }).select('dungeon startedAt status success members.user members.name members.card members.cardDoc members.boostDoc').lean(),
    Ledger.findOne({ type: 'tcg_verkauf', 'meta.docs.doc': id }).lean(),
    PackGrant.findOne({ kind: 'entzug', docs: id }).lean(),
  ]);

  // Welche Karte? Aus dem Exemplar selbst oder aus einer Spur (Handel, Duell, Verkauf, Entzug, Quest, Dungeon)
  const lineOf = (t) => [...(t.give || []), ...(t.want || [])].find((l) => l.doc && l.doc.equals(id));
  const duelCard = (b) => b.duel.cards.find((c) => c.doc && c.doc.equals(id));
  const soldEntry = sale && ((sale.meta && sale.meta.docs) || []).find((d) => d.doc && String(d.doc) === String(id));
  const questCard = quests.find((r) => r.cardDoc && r.cardDoc.equals(id));
  const dungeonCard = dungeons.flatMap((r) => r.members).find((m) => m.cardDoc && m.cardDoc.equals(id));
  const cardId =
    (copy && copy.card) ||
    (trades.length && lineOf(trades[0]).card) ||
    (duels.length && duelCard(duels[0]).card) ||
    (soldEntry && soldEntry.card) ||
    (revoke && revoke.type) ||
    (questCard && questCard.card) ||
    (dungeonCard && dungeonCard.card) ||
    null;
  if (!cardId) return null;

  const events = [];
  // Besitzerwechsel aus Handel und Duell
  for (const t of trades) {
    const line = lineOf(t);
    const other = t.buyer || t.to;
    const fromSeller = (t.give || []).some((l) => l.doc && l.doc.equals(id));
    const [from, to] = fromSeller ? [t.seller, other] : [other, t.seller];
    const sellerPays = t.extraFrom === 'seller';
    // Gegenleistung aus Sicht dessen, der die Karte abgibt
    const back = fromSeller ? logs.tradeSide(t.want, sellerPays ? 0 : t.price) : logs.tradeSide(t.give, sellerPays ? t.price : 0);
    const flow = tradeFlow(t, (c) => bankValue(c));
    events.push({ at: t.closedAt, type: 'handel', from, to, kind: t.kind, back, line, flow, trade: t._id });
  }
  for (const b of duels) {
    const c = duelCard(b);
    if (b.status !== 'entschieden') {
      events.push({ at: b.resolvedAt || b.createdAt, type: 'duell-einsatz', who: c.user, status: b.status, title: b.title });
      continue;
    }
    const winner = b.outcome === 'o1' ? b.creator : b.duel.opponent;
    if (c.side !== b.outcome) events.push({ at: b.resolvedAt, type: 'duell', from: c.user, to: winner, title: b.title });
    else events.push({ at: b.resolvedAt, type: 'duell-einsatz', who: c.user, status: 'gewonnen', title: b.title });
  }
  for (const r of quests) events.push({ at: r.createdAt, type: 'ihk', who: r.user, quest: r.quest, main: r.cardDoc && r.cardDoc.equals(id), status: r.status, success: r.success });
  for (const r of dungeons) {
    const m = r.members.find((x) => (x.cardDoc && x.cardDoc.equals(id)) || (x.boostDoc && x.boostDoc.equals(id)));
    if (m) events.push({ at: r.startedAt, type: 'dungeon', who: m.user, dungeon: r.dungeon, main: !!(m.cardDoc && m.cardDoc.equals(id)), status: r.status, success: r.success });
  }
  if (copy && copy.foiledAt) events.push({ at: copy.foiledAt, type: 'folie', grade: copy.condition ? copy.condition.grade : null, who: null });

  // Erster Besitzer: wer es beim ersten Besitzerwechsel abgab, sonst der heutige (bzw. letzte) Besitzer
  const firstMove = events.filter((e) => e.from).sort((a, b) => toMs(a.at) - toMs(b.at))[0];
  const firstOwner = String(firstMove ? firstMove.from : copy ? copy.user : sale ? sale.user : revoke ? revoke.to : '') || null;

  // Entstehung
  const opening = copy && copy.opening ? await TcgOpening.findById(copy.opening).select('user username type source cost createdAt').lean() : null;
  if (opening) {
    const pack = (catalog.packTypeByKey[opening.type] || {}).label || 'Booster Pack';
    const SOURCE = { kauf: 'gekauft', quest: 'aus einer IHK-Quest', admin: 'vom Team geschenkt', lotto: 'aus der Lotterie' };
    events.push({ at: opening.createdAt, type: 'entstanden', order: -1, who: opening.user, text: `Aus einem ${pack} gezogen (Pack ${SOURCE[opening.source] || 'unbekannter Herkunft'})` });
  } else if (copy) {
    const [grants, runs, markets] = await Promise.all([
      PackGrant.find({ kind: 'karte', type: copy.card, createdAt: { $gte: new Date(toMs(copy.createdAt) - ORIGIN_SLACK_MS), $lte: new Date(toMs(copy.createdAt) + ORIGIN_SLACK_MS) } }).lean(),
      DungeonRun.find({ status: 'fertig', 'members.bossCard': true, updatedAt: { $gte: new Date(toMs(copy.createdAt) - DUNGEON_SLACK_MS), $lte: new Date(toMs(copy.createdAt) + DUNGEON_SLACK_MS) } }).select('dungeon endsAt updatedAt members.user members.bossCard').lean(),
      BlackMarket.find({ 'offers.card': copy.card, 'offers.buyer': { $ne: null } }).lean(),
    ]);
    const o = matchOrigin(copy, firstOwner, { grants, dungeons: runs, markets });
    events.push({ at: copy.createdAt, type: 'entstanden', order: -1, who: firstOwner, text: o ? o.text : 'Entstanden (Herkunft nicht gespeichert – Karten aus Packs zeigen hier die Öffnung)' });
  } else if (firstOwner && mongoose.isValidObjectId(firstOwner)) {
    // Exemplar gelöscht (verkauft/entfernt): der Verweis auf die Pack-Öffnung ist mit ihm weg – die jüngste Öffnung des
    // ersten Besitzers mit dieser Karte vor der ersten bekannten Station ist die wahrscheinliche Herkunft
    const firstAt = events.length ? new Date(Math.min(...events.map((e) => toMs(e.at)))) : new Date();
    const guess = await TcgOpening.findOne({ user: firstOwner, 'cards.card': cardId, createdAt: { $lte: firstAt } }).sort({ createdAt: -1 }).select('createdAt type source').lean();
    if (guess) events.push({ at: guess.createdAt, type: 'entstanden', order: -1, who: firstOwner, guess: true, text: `Vermutlich aus einem ${(catalog.packTypeByKey[guess.type] || {}).label || 'Booster Pack'} gezogen (jüngste passende Öffnung von ${'{name}'})` });
  }

  // Ende: an die Bank verkauft oder vom Team entfernt – gespeichert oder aus den Buchungen erschlossen
  let gone = !copy;
  if (sale) events.push({ at: sale.createdAt, type: 'verkauft', who: sale.user, amount: bankValue(cardId) });
  else if (revoke) events.push({ at: revoke.createdAt, type: 'entzogen', who: revoke.to, by: revoke.byName });
  else if (!copy) {
    const { owner, events: ordered } = timeline(events, firstOwner);
    const lastAt = ordered.length ? ordered[ordered.length - 1].at : new Date(0);
    const guess = owner
      ? await Ledger.findOne({ user: owner, type: 'tcg_verkauf', 'meta.cards.card': cardId, createdAt: { $gte: lastAt } }).sort({ createdAt: 1 }).lean()
      : null;
    if (guess) events.push({ at: guess.createdAt, type: 'verkauft', who: owner, amount: bankValue(cardId), guess: true });
    else events.push({ at: lastAt, type: 'verschwunden', order: 1, who: owner });
  }

  const ids = events.flatMap((e) => [e.from, e.to, e.who]);
  const names = await namesOf(ids);
  const name = (v) => (v ? names.get(String(v)) || 'gelöschtes Konto' : '–');
  const { events: ordered, owner, ownerSince } = timeline(events, firstOwner, { gone });

  const DUEL_STATE = { offen: 'läuft noch', annulliert: 'annulliert, Karte blieb', gewonnen: 'gewonnen, Karte blieb' };
  const KIND = { markt: 'Markt', privat: 'Privat', tausch: 'Tausch' };
  const text = (e) => {
    switch (e.type) {
      case 'entstanden':
        return e.text.replace('{name}', name(e.who));
      case 'handel':
        return `${KIND[e.kind] || 'Handel'}: ${name(e.from)} → ${name(e.to)} · Gegenleistung ${e.back}` + (e.flow && e.flow.shifted > 0 ? ` (Wert ca. ${euro(e.flow.given)} gegen ${euro(e.flow.received)})` : '');
      case 'duell':
        return `Im Duell „${e.title}“ verloren: ${name(e.from)} → ${name(e.to)}`;
      case 'duell-einsatz':
        return `Im Duell „${e.title}“ eingesetzt von ${name(e.who)} (${DUEL_STATE[e.status] || e.status})`;
      case 'ihk': {
        const q = questById[e.quest];
        const result = e.status === 'fertig' ? (e.success ? 'geschafft' : 'gescheitert') : 'läuft';
        return `In der IHK-Quest „${q ? q.title : e.quest}“ eingesetzt von ${name(e.who)} (${e.main ? 'Hauptkarte' : 'Boost'}, ${result})`;
      }
      case 'dungeon': {
        const d = dungeonByKey[e.dungeon];
        const result = e.status === 'fertig' ? (e.success ? 'Boss besiegt' : 'Rückzug') : 'läuft';
        return `Im Dungeon „${d ? d.title : e.dungeon}“ eingesetzt von ${name(e.who)} (${e.main ? 'Charakter' : 'Boost'}, ${result})`;
      }
      case 'folie':
        return `Foliert${e.grade !== null && e.grade !== undefined ? ` – Note ${e.grade}` : ''}`;
      case 'verkauft':
        return `${e.guess ? 'Vermutlich a' : 'A'}n die Bank verkauft von ${name(e.who)} für ${euro(e.amount)}` + (e.guess ? ' (erschlossen aus seinen Buchungen: eine Karte dieser Art verkauft)' : '');
      case 'entzogen':
        return `Vom Team aus der Sammlung von ${name(e.who)} entfernt (${e.by})`;
      case 'verschwunden':
        return `Nicht mehr vorhanden – zuletzt bei ${name(e.who)}, wie es endete, ist nicht gespeichert`;
      default:
        return e.type;
    }
  };
  const ICON = { entstanden: '✦', handel: '⇄', duell: '⚔', 'duell-einsatz': '⚔', ihk: '💼', dungeon: '🕸', folie: '✨', verkauft: '🏦', entzogen: '✖', verschwunden: '?' };
  const c = catalog.cardById[cardId];
  return {
    id: String(id),
    card: cardId,
    label: cardName(cardId),
    rarity: c ? c.rarity : null,
    value: bankValue(cardId),
    exists: !!copy,
    foiledAt: copy ? copy.foiledAt : null,
    owner: owner ? name(owner) : null,
    ownerSince,
    events: ordered.map((e) => ({ at: e.at, type: e.type, icon: ICON[e.type] || '•', text: text(e), from: e.from ? name(e.from) : null, to: e.to ? name(e.to) : null, held: e.heldMs !== null && e.heldMs !== undefined ? durationText(e.heldMs) : null, guess: !!e.guess, trade: e.trade || null })),
  };
}

/**
 * Exemplare suchen: Karten, deren Name zur Eingabe passt (höchstens SEARCH_CARDS), je Karte die heutigen Exemplare
 * mit Besitzer und die nicht mehr vorhandenen, die im Handel vorkamen.
 * Liefert [{ card, label, copies: [{ id, owner, createdAt, foiled }], gone: [{ id }] }].
 */
async function searchCopies(q) {
  const needle = String(q || '').trim().toLowerCase();
  if (needle.length < 2) return [];
  const cards = catalog.CARDS.filter((c) => c.name.toLowerCase().includes(needle) || c.id.includes(needle)).slice(0, SEARCH_CARDS);
  const out = [];
  for (const c of cards) {
    const [copies, traded] = await Promise.all([
      TcgCard.find({ card: c.id }).select('user createdAt foiledAt').sort({ createdAt: 1 }).limit(SEARCH_COPIES).lean(),
      Trade.aggregate([
        { $match: { status: 'verkauft', $or: [{ 'give.card': c.id }, { 'want.card': c.id }] } },
        { $project: { lines: { $concatArrays: [{ $ifNull: ['$give', []] }, { $ifNull: ['$want', []] }] } } },
        { $unwind: '$lines' },
        { $match: { 'lines.card': c.id, 'lines.doc': { $ne: null } } },
        { $group: { _id: '$lines.doc', n: { $sum: 1 } } },
        { $limit: SEARCH_COPIES },
      ]),
    ]);
    const names = await namesOf(copies.map((x) => x.user));
    const alive = new Set(copies.map((x) => String(x._id)));
    const tradedCount = new Map(traded.map((t) => [String(t._id), t.n]));
    out.push({
      card: c.id,
      label: cardName(c.id),
      copies: copies.map((x) => ({ id: String(x._id), owner: names.get(String(x.user)) || 'gelöschtes Konto', createdAt: x.createdAt, foiled: !!x.foiledAt, trades: tradedCount.get(String(x._id)) || 0 })),
      gone: traded.filter((t) => !alive.has(String(t._id))).map((t) => ({ id: String(t._id), trades: t.n })),
    });
  }
  return out;
}

module.exports = { historyOf, searchCopies, matchOrigin, timeline, durationText, ORIGIN_SLACK_MS };

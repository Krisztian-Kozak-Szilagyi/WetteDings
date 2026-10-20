// Kartenaufwertung (/tcg/aufwertung): 10 Karten verschmelzen – ähnlich wie der Trade-up-Vertrag in Counter-Strike, nur
// ist es Zufall, welche Karte herauskommt. Die Rechnung steht in public/js/aufwertung-regeln.js (auch im Browser).
//
// - Ziel: ein fairer Weg, die Sammlung zu vervollständigen, ohne viel Wert zu verlieren.
// - Ziel ist die Stufe über der seltensten eingesetzten Karte; Seltenheiten dürfen gemischt sein. Mit der Erfolgschance
//   kommt eine zufällige Karte des Ziels, sonst eine der seltensten eingesetzten Seltenheit (man geht nie leer aus).
//   Karten, die man noch nicht besitzt, kommen fehlend-fach so oft.
// - Wertausgleich (ausgleich %): ist die neue Karte weniger wert als ausgleich % des Einsatzes (Bankwert), gibt es die
//   Differenz als Spielgeld – höchstens (100 − ausgleich) % Verlust. Immer weniger, als die Bank für die eingesetzten
//   Karten zahlen würde: es kommt kein zusätzliches Geld ins Spiel. Karten mit ungebügeltem Knick (Bank: halber Preis)
//   spielen deshalb nicht mit.
// - Gemischt sinkt die Chance: jede Karte zählt nach ihrer Seltenheit in Packs (1 Gold + 9 BFWler → Holo ≈ 45 %).
// - Glückstreffer (bonus, in 1/100 %): eine Stufe über dem Ziel. Jackpot (jackpot, in 1/100 %): Glitch oder Icon.
// - Ohne seltene Karten zu entwerten: Im Mittel bekommt man höchstens rueckgabe % des Bankwerts der eingesetzten Karten
//   zurück (Karte + Ausgleich, Glückstreffer und Jackpot eingerechnet) – eine aufgewertete Karte ist also nie billiger zu
//   haben als ihr Wert. Darüber hinaus höchstens maxChance %. Mit den Standardwerten gelingt jede volle Stufe sicher, nur
//   Holo → Bockhaber nicht (10 Holo = 500 €, ein Bockhaber = 500 €). Prüfen: npm run sim:aufwertung
// - Stufen: die Pack-Seltenheiten von Crumpled bis Icon. Geheime Seltenheiten (Sith) und Boss-Karten (St. Ivan) kommen
//   nie heraus und lassen sich nicht einsetzen; Icon ist die oberste Stufe.
// - Eingesetzt werden nur freie Exemplare: nichts auf Quest, im Dungeon, Handel, Duell oder Grading, keine Folie/kein Slab.
const crypto = require('crypto');
const mongoose = require('mongoose');
const catalog = require('./catalog');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgCard } = require('../models/Tcg');
const { TcgUpgrade, UpgradeSettings } = require('../models/Upgrade');
const { lockedDocs, isLocked } = require('./locks');
const { inTransaction } = require('../services/betService');
const { UserError } = require('../lib/util');
const { logSettingsChange } = require('../stats/settingsLog');
const Regeln = require('../../public/js/aufwertung-regeln');
/** Ungebügelter Knick? (wie bei der Bank, src/tcg/tcgService.js – dort zahlt sie nur die Hälfte) */
const openCrease = (copy) => !!(copy && copy.creased && !copy.ironedAt);

// Standardwerte (Admin-Panel → Spielwerte → TCG). Prozentwerte als ganze Zahlen.
// bonus / jackpot in Hundertstel-Prozent: 9 = 0,09 %, 1 = 0,01 %; ausgleich = so viel % des Einsatzwerts kommen mindestens zurück
const DEFAULTS = { open: false, count: 10, rueckgabe: 90, ausgleich: 80, maxChance: 100, fehlend: 3, bonus: 9, jackpot: 1 };
const LIMITS = { count: [2, 30], rueckgabe: [0, 100], ausgleich: [0, 100], maxChance: [0, 100], fehlend: [1, 20], bonus: [0, 1000], jackpot: [0, 1000] };

let settings = { ...DEFAULTS };

/** Werte prüfen (alle Felder nötig); wirft UserError mit allen Fehlern */
function cleanSettings(s) {
  const out = { open: !!(s && s.open) };
  const errors = [];
  const label = { count: 'Karten je Aufwertung', rueckgabe: 'Höchstens zurück (% des Einsatzwerts)', maxChance: 'Höchste Erfolgschance (%)', fehlend: 'Fehlende Karten so oft', ausgleich: 'Mindestens zurück (% des Einsatzwerts)', bonus: 'Glückstreffer (0,01 %)', jackpot: 'Jackpot (0,01 %)' };
  for (const [k, [min, max]] of Object.entries(LIMITS)) {
    const v = s && s[k];
    if (!Number.isInteger(v) || v < min || v > max) errors.push(`${label[k]}: ${min} bis ${max}`);
    out[k] = v;
  }
  if (!errors.length && out.ausgleich > out.rueckgabe) errors.push('Mindestens zurück darf nicht über „Höchstens zurück“ liegen');
  if (errors.length) throw new UserError(errors.join(' · '));
  return out;
}

/** Gespeicherte Werte über die Standardwerte legen – ungültige fallen auf den Standard zurück */
function mergeSettings(doc) {
  try {
    return cleanSettings({ ...DEFAULTS, ...(doc || {}) });
  } catch {
    return { ...DEFAULTS };
  }
}

async function loadSettings() {
  const doc = await UpgradeSettings.findById('aufwertung').lean();
  settings = mergeSettings(doc && doc.values);
}

async function saveSettings({ admin, values }) {
  const clean = cleanSettings(values);
  const before = settings;
  await UpgradeSettings.updateOne({ _id: 'aufwertung' }, { $set: { values: clean, updatedByName: admin.username } }, { upsert: true });
  settings = clean;
  await logSettingsChange({ area: 'aufwertung', before, after: clean, by: admin });
  return clean;
}

/** Darf das Mitglied aufwerten? (solange nicht freigegeben, nur Admins) */
const mayUse = (user) => !!user && (settings.open || !!user.isAdmin);

// ---------- Regeln (rein, getestet) ----------

/** Stufen von häufig nach selten: die sichtbaren Pack-Seltenheiten (ohne geheime wie Sith, ohne Boss-Karten) */
const ladder = () => catalog.RARITIES.filter((r) => !r.hidden).map((r) => r.key);

/** Nächste Seltenheit – null, wenn es keine gibt (Icon) oder die Seltenheit nicht aufwertbar ist (Sith, Boss …) */
function nextRarity(rarity) {
  const l = ladder();
  const i = l.indexOf(rarity);
  return i >= 0 && i < l.length - 1 ? l[i + 1] : null;
}

/** Stufen für die Rechnung: { key, label, sell, weight } (Preise und Pack-Gewichte wie im Admin-Panel → TCG) */
const ladderDefs = () => ladder().map((k) => ({ key: k, label: catalog.rarityByKey[k].label, sell: catalog.rarityByKey[k].sell, weight: catalog.rarityByKey[k].weight }));

/** Vertrag auswerten: keys = Seltenheiten der eingesetzten Karten → Ausgänge (public/js/aufwertung-regeln.js) oder null */
const contract = (keys, s = settings) => Regeln.vertrag(keys, ladderDefs(), s);

/** Erfolgschance (0 … 1) für count Karten dieser einen Seltenheit (ohne Glückstreffer und Jackpot) */
function chanceFor(rarity, s = settings) {
  const v = contract(Array.from({ length: s.count }, () => rarity), s);
  return v ? v.chance : 0;
}

/** Karten, die herauskommen können: alle erhältlichen Karten der Seltenheit (CARDS: ohne Unveröffentlichte und Test-Karten) */
const poolOf = (rarity) => (ladder().includes(rarity) ? catalog.CARDS.filter((c) => c.rarity === rarity) : []);

/**
 * Zufällige Karte aus pool: Karten, die man nicht besitzt (owned: Set der Karten-IDs), wiegen fehlend-fach.
 * rand() → [0, 1). Gibt { card, missing } zurück.
 */
function pickCard(pool, owned, fehlend, rand) {
  const weight = (c) => (owned.has(c.id) ? 1 : fehlend);
  let r = rand() * pool.reduce((s, c) => s + weight(c), 0);
  for (const c of pool) {
    r -= weight(c);
    if (r < 0) return { card: c, missing: !owned.has(c.id) };
  }
  const last = pool[pool.length - 1];
  return { card: last, missing: !owned.has(last.id) };
}

/** Chancen je Karte für die Anzeige: [{ card, missing, p }] – p = Anteil innerhalb dieser Seltenheit */
function oddsOf(pool, owned, fehlend) {
  const weight = (c) => (owned.has(c.id) ? 1 : fehlend);
  const total = pool.reduce((s, c) => s + weight(c), 0);
  return pool.map((c) => ({ card: c, missing: !owned.has(c.id), p: total ? weight(c) / total : 0 }));
}

/** Zufall aus dem Betriebssystem (fair, nicht vorhersagbar) */
const secureRand = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;

// ---------- Datenbank ----------

/** Karten-IDs, die das Mitglied gerade besitzt (zählt für „fehlt noch“) */
const ownedIds = async (userId, session) => new Set(await TcgCard.distinct('card', { user: userId }).session(session || null));

/**
 * Freie Exemplare je aufwertbarer Seltenheit für die Auswahl: { rarity: [{ card, docs: [Exemplar-IDs], dupes }] }.
 * Frei = keine Folie/kein Slab, nicht gesperrt. dupes = so viele davon sind Duplikate (eins bleibt, wie beim Verkauf).
 */
async function choices(userId) {
  // Icon ist die oberste Stufe; Karten mit ungebügeltem Knick spielen nicht mit (Bank: halber Preis)
  const docs = await TcgCard.find({ user: userId, foiledAt: null, rarity: { $in: ladder().filter((r) => nextRarity(r)) } }).select('_id card rarity creased ironedAt createdAt').sort({ createdAt: 1 }).lean();
  const locked = await lockedDocs(userId);
  const byCard = new Map();
  const total = new Map(); // alle Exemplare der Karte (auch gesperrte): eins bleibt beim Auffüllen
  for (const d of docs) {
    total.set(d.card, (total.get(d.card) || 0) + 1);
    if (isLocked(locked, d) || !catalog.cardById[d.card] || openCrease(d)) continue;
    if (!byCard.has(d.card)) byCard.set(d.card, { card: d.card, rarity: d.rarity, docs: [] });
    byCard.get(d.card).docs.push(String(d._id));
  }
  const out = {};
  for (const e of byCard.values()) {
    e.dupes = Math.min(e.docs.length, total.get(e.card) - 1);
    (out[e.rarity] = out[e.rarity] || []).push(e);
  }
  return out;
}

/**
 * Aufwerten: docIds = genau settings.count Exemplare (Seltenheiten gemischt erlaubt, siehe oben). Alles in einer Transaktion: Exemplare weg,
 * neue Karte dazu, Eintrag im Verlauf und im Kontoauszug (0 €, für die Kartenhistorie).
 * rand: nur für Tests. Gibt { success, chance, rarity, target, card, missing, upgrade } zurück.
 */
async function upgrade({ user, docIds, rand = secureRand }) {
  if (!mayUse(user)) throw new UserError('Die Kartenaufwertung ist derzeit nicht verfügbar.');
  const ids = [...new Set((Array.isArray(docIds) ? docIds : []).map(String))];
  if (ids.length !== settings.count || !ids.every((id) => mongoose.isValidObjectId(id))) throw new UserError(`Wähle genau ${settings.count} Karten derselben Seltenheit.`);
  return inTransaction(async (session) => {
    const docs = await TcgCard.find({ _id: { $in: ids }, user: user._id }).select('_id card rarity foiledAt creased ironedAt').session(session).lean();
    if (docs.length !== ids.length) throw new UserError('Einige dieser Karten besitzt du nicht mehr. Bitte lade die Seite neu.');
    const keys = docs.map((d) => d.rarity);
    const odd = docs.find((d) => !ladder().includes(d.rarity));
    if (odd) throw new UserError(`${(catalog.rarityByKey[odd.rarity] || {}).label || 'Diese'}-Karten lassen sich nicht aufwerten.`);
    const v = contract(keys);
    if (!v) throw new UserError(`Mit ${catalog.rarityByKey[ladder()[ladder().length - 1]].label}-Karten geht es nicht höher – nimm sie aus dem Vertrag.`);
    if (docs.some((d) => d.foiledAt)) throw new UserError('Karten im Sleeve oder Slab lassen sich nicht aufwerten.');
    if (docs.some(openCrease)) throw new UserError('Karten mit Knick lassen sich erst nach dem Bügeln aufwerten.');
    const locked = await lockedDocs(user._id, session);
    if (docs.some((d) => isLocked(locked, d))) throw new UserError('Eine der Karten ist gerade auf einer Quest, im Dungeon, im Handel, im Duell oder beim Grading.');

    const roll = Regeln.wurf(keys, v, rand);
    const success = roll.kind !== 'fehlschlag';
    const pool = poolOf(roll.rarity);
    if (!pool.length) throw new UserError('Für diese Seltenheit gibt es gerade keine Karten.');
    // „Fehlt noch“: nach dem Einsatz (eingesetzte Karten, von denen man kein weiteres Exemplar hat, fehlen danach)
    const del = await TcgCard.deleteMany({ _id: { $in: docs.map((d) => d._id) }, user: user._id }, { session });
    if (del.deletedCount !== docs.length) throw new UserError('Dein Bestand hat sich geändert. Bitte versuche es erneut.');
    const owned = await ownedIds(user._id, session);
    const { card, missing } = pickCard(pool, owned, settings.fehlend, rand);

    const upgradeId = new mongoose.Types.ObjectId();
    const [copy] = await TcgCard.create([{ user: user._id, card: card.id, rarity: card.rarity, upgrade: upgradeId }], { session });
    await TcgUpgrade.create(
      [{ _id: upgradeId, user: user._id, username: user.username, rarity: v.top, target: v.target, chance: v.chance, success, kind: roll.kind, value: v.value, payout: Regeln.ausgleich(v, catalog.rarityByKey[card.rarity].sell), inputs: docs.map((d) => ({ doc: d._id, card: d.card, rarity: d.rarity })), result: { doc: copy._id, card: card.id, rarity: card.rarity, missing } }],
      { session }
    );
    const byCard = new Map();
    for (const d of docs) byCard.set(d.card, { card: d.card, rarity: d.rarity, count: ((byCard.get(d.card) || {}).count || 0) + 1 });
    // Wertausgleich: Differenz zu ausgleich % des Einsatzwerts als Spielgeld (Bankwert der neuen Karte)
    const payout = Regeln.ausgleich(v, card.rarity && catalog.rarityByKey[card.rarity] ? catalog.rarityByKey[card.rarity].sell : 0);
    if (payout > 0) await User.updateOne({ _id: user._id }, { $inc: { balance: payout } }, { session });
    await Ledger.create([{ user: user._id, type: 'tcg_aufwertung', amount: payout, meta: { cards: [...byCard.values()], docs: docs.map((d) => ({ doc: d._id, card: d.card })), result: { doc: copy._id, card: card.id, rarity: card.rarity }, success, kind: roll.kind, value: v.value, payout } }], { session });
    await User.updateOne({ _id: user._id }, { $addToSet: { tcgSeen: card.id } }, { session });
    return { success, kind: roll.kind, chance: v.chance, contract: v, inputs: keys, rarity: v.top, target: v.target, card, missing, payout, upgrade: upgradeId };
  });
}

/** Letzte Aufwertungen des Mitglieds (Verlauf auf der Seite) */
const history = (userId, limit = 10) => TcgUpgrade.find({ user: userId }).sort({ createdAt: -1 }).limit(limit).lean();

module.exports = {
  DEFAULTS,
  LIMITS,
  get settings() {
    return settings;
  },
  cleanSettings,
  mergeSettings,
  loadSettings,
  saveSettings,
  mayUse,
  ladder,
  ladderDefs,
  contract,
  nextRarity,
  chanceFor,
  poolOf,
  pickCard,
  oddsOf,
  ownedIds,
  choices,
  upgrade,
  history,
};

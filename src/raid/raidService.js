// Raid gegen Lucky Dio: Kampf beginnen, Züge ausführen, Ende und Belohnung. Regeln und Einstellungen: src/raid/logic.js.
// Der Server hält jeden Kampf als geheimen Startwert + Liste der Züge (models/Raid) und spielt ihn bei jedem Zug nach.
// Nur angenommene Züge werden gespeichert; was der Browser sieht, kommt aus logic.publicState.
const crypto = require('crypto');
const config = require('../config');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgCard } = require('../models/Tcg');
const { RaidRun, RaidSettings } = require('../models/Raid');
const { inTransaction } = require('../services/betService');
const { notify } = require('../services/notifyService');
const deckService = require('../game/deckService');
const { expand } = require('../game/deck');
const catalog = require('../tcg/catalog');
const { toZonedLocalInput } = require('../lib/time');
const { UserError } = require('../lib/util');
const { logSettingsChange } = require('../stats/settingsLog');
const logic = require('./logic');

const DIO = 'lucky-dio-boss';
const MIN_CARDS = 10; // so viele im Raid spielbare Karten braucht ein Deck mindestens
const HISTORY = 10;

const settings = JSON.parse(JSON.stringify(logic.DEFAULTS));

async function loadSettings() {
  const doc = await RaidSettings.findById('raid').lean();
  Object.assign(settings, logic.mergeSettings(doc && doc.values));
}

async function saveSettings({ values, admin }) {
  let clean;
  try {
    clean = logic.cleanSettings(values);
  } catch (err) {
    if (err.invalid) throw new UserError(`Ungültige Werte: ${err.message}`);
    throw err;
  }
  await RaidSettings.updateOne({ _id: 'raid' }, { $set: { values: clean, updatedByName: admin.username } }, { upsert: true });
  const before = JSON.parse(JSON.stringify(settings));
  Object.assign(settings, clean);
  await logSettingsChange({ area: 'raid', before, after: settings, by: admin });
}

/** Darf das Mitglied in den Raid? (Solange nicht freigegeben, nur Admins) */
const mayPlay = (user) => !!user && (settings.open || !!user.isAdmin);
const today = () => toZonedLocalInput(new Date(), config.timezone).slice(0, 10);

/** Versuche heute: { used, left, limit } */
async function tries(userId) {
  const used = await RaidRun.countDocuments({ user: userId, day: today() });
  return { used, left: Math.max(0, settings.triesPerDay - used), limit: settings.triesPerDay };
}

/**
 * Das zuletzt geänderte Deck des Mitglieds und was davon im Raid spielt.
 * { deck, ids, cards, playable, problem } – problem: Grund, warum es (noch) nicht geht
 */
async function deckFor(userId) {
  const { decks } = await deckService.overview(userId);
  const deck = decks.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0] || null;
  if (!deck) return { deck: null, ids: [], cards: [], playable: false, problem: 'Du hast noch kein Deck.' };
  const ids = expand(deck.cards);
  const cards = logic.deckCards(ids, settings);
  let problem = null;
  if (deck.check.missing.length) problem = 'In deinem Deck sind Karten, die du nicht mehr besitzt.';
  else if (deck.check.errors.length) problem = 'Dein Deck verstößt gegen die Deckregeln (z. B. Boss-Karten und Items nur einmal).';
  else if (!deck.check.complete) problem = `Dein Deck braucht genau 30 Karten (gerade ${deck.check.size}).`;
  else if (cards.length < MIN_CARDS) problem = `Im Raid spielen nur Charakterkarten – in deinem Deck sind nur ${cards.length}, nötig sind mindestens ${MIN_CARDS}.`;
  return { deck, ids, cards, playable: !problem, problem };
}

const running = (userId) => RaidRun.findOne({ user: userId, status: 'laeuft' }).select('+seed +snap +actions');

/** Laufenden Kampf nachspielen: { run, s } (oder null) */
async function current(userId) {
  const run = await running(userId);
  if (!run) return null;
  const { s } = logic.replay(run.seed, run.snap, run.actions);
  return { run, s };
}

/** Kampf beginnen: kostet einen Versuch des Tages */
async function start({ user }) {
  if (!mayPlay(user)) throw new UserError('Der Raid ist derzeit nicht verfügbar.');
  if (await RaidRun.exists({ user: user._id, status: 'laeuft' })) throw new UserError('Du kämpfst schon gegen Lucky Dio.');
  const t = await tries(user._id);
  if (!t.left) throw new UserError(`Für heute hast du alle ${t.limit} Versuche gebraucht. Morgen geht es weiter!`);
  const d = await deckFor(user._id);
  if (!d.playable) throw new UserError(d.problem);
  const snap = { spieler: logic.spielerDef(settings), boss: logic.bossDef(settings), karten: d.cards, maxRounds: settings.maxRounds };
  const seed = crypto.randomInt(2 ** 31);
  const { s } = logic.replay(seed, snap, []);
  try {
    return await RaidRun.create({ user: user._id, username: user.username, day: today(), seed, snap, deckSize: d.cards.length, runde: s.runde, bossHp: s.boss.hp, bossMax: s.boss.max });
  } catch (err) {
    if (err.code === 11000) throw new UserError('Du kämpfst schon gegen Lucky Dio.');
    throw err;
  }
}

/**
 * Ein Zug. action: { a: 'spielen', uid, ziel, x, y } | { a: 'einsetzen', uid } | { a: 'ende' } (x/y: Platz auf dem Spielfeld, 0–100)
 * Gibt { ev, state, ende } zurück; ende = { sieg, reward } sobald der Kampf vorbei ist.
 */
async function act({ user, action }) {
  const cur = await current(user._id);
  if (!cur) throw new UserError('Du kämpfst gerade nicht gegen Lucky Dio.');
  const { run, s } = cur;
  const ev = logic.applyAction(s, action);
  if (!logic.accepted(ev)) return { ev, state: logic.publicState(s), ende: null };
  // Zu lange gekämpft: Dio entkommt mit der Beute
  const maxRounds = run.snap.maxRounds || settings.maxRounds;
  if (!s.vorbei && s.runde > maxRounds) {
    s.vorbei = 'niederlage';
    ev.push({ t: 'info', wo: 'boss', text: 'Lucky Dio verschwindet im Rauch …' }, { t: 'ende', sieg: false, flucht: true });
  }
  const saved = await RaidRun.updateOne(
    { _id: run._id, status: 'laeuft', actions: { $size: run.actions.length } },
    { $push: { actions: clean(action) }, $set: { runde: s.runde, bossHp: s.boss.hp } }
  );
  if (!saved.modifiedCount) throw new UserError('Dieser Zug kam doppelt an – die Seite wird neu geladen.');
  const ende = s.vorbei ? await finish(run, s) : null;
  return { ev, state: logic.publicState(s), ende };
}

/** Nur die bekannten Felder eines Zugs speichern */
const clean = (a) => ({ a: String(a.a), ...(a.uid != null ? { uid: Number(a.uid) } : {}), ...(a.ziel != null ? { ziel: Number(a.ziel) } : {}), ...(a.x != null ? { x: Number(a.x), y: Number(a.y) } : {}) });

/** Kampf beenden: Status, bei Sieg Spielgeld und mit etwas Glück Lucky Dio */
async function finish(run, s) {
  const sieg = s.vorbei === 'sieg';
  const reward = { geld: sieg ? settings.belohnung.geld : 0, dio: sieg && crypto.randomInt(10000) < settings.belohnung.dioChance * 100 };
  const card = catalog.cardById[DIO];
  await inTransaction(async (session) => {
    const done = await RaidRun.updateOne({ _id: run._id, status: 'laeuft' }, { $set: { status: sieg ? 'sieg' : 'niederlage', endedAt: new Date(), reward } }, { session });
    if (!done.modifiedCount) return; // schon beendet (doppelter Aufruf)
    if (reward.geld) {
      await User.updateOne({ _id: run.user }, { $inc: { balance: reward.geld } }, { session });
      await Ledger.create([{ user: run.user, type: 'raid_lohn', amount: reward.geld, meta: { raid: run._id } }], { session });
    }
    if (reward.dio && card) {
      await TcgCard.create([{ user: run.user, card: card.id, rarity: card.rarity }], { session });
      await User.updateOne({ _id: run.user }, { $addToSet: { tcgSeen: card.id } }, { session });
    }
  });
  if (reward.dio && card) await notify(run.user, { area: 'Raid', href: '/tcg/album', text: `Du hast Lucky Dio besiegt – und er hat seine Karte fallen lassen: „${card.name}“ ist jetzt in deinem Album!` });
  return { sieg, reward };
}

/** Kampf aufgeben (zählt als Niederlage) */
async function abandon({ user }) {
  const r = await RaidRun.updateOne({ user: user._id, status: 'laeuft' }, { $set: { status: 'aufgegeben', endedAt: new Date() } });
  if (!r.modifiedCount) throw new UserError('Du kämpfst gerade nicht gegen Lucky Dio.');
}

/** Letzte Kämpfe des Mitglieds */
const history = (userId) => RaidRun.find({ user: userId, status: { $ne: 'laeuft' } }).sort({ createdAt: -1 }).limit(HISTORY).lean();

/** Wer hat Lucky Dio schon erbeutet (für die Raid-Seite) */
const dioWinners = () => RaidRun.find({ 'reward.dio': true }).sort({ endedAt: -1 }).limit(10).select('username endedAt').lean();

module.exports = { DIO, MIN_CARDS, settings, loadSettings, saveSettings, mayPlay, tries, deckFor, current, start, act, finish, abandon, history, dioWinners };

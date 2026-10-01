const crypto = require('crypto');
const config = require('../config');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgCard } = require('../models/Tcg');
const { IhkRun, IhkState, IhkSettings } = require('../models/Ihk');
const { inTransaction } = require('../services/betService');
const { toZonedLocalInput } = require('../lib/time');
const { UserError } = require('../lib/util');
const catalog = require('../tcg/catalog');
const { QUESTS, DIFFICULTIES, questById, difficulty } = require('./quests');
const { resolve, canBoost, needsCoffee, isCoffee } = require('./abilities');
const { lockedDocs, isLocked } = require('../tcg/locks');

const WORK_TIME = 180; // "Arbeitszeit" einer Quest (Spiel-Sekunden)
// Anzahl Arbeitstakte = 10 + Speed/10 (Speed 10 → 11, 35 → 13,5, 99 → 19,9). Speed hilft also,
// entscheidend bleibt aber die passende Fähigkeit – schnelle Karten mit falschem Stat kommen nicht weit.
const tickCount = (speed) => 10 + Math.max(0, speed) / 10;
const CRIT_CHANCE = 0.1;
const OFFER_COUNT = 3;

// ---------- Einstellungen (Admin) ----------
// open = für alle Mitglieder spielbar (sonst nur Admins)
// required = Ziel-Punkte je Schwierigkeit (1–6)
// durations = Wartezeit in Minuten je Schwierigkeit (1–6)
const DEFAULTS = { open: false, dailyLimit: 5, durations: [10, 10, 10, 10, 10, 10], rewards: [1500, 2500, 4000, 6000, 10000, 15000], required: DIFFICULTIES.map((d) => d.required) };
const settings = { ...DEFAULTS, durations: [...DEFAULTS.durations], rewards: [...DEFAULTS.rewards], required: [...DEFAULTS.required] };
const validList = (list, min) => Array.isArray(list) && list.length === 6 && list.every((r) => Number.isInteger(r) && r >= min);

/** Ziel-Punkte einer Schwierigkeit (aktuelle Einstellung) */
const requiredFor = (level) => settings.required[level - 1];
/** Wartezeit (Minuten) einer Schwierigkeit */
const durationFor = (level) => settings.durations[level - 1];

async function loadSettings() {
  const doc = await IhkSettings.findById('ihk').lean();
  if (!doc) return;
  if (typeof doc.open === 'boolean') settings.open = doc.open;
  if (Number.isInteger(doc.dailyLimit) && doc.dailyLimit >= 0) settings.dailyLimit = doc.dailyLimit;
  if (validList(doc.durations, 0)) settings.durations = doc.durations;
  else if (Number.isInteger(doc.durationMin) && doc.durationMin >= 0) settings.durations = Array(6).fill(doc.durationMin); // alte Einstellung
  if (validList(doc.rewards, 0)) settings.rewards = doc.rewards;
  if (validList(doc.required, 1)) settings.required = doc.required;
}

async function saveSettings({ open, dailyLimit, durations, rewards, required, admin }) {
  await IhkSettings.updateOne({ _id: 'ihk' }, { $set: { open, dailyLimit, durations, rewards, required, updatedByName: admin.username } }, { upsert: true });
  Object.assign(settings, { open, dailyLimit, durations, rewards, required });
}

// ---------- Simulation ----------
/**
 * Würfelt eine Quest aus: Innerhalb von WORK_TIME gibt es tickCount(Speed) gleichmäßig verteilte Takte,
 * pro Takt sammelt die Karte ihren Stat (×0,8–1,2, mit CRIT_CHANCE doppelt). Geschafft, wenn required erreicht ist.
 */
function simulate(stats, stat, required, rand = () => crypto.randomInt(1000000) / 1000000, effects = []) {
  const s = { speed: stats.speed, stats: { fia: stats.fia, fis: stats.fis, bwl: stats.bwl }, extraTicks: 0, extraTime: 0, elapsed: 0, fakeNext: false, tempSpeed: null, doom: null };
  const half = WORK_TIME / 2;
  const interval = () => WORK_TIME / tickCount(s.speed * (s.tempSpeed ? s.tempSpeed.factor : 1));
  const ticks = [];
  let applied = effects.length === 0;
  let limit = WORK_TIME;
  let freeze = 0; // Sekunden, in denen die Deadline steht (Bloodlust)
  let total = 0;
  let t = 0;
  while (total < required) {
    let next = t + interval();
    if (!applied && next > half) {
      // Halbzeit: Fähigkeiten aktivieren
      s.elapsed = half; // bisher abgelaufene Deadline (für Sigrist)
      effects.forEach((e) => e.apply(s));
      applied = true;
      ticks.push({ t: half, p: 0, ability: true });
      if (s.extraTicks || s.extraTime) {
        // Bloodlust: ganze Runden; Reality Check: Sekunden
        freeze = s.extraTicks * interval() + s.extraTime;
        limit += freeze;
      }
      next = Math.max(half, t + interval());
    }
    if (next > limit + 1e-9) break;
    const fake = s.fakeNext;
    const crit = rand() < CRIT_CHANCE;
    const base = fake ? 99 : s.stats[stat];
    // Hermann: Solange die Aufgabe gestärkt ist, bringt jede Runde entsprechend weniger Punkte
    const p = Math.max(1, Math.round((base * (0.8 + 0.4 * rand()) * (crit ? 2 : 1)) / (s.doom ? s.doom.factor : 1)));
    s.fakeNext = false;
    if (s.tempSpeed && --s.tempSpeed.ticks <= 0) {
      const { then } = s.tempSpeed;
      s.tempSpeed = null;
      if (then) then(s); // z. B. Mauch: nach dem Gruschteln sind alle Werte höher
    }
    total += p;
    ticks.push({ t: Math.round(next * 10) / 10, p, crit, ...(fake ? { fake: true } : {}) });
    t = next;
    if (s.doom && --s.doom.ticks <= 0) {
      // Nach der zweiten Runde ist die Aufgabe zerstört: der Rest des Ziels fällt auf einen Schlag
      s.doom = null;
      if (total < required) {
        ticks.push({ t: Math.round(t * 10) / 10, p: required - total, destroy: true });
        total = required;
      }
    }
  }
  return { ticks, total, success: total >= required, freeze: Math.round(freeze * 10) / 10 };
}

// ---------- Angebote ----------
const today = () => toZonedLocalInput(new Date(), config.timezone).slice(0, 10);

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Drei zufällige Quests mit zufälligen, unterschiedlichen Schwierigkeiten (1–6) */
function generateOffers() {
  const quests = shuffle(QUESTS).slice(0, OFFER_COUNT);
  const levels = shuffle(DIFFICULTIES.map((d) => d.level)).slice(0, quests.length);
  return quests.map((q, i) => ({ quest: q.id, difficulty: levels[i] }));
}

const validOffers = (offers) => Array.isArray(offers) && offers.length > 0 && offers.every((o) => questById[o.quest] && difficulty(o.difficulty));

/** Angebotene Quests des Nutzers (werden bei Bedarf neu ausgewürfelt) */
async function getOffers(userId) {
  const st = await IhkState.findById(userId).lean();
  if (st && validOffers(st.offers)) return st.offers;
  const offers = generateOffers();
  await IhkState.updateOne({ _id: userId }, { $set: { offers } }, { upsert: true });
  return offers;
}

// ---------- Ablauf ----------
/** Laufende Quest (oder null) und Tagesverbrauch */
async function getState(userId) {
  const [running, used] = await Promise.all([
    IhkRun.findOne({ user: userId, status: 'laeuft' }).lean(),
    IhkRun.countDocuments({ user: userId, day: today() }),
  ]);
  return { running, used, limit: settings.dailyLimit };
}

async function start({ user, cardId, boostId, offerIndex }) {
  const card = catalog.cardById[cardId];
  if (!card || !card.isCharacter) throw new UserError('Bitte wähle eine Charakterkarte aus.');
  const boost = boostId ? catalog.cardById[boostId] : null;
  if (boostId && !boost) throw new UserError('Unbekannte Boost-Karte.');
  if (boost && boost.id === card.id) throw new UserError('Die Boost-Karte muss eine andere Karte sein.');
  if (boost && !canBoost(boost)) throw new UserError('Diese Karte hat im Boost-Slot keine Wirkung.');
  if (boost && needsCoffee(boost)) {
    const owned = await TcgCard.distinct('card', { user: user._id });
    if (!owned.some((id) => isCoffee(catalog.cardById[id]))) throw new UserError(`${boost.name} kann nur ausgespielt werden, wenn du eine Kaffee-Karte besitzt.`);
  }
  const { running, used, limit } = await getState(user._id);
  if (running) throw new UserError('Du hast bereits eine laufende Quest.');
  if (used >= limit) throw new UserError(`Du hast heute schon alle ${limit} Quests erledigt. Morgen geht es weiter!`);

  const offers = await getOffers(user._id);
  const offer = offers[offerIndex];
  if (!offer) throw new UserError('Bitte wähle eine Quest aus.');

  // Nur freie Exemplare (nicht im Handel) können auf eine Quest
  const locked = await lockedDocs(user._id);
  const freeDoc = async (id) => (await TcgCard.find({ user: user._id, card: id }).sort({ createdAt: -1 }).select('_id').lean()).find((d) => !isLocked(locked, d));
  const doc = await freeDoc(cardId);
  if (!doc) throw new UserError('Diese Karte besitzt du nicht (oder sie ist gerade im Handel).');
  const boostDoc = boost ? await freeDoc(boost.id) : null;
  if (boost && !boostDoc) throw new UserError('Die Boost-Karte besitzt du nicht (oder sie ist gerade im Handel).');

  const quest = questById[offer.quest];
  const required = requiredFor(offer.difficulty);
  const effects = resolve(card, boost);
  const result = simulate(card.stats, quest.stat, required, undefined, effects);
  try {
    return await IhkRun.create({
      user: user._id,
      quest: quest.id,
      difficulty: offer.difficulty,
      required,
      card: cardId,
      cardDoc: doc._id,
      boost: boost ? boost.id : null,
      boostDoc: boostDoc ? boostDoc._id : null,
      // nur Fähigkeiten, die vor Erreichen des Ziels (Halbzeit) wirklich aktiv wurden
      abilities: result.ticks.some((x) => x.ability) ? effects.map(({ apply, ...a }) => a) : [],
      stats: card.stats,
      day: today(),
      endsAt: new Date(Date.now() + durationFor(offer.difficulty) * 60000),
      ...result,
      reward: result.success ? settings.rewards[offer.difficulty - 1] : 0,
    });
  } catch (err) {
    if (err.code === 11000) throw new UserError('Du hast bereits eine laufende Quest.');
    throw err;
  }
}

/** Nach Ablauf: Belohnung gutschreiben, Karte freigeben, neue Quests anbieten */
async function collect({ user }) {
  const result = await inTransaction(async (session) => {
    const run = await IhkRun.findOneAndUpdate(
      { user: user._id, status: 'laeuft', endsAt: { $lte: new Date() } },
      { $set: { status: 'fertig', collectedAt: new Date() } },
      { new: true, session }
    );
    if (!run) throw new UserError('Es gibt keine abgeschlossene Quest zum Abholen.');
    if (run.reward > 0) {
      await User.updateOne({ _id: user._id }, { $inc: { balance: run.reward } }, { session });
      await Ledger.create([{ user: user._id, type: 'ihk_lohn', amount: run.reward, betTitle: questById[run.quest] ? questById[run.quest].title : null }], { session });
    }
    return run;
  });
  await IhkState.updateOne({ _id: user._id }, { $set: { offers: generateOffers() } }, { upsert: true });
  return result;
}

module.exports = { WORK_TIME, settings, requiredFor, durationFor, loadSettings, saveSettings, simulate, generateOffers, getOffers, getState, start, collect };

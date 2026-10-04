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
const tcgService = require('../tcg/tcgService');
const { QUESTS, DIFFICULTIES, questById, difficulty, statsOf, isHybrid } = require('./quests');
const { resolveAll, who, canBoost, needsCoffee, isCoffee } = require('./abilities');
const { lockedDocs, isLocked, claim } = require('../tcg/locks');
const { logSettingsChange } = require('../stats/settingsLog');

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
// packChances = Chance in % auf ein Booster Pack pro geschaffter Quest, je Schwierigkeit (1–6)
// hybrid = eigene Werte (required, durations, rewards, packChances) für Hybrid-Quests
const DEFAULTS = { open: false, dailyLimit: 5, durations: [10, 10, 10, 10, 10, 10], rewards: [1500, 2500, 4000, 6000, 10000, 15000], required: DIFFICULTIES.map((d) => d.required), packChances: [5, 5, 5, 5, 5, 5] };
const table = (t) => ({ durations: [...t.durations], rewards: [...t.rewards], required: [...t.required], packChances: [...t.packChances] });
const settings = { open: DEFAULTS.open, dailyLimit: DEFAULTS.dailyLimit, ...table(DEFAULTS), hybrid: table(DEFAULTS) };
const validList = (list, min) => Array.isArray(list) && list.length === 6 && list.every((r) => Number.isInteger(r) && r >= min);
const validChances = (list) => Array.isArray(list) && list.length === 6 && list.every((c) => Number.isFinite(c) && c >= 0 && c <= 100);

/** Wertetabelle einer Quest: Hybrid-Quests haben eigene Einstellungen */
const tableFor = (quest) => (quest && isHybrid(quest) ? settings.hybrid : settings);
/** Ziel-Punkte einer Schwierigkeit (aktuelle Einstellung) */
const requiredFor = (level, quest) => tableFor(quest).required[level - 1];
/** Wartezeit (Minuten) einer Schwierigkeit */
const durationFor = (level, quest) => tableFor(quest).durations[level - 1];
/** Lohn (Cent) einer Schwierigkeit */
const rewardFor = (level, quest) => tableFor(quest).rewards[level - 1];
/** Chance (%) auf ein Booster Pack bei geschaffter Quest */
const packChanceFor = (level, quest) => tableFor(quest).packChances[level - 1];

async function loadSettings() {
  const doc = await IhkSettings.findById('ihk').lean();
  if (!doc) return;
  if (typeof doc.open === 'boolean') settings.open = doc.open;
  if (Number.isInteger(doc.dailyLimit) && doc.dailyLimit >= 0) settings.dailyLimit = doc.dailyLimit;
  if (validList(doc.durations, 0)) settings.durations = doc.durations;
  else if (Number.isInteger(doc.durationMin) && doc.durationMin >= 0) settings.durations = Array(6).fill(doc.durationMin); // alte Einstellung
  if (validList(doc.rewards, 0)) settings.rewards = doc.rewards;
  if (validList(doc.required, 1)) settings.required = doc.required;
  if (validChances(doc.packChances)) settings.packChances = doc.packChances;
  else if (validChances(Array(6).fill(doc.packChance))) settings.packChances = Array(6).fill(doc.packChance); // alte Einstellung: eine Chance für alle
  // Hybrid-Quests: noch nie gespeichert → gleiche Werte wie die normalen Quests
  const h = doc.hybrid || {};
  settings.hybrid = {
    durations: validList(h.durations, 0) ? h.durations : [...settings.durations],
    rewards: validList(h.rewards, 0) ? h.rewards : [...settings.rewards],
    required: validList(h.required, 1) ? h.required : [...settings.required],
    packChances: validChances(h.packChances) ? h.packChances : [...settings.packChances],
  };
}

async function saveSettings({ open, dailyLimit, durations, rewards, required, packChances, hybrid, admin }) {
  await IhkSettings.updateOne({ _id: 'ihk' }, { $set: { open, dailyLimit, durations, rewards, required, packChances, hybrid, updatedByName: admin.username } }, { upsert: true });
  const before = JSON.parse(JSON.stringify(settings));
  Object.assign(settings, { open, dailyLimit, durations, rewards, required, packChances, hybrid });
  await logSettingsChange({ area: 'ihk', before, after: settings, by: admin });
}

// ---------- Simulation ----------
/**
 * Würfelt eine Quest aus: Innerhalb von WORK_TIME gibt es tickCount(Speed) gleichmäßig verteilte Takte,
 * pro Takt sammelt die Karte ihren Stat (×0,8–1,2, mit CRIT_CHANCE doppelt). Geschafft, wenn required erreicht ist.
 * stat: 'fia' | 'fis' | 'bwl' oder ein Array mit zwei davon (Hybrid-Quest). Eine Hybrid-Quest hat zwei
 * Fortschrittsbalken – je Fähigkeit einen, jeder braucht required Punkte – und ist erst geschafft, wenn beide voll sind.
 * Ergebnis: ticks mit p (erster Balken) und p2 (zweiter Balken, nur bei Hybrid), total und total2.
 */
function simulate(stats, stat, required, rand = () => crypto.randomInt(1000000) / 1000000, effects = []) {
  const s = { speed: stats.speed, stats: { fia: stats.fia, fis: stats.fis, bwl: stats.bwl }, extraTicks: 0, extraTime: 0, elapsed: 0, fakeNext: false, tempSpeed: null, doom: null };
  const half = WORK_TIME / 2;
  const interval = () => WORK_TIME / tickCount(s.speed * (s.tempSpeed ? s.tempSpeed.factor : 1));
  const keys = [].concat(stat);
  const hybrid = keys.length > 1;
  const totals = keys.map(() => 0);
  const open = () => totals.some((x) => x < required);
  const ticks = [];
  let applied = effects.length === 0;
  let limit = WORK_TIME;
  let freeze = 0; // Sekunden, in denen die Deadline steht (Bloodlust)
  let t = 0;
  // Angezeigte Werte der Karte [Speed, FIA, FIS, BWL]: ändern sie sich (Boost, Debuff, Ende eines Effekts),
  // trägt der Takt sie als st – der Browser schreibt sie dann auf die Karte (src/tcg/cardSvg.js).
  const shown = () => [s.speed * (s.tempSpeed ? s.tempSpeed.factor : 1), s.stats.fia, s.stats.fis, s.stats.bwl].map((v) => Math.round(v));
  let lastShown = shown().join();
  const withShown = (tick) => {
    const now = shown();
    if (now.join() === lastShown) return tick;
    lastShown = now.join();
    return { ...tick, st: now };
  };
  while (open()) {
    let next = t + interval();
    if (!applied && next > half) {
      // Halbzeit: Fähigkeiten aktivieren
      s.elapsed = half; // bisher abgelaufene Deadline (für Sigrist)
      effects.forEach((e) => e.apply(s));
      applied = true;
      ticks.push(withShown({ t: half, p: 0, ability: true }));
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
    // ein Wurf pro Runde – bei Hybrid-Quests gilt er für beide Balken
    // Hermann: Solange die Aufgabe gestärkt ist, bringt jede Runde entsprechend weniger Punkte
    const factor = ((0.8 + 0.4 * rand()) * (crit ? 2 : 1)) / (s.doom ? s.doom.factor : 1);
    const ps = keys.map((k) => Math.max(1, Math.round((fake ? 99 : s.stats[k]) * factor)));
    s.fakeNext = false;
    if (s.tempSpeed && --s.tempSpeed.ticks <= 0) {
      const { then } = s.tempSpeed;
      s.tempSpeed = null;
      if (then) then(s); // z. B. Mauch: nach dem Gruschteln sind alle Werte höher
    }
    ps.forEach((p, i) => {
      totals[i] += p;
    });
    ticks.push(withShown({ t: Math.round(next * 10) / 10, p: ps[0], ...(hybrid ? { p2: ps[1] } : {}), crit, ...(fake ? { fake: true } : {}) }));
    t = next;
    if (s.doom && --s.doom.ticks <= 0) {
      // Nach der zweiten Runde ist die Aufgabe zerstört: der Rest des Ziels fällt auf einen Schlag
      s.doom = null;
      if (open()) {
        const rest = totals.map((x) => Math.max(0, required - x));
        ticks.push({ t: Math.round(t * 10) / 10, p: rest[0], ...(hybrid ? { p2: rest[1] } : {}), destroy: true });
        rest.forEach((r, i) => {
          totals[i] += r;
        });
      }
    }
  }
  return { ticks, total: totals[0], ...(hybrid ? { total2: totals[1] } : {}), success: !open(), freeze: Math.round(freeze * 10) / 10 };
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

/**
 * Drei zufällige Quests. Jede Schwierigkeit (1–6) kommt höchstens einmal vor; der Typ der Quest
 * (FIA, FIS, BWL, …) wird dagegen nicht gesteuert und darf sich wiederholen – auch dreimal.
 */
function generateOffers() {
  const quests = shuffle(QUESTS).slice(0, OFFER_COUNT);
  const levels = shuffle(DIFFICULTIES.map((d) => d.level)).slice(0, quests.length);
  return quests.map((q, i) => ({ quest: q.id, difficulty: levels[i] }));
}

const validOffers = (offers) =>
  Array.isArray(offers) &&
  offers.length > 0 &&
  offers.every((o) => questById[o.quest] && difficulty(o.difficulty)) &&
  new Set(offers.map((o) => o.difficulty)).size === offers.length; // keine Schwierigkeit doppelt

/** Angebotene Quests des Nutzers (werden bei Bedarf neu ausgewürfelt) */
async function getOffers(userId) {
  const st = await IhkState.findById(userId).lean();
  if (st && validOffers(st.offers)) return st.offers;
  const offers = generateOffers();
  await IhkState.updateOne({ _id: userId }, { $set: { offers } }, { upsert: true });
  return offers;
}

/** Darf der Nutzer heute noch neu würfeln? */
async function canReroll(userId) {
  const st = await IhkState.findById(userId).select('rerollDay').lean();
  return !st || st.rerollDay !== today();
}

/** Angebote einmal pro Tag neu auswürfeln (nicht während einer laufenden Quest) */
async function reroll({ user }) {
  const { running, used, limit } = await getState(user._id);
  if (running) throw new UserError('Während einer laufenden Quest kannst du nicht neu würfeln.');
  if (used >= limit) throw new UserError('Für heute hast du alle Quests erledigt.');
  const day = today();
  try {
    // Filter auf rerollDay macht das Würfeln atomar: zwei gleichzeitige Klicks zählen nur einmal
    const res = await IhkState.updateOne({ _id: user._id, rerollDay: { $ne: day } }, { $set: { offers: generateOffers(), rerollDay: day } }, { upsert: true });
    if (!res.modifiedCount && !res.upsertedCount) throw new UserError('Du hast heute schon neu gewürfelt.');
  } catch (err) {
    // Upsert kollidiert mit vorhandenem Dokument → heute schon gewürfelt
    if (err.code === 11000) throw new UserError('Du hast heute schon neu gewürfelt.');
    throw err;
  }
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

/** Boost-Karte prüfen (Slot 1 oder 2). Gibt die Katalog-Karte zurück oder null, wenn der Slot leer ist. */
async function checkBoost(user, card, boostId) {
  if (!boostId) return null;
  const boost = catalog.cardById[boostId];
  if (!boost) throw new UserError('Unbekannte Boost-Karte.');
  if (boost.id === card.id) throw new UserError('Die Boost-Karte muss eine andere Karte sein.');
  if (!canBoost(boost)) throw new UserError('Diese Karte hat im Boost-Slot keine Wirkung.');
  if (needsCoffee(boost)) {
    const owned = await TcgCard.distinct('card', { user: user._id });
    if (!owned.some((id) => isCoffee(catalog.cardById[id]))) throw new UserError(`${boost.name} kann nur ausgespielt werden, wenn du eine Kaffee-Karte besitzt.`);
  }
  return boost;
}

async function start({ user, cardId, boostId, boost2Id, offerIndex }) {
  const card = catalog.cardById[cardId];
  if (!card || !card.isCharacter) throw new UserError('Bitte wähle eine Charakterkarte aus.');
  const { running, used, limit } = await getState(user._id);
  if (running) throw new UserError('Du hast bereits eine laufende Quest.');
  if (used >= limit) throw new UserError(`Du hast heute schon alle ${limit} Quests erledigt. Morgen geht es weiter!`);

  const offers = await getOffers(user._id);
  const offer = offers[offerIndex];
  if (!offer) throw new UserError('Bitte wähle eine Quest aus.');
  const quest = questById[offer.quest];

  // Hybrid-Quests haben einen zweiten Boost-Slot; beide Boosts müssen verschiedene Karten sein
  if (boost2Id && !isHybrid(quest)) throw new UserError('Nur Hybrid-Quests haben einen zweiten Boost-Slot.');
  const boosts = [await checkBoost(user, card, boostId), await checkBoost(user, card, boost2Id)].filter(Boolean);
  if (boosts.length === 2 && who(boosts[0]) === who(boosts[1])) throw new UserError('Die beiden Boost-Karten müssen verschieden sein.');

  const required = requiredFor(offer.difficulty, quest);
  const effects = resolveAll(card, boosts);
  const result = simulate(card.stats, statsOf(quest), required, undefined, effects);
  try {
    // Sperrprüfung und Quest-Anlage in einer Transaktion, damit die Karte nicht gleichzeitig verkauft oder gehandelt wird
    return await inTransaction(async (session) => {
      // Nur freie Exemplare (nicht im Handel) können auf eine Quest
      const locked = await lockedDocs(user._id, session);
      const freeDoc = async (id) => (await TcgCard.find({ user: user._id, card: id }).sort({ createdAt: -1 }).select('_id').session(session).lean()).find((d) => !isLocked(locked, d));
      const doc = await freeDoc(cardId);
      if (!doc) throw new UserError('Diese Karte besitzt du nicht (oder sie ist gerade im Handel oder foliert).');
      const boostDocs = [];
      for (const b of boosts) {
        const d = await freeDoc(b.id);
        if (!d) throw new UserError('Die Boost-Karte besitzt du nicht (oder sie ist gerade im Handel oder foliert).');
        boostDocs.push(d);
      }
      await claim([doc, ...boostDocs], user._id, session);

      const [run] = await IhkRun.create(
        [
          {
            user: user._id,
            quest: quest.id,
            difficulty: offer.difficulty,
            required,
            card: cardId,
            cardDoc: doc._id,
            boost: boosts[0] ? boosts[0].id : null,
            boostDoc: boostDocs[0] ? boostDocs[0]._id : null,
            boost2: boosts[1] ? boosts[1].id : null,
            boost2Doc: boostDocs[1] ? boostDocs[1]._id : null,
            // nur Fähigkeiten, die vor Erreichen des Ziels (Halbzeit) wirklich aktiv wurden
            abilities: result.ticks.some((x) => x.ability) ? effects.map(({ apply, ...a }) => a) : [],
            stats: card.stats,
            day: today(),
            endsAt: new Date(Date.now() + durationFor(offer.difficulty, quest) * 60000),
            ...result,
            reward: result.success ? rewardFor(offer.difficulty, quest) : 0,
          },
        ],
        { session }
      );
      return run;
    });
  } catch (err) {
    if (err.code === 11000) throw new UserError('Du hast bereits eine laufende Quest.');
    throw err;
  }
}

/** Würfelt mit chance % (rand: Zahl in [0, 1)) */
const rollsPack = (chance, rand = crypto.randomInt(1000000) / 1000000) => rand * 100 < chance;

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
    // Mit etwas Glück gibt es für eine geschaffte Quest zusätzlich ein Booster Pack (landet im TCG-Inventar)
    // Nur geschaffte Quests; die Chance hängt von der Schwierigkeit ab (Admin-Panel)
    if (run.success && rollsPack(packChanceFor(run.difficulty, questById[run.quest]))) {
      const type = await tcgService.grantPacks({ userId: user._id, source: 'quest', session });
      run.pack = type.key;
      await run.save({ session });
    }
    return run;
  });
  await IhkState.updateOne({ _id: user._id }, { $set: { offers: generateOffers() } }, { upsert: true });
  return result;
}

module.exports = { WORK_TIME, settings, requiredFor, durationFor, rewardFor, packChanceFor, loadSettings, saveSettings, simulate, generateOffers, rollsPack, getOffers, canReroll, reroll, getState, start, collect };

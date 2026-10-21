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
const { resolveAll, who, canBoost, needsCoffee, isCoffee, checkDogs, isAleks, ALEKS, OMER } = require('./abilities');
const { lockedDocs, pickCopy, claim } = require('../tcg/locks');
const { logSettingsChange } = require('../stats/settingsLog');
const { damageCards, ihkSeverity, damageText } = require('../grading/damage');
const { notify } = require('../services/notifyService');

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
// Forkbomb (St. Ivan, the Forsaken): so viele Prozentpunkte lässt die Verlangsamung pro Runde nach
const FORKBOMB_STEP = 2;

// Werte, deren Zuwachs Luca (You can't handle my Potions) verstärkt: Werte, Tempo, Stillstand und Zeitgewinn der Deadline
const AMP_FIELDS = [
  [(s) => s.stats, 'fia'], [(s) => s.stats, 'fis'], [(s) => s.stats, 'bwl'], [(s) => s, 'speed'],
  [(s) => s, 'extraTicks'], [(s) => s, 'extraTime'], [(s) => s, 'forkbomb'],
];
const snapshot = (s) => AMP_FIELDS.map(([o, k]) => o(s)[k]);
/** Nur die Vorteile eines Effekts verstärken: was seit before gestiegen ist, steigt um amp mehr */
function amplify(s, before, amp) {
  AMP_FIELDS.forEach(([o, k], i) => {
    const d = o(s)[k] - before[i];
    if (d > 0) o(s)[k] += d * amp;
  });
}

/**
 * Fähigkeiten zur Halbzeit anwenden. Ist Luca im Team (amp), wirken Boost-Effekte (e.boost) stärker – nur ihre
 * Vorteile: höhere Werte und Tempo, mehr Zeit, ein Tempo-Schub (tempSpeed > 1), Mauchs Bonus danach, stärkere Hunde an
 * Matze. Nachteile (Mauchs Verlangsamung, AMD, Hermanns stärkere Aufgabe) bleiben, wie sie sind.
 */
function applyEffects(effects, s) {
  const amp = Math.max(0, ...effects.map((e) => e.amp || 0)); // mehrere Lucas zählen einmal
  // Lucas eigenes Tempo und BWL +50 kommen erst danach (sonst verstärkten Boosts wie BFW Energy sie mit)
  for (const e of [...effects.filter((x) => !x.amp), ...effects.filter((x) => x.amp)]) {
    if (!amp || !e.boost) {
      e.apply(s);
      continue;
    }
    const before = snapshot(s);
    const temp = s.tempSpeed;
    const dogs = s.dogs.length;
    e.apply(s);
    amplify(s, before, amp);
    if (s.tempSpeed && s.tempSpeed !== temp) {
      const t = s.tempSpeed;
      if (t.factor > 1) t.factor = 1 + (t.factor - 1) * (1 + amp);
      if (t.then) {
        const then = t.then;
        t.then = (st) => {
          const b = snapshot(st);
          then(st);
          amplify(st, b, amp);
        };
      }
    }
    for (const d of s.dogs.slice(dogs)) for (const k of ['fia', 'fis', 'bwl']) d[k] *= 1 + amp;
  }
}

// mode: 'ihk' | 'dungeon' | 'tower' – manche Fähigkeiten wirken je Spielmodus anders (z. B. Mark, the Suntouched)
// opts.coin (Aleks, Gruß aus dem Osten): { left: Geld in Cent, bonus: schon gewonnene Werte, active: wirft schon } – im
// Dungeon und Turm aus den Kämpfen davor (dungeonService.fight). Jeder Münzwurf steht im Takt als coin: 'kopf' | 'zahl'.
function simulate(stats, stat, required, rand = () => crypto.randomInt(1000000) / 1000000, effects = [], mode = 'ihk', opts = {}) {
  // dogs: Hunde, die mit jedem Schlag mitangreifen (Treue Seele an Matze) – je { id, fia, fis, bwl }
  // coinFlip: Aleks wirft bei jedem Angriff eine Münze, solange coinLeft reicht
  const coin = opts.coin || null;
  // omer: { n } – so viele Ömer greifen gemeinsam an (Mach das Unmögliche möglich); rush: so viel schneller läuft die Deadline
  const s = { mode, duration: WORK_TIME, speed: stats.speed, stats: { fia: stats.fia, fis: stats.fis, bwl: stats.bwl }, extraTicks: 0, extraTime: 0, elapsed: 0, tempSpeed: null, doom: null, forkbomb: 0, dogs: [], coinFlip: !!(coin && coin.active), coinLeft: coin ? coin.left : 0, omer: null, rush: 0 };
  const half = WORK_TIME / 2;
  const interval = () => WORK_TIME / tickCount(s.speed * (s.tempSpeed ? s.tempSpeed.factor : 1));
  const keys = [].concat(stat);
  const hybrid = keys.length > 1;
  const totals = keys.map(() => 0);
  const open = () => totals.some((x) => x < required);
  const ticks = [];
  let applied = effects.length === 0;
  let freeze = 0; // Sekunden, in denen die Deadline steht (Bloodlust)
  const slow = []; // Forkbomb: [von, bis, Prozent] – in diesen Spiel-Sekunden läuft die Deadline langsamer
  // Verbrauchte Deadline bis zur Spielzeit x (Stillstand und Verlangsamung abgezogen, Ömer beschleunigt: rush vor und ab der Halbzeit)
  const rush = [0, 0];
  const used = (x) => rushedUsed(x, half, freeze, slow, rush);
  let t = 0;
  // Angezeigte Werte der Karte [Speed, FIA, FIS, BWL]: ändern sie sich (Boost, Debuff, Ende eines Effekts),
  // trägt der Takt sie als st – der Browser schreibt sie dann auf die Karte (src/tcg/cardSvg.js).
  const shown = () => [s.speed * (s.tempSpeed ? s.tempSpeed.factor : 1), s.stats.fia, s.stats.fis, s.stats.bwl].map((v) => Math.round(v));
  let lastShown = shown().join();
  // Kopf aus früheren Kämpfen: gilt von Anfang an (der erste Takt schreibt die Werte auf die Karte)
  if (coin && coin.bonus) for (const k of ['fia', 'fis', 'bwl']) s.stats[k] += coin.bonus;
  // Fähigkeiten, die schon zu Beginn wirken (Ömer dupliziert sich)
  for (const e of effects) if (e.start) e.start(s);
  rush[0] = rush[1] = s.rush;
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
      applyEffects(effects, s);
      rush[1] = s.rush; // ab der Halbzeit (z. B. der dritte Ömer)
      applied = true;
      ticks.push(withShown({ t: half, p: 0, ability: true }));
      if (s.extraTicks || s.extraTime) {
        // Bloodlust: ganze Runden; Reality Check: Sekunden
        freeze = s.extraTicks * interval() + s.extraTime;
      }
      next = Math.max(half, t + interval());
    }
    // Forkbomb: in dieser Runde läuft die Deadline um s.forkbomb % langsamer (erst ab der Halbzeit)
    if (s.forkbomb > 0 && next > half) slow.push([Math.max(t, half), next, s.forkbomb]);
    if (used(next) > WORK_TIME + 1e-9) {
      if (s.forkbomb > 0 && next > half) slow.pop(); // Runde nicht mehr geschafft
      break;
    }
    if (s.forkbomb > 0 && next > half) s.forkbomb = Math.max(0, s.forkbomb - FORKBOMB_STEP); // lässt jede Runde nach
    // Gruß aus dem Osten: vor dem Angriff fliegt die Münze – Kopf gilt schon für diesen Angriff
    let flip = null;
    if (s.coinFlip && s.coinLeft >= ALEKS.cost) {
      s.coinLeft -= ALEKS.cost;
      flip = rand() < ALEKS.chance ? 'kopf' : 'zahl';
      if (flip === 'kopf') for (const k of ['fia', 'fis', 'bwl']) s.stats[k] += ALEKS.plus;
    }
    // Mach das Unmögliche möglich: greift ein Ömer an, gehen alle mit – je zusätzlichem Ömer bekommt jeder
    // OMER.grow · (Grundwert + 1) / 2 auf alle Werte, und das bleibt. Getroffen wird schon mit den neuen Werten.
    if (s.omer) for (const k of ['fia', 'fis', 'bwl']) s.stats[k] += ((s.omer.n - 1) * OMER.grow * (s.omer.base[k] + 1)) / 2;
    const crit = rand() < CRIT_CHANCE;
    // ein Wurf pro Runde – bei Hybrid-Quests gilt er für beide Balken
    // Hermann: Solange die Aufgabe gestärkt ist, bringt jede Runde entsprechend weniger Punkte
    const factor = ((0.8 + 0.4 * rand()) * (crit ? 2 : 1)) / (s.doom ? s.doom.factor : 1);
    const ps = keys.map((k) => Math.max(1, Math.round(s.stats[k] * factor)) * (s.omer ? s.omer.n : 1));
    // Treue Seele: jeder Hund an Matze trifft mit demselben Wurf mit (dg = ihr Anteil am ersten Balken, steckt schon in p)
    const dps = keys.map((k) => s.dogs.reduce((sum, d) => sum + Math.round(d[k] * factor), 0));
    dps.forEach((d, i) => {
      ps[i] += d;
    });
    if (s.tempSpeed && --s.tempSpeed.ticks <= 0) {
      const { then } = s.tempSpeed;
      s.tempSpeed = null;
      if (then) then(s); // z. B. Mauch: nach dem Gruschteln sind alle Werte höher
    }
    ps.forEach((p, i) => {
      totals[i] += p;
    });
    ticks.push(withShown({ t: Math.round(next * 10) / 10, p: ps[0], ...(hybrid ? { p2: ps[1] } : {}), crit, ...(flip ? { coin: flip } : {}), ...(dps[0] ? { dg: dps[0] } : {}), ...(s.omer ? { om: s.omer.n } : {}) }));
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
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    ticks,
    total: totals[0],
    ...(hybrid ? { total2: totals[1] } : {}),
    success: !open(),
    freeze: r1(freeze),
    // Forkbomb: verlangsamte Abschnitte und die dadurch gewonnene Zeit (Deadline endet bei WORK_TIME + freeze + extend)
    slow: slow.map(([a, b, p]) => [r1(a), r1(b), p]),
    extend: r1(slowGain(half, freeze, slow)),
    // Ömer: schnellere Deadline vor und ab der Halbzeit und wann sie dadurch endet (Spielzeit)
    ...(rush[0] || rush[1] ? { rush: [...rush], end: r1(deadlineEnd((x) => used(x))) } : {}),
  };
}

/** Verbrauchte Deadline mit Ömers Beschleunigung: rush[0] bis zur Halbzeit, rush[1] danach (Stillstand zählt nicht) */
function rushedUsed(x, half, freeze, slow, rush) {
  const base = deadlineUsed(x, half, freeze, slow);
  return Math.min(x, half) * (1 + rush[0]) + Math.max(0, base - half) * (1 + rush[1]);
}

/** Spielzeit, zu der die Deadline (WORK_TIME) verbraucht ist – used wächst monoton */
function deadlineEnd(used) {
  let lo = 0;
  let hi = WORK_TIME * 4;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (used(mid) >= WORK_TIME) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Überlappung der Strecken [a, b] und [c, d] in Sekunden */
const overlap = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));

/** Durch Forkbomb gewonnene Deadline-Sekunden bis zur Spielzeit x (ohne Teile, in denen die Deadline ohnehin steht) */
function slowGain(half, freeze, slow, x = Infinity) {
  return slow.reduce((sum, [a, b, p]) => sum + ((overlap(a, b, 0, x) - overlap(a, b, half, Math.min(half + freeze, x))) * p) / 100, 0);
}

/** Verbrauchte Deadline bis zur Spielzeit x: Bloodlust-Stillstand ab der Halbzeit, Forkbomb verlangsamt */
function deadlineUsed(x, half, freeze, slow) {
  return x - overlap(half, half + freeze, 0, x) - slowGain(half, freeze, slow, x);
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

/**
 * Geld für Aleks (Gruß aus dem Osten) in Cent: ganze Euro von 0 bis ALEKS.maxMoney; andere Karten nehmen keins mit.
 * Wird beim Start abgebucht, der Rest kommt am Ende zurück.
 */
function aleksBudget(card, euros) {
  const n = Number(euros) || 0;
  if (!n || !isAleks(card)) return 0;
  if (!Number.isInteger(n) || n < 0 || n * 100 > ALEKS.maxMoney) throw new UserError(`Aleks kann zwischen 0 und ${ALEKS.maxMoney / 100} € mitnehmen (ganze Euro).`);
  return n * 100;
}

/** Münzwürfe eines Laufs (Takte mit coin) → { budget, spent, heads } für das Abrechnen am Ende */
const coinTally = (budget, ticks) => {
  const flips = ticks.filter((x) => x.coin);
  return { budget, spent: flips.length * ALEKS.cost, heads: flips.filter((x) => x.coin === 'kopf').length };
};

/** Geld zurückbuchen, das Aleks nicht verworfen hat (coins = { budget, spent }) – in der Transaktion des Abschlusses */
async function refundCoins(userId, coins, title, session) {
  const rest = coins ? coins.budget - coins.spent : 0;
  if (rest <= 0) return 0;
  await User.updateOne({ _id: userId }, { $inc: { balance: rest } }, { session });
  await Ledger.create([{ user: userId, type: 'aleks_muenzen', amount: rest, betTitle: title }], { session });
  return rest;
}

/**
 * foiled: folierte Exemplare einsetzen (geschützt vor Schaden, #204) – sonst lieber unfolierte.
 * dogId: Hunde-Slot (Yo Dawg) – nur für Matze mit genau einem Hund in den Boost-Slots, dort der andere Hund.
 * coins: Geld für Aleks in Euro (Gruß aus dem Osten), höchstens ALEKS.maxMoney.
 */
async function start({ user, cardId, boostId, boost2Id, dogId, coins = 0, offerIndex, foiled = false }) {
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
  const dog = await checkBoost(user, card, dogId);
  const dogError = checkDogs(card, boosts, dog);
  if (dogError) throw new UserError(dogError);
  const budget = aleksBudget(card, coins);

  const required = requiredFor(offer.difficulty, quest);
  const effects = resolveAll(card, [...boosts, dog]); // der Hund im Hunde-Slot wirkt wie ein Boost
  const result = simulate(card.stats, statsOf(quest), required, undefined, effects, 'ihk', { coin: budget ? { left: budget, bonus: 0, active: false } : null });
  try {
    // Sperrprüfung und Quest-Anlage in einer Transaktion, damit die Karte nicht gleichzeitig verkauft oder gehandelt wird
    return await inTransaction(async (session) => {
      // Nur freie Exemplare (nicht im Handel) können auf eine Quest – folierte auch (#204)
      const locked = await lockedDocs(user._id, session);
      const freeDoc = async (id) => pickCopy(await TcgCard.find({ user: user._id, card: id }).sort({ createdAt: -1 }).select('_id foiledAt').session(session).lean(), locked, { foiled });
      const why = foiled ? 'kein freies foliertes Exemplar' : 'gerade im Handel oder unterwegs';
      const doc = await freeDoc(cardId);
      if (!doc) throw new UserError(`Diese Karte besitzt du nicht (oder ${why}).`);
      const boostDocs = [];
      for (const b of boosts) {
        const d = await freeDoc(b.id);
        if (!d) throw new UserError(`Die Boost-Karte besitzt du nicht (oder ${why}).`);
        boostDocs.push(d);
      }
      const dogDoc = dog ? await freeDoc(dog.id) : null;
      if (dog && !dogDoc) throw new UserError(`${dog.name} besitzt du nicht (oder ${why}).`);
      await claim([doc, ...boostDocs, dogDoc].filter(Boolean), user._id, session);
      // Aleks: Geld für die Münzwürfe gleich abbuchen (der Rest kommt beim Abholen zurück)
      if (budget) {
        const paid = await User.updateOne({ _id: user._id, balance: { $gte: budget } }, { $inc: { balance: -budget } }, { session });
        if (!paid.modifiedCount) throw new UserError(`Für Aleks' Münzwürfe fehlt dir Geld (${budget / 100} €).`);
        await Ledger.create([{ user: user._id, type: 'aleks_muenzen', amount: -budget, betTitle: quest.title }], { session });
      }

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
            dog: dog ? dog.id : null,
            dogDoc: dogDoc ? dogDoc._id : null,
            ...(budget ? { coins: coinTally(budget, result.ticks) } : {}),
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
  let hits = [];
  const result = await inTransaction(async (session) => {
    const run = await IhkRun.findOneAndUpdate(
      { user: user._id, status: 'laeuft', endsAt: { $lte: new Date() } },
      { $set: { status: 'fertig', collectedAt: new Date() } },
      { new: true, session }
    );
    if (!run) throw new UserError('Es gibt keine abgeschlossene Quest zum Abholen.');
    // Aleks: nicht verworfenes Geld zurück – egal, ob die Quest geschafft ist
    run.$locals.coinsBack = await refundCoins(user._id, run.coins, questById[run.quest] ? questById[run.quest].title : null, session);
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
    // Verloren: die eingesetzten (unfolierten) Karten können Kratzer oder einen Knick abbekommen (#204)
    if (!run.success) hits = await damageCards({ userId: user._id, docs: [run.cardDoc, run.boostDoc, run.boost2Doc, run.dogDoc], severity: ihkSeverity(run), session });
    return run;
  });
  await IhkState.updateOne({ _id: user._id }, { $set: { offers: generateOffers() } }, { upsert: true });
  const text = damageText(hits, (id) => (catalog.cardById[id] || { name: id }).name, 'IHK');
  if (text) await notify(user._id, { area: 'IHK', href: '/tcg', text });
  return result;
}

module.exports = { aleksBudget, coinTally, refundCoins, WORK_TIME, settings, requiredFor, durationFor, rewardFor, packChanceFor, loadSettings, saveSettings, simulate, generateOffers, rollsPack, getOffers, canReroll, reroll, getState, start, collect };

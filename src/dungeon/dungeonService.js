// Dungeon: alle paar Stunden (Admin-Panel, Standard 2) startet ein Dungeon für je drei Spieler.
// Anmeldung allein (wird beim Start zugelost, fehlende Plätze füllen Bots) oder als Gruppe mit Einladungen
// und eigenem Chat. Karten wählt man erst in der Lobby (#111) – wer zum Start keinen Charakter hat, ist nicht dabei.
// Ablauf wie bei der IHK: Die Kämpfe (2× Trash, 1× Boss) werden beim Start mit den
// Kartenwerten und Fähigkeiten ausgewürfelt und danach abgespielt; am Ende gibt es Lohn und Beute.
// Mage Tower (mode 'tower'): einmal am Tag, der Leiter startet sofort. Runde für Runde schwerer, Fähigkeit zufällig,
// bis eine Runde verloren geht – die geschafften Runden bestimmen Lohn und Beute-Chancen. Auch das steht beim Start fest.
const crypto = require('crypto');
const config = require('../config');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgCard } = require('../models/Tcg');
const { DungeonParty, DungeonRun, DungeonSettings, TowerAttempt } = require('../models/Dungeon');
const { inTransaction } = require('../services/betService');
const { notify } = require('../services/notifyService');
const { toZonedLocalInput } = require('../lib/time');
const { UserError } = require('../lib/util');
const catalog = require('../tcg/catalog');
const { lockedDocs, isLocked, claim } = require('../tcg/locks');
const { simulate, WORK_TIME } = require('../ihk/ihkService');
const { resolve, resolveAll, canBoost, needsCoffee, isCoffee } = require('../ihk/abilities');
const { grantItems } = require('../items/itemService');
const { logSettingsChange } = require('../stats/settingsLog');
const { defOf, dungeonForSlot, TOWER } = require('./dungeons');

const TEAM_SIZE = 3;
const LOCK_SECONDS = 10; // so lange vor dem Start kann man sich nicht mehr abmelden (und nicht mehr beitreten)
// Wiedergabe (echte Sekunden): Einleitung, je Kampf, Pause dazwischen
const INTRO_SECONDS = 8;
const FIGHT_SECONDS = 45; // volle Zeit eines Kampfes (IHK: 15 Sekunden)
const PAUSE_SECONDS = 6; // Pause zwischen zwei Kämpfen
const END_SECONDS = 2; // nach dem letzten Kampf, dann wird die Beute verteilt
const CHAT_MAX = 100; // so viele Nachrichten bleiben im Chat
const CHAT_TEXT_MAX = 300;
const RESULT_MINUTES = 30; // so lange zeigt die Seite das Ergebnis des letzten Durchlaufs
const LOOT_DAYS = 7; // so lange wartet das Beute-Fenster darauf, gesehen zu werden
const BOT_NAMES = ['Praktikant-Bot', 'Azubi-Bot', 'Werkstudent-Bot'];

// ---------- Einstellungen (Admin) ----------
// open = für alle Mitglieder (sonst nur Admins); intervalHours = Abstand der Starts
// required / rewards = Ziel-Punkte und Lohn (Cent pro Spieler) für [Trash 1, Trash 2, Boss]
// foilChance / cardChance = Chance in % pro Spieler auf eine Folie bzw. die Boss-Karte (nur wenn der Boss fällt)
// botWeights = Gewicht je Seltenheit für die Karte eines Bots
// tower = Mage Tower: open (zusätzlich zu open), Ziel-Punkte der ersten Runde und Anstieg pro Runde (%), Lohn pro Spieler
// für Runde 1 und Zuwachs je weitere Runde (Cent), Beute-Chance pro geschaffter Runde und ihre Obergrenze (%),
// Wiedergabe je Runde und Pause (echte Sekunden)
const DEFAULTS = {
  open: false,
  intervalHours: 2,
  // Von Krisztian festgelegt (2026-10-04); die Simulation dazu steht in .claude/notes/funkciok.md
  required: [1800, 1950, 2200],
  rewards: [5000, 5000, 15000],
  foilChance: 2,
  cardChance: 1,
  // Bots bringen keine Crumpled-Karten; selten Bockhaber, ganz selten Glitch (Summe 100 = Prozent)
  botWeights: { crumpled: 0, bfwler: 40, gold: 40, holo: 15, bockhaber: 4, glitch: 1, icon: 0, sith: 0 },
  // Simulation (2026-10-07, strategische Gruppen: stärkste Charaktere der Seltenheit + beste Boosts): Gold ~6, Holo ~7,
  // Bockhaber ~8, Glitch ~14 Runden, beste Kombination (St. Ivan + Glitch, Mauch/Sigrist/Lili) ~17. Der steile Anstieg
  // hält den Abstand klein – mit +8 % schaffte die beste Kombination 36 Runden (~3.500 € am Tag).
  tower: { open: false, baseRequired: 600, growth: 20, rewardBase: 1000, rewardStep: 500, foilPerRound: 1, foilMax: 25, cardPerRound: 0.5, cardMax: 10, fightSeconds: 20, pauseSeconds: 4 },
};
const settings = JSON.parse(JSON.stringify(DEFAULTS));

// Erlaubte Werte des Mage Towers: [min, max, ganze Zahl?]
const TOWER_LIMITS = {
  baseRequired: [1, 100000, true],
  growth: [1, 100, false],
  rewardBase: [0, 10000000, true],
  rewardStep: [0, 10000000, true],
  foilPerRound: [0, 100, false],
  foilMax: [0, 100, false],
  cardPerRound: [0, 100, false],
  cardMax: [0, 100, false],
  fightSeconds: [5, 120, true],
  pauseSeconds: [0, 30, true],
};
const validTower = (t) =>
  !!t && typeof t.open === 'boolean' && Object.entries(TOWER_LIMITS).every(([k, [min, max, int]]) => Number.isFinite(t[k]) && t[k] >= min && t[k] <= max && (!int || Number.isInteger(t[k])));

const validTriple = (list, min) => Array.isArray(list) && list.length === 3 && list.every((v) => Number.isInteger(v) && v >= min);
const validChance = (c) => Number.isFinite(c) && c >= 0 && c <= 100;
const validInterval = (h) => Number.isInteger(h) && h >= 1 && h <= 24 && 24 % h === 0;
function validWeights(w) {
  if (!w || typeof w !== 'object') return false;
  const vals = catalog.RARITIES.map((r) => w[r.key]);
  return vals.every((v) => Number.isInteger(v) && v >= 0 && v <= 10000) && vals.some((v, i) => v > 0 && hasCharacters(catalog.RARITIES[i].key));
}
const hasCharacters = (rarity) => (catalog.cardsByRarity[rarity] || []).some((c) => c.isCharacter);

async function loadSettings() {
  const doc = await DungeonSettings.findById('dungeon').lean();
  if (!doc) return;
  if (typeof doc.open === 'boolean') settings.open = doc.open;
  if (validInterval(doc.intervalHours)) settings.intervalHours = doc.intervalHours;
  if (validTriple(doc.required, 1)) settings.required = doc.required;
  if (validTriple(doc.rewards, 0)) settings.rewards = doc.rewards;
  if (validChance(doc.foilChance)) settings.foilChance = doc.foilChance;
  if (validChance(doc.cardChance)) settings.cardChance = doc.cardChance;
  if (validWeights(doc.botWeights)) settings.botWeights = Object.fromEntries(catalog.RARITIES.map((r) => [r.key, doc.botWeights[r.key]]));
  // Turm: fehlende Werte (neu hinzugekommen) vom Standard
  const tower = doc.tower ? Object.fromEntries(Object.keys(DEFAULTS.tower).map((k) => [k, doc.tower[k] ?? DEFAULTS.tower[k]])) : null;
  if (validTower(tower)) settings.tower = tower;
}

async function saveSettings({ open, intervalHours, required, rewards, foilChance, cardChance, botWeights, tower = settings.tower, admin }) {
  if (!validInterval(intervalHours)) throw new UserError('Der Abstand muss 1, 2, 3, 4, 6, 8, 12 oder 24 Stunden sein.');
  if (!validTriple(required, 1) || required.some((r) => r > 100000)) throw new UserError('Bitte für jeden Kampf gültige Ziel-Punkte angeben (1–100000).');
  if (!validTriple(rewards, 0)) throw new UserError('Bitte für jeden Kampf einen gültigen Lohn angeben.');
  if (!validChance(foilChance) || !validChance(cardChance)) throw new UserError('Die Chancen müssen zwischen 0 und 100 % liegen.');
  if (!validWeights(botWeights)) throw new UserError('Bot-Karten: ganze Zahlen von 0 bis 10000, mindestens eine Seltenheit mit Charakterkarten über 0.');
  if (!validTower(tower)) {
    throw new UserError('Mage Tower: Ziel 1–100000 Punkte, Anstieg 1–100 %, Chancen 0–100 %, Wiedergabe 5–120 s und Pause 0–30 s je Runde.');
  }
  const next = { open, intervalHours, required, rewards, foilChance, cardChance, botWeights, tower };
  await DungeonSettings.updateOne({ _id: 'dungeon' }, { $set: { ...next, updatedByName: admin.username } }, { upsert: true });
  const before = JSON.parse(JSON.stringify(settings));
  Object.assign(settings, next);
  await logSettingsChange({ area: 'dungeon', before, after: settings, by: admin });
}

// ---------- Termine ----------
/** Nächste Startzeit nach `now`: volle Stunde deutscher Zeit, die durch hours teilbar ist */
function slotAfter(now = Date.now(), hours = settings.intervalHours) {
  let t = Math.floor(now / 3600000) * 3600000 + 3600000;
  for (let i = 0; i < 50; i++, t += 3600000) {
    const h = Number(toZonedLocalInput(new Date(t), config.timezone).slice(11, 13));
    if (h % hours === 0) return new Date(t);
  }
  return new Date(t);
}

/** Termin, für den man sich jetzt anmeldet: kurz vor dem Start schon der übernächste */
function registrationSlot(now = Date.now(), hours = settings.intervalHours) {
  const next = slotAfter(now, hours);
  return next.getTime() - now <= LOCK_SECONDS * 1000 ? slotAfter(next.getTime(), hours) : next;
}

const isLockedIn = (slot, now = Date.now()) => new Date(slot).getTime() - now <= LOCK_SECONDS * 1000;
/** Anmeldung kurz vor dem Start gesperrt? Der Turm hat keinen Termin – er ist bis zum Knopfdruck offen. */
const partyLocked = (party, now = Date.now()) => party.mode !== 'tower' && isLockedIn(party.slot, now);

/** Tag in deutscher Zeit ("YYYY-MM-DD") – ein Turm-Versuch pro Tag */
const towerDay = (now = Date.now()) => toZonedLocalInput(new Date(now), config.timezone).slice(0, 10);

// ---------- Zufall ----------
const random = () => crypto.randomInt(1000000) / 1000000;

function shuffle(list, rand = random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Karte eines Bots: Seltenheit nach botWeights, darin eine zufällige Charakterkarte */
function botCard(rand = random, weights = settings.botWeights) {
  const pool = catalog.RARITIES.filter((r) => weights[r.key] > 0 && hasCharacters(r.key));
  const total = pool.reduce((s, r) => s + weights[r.key], 0);
  let x = rand() * total;
  let rarity = pool[pool.length - 1];
  for (const r of pool) {
    x -= weights[r.key];
    if (x < 0) {
      rarity = r;
      break;
    }
  }
  const cards = catalog.cardsByRarity[rarity.key].filter((c) => c.isCharacter);
  return cards[Math.floor(rand() * cards.length)];
}

/**
 * Boost-Karte eines Bots: zufällige Karte, die im Boost-Slot wirkt (ohne Hermann, der eine Kaffee-Karte braucht).
 * Jede Karte zählt mit dem Gewicht ihrer Seltenheit (botWeights); ist dort keine dabei, gleich wahrscheinlich.
 */
function botBoost(rand = random, weights = settings.botWeights) {
  const pool = catalog.CARDS.filter((c) => canBoost(c) && !needsCoffee(c));
  if (!pool.length) return null;
  const w = (c) => weights[c.rarity] || 0;
  const total = pool.reduce((s, c) => s + w(c), 0);
  if (!total) return pool[Math.floor(rand() * pool.length)];
  let x = rand() * total;
  for (const c of pool) {
    x -= w(c);
    if (x < 0) return c;
  }
  return pool[pool.length - 1];
}

// ---------- Kampf ----------
// Boost-Fähigkeiten, die im Dungeon der ganzen Gruppe helfen: Ömer (FIS für die befreundeten Karten), Hundekarten
// (alle freundlichen Charaktere), Mauch (schickt die Gruppe zum Gruschteln) und Matzes Hundekarte-Bonus, sobald
// irgendwer einen Hund mitbringt. Bloodlust und Reality Check treffen den Gegner – also die Deadline aller.
// Fähigkeiten von Hauptkarten, die für die ganze Gruppe wirken
const TEAM_MAIN_KEYS = new Set(['forkbomb']);
const TEAM_KEYS = new Set(['forkbomb', 'osmanen', 'hund', 'gruschteln', 'hundekarte', 'bloodlust', 'reality-check']);

/** Fähigkeiten eines Spielers: eigene Karte + eigener Boost, dazu die Gruppen-Fähigkeiten der Boosts der anderen */
function teamEffects(members, m) {
  const mem = members[m];
  const out = resolveAll(mem.card, mem.boost ? [mem.boost] : []).map((e) => ({ ...e, from: m }));
  members.forEach((other, o) => {
    // Forkbomb einer Hauptkarte trifft die Aufgabe – also wirkt sie für die ganze Gruppe
    if (o !== m) for (const e of resolve(other.card, null)) if (TEAM_MAIN_KEYS.has(e.key) && !out.some((x) => x.key === e.key)) out.push({ ...e, from: o });
    if (o === m || !other.boost) return;
    for (const e of resolve(mem.card, other.boost)) {
      if (TEAM_KEYS.has(e.key) && !out.some((x) => x.key === e.key && x.label === e.label)) out.push({ ...e, from: o });
    }
  });
  return out;
}

/**
 * Ein Kampf: Jeder Spieler arbeitet wie in der IHK (eigene Takte, Krits und Fähigkeiten zur Halbzeit) –
 * die Punkte aller drei landen in einem gemeinsamen Balken. Geschafft, sobald required erreicht ist,
 * verloren, wenn die Zeit (limit, Spiel-Sekunden) vorher abläuft.
 * members: [{ card, boost }] (Katalog-Karten). Ergebnis: ticks [{ m, t, p, crit, ability, destroy }] nach Zeit,
 * abilities [{ m, from, team, label, text }] (from = wessen Karte die Fähigkeit bringt).
 * fightSeconds: volle Zeit in der Wiedergabe (Turm: kürzer).
 */
function fight(members, stat, required, rand = random, fightSeconds = FIGHT_SECONDS) {
  const events = [];
  const abilities = [];
  let limit = WORK_TIME;
  members.forEach((mem, m) => {
    const effects = teamEffects(members, m);
    const r = simulate(mem.card.stats, stat, required, rand, effects);
    if (effects.length && r.ticks.some((x) => x.ability)) effects.forEach((e) => abilities.push({ m, from: e.from, team: TEAM_KEYS.has(e.key), label: e.label, text: e.text }));
    limit = Math.max(limit, WORK_TIME + r.freeze + (r.extend || 0));
    r.ticks.forEach((x) => events.push({ m, t: x.t, p: x.p, ...(x.crit ? { crit: true } : {}), ...(x.ability ? { ability: true } : {}), ...(x.destroy ? { destroy: true } : {}), ...(x.st ? { st: x.st } : {}) }));
  });
  events.sort((a, b) => a.t - b.t || a.m - b.m);
  const ticks = [];
  let total = 0;
  let doneAt = null;
  for (const e of events) {
    ticks.push(e);
    total += e.p;
    if (total >= required) {
      doneAt = e.t;
      break;
    }
  }
  // Fähigkeiten, die erst nach dem Sieg ausgelöst hätten, zählen nicht
  const used = abilities.filter((a) => ticks.some((x) => x.ability && x.m === a.m));
  const success = total >= required;
  // Wiedergabe in gleichmäßigem Tempo (volle Zeit = fightSeconds): ein gewonnener Kampf endet beim Sieg,
  // ein verlorener mit Ablauf der Deadline. Sie beginnt erst eine Sekunde vor dem ersten Treffer (start,
  // Spielzeit) – die Takte davor bringen noch keine Punkte, die Deadline läuft dabei trotzdem.
  const start = Math.max(0, Math.round(((ticks.length ? ticks[0].t : 0) - limit / fightSeconds) * 10) / 10);
  const seconds = Math.max(1, Math.round((fightSeconds * ((success ? doneAt : limit) - start)) / limit * 10) / 10);
  return { ticks, abilities: used, total: Math.min(total, required), success, doneAt, limit, start, seconds };
}

/** Alle Kämpfe eines Dungeons; nach einer Niederlage ist Schluss */
function playDungeon(dungeon, members, rand = random, opts = settings) {
  const fights = [];
  for (const [i, f] of dungeon.fights.entries()) {
    const r = fight(members, f.stat, opts.required[i], rand);
    fights.push({ key: f.key, boss: !!f.boss, required: opts.required[i], reward: opts.rewards[i], ...r });
    if (!r.success) break;
  }
  return fights;
}

/** Wiedergabedauer in Sekunden: Einleitung, Kämpfe mit Pausen dazwischen, kurzer Abschluss */
const runSeconds = (fights, pause = PAUSE_SECONDS) => INTRO_SECONDS + fights.reduce((s, f) => s + f.seconds, 0) + Math.max(0, fights.length - 1) * pause + END_SECONDS;

/** Karte, die der Boss dieses Dungeons (oder der Turm) fallen lässt (Katalogkarte), oder null */
function bossCardOf(dungeonKey) {
  const d = defOf(dungeonKey);
  return (d && d.bossCard && catalog.cardById[d.bossCard]) || null;
}

// ---------- Mage Tower ----------
const TOWER_STATS = ['fia', 'fis', 'bwl'];
const MAX_ROUNDS = 100; // Sicherheitsgrenze – der Anstieg sorgt lange vorher für eine Niederlage

/** Ziel-Punkte der Runde n (ab 1): jede Runde growth % mehr als die vorige */
const towerRequired = (n, opts = settings.tower) => Math.round(opts.baseRequired * (1 + opts.growth / 100) ** (n - 1));
/** Lohn pro Spieler für Runde n (Cent) */
const towerReward = (n, opts = settings.tower) => opts.rewardBase + opts.rewardStep * (n - 1);
/** Beute-Chancen in % nach `rounds` geschafften Runden */
const towerChances = (rounds, opts = settings.tower) => ({
  foil: Math.min(opts.foilMax, opts.foilPerRound * rounds),
  card: Math.min(opts.cardMax, opts.cardPerRound * rounds),
});

/** Begegnung einer Runde: zufällige Fähigkeit, darin eine zufällige Begegnung – nicht dieselbe wie zuletzt */
function towerFloor(prevKey, rand = random) {
  const stat = TOWER_STATS[Math.floor(rand() * TOWER_STATS.length)];
  const pool = TOWER.floors.filter((f) => f.stat === stat && f.key !== prevKey);
  return pool[Math.floor(rand() * pool.length)];
}

/** Alle Runden eines Turm-Laufs: so lange, bis eine verloren geht (höchstens maxRounds) */
function playTower(members, rand = random, opts = settings.tower, maxRounds = MAX_ROUNDS) {
  const fights = [];
  let prev = null;
  for (let n = 1; n <= maxRounds; n++) {
    const floor = towerFloor(prev, rand);
    prev = floor.key;
    const required = towerRequired(n, opts);
    const r = fight(members, floor.stat, required, rand, opts.fightSeconds);
    fights.push({ key: floor.key, boss: false, required, reward: towerReward(n, opts), ...r });
    if (!r.success) break;
  }
  return fights;
}

/** Lohn und Beute pro Spieler im Turm: Lohn aller geschafften Runden, Folie und Karte mit den Chancen der Runden */
function towerRewardsFor(fights, isBot, rand = random, opts = settings.tower) {
  if (isBot) return { reward: 0, foil: false, bossCard: false };
  const won = fights.filter((f) => f.success);
  const chance = towerChances(won.length, opts);
  return { reward: won.reduce((s, f) => s + f.reward, 0), foil: rand() * 100 < chance.foil, bossCard: rand() * 100 < chance.card };
}

/** Lohn und Beute pro Spieler (Bots bekommen nichts) */
function rewardsFor(fights, isBot, rand = random, opts = settings) {
  const money = fights.filter((f) => f.success).reduce((s, f) => s + f.reward, 0);
  const boss = fights.some((f) => f.boss && f.success);
  if (isBot) return { reward: 0, foil: false, bossCard: false };
  return { reward: money, foil: boss && rand() * 100 < opts.foilChance, bossCard: boss && rand() * 100 < opts.cardChance };
}

/** Solo-Anmeldungen in Dreiergruppen aufteilen (zufällig) */
const makeTeams = (entries, rand = random) => {
  const list = shuffle(entries, rand);
  const teams = [];
  for (let i = 0; i < list.length; i += TEAM_SIZE) teams.push(list.slice(i, i + TEAM_SIZE));
  return teams;
};

// ---------- Anmeldung ----------
/** Freie Exemplare (nicht foliert, nicht gesperrt) – als Kartenliste für die Auswahl */
/** ownDungeon: die eigenen, schon für den Dungeon gesperrten Karten zählen als frei (Karten tauschen vor dem Start) */
async function availableCards(userId, { ownDungeon = false } = {}) {
  const [docs, locked] = await Promise.all([TcgCard.find({ user: userId, foiledAt: null }).select('card').lean(), lockedDocs(userId)]);
  const free = (d) => !isLocked(locked, d) || (ownDungeon && locked.reasons.get(String(d._id)) === 'dungeon');
  // counts: freie Exemplare je Karte – dieselbe Karte als Charakter UND Boost braucht zwei
  const counts = {};
  docs.filter(free).forEach((d) => {
    counts[d.card] = (counts[d.card] || 0) + 1;
  });
  const rank = (c) => catalog.rarityByKey[c.rarity].rank;
  const all = Object.keys(counts).map((id) => catalog.cardById[id]).filter(Boolean).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name, 'de'));
  // Boost: Items, Spells und Charaktere mit Boost-Fähigkeit (Ömer, Pascal, Lili)
  return { characters: all.filter((c) => c.isCharacter), boosts: all.filter((c) => canBoost(c)), counts };
}

/** Mitglied ohne Karten – so tritt man bei, gewählt wird danach in der Lobby (#111) */
const emptyMember = (user) => ({ user: user._id, name: user.username, card: null, cardDoc: null, boost: null, boostDoc: null });

/**
 * Karten prüfen und Exemplare in der Transaktion sperren → Mitglieds-Eintrag.
 * Ohne cardId bleibt der Charakter offen (in der Lobby darf man zuerst den Boost wählen).
 */
async function memberEntry(user, cardId, boostId, session, { ownDungeon = false } = {}) {
  const card = cardId ? catalog.cardById[cardId] : null;
  if (cardId && (!card || !card.isCharacter)) throw new UserError('Bitte wähle eine Charakterkarte aus.');
  let boost = null;
  if (boostId) {
    boost = catalog.cardById[boostId];
    if (!boost || !canBoost(boost)) throw new UserError('Diese Karte hat im Boost-Slot keine Wirkung.');
  }
  if (boost && needsCoffee(boost)) {
    const owned = await TcgCard.distinct('card', { user: user._id }).session(session);
    if (!owned.some((id) => isCoffee(catalog.cardById[id]))) throw new UserError(`${boost.name} kann nur ausgespielt werden, wenn du eine Kaffee-Karte besitzt.`);
  }
  const locked = await lockedDocs(user._id, session);
  // Karten tauschen: die bisher eingesetzten Exemplare sind wieder wählbar
  if (ownDungeon) [...locked.reasons].filter(([, r]) => r === 'dungeon').forEach(([id]) => locked.reasons.delete(id));
  // except: dieses Exemplar ist schon vergeben (dieselbe Karte als Charakter und Boost → zwei verschiedene Exemplare)
  const freeDoc = async (id, except) => (await TcgCard.find({ user: user._id, card: id }).sort({ createdAt: -1 }).select('_id').session(session).lean()).find((d) => !isLocked(locked, d) && !(except && d._id.equals(except._id)));
  const doc = card ? await freeDoc(card.id) : null;
  if (card && !doc) throw new UserError('Diese Karte ist nicht frei (Quest, Handel, Folie oder schon im Dungeon).');
  const same = !!card && !!boost && boost.id === card.id;
  const boostDoc = boost ? await freeDoc(boost.id, same ? doc : null) : null;
  if (boost && !boostDoc) {
    throw new UserError(same ? `Für ${boost.name} als Charakter und Boost brauchst du zwei freie Exemplare.` : 'Die Boost-Karte ist nicht frei (Quest, Handel, Folie oder schon im Dungeon).');
  }
  await claim([doc, boostDoc], user._id, session);
  return { user: user._id, name: user.username, card: card ? card.id : null, cardDoc: doc ? doc._id : null, boost: boost ? boost.id : null, boostDoc: boostDoc ? boostDoc._id : null };
}

const partyOf = (userId) => DungeonParty.findOne({ 'members.user': userId });
const runningRunOf = (userId) => DungeonRun.findOne({ 'members.user': userId, status: 'laeuft' });

function checkOpen(user) {
  if (!settings.open && !user.isAdmin) throw new UserError('Der Dungeon ist derzeit nicht verfügbar.');
}

/** Turm: für alle nur, wenn Dungeon und Turm freigegeben sind – Admins immer */
const towerOpen = (user) => !!user.isAdmin || (settings.open && settings.tower.open);
function checkTowerOpen(user) {
  if (!towerOpen(user)) throw new UserError('Der Mage Tower ist derzeit nicht verfügbar.');
}

/** War dieser Spieler heute schon im Turm? */
const playedTowerToday = async (userId, now = Date.now()) => !!(await TowerAttempt.exists({ user: userId, day: towerDay(now) }));

const duplicate = (err) => {
  if (err.code === 11000) throw new UserError('Du bist schon für einen Dungeon angemeldet.');
  throw err;
};

/** Anmelden: allein (solo) oder als neue Gruppe (du bist Gruppenleiter). Karten wählt man danach in der Lobby. */
async function register({ user, solo }) {
  checkOpen(user);
  if (await runningRunOf(user._id)) throw new UserError('Du bist gerade in einem Dungeon.');
  if (await partyOf(user._id)) throw new UserError('Du bist schon für einen Dungeon angemeldet.');
  return DungeonParty.create({ slot: registrationSlot(), solo: !!solo, leader: user._id, members: [emptyMember(user)] }).catch(duplicate);
}

/** Mage Tower: allein (Bots füllen auf) oder als Gruppe. Kein Termin – der Leiter startet, sobald alle gewählt haben. */
async function registerTower({ user, solo }) {
  checkTowerOpen(user);
  if (await runningRunOf(user._id)) throw new UserError('Du bist gerade in einem Dungeon.');
  if (await partyOf(user._id)) throw new UserError('Du bist schon für einen Dungeon angemeldet.');
  if (await playedTowerToday(user._id)) throw new UserError('Du warst heute schon im Mage Tower – ab Mitternacht geht es wieder.');
  return DungeonParty.create({ mode: 'tower', slot: new Date(), solo: !!solo, leader: user._id, members: [emptyMember(user)] }).catch(duplicate);
}

/** Gruppenleiter lädt ein Mitglied ein (Name) */
async function invite({ user, name }) {
  const party = await partyOf(user._id);
  if (!party || party.solo) throw new UserError('Gründe zuerst eine Gruppe.');
  if (!party.leader.equals(user._id)) throw new UserError('Nur der Gruppenleiter kann einladen.');
  if (partyLocked(party)) throw new UserError('Der Dungeon startet gleich – Einladungen sind nicht mehr möglich.');
  const target = await User.findOne({ usernameLower: String(name || '').trim().toLowerCase() }).select('_id username').lean();
  if (!target) throw new UserError('Dieses Mitglied gibt es nicht.');
  if (party.members.some((m) => m.user && m.user.equals(target._id))) throw new UserError(`${target.username} ist schon in deiner Gruppe.`);
  if (party.invites.some((i) => i.user.equals(target._id))) throw new UserError(`${target.username} ist schon eingeladen.`);
  const tower = party.mode === 'tower';
  if (tower && (await playedTowerToday(target._id))) throw new UserError(`${target.username} war heute schon im Mage Tower.`);
  // Filter macht es atomar: höchstens drei Plätze (Mitglieder + offene Einladungen)
  const res = await DungeonParty.updateOne(
    { _id: party._id, leader: user._id, 'invites.user': { $ne: target._id }, $expr: { $lt: [{ $add: [{ $size: '$members' }, { $size: '$invites' }] }, TEAM_SIZE] } },
    { $push: { invites: { user: target._id, name: target.username } } }
  );
  if (!res.modifiedCount) throw new UserError('Deine Gruppe ist schon voll.');
  await notify([target._id], { area: 'Dungeon', href: '/dungeon', text: `${user.username} lädt dich in den ${tower ? 'Mage Tower' : 'Dungeon'} ein.` });
  return target;
}

/**
 * Wen der Gruppenleiter einladen kann – für die Vorschläge im Einladen-Feld. Nicht dabei: man selbst, wer schon in
 * der Gruppe steht oder eingeladen ist, gelöschte und gesperrte Konten, wer in einer vollen Gruppe oder gerade in
 * einem Durchlauf ist, beim Turm wer heute schon oben war, und ohne Freigabe alle außer Admins.
 * → [{ name, note }] (note: z. B. "schon angemeldet" – muss die eigene Anmeldung erst verlassen)
 */
async function invitablePlayers(user, now = Date.now()) {
  const party = await DungeonParty.findOne({ 'members.user': user._id, leader: user._id, solo: false }).lean();
  if (!party) return [];
  const tower = party.mode === 'tower';
  const [users, parties, runs, played] = await Promise.all([
    User.find({ deletedAt: null, $or: [{ bannedUntil: null }, { bannedUntil: { $lte: new Date(now) } }] }).select('username usernameLower').sort({ usernameLower: 1 }).lean(),
    DungeonParty.find({}).select('members.user').lean(),
    DungeonRun.find({ status: 'laeuft' }).select('members.user').lean(),
    tower ? TowerAttempt.find({ day: towerDay(now) }).select('user').lean() : [],
  ]);
  const open = tower ? settings.open && settings.tower.open : settings.open;
  const busy = new Set([String(user._id), ...party.members.map((m) => String(m.user)), ...party.invites.map((i) => String(i.user)), ...played.map((a) => String(a.user))]);
  runs.forEach((r) => r.members.forEach((m) => m.user && busy.add(String(m.user))));
  const registered = new Set();
  for (const p of parties) {
    const ids = p.members.map((m) => String(m.user));
    ids.forEach((id) => (p.members.length >= TEAM_SIZE ? busy : registered).add(id));
  }
  return users
    .filter((u) => !busy.has(String(u._id)) && (open || config.adminUsernames.includes(u.usernameLower)))
    .map((u) => ({ name: u.username, note: registered.has(String(u._id)) ? 'schon angemeldet' : null }));
}

/** Einladung zurückziehen (Gruppenleiter) */
async function cancelInvite({ user, inviteeId }) {
  await DungeonParty.updateOne({ leader: user._id, 'members.user': user._id }, { $pull: { invites: { user: inviteeId } } });
}

/** Einladung annehmen: zuerst beitreten, die Karten wählt man danach in der Lobby */
async function accept({ user, partyId }) {
  checkOpen(user);
  if (await runningRunOf(user._id)) throw new UserError('Du bist gerade in einem Dungeon.');
  if (await partyOf(user._id)) throw new UserError('Verlasse zuerst deine aktuelle Anmeldung.');
  const party = await DungeonParty.findOne({ _id: partyId, 'invites.user': user._id }).lean();
  if (!party) throw new UserError('Diese Einladung gibt es nicht mehr.');
  if (partyLocked(party)) throw new UserError('Der Dungeon startet gleich – Beitreten ist nicht mehr möglich.');
  if (party.mode === 'tower') {
    checkTowerOpen(user);
    if (await playedTowerToday(user._id)) throw new UserError('Du warst heute schon im Mage Tower – ab Mitternacht geht es wieder.');
  }
  const res = await DungeonParty.updateOne(
    { _id: party._id, 'invites.user': user._id, [`members.${TEAM_SIZE - 1}`]: { $exists: false } },
    { $pull: { invites: { user: user._id } }, $push: { members: emptyMember(user) } }
  ).catch(duplicate);
  if (!res.modifiedCount) throw new UserError('Die Gruppe ist schon voll.');
}

async function decline({ user, partyId }) {
  await DungeonParty.updateOne({ _id: partyId }, { $pull: { invites: { user: user._id } } });
}

/** Karten in der Lobby wählen oder tauschen (bis kurz vor dem Start); ohne cardId bleibt der Charakter offen */
async function changeCards({ user, cardId, boostId }) {
  const party = await partyOf(user._id);
  if (!party) throw new UserError('Du bist für keinen Dungeon angemeldet.');
  if (partyLocked(party)) throw new UserError('Der Dungeon startet gleich – Karten tauschen ist nicht mehr möglich.');
  await inTransaction(async (session) => {
    const m = await memberEntry(user, cardId, boostId, session, { ownDungeon: true });
    const res = await DungeonParty.updateOne(
      { _id: party._id, 'members.user': user._id },
      { $set: { 'members.$.card': m.card, 'members.$.cardDoc': m.cardDoc, 'members.$.boost': m.boost, 'members.$.boostDoc': m.boostDoc } },
      { session }
    );
    if (!res.matchedCount) throw new UserError('Du bist für keinen Dungeon angemeldet.');
  });
}

/** Beute-Fenster nur einmal zeigen: für diesen Spieler als gesehen markieren */
async function markLootSeen(runId, userId) {
  await DungeonRun.updateOne({ _id: runId }, { $set: { 'members.$[m].seen': true } }, { arrayFilters: [{ 'm.user': userId }] });
}

/** Abmelden bzw. Gruppe verlassen (bis kurz vor dem Start). Der Leiter gibt die Leitung weiter. */
async function leave({ user }) {
  const party = await partyOf(user._id);
  if (!party) throw new UserError('Du bist für keinen Dungeon angemeldet.');
  if (partyLocked(party)) throw new UserError('Der Dungeon startet gleich – Abmelden ist nicht mehr möglich.');
  const rest = party.members.filter((m) => !m.user.equals(user._id));
  if (!rest.length) {
    await DungeonParty.deleteOne({ _id: party._id, 'members.user': user._id });
    return;
  }
  const leader = party.leader.equals(user._id) ? rest[0].user : party.leader;
  await DungeonParty.updateOne({ _id: party._id }, { $pull: { members: { user: user._id } }, $set: { leader } });
}

// ---------- Chat ----------
const lastChat = new Map(); // Bremse: höchstens eine Nachricht pro Sekunde und Spieler

async function chat({ user, text }) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_TEXT_MAX);
  if (!clean) return;
  const now = Date.now();
  if (now - (lastChat.get(String(user._id)) || 0) < 1000) throw new UserError('Nicht so schnell.');
  lastChat.set(String(user._id), now);
  const entry = { $push: { chat: { $each: [{ user: user._id, name: user.username, text: clean, at: new Date() }], $slice: -CHAT_MAX } } };
  const res = await DungeonParty.updateOne({ 'members.user': user._id, solo: false }, entry);
  if (res.modifiedCount) return;
  const run = await DungeonRun.updateOne({ 'members.user': user._id, status: 'laeuft' }, entry);
  if (!run.modifiedCount) throw new UserError('Du bist in keiner Gruppe.');
}

// ---------- Start und Ende ----------
/**
 * Wer kann mit? Nur Spieler mit gewähltem Charakter – die anderen fallen beim Start heraus (#111).
 * { players: Mitglieds-Einträge (mit joinedAt), dropped: Nutzer-IDs ohne Charakter }
 */
function splitPlayers(parties) {
  const all = parties.flatMap((p) => p.members); // joinedAt bleibt im Durchlauf (Manipulationserkennung)
  return { players: all.filter((m) => m.card), dropped: all.filter((m) => !m.card && m.user).map((m) => m.user) };
}

/** Spieler um Bots auf TEAM_SIZE auffüllen → [{ ...Mitglied, bot }] */
function fillBots(players) {
  const members = players.map((p) => ({ ...p, bot: false }));
  const usedBots = new Set();
  while (members.length < TEAM_SIZE) {
    const card = botCard();
    const name = BOT_NAMES.find((n) => !usedBots.has(n)) || 'Bot';
    usedBots.add(name);
    const boost = botBoost();
    members.push({ user: null, name, card: card.id, cardDoc: null, boost: boost && boost.id !== card.id ? boost.id : null, boostDoc: null, bot: true });
  }
  return members;
}

/** Mitglieder als Katalog-Karten für fight() */
const teamCards = (members) => members.map((m) => ({ card: catalog.cardById[m.card], boost: m.boost ? catalog.cardById[m.boost] : null }));

/** Ein Team starten: Anmeldungen löschen, Durchlauf anlegen (Bots füllen auf) */
async function startTeam(slot, parties, players, chatLog, now) {
  const dungeon = dungeonForSlot(slot, settings.intervalHours);
  const members = fillBots(players);
  const fights = playDungeon(dungeon, teamCards(members));
  const leaderId = parties.length === 1 && !parties[0].solo ? String(parties[0].leader) : null;
  const runMembers = members.map(({ bot, ...m }) => ({ ...m, leader: !!leaderId && String(m.user) === leaderId, ...rewardsFor(fights, bot) }));
  const success = fights.length === dungeon.fights.length && fights[fights.length - 1].success;
  await inTransaction(async (session) => {
    const ids = parties.map((p) => p._id);
    const del = await DungeonParty.deleteMany({ _id: { $in: ids } }, { session });
    if (del.deletedCount !== ids.length) throw new Error('Dungeon-Anmeldung wurde gleichzeitig verändert.');
    await DungeonRun.create(
      [{ slot, dungeon: dungeon.key, members: runMembers, fights, success, startedAt: new Date(now), endsAt: new Date(now + runSeconds(fights) * 1000), chat: chatLog }],
      { session }
    );
  });
}

/**
 * Mage Tower betreten: nur der Leiter (allein: man selbst), erst wenn alle Mitglieder einen Charakter haben.
 * Offene Einladungen verfallen. Verbraucht den heutigen Versuch aller Mitglieder – das Ergebnis steht sofort fest.
 */
async function startTower({ user, now = Date.now() }) {
  checkTowerOpen(user);
  const party = await DungeonParty.findOne({ 'members.user': user._id }).lean();
  if (!party || party.mode !== 'tower') throw new UserError('Du bist für keinen Mage Tower angemeldet.');
  if (!party.leader.equals(user._id)) throw new UserError('Nur der Gruppenleiter kann den Turm betreten.');
  const waiting = party.members.filter((m) => !m.card);
  if (waiting.length) throw new UserError(`Noch ohne Charakter: ${waiting.map((m) => m.name).join(', ')}.`);
  const day = towerDay(now);
  const humans = party.members.filter((m) => m.user);
  const already = await TowerAttempt.find({ user: { $in: humans.map((m) => m.user) }, day }).select('user').lean();
  if (already.length) {
    const names = humans.filter((m) => already.some((a) => a.user.equals(m.user))).map((m) => m.name);
    throw new UserError(`${names.join(', ')} ${names.length > 1 ? 'waren' : 'war'} heute schon im Mage Tower.`);
  }

  const opts = { ...settings.tower };
  const members = fillBots(party.members);
  const fights = playTower(teamCards(members), random, opts);
  const rounds = fights.filter((f) => f.success).length;
  const leaderId = party.solo ? null : String(party.leader);
  const runMembers = members.map(({ bot, ...m }) => ({ ...m, leader: !!leaderId && String(m.user) === leaderId, ...towerRewardsFor(fights, bot, random, opts) }));
  try {
    await inTransaction(async (session) => {
      const del = await DungeonParty.deleteOne({ _id: party._id, mode: 'tower' }, { session });
      if (!del.deletedCount) throw new UserError('Die Anmeldung wurde gleichzeitig verändert – bitte lade die Seite neu.');
      const [run] = await DungeonRun.create(
        [{
          mode: 'tower',
          slot: new Date(now),
          dungeon: TOWER.key,
          rounds,
          fightSeconds: opts.fightSeconds,
          pause: opts.pauseSeconds,
          members: runMembers,
          fights,
          success: rounds > 0,
          startedAt: new Date(now),
          endsAt: new Date(now + runSeconds(fights, opts.pauseSeconds) * 1000),
          chat: party.chat || [],
        }],
        { session }
      );
      // eindeutiger Index (user, day): ein zweiter Versuch am selben Tag bricht die ganze Transaktion ab
      await TowerAttempt.insertMany(humans.map((m) => ({ user: m.user, day, run: run._id })), { session });
    });
  } catch (err) {
    if (err.code === 11000) throw new UserError('Ein Mitglied war heute schon im Mage Tower.');
    throw err;
  }
  const others = humans.filter((m) => !m.user.equals(user._id)).map((m) => m.user);
  if (others.length) {
    await notify(others, { area: 'Dungeon', href: '/dungeon', text: `${user.username} hat eure Gruppe in den Mage Tower geführt.` }).catch((err) => console.error('Turm-Hinweis fehlgeschlagen:', err.message));
  }
  return { rounds };
}

/** Fällige Anmeldungen starten (force: alle sofort – Admin-Knopf zum Testen). Den Turm startet nur sein Leiter. */
async function startDue({ now = Date.now(), force = false } = {}) {
  const parties = await DungeonParty.find(force ? { mode: { $ne: 'tower' } } : { mode: { $ne: 'tower' }, slot: { $lte: new Date(now) } }).lean();
  const bySlot = new Map();
  parties.forEach((p) => {
    const k = force ? 'jetzt' : String(p.slot.getTime());
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k).push(p);
  });
  let started = 0;
  for (const list of bySlot.values()) {
    const slot = list[0].slot;
    const groups = list.filter((p) => !p.solo).map((p) => [p]);
    // Einzelspieler ohne Charakter kommen gar nicht erst in die Auslosung
    const soloParties = list.filter((p) => p.solo);
    const idle = soloParties.filter((p) => !splitPlayers([p]).players.length);
    const solos = makeTeams(soloParties.filter((p) => !idle.includes(p)));
    const dropped = [];
    for (const team of [...groups, ...solos, ...idle.map((p) => [p])]) {
      try {
        const { players, dropped: out } = splitPlayers(team);
        if (players.length) {
          await startTeam(slot, team, players, team.length === 1 ? team[0].chat : [], now);
          started++;
        } else {
          await DungeonParty.deleteMany({ _id: { $in: team.map((p) => p._id) } }); // niemand mit Charakter: kein Durchlauf
        }
        dropped.push(...out);
      } catch (err) {
        console.error('Dungeon-Start fehlgeschlagen:', err.message);
      }
    }
    if (dropped.length) {
      await notify(dropped, { area: 'Dungeon', href: '/dungeon', text: 'Der Dungeon ist ohne dich gestartet – du hattest keine Charakterkarte gewählt.' }).catch((err) => console.error('Dungeon-Hinweis fehlgeschlagen:', err.message));
    }
  }
  return started;
}

const euroText = (cents) => (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

/** "3 Runden geschafft" / "1 Runde geschafft" / "gleich in der ersten Runde gescheitert" */
const towerResultText = (rounds) => (rounds > 0 ? `${rounds} ${rounds === 1 ? 'Runde' : 'Runden'} geschafft` : 'gleich in der ersten Runde gescheitert');

/** Abgelaufene Durchläufe abschließen: Lohn und Folien gutschreiben, Chat löschen, Karten freigeben */
async function finishDue({ now = Date.now() } = {}) {
  const due = await DungeonRun.find({ status: 'laeuft', endsAt: { $lte: new Date(now) } }).select('_id').lean();
  for (const { _id } of due) {
    try {
      const run = await inTransaction(async (session) => {
        const r = await DungeonRun.findOneAndUpdate({ _id, status: 'laeuft' }, { $set: { status: 'fertig', chat: [] } }, { new: true, session });
        if (!r) return null;
        const d = defOf(r.dungeon);
        for (const m of r.members.filter((x) => x.user)) {
          if (m.reward > 0) {
            await User.updateOne({ _id: m.user }, { $inc: { balance: m.reward } }, { session });
            await Ledger.create([{ user: m.user, type: 'dungeon_lohn', amount: m.reward, betTitle: d ? d.title : null }], { session });
          }
        }
        const foils = r.members.filter((x) => x.user && x.foil).map((x) => x.user);
        // Boss-Karte: ein neues Exemplar je Gewinner, gilt danach als „schon besessen“ (Album) und als selbst erbeutet (#127)
        const card = bossCardOf(r.dungeon);
        const winners = card ? r.members.filter((x) => x.user && x.bossCard).map((x) => x.user) : [];
        if (winners.length) {
          await TcgCard.insertMany(winners.map((user) => ({ user, card: card.id, rarity: card.rarity })), { session });
          await User.updateMany({ _id: { $in: winners } }, { $addToSet: { tcgSeen: card.id, tcgLooted: card.id } }, { session });
        }
        if (foils.length) await grantItems({ userIds: foils, type: 'folie', source: 'dungeon', session });
        return r;
      });
      if (!run) continue;
      const d = defOf(run.dungeon);
      const card = bossCardOf(run.dungeon);
      for (const m of run.members.filter((x) => x.user)) {
        const loot = [m.reward > 0 ? euroText(m.reward) : null, m.foil ? 'eine Folie' : null, m.bossCard && card ? `die Boss-Karte „${card.name}“` : null].filter(Boolean);
        let head = run.success ? `${d ? d.title : 'Dungeon'} geschafft!` : `${d ? d.title : 'Dungeon'}: Rückzug.`;
        if (run.mode === 'tower') head = `Mage Tower: ${towerResultText(run.rounds)}.`;
        await notify([m.user], { area: 'Dungeon', href: '/dungeon', text: loot.length ? `${head} Beute: ${loot.join(', ')}.` : `${head} Diesmal ohne Beute.` });
      }
    } catch (err) {
      console.error('Dungeon-Abschluss fehlgeschlagen:', err.message);
    }
  }
}

/**
 * Seltene Beute aller Spieler (Folie, Boss-Karte) aus abgeschlossenen Durchläufen, neueste zuerst – für die Liste
 * unten auf der Dungeon-Seite (wie "Seltene Ziehungen" im TCG, #78). Namen sind die aktuellen (Umbenennungen).
 */
function lootEntries(runs, nameById = {}) {
  const out = [];
  for (const r of runs) {
    const d = defOf(r.dungeon);
    const card = bossCardOf(r.dungeon);
    for (const m of r.members) {
      if (!m.user || !(m.foil || (m.bossCard && card))) continue;
      out.push({
        name: nameById[String(m.user)] || m.name,
        dungeon: d ? d.title : 'Dungeon',
        foil: !!m.foil,
        card: m.bossCard && card ? { name: card.name, rarity: card.rarity } : null,
        at: r.endsAt,
      });
    }
  }
  return out;
}

async function rareLoot(limit = 10) {
  const runs = await DungeonRun.find({ status: 'fertig', members: { $elemMatch: { user: { $ne: null }, $or: [{ foil: true }, { bossCard: true }] } } })
    .sort({ endsAt: -1 })
    .limit(limit)
    .select('dungeon endsAt members.user members.name members.foil members.bossCard')
    .lean();
  const ids = [...new Set(runs.flatMap((r) => r.members.filter((m) => m.user).map((m) => String(m.user))))];
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select('username').lean() : [];
  return lootEntries(runs, Object.fromEntries(users.map((u) => [String(u._id), u.username]))).slice(0, limit);
}

/** Hat dieser Spieler einen Durchlauf, dessen Zeit um ist? Dann sofort abschließen (statt auf den Job zu warten). */
async function finishOwnDue(userId) {
  const due = await DungeonRun.exists({ 'members.user': userId, status: 'laeuft', endsAt: { $lte: new Date() } });
  if (due) await finishDue();
}

async function tick() {
  await startDue();
  await finishDue();
}

// ---------- Anzeige ----------
/** Alles, was die Dungeon-Seite für diesen Spieler braucht */
async function pageState(userId) {
  const since = new Date(Date.now() - RESULT_MINUTES * 60000);
  const [party, invitations, run, unseen] = await Promise.all([
    DungeonParty.findOne({ 'members.user': userId }).lean(),
    DungeonParty.find({ 'invites.user': userId }).lean(),
    DungeonRun.findOne({ 'members.user': userId, $or: [{ status: 'laeuft' }, { endsAt: { $gte: since } }] }).sort({ startedAt: -1 }).lean(),
    // Beute, deren Fenster noch nicht weggeklickt wurde (auch wenn man zwischendurch woanders war)
    DungeonRun.findOne({ status: 'fertig', endsAt: { $gte: new Date(Date.now() - LOOT_DAYS * 86400000) }, members: { $elemMatch: { user: userId, seen: { $ne: true } } } }).sort({ endsAt: -1 }).lean(),
  ]);
  // Fingerabdruck: ändert er sich, lädt die Seite neu (Beitritte, Einladungen, Start, Ende)
  const rev = crypto
    .createHash('sha1')
    .update(JSON.stringify([party && [party._id, party.leader, party.members.map((m) => [m.user, m.card, m.boost]), party.invites.map((i) => i.user)], invitations.map((p) => p._id), run && [run._id, run.status]]))
    .digest('hex')
    .slice(0, 12);
  return { party, invitations, run, unseen, rev };
}

/** Chat, den dieser Spieler gerade sieht (Gruppe vor dem Start, sonst laufender Durchlauf) */
async function chatFor(userId) {
  const party = await DungeonParty.findOne({ 'members.user': userId, solo: false }).select('chat').lean();
  if (party) return party.chat;
  const run = await DungeonRun.findOne({ 'members.user': userId, status: 'laeuft' }).select('chat').lean();
  return run ? run.chat : null;
}

module.exports = {
  lootEntries,
  rareLoot,
  TEAM_SIZE,
  bossCardOf,
  LOCK_SECONDS,
  INTRO_SECONDS,
  FIGHT_SECONDS,
  PAUSE_SECONDS,
  CHAT_TEXT_MAX,
  DEFAULTS,
  settings,
  loadSettings,
  saveSettings,
  slotAfter,
  registrationSlot,
  isLockedIn,
  botCard,
  botBoost,
  teamEffects,
  fight,
  playDungeon,
  runSeconds,
  rewardsFor,
  MAX_ROUNDS,
  towerDay,
  towerOpen,
  partyLocked,
  playedTowerToday,
  towerRequired,
  towerReward,
  towerChances,
  playTower,
  towerRewardsFor,
  towerResultText,
  registerTower,
  startTower,
  fillBots,
  teamCards,
  makeTeams,
  splitPlayers,
  availableCards,
  register,
  invite,
  invitablePlayers,
  cancelInvite,
  accept,
  decline,
  leave,
  changeCards,
  markLootSeen,
  chat,
  startDue,
  finishDue,
  finishOwnDue,
  tick,
  pageState,
  chatFor,
};

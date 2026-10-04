// Dungeon: alle paar Stunden (Admin-Panel, Standard 2) startet ein Dungeon für je drei Spieler.
// Anmeldung allein (wird beim Start zugelost, fehlende Plätze füllen Bots) oder als Gruppe mit Einladungen
// und eigenem Chat. Ablauf wie bei der IHK: Die Kämpfe (2× Trash, 1× Boss) werden beim Start mit den
// Kartenwerten und Fähigkeiten ausgewürfelt und danach abgespielt; am Ende gibt es Lohn und Beute.
const crypto = require('crypto');
const config = require('../config');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { TcgCard } = require('../models/Tcg');
const { DungeonParty, DungeonRun, DungeonSettings } = require('../models/Dungeon');
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
const { dungeonByKey, dungeonForSlot } = require('./dungeons');

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
};
const settings = JSON.parse(JSON.stringify(DEFAULTS));

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
}

async function saveSettings({ open, intervalHours, required, rewards, foilChance, cardChance, botWeights, admin }) {
  if (!validInterval(intervalHours)) throw new UserError('Der Abstand muss 1, 2, 3, 4, 6, 8, 12 oder 24 Stunden sein.');
  if (!validTriple(required, 1) || required.some((r) => r > 100000)) throw new UserError('Bitte für jeden Kampf gültige Ziel-Punkte angeben (1–100000).');
  if (!validTriple(rewards, 0)) throw new UserError('Bitte für jeden Kampf einen gültigen Lohn angeben.');
  if (!validChance(foilChance) || !validChance(cardChance)) throw new UserError('Die Chancen müssen zwischen 0 und 100 % liegen.');
  if (!validWeights(botWeights)) throw new UserError('Bot-Karten: ganze Zahlen von 0 bis 10000, mindestens eine Seltenheit mit Charakterkarten über 0.');
  const next = { open, intervalHours, required, rewards, foilChance, cardChance, botWeights };
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
const TEAM_KEYS = new Set(['osmanen', 'hund', 'gruschteln', 'hundekarte', 'bloodlust', 'reality-check']);

/** Fähigkeiten eines Spielers: eigene Karte + eigener Boost, dazu die Gruppen-Fähigkeiten der Boosts der anderen */
function teamEffects(members, m) {
  const mem = members[m];
  const out = resolveAll(mem.card, mem.boost ? [mem.boost] : []).map((e) => ({ ...e, from: m }));
  members.forEach((other, o) => {
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
 */
function fight(members, stat, required, rand = random) {
  const events = [];
  const abilities = [];
  let limit = WORK_TIME;
  members.forEach((mem, m) => {
    const effects = teamEffects(members, m);
    const r = simulate(mem.card.stats, stat, required, rand, effects);
    if (effects.length && r.ticks.some((x) => x.ability)) effects.forEach((e) => abilities.push({ m, from: e.from, team: TEAM_KEYS.has(e.key), label: e.label, text: e.text }));
    limit = Math.max(limit, WORK_TIME + r.freeze);
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
  // Wiedergabe in gleichmäßigem Tempo (volle Zeit = FIGHT_SECONDS): ein gewonnener Kampf endet beim Sieg,
  // ein verlorener mit Ablauf der Deadline. Sie beginnt erst eine Sekunde vor dem ersten Treffer (start,
  // Spielzeit) – die Takte davor bringen noch keine Punkte, die Deadline läuft dabei trotzdem.
  const start = Math.max(0, Math.round(((ticks.length ? ticks[0].t : 0) - limit / FIGHT_SECONDS) * 10) / 10);
  const seconds = Math.max(1, Math.round((FIGHT_SECONDS * ((success ? doneAt : limit) - start)) / limit * 10) / 10);
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
const runSeconds = (fights) => INTRO_SECONDS + fights.reduce((s, f) => s + f.seconds, 0) + Math.max(0, fights.length - 1) * PAUSE_SECONDS + END_SECONDS;

/** Karte, die der Boss dieses Dungeons fallen lässt (Katalogkarte), oder null */
function bossCardOf(dungeonKey) {
  const d = dungeonByKey[dungeonKey];
  return (d && d.bossCard && catalog.cardById[d.bossCard]) || null;
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
  const ids = [...new Set(docs.filter(free).map((d) => d.card))];
  const rank = (c) => catalog.rarityByKey[c.rarity].rank;
  const all = ids.map((id) => catalog.cardById[id]).filter(Boolean).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name, 'de'));
  return { characters: all.filter((c) => c.isCharacter), boosts: all.filter((c) => !c.isCharacter && canBoost(c)) };
}

/** Karten prüfen und Exemplare in der Transaktion sperren → Mitglieds-Eintrag */
async function memberEntry(user, cardId, boostId, session, { ownDungeon = false } = {}) {
  const card = catalog.cardById[cardId];
  if (!card || !card.isCharacter) throw new UserError('Bitte wähle eine Charakterkarte aus.');
  let boost = null;
  if (boostId) {
    boost = catalog.cardById[boostId];
    if (!boost || boost.id === card.id || !canBoost(boost)) throw new UserError('Diese Karte hat im Boost-Slot keine Wirkung.');
  }
  if (boost && needsCoffee(boost)) {
    const owned = await TcgCard.distinct('card', { user: user._id }).session(session);
    if (!owned.some((id) => isCoffee(catalog.cardById[id]))) throw new UserError(`${boost.name} kann nur ausgespielt werden, wenn du eine Kaffee-Karte besitzt.`);
  }
  const locked = await lockedDocs(user._id, session);
  // Karten tauschen: die bisher eingesetzten Exemplare sind wieder wählbar
  if (ownDungeon) [...locked.reasons].filter(([, r]) => r === 'dungeon').forEach(([id]) => locked.reasons.delete(id));
  const freeDoc = async (id) => (await TcgCard.find({ user: user._id, card: id }).sort({ createdAt: -1 }).select('_id').session(session).lean()).find((d) => !isLocked(locked, d));
  const doc = await freeDoc(card.id);
  if (!doc) throw new UserError('Diese Karte ist nicht frei (Quest, Handel, Folie oder schon im Dungeon).');
  const boostDoc = boost ? await freeDoc(boost.id) : null;
  if (boost && !boostDoc) throw new UserError('Die Boost-Karte ist nicht frei (Quest, Handel, Folie oder schon im Dungeon).');
  await claim([doc, boostDoc], user._id, session);
  return { user: user._id, name: user.username, card: card.id, cardDoc: doc._id, boost: boost ? boost.id : null, boostDoc: boostDoc ? boostDoc._id : null };
}

const partyOf = (userId) => DungeonParty.findOne({ 'members.user': userId });
const runningRunOf = (userId) => DungeonRun.findOne({ 'members.user': userId, status: 'laeuft' });

function checkOpen(user) {
  if (!settings.open && !user.isAdmin) throw new UserError('Der Dungeon ist derzeit nicht verfügbar.');
}

const duplicate = (err) => {
  if (err.code === 11000) throw new UserError('Du bist schon für einen Dungeon angemeldet.');
  throw err;
};

/** Anmelden: allein (solo) oder als neue Gruppe (du bist Gruppenleiter) */
async function register({ user, cardId, boostId, solo }) {
  checkOpen(user);
  if (await runningRunOf(user._id)) throw new UserError('Du bist gerade in einem Dungeon.');
  if (await partyOf(user._id)) throw new UserError('Du bist schon für einen Dungeon angemeldet.');
  return inTransaction(async (session) => {
    const member = await memberEntry(user, cardId, boostId, session);
    const [party] = await DungeonParty.create([{ slot: registrationSlot(), solo: !!solo, leader: user._id, members: [member] }], { session });
    return party;
  }).catch(duplicate);
}

/** Gruppenleiter lädt ein Mitglied ein (Name) */
async function invite({ user, name }) {
  const party = await partyOf(user._id);
  if (!party || party.solo) throw new UserError('Gründe zuerst eine Gruppe.');
  if (!party.leader.equals(user._id)) throw new UserError('Nur der Gruppenleiter kann einladen.');
  if (isLockedIn(party.slot)) throw new UserError('Der Dungeon startet gleich – Einladungen sind nicht mehr möglich.');
  const target = await User.findOne({ usernameLower: String(name || '').trim().toLowerCase() }).select('_id username').lean();
  if (!target) throw new UserError('Dieses Mitglied gibt es nicht.');
  if (party.members.some((m) => m.user && m.user.equals(target._id))) throw new UserError(`${target.username} ist schon in deiner Gruppe.`);
  if (party.invites.some((i) => i.user.equals(target._id))) throw new UserError(`${target.username} ist schon eingeladen.`);
  // Filter macht es atomar: höchstens drei Plätze (Mitglieder + offene Einladungen)
  const res = await DungeonParty.updateOne(
    { _id: party._id, leader: user._id, 'invites.user': { $ne: target._id }, $expr: { $lt: [{ $add: [{ $size: '$members' }, { $size: '$invites' }] }, TEAM_SIZE] } },
    { $push: { invites: { user: target._id, name: target.username } } }
  );
  if (!res.modifiedCount) throw new UserError('Deine Gruppe ist schon voll.');
  await notify([target._id], { area: 'Dungeon', href: '/dungeon', text: `${user.username} lädt dich in den Dungeon ein.` });
  return target;
}

/** Einladung zurückziehen (Gruppenleiter) */
async function cancelInvite({ user, inviteeId }) {
  await DungeonParty.updateOne({ leader: user._id, 'members.user': user._id }, { $pull: { invites: { user: inviteeId } } });
}

/** Einladung annehmen: mit eigener Karte in die Gruppe */
async function accept({ user, partyId, cardId, boostId }) {
  checkOpen(user);
  if (await runningRunOf(user._id)) throw new UserError('Du bist gerade in einem Dungeon.');
  if (await partyOf(user._id)) throw new UserError('Verlasse zuerst deine aktuelle Anmeldung.');
  const party = await DungeonParty.findOne({ _id: partyId, 'invites.user': user._id }).lean();
  if (!party) throw new UserError('Diese Einladung gibt es nicht mehr.');
  if (isLockedIn(party.slot)) throw new UserError('Der Dungeon startet gleich – Beitreten ist nicht mehr möglich.');
  return inTransaction(async (session) => {
    const member = await memberEntry(user, cardId, boostId, session);
    const res = await DungeonParty.updateOne(
      { _id: party._id, 'invites.user': user._id, [`members.${TEAM_SIZE - 1}`]: { $exists: false } },
      { $pull: { invites: { user: user._id } }, $push: { members: member } },
      { session }
    );
    if (!res.modifiedCount) throw new UserError('Die Gruppe ist schon voll.');
  }).catch(duplicate);
}

async function decline({ user, partyId }) {
  await DungeonParty.updateOne({ _id: partyId }, { $pull: { invites: { user: user._id } } });
}

/** Abmelden bzw. Gruppe verlassen (bis kurz vor dem Start). Der Leiter gibt die Leitung weiter. */
/** Karten tauschen, ohne die Anmeldung oder Gruppe zu verlassen (bis kurz vor dem Start) */
async function changeCards({ user, cardId, boostId }) {
  const party = await partyOf(user._id);
  if (!party) throw new UserError('Du bist für keinen Dungeon angemeldet.');
  if (isLockedIn(party.slot)) throw new UserError('Der Dungeon startet gleich – Karten tauschen ist nicht mehr möglich.');
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

async function leave({ user }) {
  const party = await partyOf(user._id);
  if (!party) throw new UserError('Du bist für keinen Dungeon angemeldet.');
  if (isLockedIn(party.slot)) throw new UserError('Der Dungeon startet gleich – Abmelden ist nicht mehr möglich.');
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
/** Ein Team starten: Anmeldungen löschen, Durchlauf anlegen (Bots füllen auf) */
async function startTeam(slot, parties, players, chatLog, now) {
  const dungeon = dungeonForSlot(slot, settings.intervalHours);
  const members = players.map((p) => ({ ...p, bot: false }));
  const usedBots = new Set();
  while (members.length < TEAM_SIZE) {
    const card = botCard();
    const name = BOT_NAMES.find((n) => !usedBots.has(n)) || 'Bot';
    usedBots.add(name);
    const boost = botBoost();
    members.push({ user: null, name, card: card.id, cardDoc: null, boost: boost && boost.id !== card.id ? boost.id : null, boostDoc: null, bot: true });
  }
  const fights = playDungeon(
    dungeon,
    members.map((m) => ({ card: catalog.cardById[m.card], boost: m.boost ? catalog.cardById[m.boost] : null }))
  );
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

/** Fällige Anmeldungen starten (force: alle sofort – Admin-Knopf zum Testen) */
async function startDue({ now = Date.now(), force = false } = {}) {
  const parties = await DungeonParty.find(force ? {} : { slot: { $lte: new Date(now) } }).lean();
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
    const solos = makeTeams(list.filter((p) => p.solo));
    for (const team of [...groups, ...solos]) {
      try {
        const players = team.flatMap((p) => p.members.map(({ joinedAt, ...m }) => m));
        await startTeam(slot, team, players, team.length === 1 ? team[0].chat : [], now);
        started++;
      } catch (err) {
        console.error('Dungeon-Start fehlgeschlagen:', err.message);
      }
    }
  }
  return started;
}

const euroText = (cents) => (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

/** Abgelaufene Durchläufe abschließen: Lohn und Folien gutschreiben, Chat löschen, Karten freigeben */
async function finishDue({ now = Date.now() } = {}) {
  const due = await DungeonRun.find({ status: 'laeuft', endsAt: { $lte: new Date(now) } }).select('_id').lean();
  for (const { _id } of due) {
    try {
      const run = await inTransaction(async (session) => {
        const r = await DungeonRun.findOneAndUpdate({ _id, status: 'laeuft' }, { $set: { status: 'fertig', chat: [] } }, { new: true, session });
        if (!r) return null;
        const d = dungeonByKey[r.dungeon];
        for (const m of r.members.filter((x) => x.user)) {
          if (m.reward > 0) {
            await User.updateOne({ _id: m.user }, { $inc: { balance: m.reward } }, { session });
            await Ledger.create([{ user: m.user, type: 'dungeon_lohn', amount: m.reward, betTitle: d ? d.title : null }], { session });
          }
        }
        const foils = r.members.filter((x) => x.user && x.foil).map((x) => x.user);
        // Boss-Karte: ein neues Exemplar je Gewinner, gilt danach als „schon besessen“ (Album)
        const card = bossCardOf(r.dungeon);
        const winners = card ? r.members.filter((x) => x.user && x.bossCard).map((x) => x.user) : [];
        if (winners.length) {
          await TcgCard.insertMany(winners.map((user) => ({ user, card: card.id, rarity: card.rarity })), { session });
          await User.updateMany({ _id: { $in: winners } }, { $addToSet: { tcgSeen: card.id } }, { session });
        }
        if (foils.length) await grantItems({ userIds: foils, type: 'folie', source: 'dungeon', session });
        return r;
      });
      if (!run) continue;
      const d = dungeonByKey[run.dungeon];
      const card = bossCardOf(run.dungeon);
      for (const m of run.members.filter((x) => x.user)) {
        const loot = [m.reward > 0 ? euroText(m.reward) : null, m.foil ? 'eine Folie' : null, m.bossCard && card ? `die Boss-Karte „${card.name}“` : null].filter(Boolean);
        const head = run.success ? `${d ? d.title : 'Dungeon'} geschafft!` : `${d ? d.title : 'Dungeon'}: Rückzug.`;
        await notify([m.user], { area: 'Dungeon', href: '/dungeon', text: loot.length ? `${head} Beute: ${loot.join(', ')}.` : `${head} Diesmal ohne Beute.` });
      }
    } catch (err) {
      console.error('Dungeon-Abschluss fehlgeschlagen:', err.message);
    }
  }
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
    .update(JSON.stringify([party && [party._id, party.leader, party.members.map((m) => m.user), party.invites.map((i) => i.user)], invitations.map((p) => p._id), run && [run._id, run.status]]))
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
  makeTeams,
  availableCards,
  register,
  invite,
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

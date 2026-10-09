// Live-Turm für eSports-Teams: Datenbank-Seite um die reine Logik in liveTower.js.
// Ein Lauf ist ein DungeonRun (mode 'tower') mit dem Feld live – so gelten Kartensperren, Beute-Fenster, Protokolle
// und die eSports-Wertung wie beim normalen Turm. Statt alles beim Start auszuwürfeln, wird jeder Kampf erst am Ende
// der Pause gerechnet (mit den Entscheidungen des Teams). Der Server schaltet die Phasen weiter, sobald jemand die
// Seite abfragt oder der Dungeon-Job läuft (advance) – so geht es auch weiter, wenn alle weggeklickt haben.
// Änderungen am Zustand: immer mit live.rev im Filter (gleichzeitige Klicks → einer gewinnt, der andere wiederholt).

const crypto = require('crypto');
const { DungeonRun } = require('../models/Dungeon');
const { TcgCard } = require('../models/Tcg');
const catalog = require('../tcg/catalog');
const cardBans = require('../tcg/cardBans');
const { lockedDocs, isLocked, claim } = require('../tcg/locks');
const { simulate, WORK_TIME } = require('../ihk/ihkService');
const { inTransaction } = require('../services/betService');
const { UserError } = require('../lib/util');
const { TOWER, floorByKey } = require('./tower');
const L = require('./liveTower');

const dungeon = () => require('./dungeonService');
const esports = () => require('../esports/esportsService');
const random = () => crypto.randomInt(1000000) / 1000000;
const SAFETY_HOURS = 6; // so lange sperrt ein Live-Lauf höchstens (falls etwas hängen bleibt)
const TAIL_MS = 1500; // kurze Pause nach dem letzten Treffer, bevor die Phase wechselt

const weekOf = (now) => new Date(esports().weekStart(now)).toISOString().slice(0, 10);
const planFor = (live) => L.weekPlan(live.week, TOWER.floors);
const idxOf = (run, userId) => run.members.findIndex((m) => m.user && String(m.user) === String(userId));

/**
 * Felder für einen neuen Live-Lauf (startTower legt ihn an). members = Anmeldung (Karte, Boost, Kaffee, Energy).
 * opts = Turm-Werte zum Startzeitpunkt (Ziel, Anstieg, Lohn, Beute, Wiedergabe).
 */
function newRunFields(members, opts, now) {
  return {
    fights: [],
    rounds: 0,
    success: false,
    fightSeconds: opts.fightSeconds,
    pause: L.PAUSE_SECONDS,
    endsAt: new Date(now + SAFETY_HOURS * 3600000),
    live: {
      week: weekOf(now),
      n: 0,
      phase: 'start',
      phaseEndsAt: now + L.START_SECONDS * 1000,
      energy: L.ENERGY,
      chosen: [],
      weiter: [],
      bock: members.map(() => 100),
      boostUntil: members.map(() => 0),
      coffeeUsed: members.map(() => false),
      drink: { used: false, by: null, mode: null },
      points: 0,
      opts: { ...opts },
      rev: 0,
    },
  };
}

// ---------- Phasen ----------
/** Nächsten Kampf rechnen (Start t0, ms). Ändert run (Kopie) und gibt nichts zurück. */
function startFight(run, t0) {
  const d = dungeon();
  const live = run.live;
  const n = live.n + 1;
  const floor = planFor(live)[n - 1];
  const required = L.effectiveRequired(d.towerRequired(n, live.opts), floor.trait);
  const applied = L.applyChoices(live.chosen, live.energy, live.boostUntil, t0);
  const cards = d.teamCards(run.members);
  const sims = run.members.map((m, i) => {
    const card = cards[i].card;
    const r = simulate(card.stats, floor.stat, required, random, d.teamEffects(cards, i));
    return { ticks: r.ticks, freeze: r.freeze || 0, extend: r.extend || 0, speed: card.stats.speed };
  });
  const values = cards.map((c) => c.card.stats[floor.stat] || 0);
  const boostUntil = applied.boostUntil.map((ms) => Math.max(0, (ms - t0) / 1000));
  const r = L.playFight(sims, live.bock, values, { required, trait: floor.trait, boostUntil, ext: applied.ext, rand: random, workTime: WORK_TIME, fightSeconds: live.opts.fightSeconds });
  run.fights.push({
    key: floor.key,
    boss: false,
    stat: floor.stat,
    trait: floor.trait || undefined,
    required,
    reward: d.towerReward(n, live.opts),
    limit: r.limit,
    seconds: r.seconds,
    start: 0,
    ticks: r.ticks,
    drains: r.drains,
    abilities: [],
    total: r.total,
    success: r.success,
    doneAt: r.doneAt,
    startAt: t0,
    bockBefore: [...live.bock],
  });
  Object.assign(live, {
    n,
    phase: 'kampf',
    phaseEndsAt: t0 + r.seconds * 1000 + TAIL_MS,
    energy: applied.energy,
    boostUntil: applied.boostUntil,
    bock: r.bock,
    chosen: [],
    weiter: [],
    points: live.points + r.total,
  });
}

/** Lauf beenden: Lohn und Beute festlegen; finishDue zahlt aus (endsAt = jetzt) */
function finish(run, now) {
  const d = dungeon();
  const opts = run.live.opts;
  run.rounds = run.fights.filter((f) => f.success).length;
  run.success = run.rounds > 0;
  run.members = run.members.map((m) => ({ ...m, ...d.towerRewardsFor(run.fights, false, random, opts) }));
  run.endsAt = new Date(now);
  run.live.phase = 'ende';
  run.live.phaseEndsAt = now;
}

/** Phasen bis jetzt weiterschalten (mehrere, falls lange niemand da war). → true, wenn sich etwas geändert hat */
function step(run, now) {
  const live = run.live;
  let changed = false;
  for (let guard = 0; guard < 200 && live.phase !== 'ende'; guard++) {
    const humans = run.members.filter((m) => m.user).length;
    if (live.phase === 'start' || live.phase === 'pause') {
      const allReady = live.phase === 'pause' && live.weiter.length >= humans;
      if (!allReady && now < live.phaseEndsAt) break;
      startFight(run, allReady ? Math.min(now, live.phaseEndsAt) : live.phaseEndsAt);
    } else if (live.phase === 'kampf') {
      if (now < live.phaseEndsAt) break;
      const last = run.fights[run.fights.length - 1];
      if (last && last.success) {
        live.phase = 'pause';
        live.phaseEndsAt = live.phaseEndsAt + L.PAUSE_SECONDS * 1000;
        live.weiter = [];
      } else {
        finish(run, Math.min(now, live.phaseEndsAt));
      }
    }
    changed = true;
  }
  return changed;
}

/** Zustand speichern – nur, wenn niemand dazwischen gespeichert hat (live.rev). → false bei Konflikt */
async function save(run, session = null) {
  const rev = run.live.rev;
  run.live.rev = rev + 1;
  const res = await DungeonRun.updateOne(
    { _id: run._id, status: 'laeuft', 'live.rev': rev },
    { $set: { live: run.live, fights: run.fights, rounds: run.rounds, success: run.success, members: run.members, endsAt: run.endsAt } },
    { session }
  );
  return res.modifiedCount === 1;
}

/** Laufenden Live-Lauf laden und weiterschalten. → run (lean) oder null */
async function load(filter, now = Date.now()) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const run = await DungeonRun.findOne({ ...filter, status: 'laeuft', live: { $ne: null } }).lean();
    if (!run) return null;
    if (!step(run, now)) return run;
    if (await save(run)) return run;
  }
  throw new UserError('Gerade viel los – bitte gleich noch einmal.');
}

const loadFor = (userId, now) => load({ 'members.user': userId }, now);

/** Dungeon-Job: alle Live-Läufe weiterschalten (auch ohne Zuschauer) */
async function advanceAll(now = Date.now()) {
  const runs = await DungeonRun.find({ status: 'laeuft', live: { $ne: null } }).select('_id').lean();
  for (const { _id } of runs) await load({ _id }, now).catch((err) => console.error('Live-Turm:', err.message));
}

// ---------- Aktionen (nur in der Pause) ----------
/**
 * Aktion mit frischem Zustand ausführen: in der Transaktion neu lesen (eine Wiederholung der Transaktion fängt
 * so wieder beim gespeicherten Stand an), weiterschalten, fn(run, i, session) ändert run, speichern.
 */
async function act(user, fn, { needPause = true } = {}) {
  const pre = await loadFor(user._id);
  if (!pre) throw new UserError('Du bist in keinem Live-Turm.');
  let out = null;
  await inTransaction(async (session) => {
    const run = await DungeonRun.findOne({ _id: pre._id, status: 'laeuft' }).session(session).lean();
    if (!run || !run.live) throw new UserError('Der Lauf ist schon vorbei.');
    step(run, Date.now());
    const i = idxOf(run, user._id);
    if (needPause && run.live.phase !== 'pause') throw new UserError('Das geht nur in der Pause.');
    await fn(run, i, session);
    if (!(await save(run, session))) throw new UserError('Gerade viel los – bitte gleich noch einmal.');
    out = run;
  });
  return out;
}

/** Team-Fähigkeit wählen/abwählen (boost, einzel, verl) – jeder im Team darf das */
function choose({ user, key, target }) {
  return act(user, (run, i) => {
    const r = L.toggleChoice(run.live.chosen, run.live.energy, { key, by: i, target });
    if (r.error) throw new UserError(r.error);
    run.live.chosen = r.chosen;
  });
}

/** „Weiter“ drücken oder zurücknehmen */
function weiter({ user }) {
  return act(user, (run, i) => {
    const w = run.live.weiter;
    run.live.weiter = w.includes(i) ? w.filter((x) => x !== i) : [...w, i];
  });
}

/** Eine verbrauchte Karte löschen (Kaffee, Energy) – muss noch dem Spieler gehören */
async function consume(docId, userId, session) {
  const res = await TcgCard.deleteOne({ _id: docId, user: userId }, { session });
  if (!res.deletedCount) throw new UserError('Diese Karte hast du nicht mehr.');
}

/** Eigenen Kaffee trinken: Bock + Wert der Karte (höchstens 100 %) */
function coffee({ user }) {
  return act(user, async (run, i, session) => {
    const m = run.members[i];
    const pct = L.COFFEE[m.coffee];
    if (!m.coffeeDoc || !pct || run.live.coffeeUsed[i]) throw new UserError('Du hast keinen Kaffee mehr.');
    await consume(m.coffeeDoc, m.user, session);
    run.live.coffeeUsed[i] = true;
    run.live.bock[i] = Math.min(100, run.live.bock[i] + pct);
  });
}

/** BfW Energy (einmal pro Lauf): Team-Energie auffüllen oder den Bock eines Spielers auf 100 % */
function drink({ user, mode, target }) {
  return act(user, async (run, i, session) => {
    if (run.live.drink.used) throw new UserError('Ihr habt euer BfW Energy schon getrunken.');
    if (mode === 'bock' && !(Number.isInteger(target) && target >= 0 && target < run.members.length)) throw new UserError('Für wen?');
    if (mode !== 'team' && mode !== 'bock') throw new UserError('Wofür?');
    // eigenes Energy zuerst, sonst das eines Mitspielers
    const holder = [i, ...run.members.map((_, k) => k).filter((k) => k !== i)].find((k) => run.members[k].energyDoc);
    if (holder === undefined) throw new UserError('Niemand hat ein BfW Energy dabei.');
    await consume(run.members[holder].energyDoc, run.members[holder].user, session);
    run.members[holder] = { ...run.members[holder], energyDoc: null };
    run.live.drink = { used: true, by: i, mode, target: mode === 'bock' ? target : null };
    if (mode === 'team') run.live.energy = L.ENERGY + L.spentOf(run.live.chosen); // die gewählten Fähigkeiten bleiben bezahlt
    else run.live.bock[target] = 100;
  });
}

/** Kartenwechsel (nur die eigene Karte): neue Hauptkarte; Bock unter SWITCH_BOCK wird auf SWITCH_BOCK gehoben, darüber bleibt er */
function switchCard({ user, cardId }) {
  return act(user, async (run, i, session) => {
    const card = catalog.cardById[cardId];
    if (!card || !card.isCharacter || !card.stats) throw new UserError('Bitte wähle eine Charakterkarte.');
    if (cardBans.isBanned(card.id, 'tower')) throw new UserError(`${card.name} ist im Mage Tower gesperrt.`);
    const m = run.members[i];
    if (m.card === card.id) throw new UserError('Diese Karte spielst du schon.');
    if (dungeon().towerDuplicate(run.members, m.user, card.id, null)) throw new UserError(`${card.name} ist schon in eurem Team.`);
    const r = L.addSwitch(run.live.chosen, run.live.energy, i);
    if (r.error) throw new UserError(r.error);
    const locked = await lockedDocs(m.user, session);
    const docs = await TcgCard.find({ user: m.user, card: card.id }).sort({ createdAt: -1 }).select('_id').session(session).lean();
    const doc = docs.find((x) => !isLocked(locked, x));
    if (!doc) throw new UserError('Diese Karte ist nicht frei (Quest, Handel, Folie oder schon im Turm).');
    await claim([doc], m.user, session);
    run.members[i] = { ...m, card: card.id, cardDoc: doc._id };
    run.live.chosen = r.chosen;
    run.live.bock[i] = Math.max(run.live.bock[i], L.SWITCH_BOCK);
  });
}

// ---------- Anzeige ----------
const cardView = (id) => {
  const c = id ? catalog.cardById[id] : null;
  if (!c) return null;
  const r = catalog.rarityByKey[c.rarity] || {};
  return { id: c.id, name: c.name, rarity: c.rarity, rarityLabel: r.label || c.rarity, image: c.image, stats: c.stats || null };
};

/** Stockwerk für die Anzeige (Texte aus dem Admin-Panel) */
function floorView(fight, n) {
  const def = floorByKey[fight.key] || {};
  const trait = fight.trait ? L.traitByKey[fight.trait] : null;
  return { n, key: fight.key, title: def.title, text: def.text, successText: def.success, failText: def.fail, stat: fight.stat, trait: trait ? { label: trait.label, text: trait.text } : null };
}

/** Zustand für den Browser (public/js/live-tower.js) */
function view(run, userId, now = Date.now()) {
  const live = run.live;
  const me = idxOf(run, userId);
  const plan = planFor(live);
  const d = dungeon();
  const last = run.fights[run.fights.length - 1] || null;
  let next = null;
  if (live.phase === 'start' || live.phase === 'pause') {
    const n = live.n + 1;
    const f = plan[n - 1];
    const def = floorByKey[f.key] || {};
    const prevTrait = last ? last.trait : null;
    const hidden = n === 1 || prevTrait === 'nebel'; // erstes Stockwerk: selbst herausfinden; Nebel: keine Vorschau
    const trait = f.trait ? L.traitByKey[f.trait] : null;
    next = {
      n,
      hidden,
      stat: hidden ? null : f.stat,
      title: hidden ? null : def.title,
      trait: hidden || !trait ? null : { label: trait.label, text: trait.text },
      required: hidden ? null : L.effectiveRequired(d.towerRequired(n, live.opts), f.trait),
    };
  }
  return {
    now,
    rev: live.rev,
    phase: live.phase,
    n: live.n,
    phaseEndsAt: live.phaseEndsAt,
    me,
    energy: live.energy - L.spentOf(live.chosen),
    energyStart: live.energy,
    energyMax: L.ENERGY,
    costs: L.COSTS,
    overload: L.OVERLOAD,
    pauseSeconds: L.PAUSE_SECONDS,
    boostSeconds: L.BOOST_SECONDS,
    extSeconds: L.EXT_SECONDS,
    chosen: live.chosen.map((c) => ({ key: c.key, by: c.by, byName: run.members[c.by] ? run.members[c.by].name : '', target: c.target })),
    drink: { used: live.drink.used, available: !live.drink.used && run.members.some((m) => m.energyDoc), byName: live.drink.used && run.members[live.drink.by] ? run.members[live.drink.by].name : null },
    players: run.members.map((m, i) => ({
      name: m.name,
      me: i === me,
      card: cardView(m.card),
      boost: cardView(m.boost),
      bock: live.bock[i],
      coffee: m.coffeeDoc && !live.coffeeUsed[i] ? { name: (catalog.cardById[m.coffee] || {}).name || 'Kaffee', rarity: (catalog.cardById[m.coffee] || {}).rarity, pct: L.COFFEE[m.coffee] || 0 } : null,
      weiter: live.weiter.includes(i),
      boostLeft: Math.max(0, Math.round((live.boostUntil[i] - now) / 100) / 10),
    })),
    fight: last
      ? {
          ...floorView(last, run.fights.length),
          required: last.required,
          seconds: last.seconds,
          limit: last.limit,
          startAt: last.startAt,
          ticks: last.ticks,
          drains: last.drains || [],
          total: last.total,
          success: last.success,
          bockBefore: last.bockBefore || [],
          workTime: WORK_TIME,
          fightSeconds: live.opts.fightSeconds,
        }
      : null,
    next,
    rounds: run.fights.filter((f) => f.success).length,
    points: live.points,
    result: live.phase === 'ende' ? { rounds: run.rounds, points: live.points, players: run.members.map((m) => ({ name: m.name, reward: m.reward, foil: m.foil, bossCard: m.bossCard })) } : null,
  };
}

/** Zuletzt beendeter Live-Lauf (für die Ergebnis-Ansicht), höchstens einen Tag alt */
const lastFinished = (userId, now = Date.now()) =>
  DungeonRun.findOne({ 'members.user': userId, live: { $ne: null }, 'live.phase': 'ende', endsAt: { $gte: new Date(now - 86400000) } }).sort({ endsAt: -1 }).lean();

/** Freie eigene Charakterkarten für den Kartenwechsel (ohne gesperrte und solche, die das Team schon spielt) */
async function switchChoices(userId) {
  const run = await DungeonRun.findOne({ 'members.user': userId, status: 'laeuft', live: { $ne: null } }).select('members').lean();
  if (!run) return [];
  const { characters, counts } = await dungeon().availableCards(userId, { ownDungeon: false, mode: 'tower' });
  const taken = new Set(run.members.flatMap((m) => [m.card, m.boost]).filter(Boolean));
  return characters
    .filter((c) => c.stats && counts[c.id] > 0 && !taken.has(c.id) && !cardBans.isBanned(c.id, 'tower'))
    .map((c) => ({ id: c.id, name: c.name, rarity: c.rarity, stats: c.stats }));
}

module.exports = { newRunFields, step, load, loadFor, advanceAll, choose, weiter, coffee, drink, switchCard, view, lastFinished, switchChoices, weekOf };

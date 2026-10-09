/**
 * eSports-Teams: gründen, einladen, austreten, rauswerfen – und der Wochenbericht der Liga.
 * Die Rechnung (Rangliste, Sprünge, Kurswirkung) steht in league.js, hier nur Speichern, Geld und Forum.
 *
 * Ablauf eines Teams:
 *  - Gründung kostet foundCost() (Admin, Startwert FOUND_COST); der Gründer ist Kapitän. Im Forum entsteht unter „eSports“ ein Unterbereich.
 *  - Ab TEAM_SIZE Mitgliedern wird der Team-ETF im Broker gehandelt (Start bei START_PRICE €).
 *  - Fällt ein gehandeltes Team unter TEAM_SIZE, friert es ein (kein Kauf, kein Sprung, kein Rauschen).
 *    Füllt es sich nicht binnen FREEZE_DAYS wieder auf: Konkurs – die Anleger bekommen den Wert zum letzten Kurs
 *    ausgezahlt, jedes übrige Mitglied zahlt BANKRUPT_FEE (was das Guthaben nicht deckt, wird Schuld: debtService).
 *  - Austritt aus einem gehandelten Team kostet LEAVE_FEE (geht an die übrigen Mitglieder), aus einem eingefrorenen
 *    BANKRUPT_FEE (wer das sinkende Schiff verlässt, zahlt wie beim Konkurs). Rauswurf kostet den Rausgeworfenen nichts.
 *  - Sonntags um REPORT_TIME: Wochenbericht – jedes gehandelte Team (schon vor der Woche gehandelt) springt nach
 *    seinem Platz und postet im eigenen Unterbereich. Platz 1–3 bekommen eine Trophäe (Gold, Silber, Bronze) fürs
 *    Teamprofil; jedes Mitglied (schon vor der Woche im Team) bekommt den Preis des Platzes (Geld + Booster Packs, Admin).
 *  - Profil (/esports/team/<kürzel>): Text, Motto, Farbe und Teambild bearbeitet der Kapitän. Das Teambild ist ein
 *    Avatar aus dem Kosmetik-Shop zum halben Preis, bezahlt mit dem Konfetti des Kapitäns, und gehört dem Team.
 */
const mongoose = require('mongoose');
const config = require('../config');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { EsportsTeam, EsportsWeek, EsportsSettings } = require('../models/Esports');
const { TcgPack } = require('../models/Tcg');
const tcgCatalog = require('../tcg/catalog');
const cosmetics = require('../cosmetics/cosmeticService');
const cosmeticCatalog = require('../cosmetics/catalog');
const avatars = require('../profile/avatars');
const { logSettingsChange } = require('../stats/settingsLog');
const { DungeonRun } = require('../models/Dungeon');
const { CoinHolding, CoinTrade } = require('../models/Coin');
const { ForumCategory, ForumThread } = require('../models/Forum');
const { inTransaction } = require('../services/betService');
const debts = require('../services/debtService');
const { notify } = require('../services/notifyService');
const { UserError } = require('../lib/util');
const { toZonedLocalInput, parseZonedLocal } = require('../lib/time');
const model = require('../coin/model');
const { createEngine } = require('../coin/engine');
const markets = require('../coin/markets');
const trade = require('../coin/tradeService');
const systemAuthors = require('../forum/systemAuthors');
const league = require('./league');

const DAY = 24 * 60 * 60 * 1000;
const LIVE = ['offen', 'aktiv', 'eingefroren']; // Teams, in denen man Mitglied sein kann
const LISTED = ['aktiv', 'eingefroren']; // Teams mit ETF im Broker
const frozen = new Set(); // Kürzel eingefrorener Teams – die Engine fragt das bei jedem Tick ab

const euroText = (cents) => (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const categoryKey = (team) => `esports-${team._id}`;
const isOpen = (user) => require('../dungeon/dungeonService').towerOpen(user); // eSports hängt am Mage Tower

function checkOpen(user) {
  if (!isOpen(user)) throw new UserError('eSports ist derzeit nicht verfügbar.');
}

// ---------- Woche ----------

/** Datum (deutsche Zeit) und Wochentag (0 = Sonntag) */
function zoned(now) {
  const day = toZonedLocalInput(new Date(now), config.timezone).slice(0, 10);
  const [y, m, d] = day.split('-').map(Number);
  return { day, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** Letzter fälliger Wochenbericht bis now: { day: "YYYY-MM-DD" (Sonntag), due: Date } */
function lastDue(now = Date.now()) {
  let t = now;
  for (let i = 0; i < 8; i++, t -= DAY) {
    const { day, weekday } = zoned(t);
    if (weekday !== league.REPORT_DAY) continue;
    const due = parseZonedLocal(`${day}T${league.REPORT_TIME}`, config.timezone);
    if (due.getTime() <= now) return { day, due };
  }
  return null;
}

/** Beginn der laufenden Liga-Woche (der letzte Bericht) */
const weekStart = (now = Date.now()) => lastDue(now).due;

// ---------- Engines & Forum-Verfasser ----------

function engineFor(team) {
  return createEngine({
    symbol: team.ticker,
    name: team.name,
    kind: 'etf',
    startPrice: league.START_PRICE,
    params: model.TEAM_PARAMS,
    backfillDays: 0,
    paused: () => frozen.has(team.ticker),
    team: { id: String(team._id), name: team.name },
  });
}

async function registerAuthors() {
  const all = await EsportsTeam.find({}).select('name avatar').lean();
  systemAuthors.register(all.map((t) => ({ id: t._id, name: t.name, avatar: t.avatar ? avatars.urlOf(t.avatar) : null })));
}

// ---------- Einstellungen (Admin): Preise der Trophäen ----------

const SETTINGS_ID = 'esports';
const settings = { prizes: league.DEFAULT_PRIZES.map((p) => ({ ...p })), minTeams: league.DEFAULT_MIN_TEAMS, foundCost: league.FOUND_COST };

function applySettings(doc) {
  if (!doc) return;
  const prizes = Array.isArray(doc.prizes) ? doc.prizes.map((p) => ({ cash: p.cash, packs: p.packs })) : settings.prizes;
  const minTeams = Number.isInteger(doc.minTeams) ? doc.minTeams : settings.minTeams;
  if (Number.isInteger(doc.foundCost) && !league.foundCostError(doc.foundCost)) settings.foundCost = doc.foundCost;
  if (league.prizesError(prizes, minTeams)) return; // kaputte Werte: Startwerte behalten
  settings.prizes = prizes;
  settings.minTeams = minTeams;
}

/** Gründungskosten in Cent (Admin-Panel) */
const foundCost = () => settings.foundCost;

async function loadSettings() {
  applySettings(await EsportsSettings.findById(SETTINGS_ID).lean());
}

/** Admin: Gründungskosten, Preis je Platz (Geld in Cent, Packs) und Mindestzahl der Teams mit Punkten speichern */
async function saveSettings({ admin, prizes, minTeams, foundCost: cost }) {
  const err = league.foundCostError(cost) || league.prizesError(prizes, minTeams);
  if (err) throw new UserError(err);
  const before = { foundCost: settings.foundCost, prizes: settings.prizes.map((p) => ({ ...p })), minTeams: settings.minTeams };
  const clean = { foundCost: cost, prizes: prizes.map((p) => ({ cash: p.cash, packs: p.packs })), minTeams };
  await EsportsSettings.updateOne({ _id: SETTINGS_ID }, { $set: { ...clean, updatedByName: admin.username } }, { upsert: true });
  applySettings(clean);
  await logSettingsChange({ area: 'esports', before, after: clean, by: admin });
}

/** Preise je Platz mit Bezeichnung (für Seite, Regeln und Admin) */
const prizeList = () => league.PLACES.map((p, i) => ({ ...p, ...settings.prizes[i] }));

/** Beim Serverstart (nach markets.start): Forum-Verfasser und die Engines aller gehandelten Teams */
async function start() {
  await registerAuthors();
  await removeClosedCategories();
  await trimTeams();
  const teams = await EsportsTeam.find({ status: { $in: LISTED } }).lean();
  for (const t of teams) {
    if (t.status === 'eingefroren') frozen.add(t.ticker);
    await markets.add(engineFor(t)).catch((err) => console.error(`eSports ${t.ticker}:`, err.message));
  }
}

// ---------- Lesen ----------

const teamOfUser = (userId) => EsportsTeam.findOne({ 'members.user': userId, status: { $in: LIVE } }).lean();

/** Team-ID je Spieler (für die Solo-Warteschlange im Dungeon): Map userId → teamId */
async function teamsOf(userIds) {
  const teams = await EsportsTeam.find({ 'members.user': { $in: userIds }, status: { $in: LIVE } }).select('members.user').lean();
  const out = new Map();
  for (const t of teams) for (const m of t.members) out.set(String(m.user), String(t._id));
  return out;
}

/**
 * Für welches Team zählt ein Mage-Tower-Lauf? Nur wenn alle Spieler Mitglieder desselben gehandelten Teams sind –
 * und zwar schon vor Beginn der laufenden Woche (kein schneller Einkauf starker Spieler vor dem Bericht).
 */
async function towerTeam(userIds, now = Date.now()) {
  if (userIds.length !== league.TEAM_SIZE) return null;
  const team = await EsportsTeam.findOne({ status: 'aktiv', 'members.user': { $all: userIds } }).select('members').lean();
  if (!team) return null;
  const since = weekStart(now);
  const ok = userIds.every((id) => team.members.some((m) => m.user.equals(id) && m.joinedAt <= since));
  return ok ? team._id : null;
}

/** Wertung eines Laufs: Runden und gesammelte Punkte (alle Kämpfe, auch der verlorene) */
const runScore = (r) => ({ rounds: r.rounds || 0, points: (r.fights || []).reduce((s, f) => s + (f.total || 0), 0) });

/** Läufe eines Teams in der laufenden Woche (für die Ergebnis-Ansicht des Live-Turms – nur das eigene Team) */
async function teamWeekRuns(teamId, now = Date.now()) {
  const runs = await DungeonRun.find({ mode: 'tower', esportsTeam: teamId, startedAt: { $gte: weekStart(now) } }).select('rounds fights.total startedAt status').sort({ startedAt: 1 }).lean();
  const list = runs.filter((r) => r.status === 'fertig' || r.rounds).map((r) => ({ at: r.startedAt, ...runScore(r) }));
  const best = new Set([...list].sort((a, b) => b.rounds - a.rounds || b.points - a.points).slice(0, league.TOP_RUNS));
  return list.map((r) => ({ ...r, counts: best.has(r) }));
}

/** Profilfelder mit Startwerten – ältere Teams (vor dem Teamprofil gegründet) haben sie nicht, und .lean() füllt nichts auf */
const withProfile = (t) => ({ ...t, bio: t.bio || '', motto: t.motto || '', color: t.color || null, avatar: t.avatar || null, cosmetics: t.cosmetics || [], trophies: t.trophies || [] });

/** Alle bestehenden Teams für die Übersicht samt Kurs, nach Platz der letzten Woche (ohne Platz zuletzt) – aufgelöste zeigt die Seite nirgends */
async function list() {
  const teams = await EsportsTeam.find({ status: { $in: LIVE } }).lean();
  const order = { aktiv: 0, eingefroren: 1, offen: 2, aufgeloest: 3 };
  return teams
    .map((t) => {
      const e = LISTED.includes(t.status) ? markets.get(t.ticker) : null;
      return { ...withProfile(t), price: e && e.isRunning() ? e.getPrice() : null, path: e ? `/broker/${t.ticker.toLowerCase()}` : null };
    })
    .sort((a, b) => (a.lastRank ?? 999) - (b.lastRank ?? 999) || order[a.status] - order[b.status] || a.createdAt - b.createdAt);
}

/** Team zum Kürzel (aus der Adresse) für das Profil – aufgelöste gibt es nicht mehr */
async function byTicker(raw) {
  const ticker = league.cleanTicker(raw);
  if (!ticker) return null;
  const t = await EsportsTeam.findOne({ ticker, status: { $in: LIVE } }).lean();
  if (!t) return null;
  const e = LISTED.includes(t.status) ? markets.get(t.ticker) : null;
  return { ...withProfile(t), price: e && e.isRunning() ? e.getPrice() : null, path: e ? `/broker/${t.ticker.toLowerCase()}` : null };
}

/** Wochenberichte eines Teams (neueste zuerst): [{ week, rank, of, score, change }] */
async function historyOf(teamId, limit = 12) {
  const weeks = await EsportsWeek.find({ status: 'fertig', 'rows.team': teamId }).sort({ _id: -1 }).limit(limit).lean();
  return weeks.map((w) => {
    const r = w.rows.find((x) => String(x.team) === String(teamId));
    return { week: w._id, rank: r.rank, of: r.of, score: r.score, change: r.change };
  });
}

/** Avatare für das Teambild: halber Preis, Besitz des Teams markiert */
function teamAvatars(team) {
  const owned = team.cosmetics || [];
  return cosmetics.avatars().map((a) => ({ ...a, price: league.teamAvatarPrice(a.price), owned: owned.includes(cosmeticCatalog.ownedKey('avatar', a.key)), worn: team.avatar === a.key }));
}

// ---------- Profil (nur der Kapitän) ----------

async function captainTeam(user) {
  const team = await loadOwnTeam(user);
  if (!team.captain.equals(user._id)) throw new UserError('Nur der Kapitän kann das Teamprofil bearbeiten.');
  return team;
}

/** Text, Motto und Farbe speichern; gibt das Team zurück */
async function updateProfile({ user, bio, motto, color }) {
  const team = await captainTeam(user);
  const c = color ? league.findColor(color) : null;
  if (color && !c) throw new UserError('Diese Farbe gibt es nicht.');
  await EsportsTeam.updateOne({ _id: team._id, captain: user._id }, { $set: { bio: league.cleanBio(bio), motto: league.cleanMotto(motto), color: c ? c.key : null } });
  return team;
}

/** Avatar fürs Team kaufen (halber Preis, Konfetti des Kapitäns) und gleich als Teambild setzen */
async function buyAvatar({ user, key }) {
  const team = await captainTeam(user);
  const it = cosmetics.item('avatar', key);
  if (!it) throw new UserError('Diesen Avatar gibt es nicht.');
  const owned = cosmeticCatalog.ownedKey('avatar', it.key);
  const price = league.teamAvatarPrice(it.price);
  await inTransaction(async (session) => {
    const t = await EsportsTeam.updateOne({ _id: team._id, captain: user._id, status: { $in: LIVE }, cosmetics: { $ne: owned } }, { $addToSet: { cosmetics: owned }, $set: { avatar: it.key } }, { session });
    if (!t.modifiedCount) throw new UserError('Das Team besitzt diesen Avatar schon.');
    const paid = await User.updateOne({ _id: user._id, deletedAt: null, konfetti: { $gte: price } }, { $inc: { konfetti: -price } }, { session });
    if (!paid.modifiedCount) throw new UserError(`Dafür reicht dein ${cosmetics.currencyName()} nicht.`);
    await Ledger.create([{ user: user._id, type: 'kosmetik_kauf', amount: 0, betTitle: `${it.name} (Team ${team.name})`, meta: { kind: 'avatar', item: it.key, konfetti: -price, team: team._id } }], { session });
  });
  await registerAuthors();
  return team;
}

/** Gekauften Team-Avatar als Teambild setzen */
async function wearAvatar({ user, key }) {
  const team = await captainTeam(user);
  const it = cosmetics.item('avatar', key);
  if (!it || !(team.cosmetics || []).includes(cosmeticCatalog.ownedKey('avatar', it.key))) throw new UserError('Diesen Avatar besitzt das Team nicht.');
  await EsportsTeam.updateOne({ _id: team._id, captain: user._id }, { $set: { avatar: it.key } });
  await registerAuthors();
  return team;
}

/** Kapitänsrolle an ein anderes Mitglied abgeben */
async function transferCaptain({ user, userId }) {
  const team = await captainTeam(user);
  if (!mongoose.isValidObjectId(userId) || String(userId) === String(user._id)) throw new UserError('Dieses Mitglied gibt es nicht.');
  const target = team.members.find((m) => m.user.equals(userId));
  if (!target) throw new UserError('Dieses Mitglied gibt es nicht.');
  const res = await EsportsTeam.updateOne({ _id: team._id, captain: user._id, 'members.user': target.user }, { $set: { captain: target.user } });
  if (!res.modifiedCount) throw new UserError('Das Team hat sich gerade geändert – bitte lade die Seite neu.');
  await notify(target.user, { area: 'eSports', href: `/esports/team/${team.ticker.toLowerCase()}`, text: `${user.username} hat dich zum Kapitän von „${team.name}“ gemacht.` });
  return team;
}

/** Offene Einladungen an einen Spieler */
const invitesFor = (userId) => EsportsTeam.find({ 'invites.user': userId, status: { $in: LIVE } }).select('name ticker members').lean();

// ---------- Gründen ----------

async function found({ user, name: rawName, ticker: rawTicker }) {
  checkOpen(user);
  const name = league.cleanName(rawName);
  if (!name) throw new UserError('Teamname: 3–24 Zeichen, Buchstaben, Ziffern, Leerzeichen und . & \' _ -');
  const ticker = league.cleanTicker(rawTicker);
  if (!ticker) throw new UserError('Kürzel: 3–5 Buchstaben (A–Z).');
  if (markets.FIXED.includes(ticker)) throw new UserError('Dieses Kürzel ist schon vergeben.');
  const [own, clash] = await Promise.all([
    teamOfUser(user._id),
    User.exists({ usernameLower: name.toLowerCase() }), // Teamberichte erscheinen unter dem Teamnamen – nie wie ein Mitglied
  ]);
  if (own) throw new UserError('Du bist schon in einem Team.');
  if (clash || /^b(ö|oe)rse$/i.test(name)) throw new UserError('Dieser Name ist schon vergeben.');

  let team;
  try {
    team = await inTransaction(async (session) => {
      const cost = foundCost();
      const paid = cost ? await User.updateOne({ _id: user._id, balance: { $gte: cost } }, { $inc: { balance: -cost } }, { session }) : { modifiedCount: 1 };
      if (!paid.modifiedCount) throw new UserError('Dein Guthaben reicht dafür nicht aus.');
      const [t] = await EsportsTeam.create([{ name, nameLower: name.toLowerCase(), ticker, captain: user._id, members: [{ user: user._id, name: user.username }] }], { session });
      if (cost) await Ledger.create([{ user: user._id, type: 'esports_gruendung', amount: -cost, betTitle: name }], { session });
      return t;
    });
  } catch (err) {
    if (err.code === 11000) throw new UserError(/ticker/.test(err.message) ? 'Dieses Kürzel ist schon vergeben.' : /nameLower/.test(err.message) ? 'Dieser Name ist schon vergeben.' : 'Du bist schon in einem Team.');
    throw err;
  }
  await registerAuthors();
  await createCategory(team).catch((err) => console.error('eSports-Forum:', err.message));
  return team;
}

/** Unterbereich im Forum unter „eSports“ (Name = Teamname) */
async function createCategory(team) {
  const parent = await ForumCategory.findOne({ key: 'esports' }).lean();
  if (!parent) throw new Error('Forum-Bereich „eSports“ fehlt.');
  const count = await ForumCategory.countDocuments({ parent: parent._id });
  const cat = await ForumCategory.create({ title: team.name, description: '', parent: parent._id, order: count, key: categoryKey(team) });
  await EsportsTeam.updateOne({ _id: team._id }, { $set: { category: cat._id } });
}

// ---------- Einladen & Beitreten ----------

async function loadOwnTeam(user) {
  const team = await teamOfUser(user._id);
  if (!team) throw new UserError('Du bist in keinem Team.');
  return withProfile(team);
}

async function invite({ user, username }) {
  checkOpen(user);
  const team = await loadOwnTeam(user);
  if (!team.captain.equals(user._id)) throw new UserError('Nur der Kapitän lädt ein.');
  if (team.members.length >= league.MAX_MEMBERS) throw new UserError(`Ein Team hat höchstens ${league.MAX_MEMBERS} Mitglieder.`);
  const name = String(username || '').trim();
  const target = name ? await User.findOne({ usernameLower: name.toLowerCase(), deletedAt: null }).select('_id username').lean() : null;
  if (!target) throw new UserError('Diesen Spieler gibt es nicht.');
  if (target._id.equals(user._id)) throw new UserError('Du bist schon im Team.');
  if (await teamOfUser(target._id)) throw new UserError(`${target.username} ist schon in einem Team.`);
  const res = await EsportsTeam.updateOne({ _id: team._id, 'invites.user': { $ne: target._id } }, { $push: { invites: { user: target._id, name: target.username } } });
  if (!res.modifiedCount) throw new UserError(`${target.username} ist schon eingeladen.`);
  await notify(target._id, { area: 'eSports', href: '/esports', text: `${user.username} lädt dich ins eSports-Team „${team.name}“ ein.` });
}

async function cancelInvite({ user, userId }) {
  const team = await loadOwnTeam(user);
  if (!team.captain.equals(user._id)) throw new UserError('Nur der Kapitän verwaltet Einladungen.');
  if (!mongoose.isValidObjectId(userId)) return;
  await EsportsTeam.updateOne({ _id: team._id }, { $pull: { invites: { user: userId } } });
}

async function decline({ user, teamId }) {
  if (!mongoose.isValidObjectId(teamId)) return;
  await EsportsTeam.updateOne({ _id: teamId }, { $pull: { invites: { user: user._id } } });
}

async function accept({ user, teamId }) {
  checkOpen(user);
  if (!mongoose.isValidObjectId(teamId)) throw new UserError('Diese Einladung gibt es nicht.');
  let team;
  try {
    team = await EsportsTeam.findOneAndUpdate(
      { _id: teamId, status: { $in: LIVE }, 'invites.user': user._id, [`members.${league.MAX_MEMBERS - 1}`]: { $exists: false } },
      { $push: { members: { user: user._id, name: user.username, joinedAt: new Date() } }, $pull: { invites: { user: user._id } } },
      { new: true }
    ).lean();
  } catch (err) {
    if (err.code === 11000) throw new UserError('Du bist schon in einem Team.');
    throw err;
  }
  if (!team) throw new UserError('Diese Einladung gilt nicht mehr (oder das Team ist voll).');
  await EsportsTeam.updateMany({ _id: { $ne: team._id } }, { $pull: { invites: { user: user._id } } }); // andere Einladungen verfallen
  await afterChange(team);
  await notify(team.members.map((m) => m.user), { area: 'eSports', href: '/esports', text: `${user.username} ist eurem Team „${team.name}“ beigetreten.`, except: user });
}

// ---------- Austreten & Rauswerfen ----------

async function leave({ user }) {
  const team = await loadOwnTeam(user);
  return removeMember(team, user._id, { fee: true });
}

async function kick({ user, userId }) {
  const team = await loadOwnTeam(user);
  if (!team.captain.equals(user._id)) throw new UserError('Nur der Kapitän kann Mitglieder entfernen.');
  if (!mongoose.isValidObjectId(userId) || String(userId) === String(user._id)) throw new UserError('Dieses Mitglied gibt es nicht.');
  const target = team.members.find((m) => m.user.equals(userId));
  if (!target) throw new UserError('Dieses Mitglied gibt es nicht.');
  await removeMember(team, target.user, { fee: false });
  await notify(target.user, { area: 'eSports', href: '/esports', text: `Du wurdest aus dem eSports-Team „${team.name}“ entfernt.` });
}

/**
 * Mitglied entfernen. fee: Austritt (Gebühr je nach Status) – beim Rauswurf zahlt niemand.
 * Reicht das Guthaben nicht, wird der Rest zur Schuld und von allen künftigen Einnahmen getilgt.
 */
async function removeMember(team, userId, { fee }) {
  const rest = team.members.filter((m) => !m.user.equals(userId));
  const cost = !fee ? 0 : team.status === 'aktiv' ? league.LEAVE_FEE : team.status === 'eingefroren' ? league.BANKRUPT_FEE : 0;
  const captain = team.captain.equals(userId) && rest.length ? rest.slice().sort((a, b) => a.joinedAt - b.joinedAt)[0].user : team.captain;
  const updated = await inTransaction(async (session) => {
    const t = await EsportsTeam.findOneAndUpdate({ _id: team._id, 'members.user': userId }, { $pull: { members: { user: userId } }, $set: { captain } }, { new: true, session }).lean();
    if (!t) throw new UserError('Die Mitgliedschaft hat sich gerade geändert – bitte lade die Seite neu.');
    if (cost) {
      // Was das Guthaben nicht deckt, wird Schuld (debtService) – Ausgeben vorher hilft also nicht
      const { paid: take } = await debts.charge(userId, cost, { type: team.status === 'aktiv' ? 'esports_austritt' : 'esports_konkurs', title: team.name }, session);
      if (take) {
        // Austritt aus einem gehandelten Team: der sofort bezahlte Teil geht an die übrigen Mitglieder
        if (team.status === 'aktiv' && t.members.length) {
          const shares = league.splitFee(take, t.members.length);
          for (const [i, m] of t.members.entries()) {
            if (!shares[i]) continue;
            await User.updateOne({ _id: m.user }, { $inc: { balance: shares[i] } }, { session });
            await Ledger.create([{ user: m.user, type: 'esports_anteil', amount: shares[i], betTitle: team.name }], { session });
          }
        }
      }
    }
    return t;
  });
  await afterChange(updated);
  return updated;
}

/**
 * Teams über MAX_MEMBERS (nach dem Senken der Obergrenze): die zuletzt Beigetretenen verlassen das Team,
 * ohne Gebühr wie beim Rauswurf; der Kapitän bleibt. Läuft beim Start, danach verhindert invite/accept zu große Teams.
 */
async function trimTeams() {
  const teams = await EsportsTeam.find({ status: { $in: LIVE }, [`members.${league.MAX_MEMBERS}`]: { $exists: true } }).lean();
  for (const team of teams) {
    let current = team;
    for (const m of league.overflow(team.members, team.captain)) {
      current = await removeMember(current, m.user, { fee: false });
      await notify(m.user, { area: 'eSports', href: '/esports', text: `eSports-Teams haben jetzt höchstens ${league.MAX_MEMBERS} Mitglieder. Du warst unter den zuletzt Beigetretenen und bist nicht mehr im Team „${team.name}“ – ohne Gebühr.` });
      console.log(`eSports: ${m.name} aus „${team.name}“ entfernt (höchstens ${league.MAX_MEMBERS} Mitglieder).`);
    }
  }
}

/** Nach jeder Änderung der Mitglieder: ETF starten, einfrieren, auftauen oder das leere Team auflösen */
async function afterChange(team) {
  const n = team.members.length;
  if (!n) return close(team, { reason: 'leer' });
  if (n >= league.TEAM_SIZE && team.status === 'offen') {
    const t = await EsportsTeam.findOneAndUpdate({ _id: team._id, status: 'offen' }, { $set: { status: 'aktiv', listedAt: new Date() } }, { new: true }).lean();
    if (t) await markets.add(engineFor(t));
  } else if (n >= league.TEAM_SIZE && team.status === 'eingefroren') {
    const t = await EsportsTeam.findOneAndUpdate({ _id: team._id, status: 'eingefroren' }, { $set: { status: 'aktiv', frozenAt: null } }, { new: true }).lean();
    if (t) frozen.delete(t.ticker);
  } else if (n < league.TEAM_SIZE && team.status === 'aktiv') {
    const t = await EsportsTeam.findOneAndUpdate({ _id: team._id, status: 'aktiv' }, { $set: { status: 'eingefroren', frozenAt: new Date() } }, { new: true }).lean();
    if (t) {
      frozen.add(t.ticker);
      await notify(t.members.map((m) => m.user), { area: 'eSports', href: '/esports', text: `„${t.name}“ hat weniger als ${league.TEAM_SIZE} Mitglieder und ist eingefroren – ohne neue Mitglieder binnen ${league.FREEZE_DAYS} Tagen folgt der Konkurs.` });
    }
  }
  return null;
}

/**
 * Team auflösen. Gehandelte Teams: Anleger bekommen den Wert zum letzten Kurs (ohne Steuer), der ETF verschwindet.
 * reason 'konkurs': jedes übrige Mitglied zahlt BANKRUPT_FEE (höchstens sein Guthaben).
 */
async function close(team, { reason }) {
  const engine = markets.get(team.ticker);
  const price = engine && engine.isRunning() ? engine.getPrice() : null;
  const holders = price !== null ? await CoinHolding.find({ coin: team.ticker, units: { $gt: 0 } }).lean() : [];
  const done = await inTransaction(async (session) => {
    const t = await EsportsTeam.findOneAndUpdate({ _id: team._id, status: { $in: LIVE } }, { $set: { status: 'aufgeloest', closedAt: new Date(), members: [], invites: [] } }, { session }).lean();
    if (!t) return null;
    for (const h of holders) {
      const cents = trade.valueCents(h.units, price);
      await CoinHolding.updateOne({ _id: h._id }, { $set: { units: 0, costCents: 0 } }, { session });
      if (cents <= 0) continue;
      await User.updateOne({ _id: h.user }, { $inc: { balance: cents } }, { session });
      await CoinTrade.create([{ user: h.user, coin: team.ticker, side: 'verkauf', units: h.units, price, cents, tax: 0 }], { session });
      await Ledger.create([{ user: h.user, type: 'esports_auszahlung', amount: cents, betTitle: team.name }], { session });
    }
    if (reason === 'konkurs') {
      for (const m of t.members) await debts.charge(m.user, league.BANKRUPT_FEE, { type: 'esports_konkurs', title: team.name }, session);
    }
    return t;
  });
  if (!done) return null;
  frozen.delete(team.ticker);
  await markets.remove(team.ticker);
  await removeCategory(done).catch((err) => console.error(`eSports-Forum ${team.ticker}:`, err.message));
  const text = reason === 'konkurs' ? `„${team.name}“ ist in Konkurs gegangen.` : `„${team.name}“ hat sich aufgelöst.`;
  if (holders.length) await notify(holders.map((h) => h.user), { area: 'Broker', href: '/broker', text: `${text} Deine Anteile wurden zum letzten Kurs ausgezahlt.` });
  if (reason === 'konkurs') await notify(done.members.map((m) => m.user), { area: 'eSports', href: '/esports', text: `${text} Jedes Mitglied zahlt ${euroText(league.BANKRUPT_FEE)} €.` });
  return done;
}

/** Forum-Unterbereich eines aufgelösten Teams samt Themen entfernen (wie „Bereich löschen“ im Forum) */
async function removeCategory(team) {
  const cat = team.category || (await ForumCategory.findOne({ key: categoryKey(team) }).select('_id').lean())?._id;
  if (!cat) return;
  await ForumCategory.deleteOne({ _id: cat });
  await ForumThread.updateMany({ category: cat, deleted: false }, { $set: { deleted: true } });
  await EsportsTeam.updateOne({ _id: team._id }, { $set: { category: null } });
}

/** Beim Start: Forum-Bereiche schon aufgelöster Teams entfernen (früher blieben sie als „(aufgelöst)“ stehen) */
async function removeClosedCategories() {
  const closed = await EsportsTeam.find({ status: 'aufgeloest' }).select('_id category').lean();
  for (const t of closed) await removeCategory(t).catch((err) => console.error('eSports-Forum:', err.message));
}

/** Job: eingefrorene Teams nach FREEZE_DAYS in den Konkurs schicken */
async function closeExpired(now = Date.now()) {
  const due = await EsportsTeam.find({ status: 'eingefroren', frozenAt: { $lte: new Date(now - league.FREEZE_DAYS * DAY) } }).lean();
  for (const t of due) await close(t, { reason: 'konkurs' }).catch((err) => console.error(`eSports-Konkurs ${t.ticker}:`, err.message));
  return due.length;
}

// ---------- Wochenbericht ----------

/** Ist der Wochenbericht fällig und noch nicht da? Dann auswerten, Kurse springen lassen, im Forum posten. */
async function runDue(now = Date.now()) {
  const last = lastDue(now);
  if (!last || zoned(now).day !== last.day) return null; // nur am Sonntag selbst nachholen
  const from = new Date(last.due.getTime() - 7 * DAY);
  try {
    await EsportsWeek.create({ _id: last.day, from, to: last.due });
  } catch (err) {
    if (err.code === 11000) return null;
    throw err;
  }
  try {
    return await publish(last.day, from, last.due);
  } catch (err) {
    await EsportsWeek.deleteOne({ _id: last.day, status: 'laeuft' }).catch(() => {});
    throw err;
  }
}

async function publish(day, from, to) {
  // Nur Teams, die schon die ganze Woche gehandelt wurden; eingefrorene setzen aus
  const teams = await EsportsTeam.find({ status: 'aktiv', listedAt: { $lte: from } }).lean();
  const runs = teams.length
    ? await DungeonRun.find({ mode: 'tower', esportsTeam: { $in: teams.map((t) => t._id) }, startedAt: { $gte: from, $lt: to } }).select('esportsTeam rounds fights.total').lean()
    : [];
  const rows = league.rankWeek(teams.map((t) => ({ id: String(t._id), prevRank: t.lastRank, runs: runs.filter((r) => r.esportsTeam.equals(t._id)).map(runScore) })));
  const out = [];
  const won = new Map(league.trophies(rows, settings.minTeams).map((t) => [t.id, t.place]));
  const prizes = prizeList();
  const [y, m, d] = day.split('-');
  const forumService = require('../forum/forumService'); // erst hier laden: zieht viele Module nach sich
  for (const row of rows) {
    const team = teams.find((t) => String(t._id) === row.id);
    const engine = markets.get(team.ticker);
    if (!engine || !engine.isRunning()) continue;
    const jump = await engine.jump(row.log, Math.max(-1, Math.min(1, row.log / 0.2)));
    await EsportsTeam.updateOne({ _id: team._id }, { $set: { lastRank: row.rank, lastOf: row.of, lastChange: row.change } });
    const place = won.get(row.id) || null;
    if (place) await awardTrophy(team, { day, from, place, score: row.score, prize: prizes[place - 1] }).catch((err) => console.error(`eSports-Trophäe ${team.ticker}:`, err.message));
    out.push({ team: team._id, name: team.name, ticker: team.ticker, rank: row.rank, of: row.of, score: row.score, change: row.change, priceBefore: jump.before, priceAfter: jump.after, trophy: place });
    const text = league.reportText(team, row, `${d}.${m}.${y}`, place);
    await forumService
      .systemThread({ author: { id: team._id, name: team.name }, categoryKey: categoryKey(team), title: text.title, body: text.body })
      .catch((err) => console.error(`eSports-Bericht ${team.ticker}:`, err.message));
  }
  await EsportsWeek.updateOne({ _id: day }, { $set: { status: 'fertig', rows: out } });
  if (out.length) console.log(`eSports-Wochenbericht ${day}: ${out.length} Teams`);
  return out;
}

/**
 * Trophäe ins Teamprofil und Preis an jedes Mitglied, das schon vor der Woche im Team war – alles in einer
 * Transaktion; die Trophäe je Woche gibt es nur einmal (ein wiederholter Bericht zahlt nicht doppelt).
 */
async function awardTrophy(team, { day, from, place, score, prize }) {
  const winners = league.prizeMembers(team.members, from);
  const label = league.placeInfo(place).label;
  const paid = await inTransaction(async (session) => {
    const t = await EsportsTeam.updateOne({ _id: team._id, 'trophies.week': { $ne: day } }, { $push: { trophies: { week: day, place, score } } }, { session });
    if (!t.modifiedCount) return false;
    for (const m of winners) {
      if (prize.cash) {
        await User.updateOne({ _id: m.user }, { $inc: { balance: prize.cash } }, { session });
        await Ledger.create([{ user: m.user, type: 'esports_preis', amount: prize.cash, betTitle: `${team.name} · ${label}`, meta: { week: day, place, packs: prize.packs } }], { session });
      }
      if (prize.packs) await TcgPack.insertMany(Array.from({ length: prize.packs }, () => ({ user: m.user, type: tcgCatalog.DEFAULT_PACK, source: 'esports', cost: 0 })), { session });
    }
    return true;
  });
  if (!paid || !winners.length) return;
  const parts = [prize.cash ? euroText(prize.cash) + ' €' : '', prize.packs ? `${prize.packs} Booster ${prize.packs === 1 ? 'Pack' : 'Packs'}` : ''].filter(Boolean).join(' und ');
  await notify(winners.map((m) => m.user), {
    area: 'eSports',
    href: `/esports/team/${team.ticker.toLowerCase()}`,
    text: `„${team.name}“ holt die ${label}-Trophäe der Woche!${parts ? ` Dein Preis: ${parts}.` : ''}`,
  });
}

const lastWeek = () => EsportsWeek.findOne({ status: 'fertig' }).sort({ _id: -1 }).lean();

module.exports = {
  isOpen,
  lastDue,
  weekStart,
  start,
  teamOfUser,
  teamsOf,
  towerTeam,
  teamWeekRuns,
  list,
  byTicker,
  historyOf,
  teamAvatars,
  updateProfile,
  buyAvatar,
  wearAvatar,
  transferCaptain,
  loadSettings,
  saveSettings,
  prizeList,
  foundCost,
  settings,
  invitesFor,
  found,
  invite,
  cancelInvite,
  accept,
  decline,
  leave,
  kick,
  close,
  closeExpired,
  awardTrophy,
  runDue,
  lastWeek,
};

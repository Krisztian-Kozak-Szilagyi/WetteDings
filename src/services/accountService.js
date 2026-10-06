const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Comment = require('../models/Comment');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const { ForumThread, ForumPost, ForumRead, ForumReport, ForumModLog, ForumReaction } = require('../models/Forum');
const RegistrationCode = require('../models/RegistrationCode');
const { LotteryRound, LotteryEntry } = require('../models/Lottery');
const { TcgCard, TcgPack, TcgOpening, PackGrant } = require('../models/Tcg');
const { Item, ItemStack } = require('../models/Item');
const Group = require('../models/Group');
const roles = require('./roles');
const { CoinHolding } = require('../models/Coin');
const { IhkRun, IhkState } = require('../models/Ihk');
const { GradingShop, GradingJob } = require('../models/Grading');
const { Trade, TradeTalk } = require('../models/Trade');
const { DungeonParty, DungeonRun } = require('../models/Dungeon');
const { inTransaction } = require('./betService');
const { UserError } = require('../lib/util');
const deviceService = require('../device/deviceService');

const { NAME_PATTERN, NAME_HINT, assertUsernameAllowed } = require('./usernameRules');

const RENAME_COOLDOWN_DAYS = 7; // so lange muss man nach einer Namensänderung bis zur nächsten warten
const DAY = 24 * 60 * 60 * 1000;

/**
 * Der Benutzername steht an vielen Stellen als Kopie (damit Listen ohne Nachschlagen auskommen).
 * Hier werden alle Kopien auf den neuen Namen gesetzt. Wo keine Nutzer-ID daneben gespeichert ist,
 * wird über den alten Namen gesucht – Namen sind eindeutig.
 */
async function propagateName(userId, oldName, name, session) {
  const opt = { session };
  await Promise.all([
    Bet.updateMany({ creator: userId }, { $set: { creatorName: name } }, opt),
    Bet.updateMany({ referee: userId }, { $set: { refereeName: name } }, opt),
    Group.updateMany({ owner: userId }, { $set: { ownerName: name } }, opt),
    Bet.updateMany({ resolvedBy: userId }, { $set: { resolvedByName: name } }, opt),
    Bet.updateMany({ 'votes.by': userId }, { $set: { 'votes.$[v].byName': name } }, { ...opt, arrayFilters: [{ 'v.by': userId }] }),
    Bet.updateMany({ 'edits.byName': oldName }, { $set: { 'edits.$[e].byName': name } }, { ...opt, arrayFilters: [{ 'e.byName': oldName }] }),
    Comment.updateMany({ user: userId }, { $set: { username: name } }, opt),
    Comment.updateMany({ deletedByName: oldName }, { $set: { deletedByName: name } }, opt),
    Position.updateMany({ user: userId }, { $set: { username: name } }, opt),
    LotteryEntry.updateMany({ user: userId }, { $set: { username: name } }, opt),
    LotteryRound.updateMany({ winner: userId }, { $set: { winnerName: name } }, opt),
    ForumThread.updateMany({ author: userId }, { $set: { authorName: name } }, opt),
    ForumThread.updateMany({ lastPostBy: userId }, { $set: { lastPostByName: name } }, opt),
    ForumPost.updateMany({ author: userId }, { $set: { authorName: name } }, opt),
    ForumReport.updateMany({ by: userId }, { $set: { byName: name } }, opt),
    ForumReaction.updateMany({ user: userId }, { $set: { userName: name } }, opt),
    RegistrationCode.updateMany({ createdBy: userId }, { $set: { createdByName: name } }, opt),
    RegistrationCode.updateMany({ usedBy: userId }, { $set: { usedByName: name } }, opt),
    TcgOpening.updateMany({ user: userId }, { $set: { username: name } }, opt),
    Trade.updateMany({ seller: userId }, { $set: { sellerName: name } }, opt),
    Trade.updateMany({ buyer: userId }, { $set: { buyerName: name } }, opt),
    Trade.updateMany({ to: userId }, { $set: { toName: name } }, opt),
    TradeTalk.updateMany({ seller: userId }, { $set: { sellerName: name } }, opt),
    TradeTalk.updateMany({ to: userId }, { $set: { toName: name } }, opt),
    PackGrant.updateMany({ by: userId }, { $set: { byName: name } }, opt),
    PackGrant.updateMany({ to: userId }, { $set: { toName: name } }, opt),
  ]);
  // Dungeon: Plätze, Einladungen und Chat (nacheinander, weil es dieselben Dokumente sind)
  for (const M of [DungeonParty, DungeonRun]) {
    await M.updateMany({ 'members.user': userId }, { $set: { 'members.$[m].name': name } }, { ...opt, arrayFilters: [{ 'm.user': userId }] });
    await M.updateMany({ 'chat.user': userId }, { $set: { 'chat.$[c].name': name } }, { ...opt, arrayFilters: [{ 'c.user': userId }] });
  }
  await DungeonParty.updateMany({ 'invites.user': userId }, { $set: { 'invites.$[i].name': name } }, { ...opt, arrayFilters: [{ 'i.user': userId }] });
}

/** Wann darf der Name frühestens wieder geändert werden? (null = sofort) */
function nextRenameAt(user) {
  if (!user.usernameChangedAt) return null;
  const at = new Date(new Date(user.usernameChangedAt).getTime() + RENAME_COOLDOWN_DAYS * DAY);
  return at > new Date() ? at : null;
}

/** Benutzernamen ändern – überall, wo er angezeigt wird */
async function rename({ user, username }) {
  // Admin-Rechte hängen am Benutzernamen (ADMIN_USERNAMES) – deshalb bleibt der Name von Admins fest
  if (user.isAdmin) throw new UserError('Admin-Konten können ihren Namen nicht ändern – die Admin-Rechte hängen am Benutzernamen.');
  const name = assertUsernameAllowed(username); // Muster und reservierte Namen
  if (name === user.username) throw new UserError('Das ist bereits dein Benutzername.');
  const lower = name.toLowerCase();
  if (nextRenameAt(user)) throw new UserError(`Du kannst deinen Namen nur alle ${RENAME_COOLDOWN_DAYS} Tage ändern.`);

  try {
    await inTransaction(async (session) => {
      await User.updateOne({ _id: user._id }, { $set: { username: name, usernameLower: lower, usernameChangedAt: new Date() } }, { session });
      await propagateName(user._id, user.username, name, session);
      // Mod-Log nur beim Umbenennen – nach einer Kontolöschung bleibt dort der Name stehen, unter dem gehandelt wurde
      await ForumModLog.updateMany({ by: user._id }, { $set: { byName: name } }, { session });
    });
  } catch (err) {
    if (err && err.code === 11000) throw new UserError('Dieser Benutzername ist bereits vergeben.');
    throw err;
  }
  await roles.load(); // Dev-Abzeichen folgt dem neuen Namen
  return name;
}

/**
 * Konto löschen (Art. 17 DSGVO). Alle persönlichen Angaben und der eigene Spielstand werden entfernt.
 * Das Nutzer-Dokument bleibt als leere Hülle mit neutralem Namen bestehen, damit gemeinsame Wetten
 * (Einsätze, Töpfe, Auszahlungen) für die anderen Mitglieder nachvollziehbar und abrechenbar bleiben.
 * Aus demselben Grund bleiben die rein spielbezogenen Verläufe (Kontoauszug, Coin-Trades, Pack-Öffnungen,
 * abgeschlossene IHK-Quests) an der anonymen Hülle stehen – sonst würde sich die Statistik (Geldquellen
 * und -senken, Pull-Raten, Erfolgsquoten) rückwirkend ändern. Personenbezogene Angaben enthalten sie nicht.
 */
async function deleteAccount({ user, password }) {
  if (user.isAdmin) throw new UserError('Admin-Konten können nicht gelöscht werden. Entferne zuerst die Admin-Rechte.');
  const doc = await User.findById(user._id).select('passwordHash');
  if (!doc || !(await bcrypt.compare(String(password || ''), doc.passwordHash))) throw new UserError('Das Passwort ist falsch.');

  const id = user._id;
  const anon = `geloescht-${String(id).slice(-8)}`;
  await inTransaction(async (session) => {
    const opt = { session };
    // Vorher-Stand zurückgeben: das restliche Guthaben wird unten als Abgang gebucht
    const old = await User.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          username: anon,
          usernameLower: anon,
          email: `${anon}@geloescht.invalid`,
          passwordHash: crypto.randomBytes(32).toString('hex'), // kein gültiger Hash → Anmeldung unmöglich
          balance: 0,
          deletedAt: new Date(),
          role: null,
          realName: null,
          tcgProtected: [],
          tcgFavorites: [],
          bio: '',
          pinnedAchievements: [],
          tcgSeen: [],
        },
        $unset: { lastBonusDay: '', marketSeenAt: '', packsSeenAt: '', patchSeenAt: '', usernameChangedAt: '', supportConsentAt: '' },
      },
      { ...opt, projection: { balance: 1 } }
    );
    // Das verfallene Guthaben verlässt die Wirtschaft: als Buchung festhalten, damit die Geldmenge
    // (Summe aller Buchungen) weiter zu den Kontoständen passt
    if (old && old.balance > 0) await Ledger.create([{ user: id, type: 'konto_geloescht', amount: -old.balance }], opt);
    await propagateName(id, user.username, anon, session);
    await Promise.all([
      TcgCard.deleteMany({ user: id }, opt),
      TcgPack.deleteMany({ user: id }, opt),
      Item.deleteMany({ user: id }, opt),
      ItemStack.deleteMany({ user: id }, opt),
      CoinHolding.deleteMany({ user: id }, opt),
      // laufende Quest abbrechen (ihre Karte gibt es nicht mehr); abgeschlossene bleiben für die Statistik
      IhkRun.deleteMany({ user: id, status: 'laeuft' }, opt),
      IhkState.deleteOne({ _id: id }, opt),
      GradingShop.deleteOne({ _id: id }, opt),
      GradingJob.deleteMany({ user: id }, opt),
      require('../models/Deck').deleteMany({ user: id }, opt),
      // offene Handelsangebote verschwinden; abgeschlossene bleiben (mit neutralem Namen) für die Gegenseite
      Trade.deleteMany({ seller: id, status: 'offen' }, opt),
      Trade.updateMany({ to: id, status: 'offen' }, { $set: { status: 'abgelehnt', closedAt: new Date() } }, opt),
      TradeTalk.updateMany({ $or: [{ seller: id }, { to: id }], status: 'offen' }, { $set: { status: 'beendet' } }, opt),
      // Kommentare: Text entfernen
      Comment.updateMany({ user: id }, { $set: { deleted: true, text: '' } }, opt),
      // Forum: Texte der eigenen Beiträge entfernen (auch das aufbewahrte Original), Upvotes und Lesestände löschen
      ForumPost.updateMany({ author: id }, { $set: { deleted: true, deletedByRole: 'autor', body: '', original: null } }, opt),
      ForumThread.updateMany({ upvotes: id }, { $pull: { upvotes: id } }, opt),
      ForumRead.deleteMany({ user: id }, opt),
      ForumReport.deleteMany({ by: id }, opt),
      // Reaktionen zeigen den Namen im Tooltip → entfernen. Umfrage-Stimmen bleiben an der anonymen Hülle:
      // sie enthalten nur die gewählte Antwort und sind nirgends einem Namen zugeordnet; so ändern sich
      // abgeschlossene Ergebnisse nicht rückwirkend (wie bei den Spielverläufen oben)
      ForumReaction.deleteMany({ user: id }, opt),
      require('../models/Notification').deleteMany({ user: id }, opt),
      // Erfolge löschen – nur Einzelstücke bleiben an der neutralen Hülle, damit sie nie ein zweites Mal vergeben werden
      require('../models/Achievement').deleteMany({ user: id, key: { $nin: require('../achievements/list').SPECIAL.map(([k]) => k) } }, opt),
      // Wett-Gruppen: eigene werden aufgelöst, aus fremden tritt das Konto aus
      Group.updateMany({ owner: id }, { $set: { deleted: true } }, opt),
      Group.updateMany({ members: id, owner: { $ne: id } }, { $pull: { members: id } }, opt),
    ]);
    // Nachrichten aus Verhandlungen entfernen (nacheinander, weil dieselben Angebote oben schon geändert werden)
    await Trade.updateMany({ seller: id }, { $pull: { messages: { from: 'seller' } } }, opt);
    await Trade.updateMany({ to: id }, { $pull: { messages: { from: 'to' } } }, opt);
    await TradeTalk.updateMany({ seller: id }, { $pull: { messages: { from: 'seller' } } }, opt);
    await TradeTalk.updateMany({ to: id }, { $pull: { messages: { from: 'to' } } }, opt);
    // Dungeon: Anmeldungen verlassen (leere verschwinden, die Leitung geht weiter), Chat-Nachrichten entfernen;
    // im laufenden Durchlauf spielt der Platz ohne Lohn zu Ende (die Karte gibt es nicht mehr)
    await DungeonParty.updateMany({ $or: [{ 'members.user': id }, { 'invites.user': id }, { 'chat.user': id }] }, { $pull: { members: { user: id }, invites: { user: id }, chat: { user: id } } }, opt);
    await DungeonParty.deleteMany({ members: { $size: 0 } }, opt);
    await DungeonParty.updateMany({ leader: id }, [{ $set: { leader: { $arrayElemAt: ['$members.user', 0] } } }], opt);
    await DungeonRun.updateMany({ 'chat.user': id }, { $pull: { chat: { user: id } } }, opt);
    await DungeonRun.updateMany({ 'members.user': id, status: 'laeuft' }, { $set: { 'members.$[m].user': null, 'members.$[m].reward': 0, 'members.$[m].foil': false, 'members.$[m].bossCard': false } }, { ...opt, arrayFilters: [{ 'm.user': id }] });
  });
  await roles.load();
  // alle Sitzungen dieses Kontos beenden (connect-mongo speichert die Sitzung als JSON-Text)
  await deviceService.forgetUser(id); // Geräte und Mehrfach-Konten-Hinweise
  await require('../moderation/suspicionService').forgetUser(id); // Auffälligkeiten (Manipulationserkennung)
  await require('../models/DuelTip').deleteMany({ user: id }); // Zuschauer-Tipps (die Summen am Duell bleiben anonym)
  await mongoose.connection.collection('sessions').deleteMany({ session: { $regex: `"userId":"${String(id)}"` } });
}

module.exports = { NAME_PATTERN, NAME_HINT, RENAME_COOLDOWN_DAYS, nextRenameAt, rename, deleteAccount, propagateName };

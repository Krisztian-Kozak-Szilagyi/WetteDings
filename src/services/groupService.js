const mongoose = require('mongoose');
const Group = require('../models/Group');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const { UserError } = require('../lib/util');

const NAME_MIN = 2;
const NAME_MAX = 40;
const MAX_OWNED = 10; // Gruppen pro Person
const MAX_MEMBERS = 100;

/** Alle Gruppen, deren Wetten ein Mitglied sehen darf (auch aufgelöste – für alte Wetten) */
const groupIdsOf = async (userId) => (await Group.find({ members: userId }).select('_id').lean()).map((g) => g._id);

/** Aktive Gruppen eines Mitglieds (für Auswahl und Verwaltung), eigene zuerst */
async function groupsOf(userId) {
  const groups = await Group.find({ members: userId, deleted: false }).sort({ name: 1 }).lean();
  const mine = (g) => String(g.owner) === String(userId);
  return groups.sort((a, b) => mine(b) - mine(a));
}

/** Filter: öffentliche Wetten und die der eigenen Gruppen (alte Wetten ohne Feld gelten als öffentlich) */
const visibleFilter = (groupIds) => ({ $or: [{ group: null }, { group: { $in: groupIds } }] });

/** Darf dieses Mitglied die Wette sehen? Admin und Devs immer (Streitfälle), sonst nur Gruppenmitglieder. */
const canSee = (bet, user, groupIds) => !bet.group || !!user.isStaff || groupIds.some((id) => String(id) === String(bet.group));

function cleanName(name) {
  const n = String(typeof name === 'string' ? name : '').trim().replace(/\s+/g, ' ');
  if (n.length < NAME_MIN || n.length > NAME_MAX) throw new UserError(`Der Gruppenname muss ${NAME_MIN}–${NAME_MAX} Zeichen lang sein.`);
  return n;
}

async function create({ user, name }) {
  const n = cleanName(name);
  const owned = await Group.find({ owner: user._id, deleted: false }).select('name').lean();
  if (owned.length >= MAX_OWNED) throw new UserError(`Du kannst höchstens ${MAX_OWNED} Gruppen haben.`);
  if (owned.some((g) => g.name.toLowerCase() === n.toLowerCase())) throw new UserError('Du hast schon eine Gruppe mit diesem Namen.');
  return Group.create({ name: n, owner: user._id, ownerName: user.username, members: [user._id] });
}

/** Eigene, aktive Gruppe laden – nur der Ersteller verwaltet sie */
async function ownGroup(user, groupId) {
  const group = mongoose.isValidObjectId(groupId) ? await Group.findOne({ _id: groupId, owner: user._id, deleted: false }) : null;
  if (!group) throw new UserError('Diese Gruppe gibt es nicht (oder sie gehört dir nicht).');
  return group;
}

async function addMember({ user, groupId, username }) {
  const group = await ownGroup(user, groupId);
  const member = await User.findOne({ usernameLower: String(username || '').trim().toLowerCase(), deletedAt: null }).select('username').lean();
  if (!member) throw new UserError('Dieses Mitglied gibt es nicht.');
  if (group.members.some((id) => id.equals(member._id))) throw new UserError(`${member.username} ist schon in der Gruppe.`);
  if (group.members.length >= MAX_MEMBERS) throw new UserError(`Eine Gruppe kann höchstens ${MAX_MEMBERS} Mitglieder haben.`);
  await Group.updateOne({ _id: group._id }, { $addToSet: { members: member._id } });
  return { group, member };
}

/**
 * Wer noch an offenen Wetten der Gruppe beteiligt ist (als Ersteller, Schiedsrichter oder mit Einsatz),
 * kann die Gruppe nicht verlassen – er würde sonst seine eigenen Wetten nicht mehr sehen.
 */
async function assertNotInvolved(groupId, userId, who) {
  const open = await Bet.find({ group: groupId, status: 'offen' }).select('creator referee').lean();
  const involved = open.some((b) => String(b.creator) === String(userId) || String(b.referee) === String(userId));
  const staked = !involved && open.length ? await Position.exists({ user: userId, bet: { $in: open.map((b) => b._id) } }) : false;
  if (involved || staked) throw new UserError(`${who} noch an offenen Wetten dieser Gruppe beteiligt. Das geht erst, wenn sie abgeschlossen sind.`);
}

/** Offene Wetten annullieren (Einsätze gehen zurück) – z. B. wenn ihre Gruppe aufgelöst wird */
async function voidBets(bets, note) {
  const { resolveBet, SYSTEM_ACTOR } = require('./betService'); // erst hier laden (gegenseitige Abhängigkeit)
  for (const b of bets) await resolveBet({ actor: SYSTEM_ACTOR, betId: b._id, outcome: 'annulliert', note });
  return bets.length;
}

/**
 * Mitglied entfernen – geht immer. Offene Gruppen-Wetten, die dieses Mitglied aufgestellt hat oder bei
 * denen es Schiedsrichter ist, werden annulliert (die Einsätze gehen zurück), weil sie sonst niemand mehr
 * abschließen könnte. Eigene Einsätze des Mitglieds in anderen Wetten der Gruppe laufen normal weiter.
 */
async function removeMember({ user, groupId, memberId }) {
  const group = await ownGroup(user, groupId);
  if (!mongoose.isValidObjectId(memberId) || String(memberId) === String(user._id)) throw new UserError('Dieses Mitglied kann nicht entfernt werden.');
  const stuck = await Bet.find({ group: group._id, status: 'offen', $or: [{ creator: memberId }, { referee: memberId }] }).select('_id').lean();
  const voided = await voidBets(stuck, `Annulliert: Ein Beteiligter (Wettersteller oder Schiedsrichter) gehört nicht mehr zur Gruppe „${group.name}“.`);
  await Group.updateOne({ _id: group._id }, { $pull: { members: memberId } });
  return { group, voided };
}

/** Selbst austreten (nicht als Ersteller – der löst die Gruppe auf) */
async function leave({ user, groupId }) {
  const group = mongoose.isValidObjectId(groupId) ? await Group.findOne({ _id: groupId, members: user._id, deleted: false }) : null;
  if (!group) throw new UserError('Du bist nicht in dieser Gruppe.');
  if (group.owner.equals(user._id)) throw new UserError('Als Ersteller kannst du nicht austreten – du kannst die Gruppe aber auflösen.');
  await assertNotInvolved(group._id, user._id, 'Du bist');
  await Group.updateOne({ _id: group._id }, { $pull: { members: user._id } });
  return group;
}

/**
 * Gruppe auflösen – geht immer. Noch offene Wetten der Gruppe werden annulliert (die Einsätze gehen zurück);
 * abgeschlossene bleiben für die bisherigen Mitglieder sichtbar.
 */
async function dissolve({ user, groupId }) {
  const group = await ownGroup(user, groupId);
  const open = await Bet.find({ group: group._id, status: 'offen' }).select('_id').lean();
  const voided = await voidBets(open, `Annulliert: Die Gruppe „${group.name}“ wurde aufgelöst.`);
  await Group.updateOne({ _id: group._id }, { $set: { deleted: true } });
  return { group, voided };
}

/** Für "Mein Konto": eigene und fremde Gruppen samt Mitgliedernamen */
async function overview(userId) {
  const groups = await groupsOf(userId);
  const ids = [...new Set(groups.flatMap((g) => g.members.map(String)))];
  const users = await User.find({ _id: { $in: ids } }).select('username').lean();
  const nameOf = new Map(users.map((u) => [String(u._id), u.username]));
  return groups.map((g) => ({
    ...g,
    mine: String(g.owner) === String(userId),
    memberList: g.members.map((id) => ({ _id: id, username: nameOf.get(String(id)) || '?' })).sort((a, b) => a.username.localeCompare(b.username, 'de')),
  }));
}

/**
 * Neue offene Wetten anderer seit dem letzten Besuch der Wett-Übersicht:
 * öffentliche und die aus den eigenen Gruppen (Abzeichen am Menüpunkt „Wetten“).
 */
async function newBetCounts(user, groupIds) {
  // Duell-Anfragen zählen nicht (sie sehen nur die Beteiligten, siehe betService.hiddenDuelFilter)
  const base = { status: 'offen', creator: { $ne: user._id }, createdAt: { $gt: user.betsSeenAt || user.createdAt }, 'duel.state': { $ne: 'angefragt' } };
  const [pub, group] = await Promise.all([
    Bet.countDocuments({ ...base, group: null }),
    groupIds.length ? Bet.countDocuments({ ...base, group: { $in: groupIds } }) : 0,
  ]);
  return { pub, group };
}

module.exports = { NAME_MAX, groupIdsOf, groupsOf, visibleFilter, canSee, create, addMember, removeMember, leave, dissolve, overview, newBetCounts };

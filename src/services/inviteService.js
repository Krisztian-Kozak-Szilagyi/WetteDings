// Einladungslinks der Mitglieder mit Provision: Wer über den Link eines Mitglieds ein Konto erstellt, bringt
// diesem Mitglied Booster Packs ein. Ein Link ist ein Registrierungscode (models/RegistrationCode) mit reward = true.
const config = require('../config');
const User = require('../models/User');
const RegistrationCode = require('../models/RegistrationCode');
const InviteSettings = require('../models/InviteSettings');
const { Device } = require('../models/Device');
const { TcgPack } = require('../models/Tcg');
const catalog = require('../tcg/catalog');
const { UserError } = require('../lib/util');
const { notify } = require('./notifyService');
const { logSettingsChange } = require('../stats/settingsLog');
const { createCode, formatCode, ttlText } = require('./codeService');

// Ein Link gilt 7 Tage und für eine Person; mehr als MAX_OPEN_LINKS offene Links gleichzeitig gibt es nicht
const LINK_TTL_MINUTES = 7 * 24 * 60;
const MAX_OPEN_LINKS = 3;
const MAX_PACKS = 20;
const HISTORY_MAX = 50;

// open = Mitglieder können Links erstellen (sonst nur Admins); packs = Provision je neuem Mitglied
const DEFAULTS = { open: false, packs: config.inviteRewardPacks };
const settings = { ...DEFAULTS };

const validPacks = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_PACKS;

async function loadSettings() {
  const doc = await InviteSettings.findById('einladung').lean();
  if (!doc) return;
  if (typeof doc.open === 'boolean') settings.open = doc.open;
  if (validPacks(doc.packs)) settings.packs = doc.packs;
}

async function saveSettings({ open, packs, admin }) {
  if (!validPacks(packs)) throw new UserError(`Provision: 0 bis ${MAX_PACKS} Booster Packs.`);
  await InviteSettings.updateOne({ _id: 'einladung' }, { $set: { open: !!open, packs, updatedByName: admin.username } }, { upsert: true });
  const before = { ...settings };
  Object.assign(settings, { open: !!open, packs });
  await logSettingsChange({ area: 'einladung', before, after: settings, by: admin });
}

/** Darf dieses Mitglied Einladungslinks erstellen? (Solange nicht freigegeben, nur der Admin zum Ausprobieren) */
const mayInvite = (user) => !!user && (settings.open || !!user.isAdmin);

/** Vollständige Adresse eines Links: https://host/registrieren?code=ABCD-2345 */
const linkUrl = (origin, code) => `${origin}/registrieren?code=${formatCode(code)}`;

/**
 * Bekommt der Einlader eine Provision? Gibt { packs, withheld } zurück; withheld nennt den Grund, wenn nicht.
 * inviter: Konto des Einladers (oder null, wenn gelöscht), sameDevice: neues Konto vom Gerät des Einladers.
 */
function rewardDecision({ packs, inviter, sameDevice, now = Date.now() }) {
  if (!inviter || inviter.deletedAt) return { packs: 0, withheld: 'Konto des Einladers gelöscht' };
  if (inviter.bannedUntil && new Date(inviter.bannedUntil).getTime() > now) return { packs: 0, withheld: 'Einlader gesperrt' };
  if (sameDevice) return { packs: 0, withheld: 'gleiches Gerät wie der Einlader' };
  if (!packs) return { packs: 0, withheld: null };
  return { packs, withheld: null };
}

/** Neuer Einladungslink (Registrierungscode mit Provision) für ein Mitglied */
async function createLink(user) {
  if (!mayInvite(user)) throw new UserError('Einladungslinks gibt es derzeit noch nicht.');
  const open = await RegistrationCode.countDocuments({ createdBy: user._id, reward: true, usedAt: null, expiresAt: { $gt: new Date() } });
  if (open >= MAX_OPEN_LINKS) {
    throw new UserError(`Du hast schon ${MAX_OPEN_LINKS} offene Einladungslinks. Lösch einen oder warte, bis einer benutzt wurde oder abläuft.`);
  }
  return createCode(user, LINK_TTL_MINUTES, { reward: true });
}

/** Eigene Links, die noch gelten oder schon benutzt wurden (abgelaufene löscht MongoDB) */
const ownLinks = (userId) => RegistrationCode.find({ createdBy: userId, reward: true }).sort({ createdAt: -1 }).limit(HISTORY_MAX).lean();

/** Wen das Mitglied geworben hat – mit der jeweils gutgeschriebenen Provision */
const invitedMembers = (userId) =>
  User.find({ invitedBy: userId }).select('username deletedAt createdAt inviteReward').sort({ createdAt: -1 }).limit(HISTORY_MAX).lean();

/**
 * Nach dem Einlösen eines Codes in der Registrierungs-Transaktion: Ist es ein Mitglieder-Link, wird das neue
 * Konto dem Einlader zugeordnet und dieser bekommt seine Provision. Gibt { inviterId, packs, type } zurück,
 * wenn Packs vergeben wurden (die Benachrichtigung folgt nach der Transaktion, siehe notifyReward).
 */
async function rewardInviter({ redeemed, user, deviceId = null, session }) {
  if (!redeemed || !redeemed.reward) return null;
  const inviter = await User.findById(redeemed.createdBy).select('deletedAt bannedUntil').session(session).lean();
  // Registriert sich jemand mit dem Gerät des Einladers, ist das sehr wahrscheinlich ein Zweitkonto
  const sameDevice = !!deviceId && !!(await Device.exists({ user: redeemed.createdBy, deviceId }).session(session));
  const { packs, withheld } = rewardDecision({ packs: settings.packs, inviter, sameDevice });
  await User.updateOne({ _id: user._id }, { $set: { invitedBy: redeemed.createdBy, inviteReward: { packs, withheld } } }, { session });
  if (!packs) return null;
  const type = catalog.DEFAULT_PACK;
  await TcgPack.insertMany(Array.from({ length: packs }, () => ({ user: redeemed.createdBy, type, source: 'einladung', cost: 0 })), { session });
  return { inviterId: redeemed.createdBy, packs, type };
}

/** Glocke beim Einlader: "Max hat sich über deinen Link registriert …" */
async function notifyReward(reward, newUser) {
  if (!reward) return;
  const t = catalog.packTypeByKey[reward.type];
  const what = reward.packs > 1 ? `${reward.packs}× ${t.label}` : `ein ${t.label}`;
  await notify(reward.inviterId, { area: 'Inventar', href: '/inventar', text: `${newUser.username} hat sich über deinen Einladungslink registriert – du bekommst ${what}.` });
}

module.exports = {
  DEFAULTS,
  LINK_TTL_MINUTES,
  MAX_OPEN_LINKS,
  MAX_PACKS,
  linkTtlText: ttlText(LINK_TTL_MINUTES),
  settings,
  loadSettings,
  saveSettings,
  mayInvite,
  linkUrl,
  rewardDecision,
  createLink,
  ownLinks,
  invitedMembers,
  rewardInviter,
  notifyReward,
};

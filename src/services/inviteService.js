// Einladungslinks mit Provision: Ein Dev (oder der Admin) erstellt einen Link für ein Mitglied, das ihn sich gewünscht
// hat, und legt dabei Gültigkeit und Provision fest. Das Mitglied schickt den Link weiter; wer darüber ein Konto
// erstellt, bringt dem Mitglied die Booster Packs ein. Ein Link ist ein Registrierungscode (models/RegistrationCode)
// mit reward = true und dem begünstigten Mitglied in beneficiary.
const User = require('../models/User');
const RegistrationCode = require('../models/RegistrationCode');
const { Device } = require('../models/Device');
const { TcgPack } = require('../models/Tcg');
const catalog = require('../tcg/catalog');
const { UserError } = require('../lib/util');
const { notify } = require('./notifyService');
const { createCode, formatCode, parseTtl, ttlText } = require('./codeService');

const MAX_PACKS = 20;
const HISTORY_MAX = 50;

/** Eingabe aus dem Formular -> Packzahl 0 … MAX_PACKS, sonst null */
function parsePacks(input) {
  const raw = typeof input === 'string' ? input.trim() : typeof input === 'number' ? String(input) : '';
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_PACKS ? n : null;
}

/** "ein Booster Pack" / "3 Booster Packs" / "keine Booster Packs" */
const packsText = (n) => (n === 1 ? 'ein Booster Pack' : `${n || 'keine'} Booster Packs`);

/** Vollständige Adresse eines Links: https://host/registrieren?code=ABCD-2345 */
const linkUrl = (origin, code) => `${origin}/registrieren?code=${formatCode(code)}`;

/**
 * Bekommt das Mitglied seine Provision? Gibt { packs, withheld } zurück; withheld nennt den Grund, wenn nicht.
 * beneficiary: Konto des Mitglieds (oder null, wenn gelöscht), sameDevice: neues Konto vom Gerät des Mitglieds.
 */
function rewardDecision({ packs, beneficiary, sameDevice, now = Date.now() }) {
  if (!beneficiary || beneficiary.deletedAt) return { packs: 0, withheld: 'Konto des Einladenden gelöscht' };
  if (beneficiary.bannedUntil && new Date(beneficiary.bannedUntil).getTime() > now) return { packs: 0, withheld: 'Einladender gesperrt' };
  if (sameDevice) return { packs: 0, withheld: 'gleiches Gerät wie der Einladende' };
  return { packs: packs || 0, withheld: null };
}

/**
 * Dev/Admin erstellt einen Einladungslink für ein Mitglied. beneficiary: { _id, username },
 * ttlMinutes aus CODE_TTL_OPTIONS, packs: Provision je Registrierung (0 … MAX_PACKS).
 */
async function createLink({ staff, beneficiary, ttlMinutes, packs }) {
  if (!beneficiary) throw new UserError('Bitte wähle das Mitglied aus, das den Link bekommt.');
  const n = parsePacks(packs);
  if (n === null) throw new UserError(`Provision: 0 bis ${MAX_PACKS} Booster Packs.`);
  const ttl = parseTtl(ttlMinutes);
  const link = await createCode(staff, ttl, { reward: true, beneficiary, rewardPacks: n });
  await notify(beneficiary._id, {
    area: 'Konto',
    href: '/konto/einladungen',
    text: `${staff.username} hat dir einen Einladungslink erstellt (gültig für ${ttlText(ttl)}). Registriert sich jemand darüber, bekommst du ${packsText(n)}.`,
  });
  return link;
}

/** Links für ein Mitglied, die noch gelten oder schon benutzt wurden (abgelaufene löscht MongoDB) */
const linksFor = (userId) => RegistrationCode.find({ beneficiary: userId, reward: true }).sort({ createdAt: -1 }).limit(HISTORY_MAX).lean();

/** Wen das Mitglied geworben hat – mit der jeweils gutgeschriebenen Provision */
const invitedMembers = (userId) =>
  User.find({ invitedBy: userId }).select('username deletedAt createdAt inviteReward').sort({ createdAt: -1 }).limit(HISTORY_MAX).lean();

/**
 * Nach dem Einlösen eines Codes in der Registrierungs-Transaktion: Ist es ein Einladungslink, wird das neue Konto
 * dem Mitglied zugeordnet und dieses bekommt seine Provision. Gibt { userId, packs, type } zurück, wenn Packs
 * vergeben wurden (die Benachrichtigung folgt nach der Transaktion, siehe notifyReward).
 */
async function rewardInviter({ redeemed, user, deviceId = null, session }) {
  if (!redeemed || !redeemed.reward || !redeemed.beneficiary) return null;
  const beneficiaryId = redeemed.beneficiary;
  const beneficiary = await User.findById(beneficiaryId).select('deletedAt bannedUntil').session(session).lean();
  // Registriert sich jemand mit dem Gerät des Mitglieds, ist das sehr wahrscheinlich ein Zweitkonto
  const sameDevice = !!deviceId && !!(await Device.exists({ user: beneficiaryId, deviceId }).session(session));
  const { packs, withheld } = rewardDecision({ packs: redeemed.rewardPacks, beneficiary, sameDevice });
  await User.updateOne({ _id: user._id }, { $set: { invitedBy: beneficiaryId, inviteReward: { packs, withheld } } }, { session });
  if (!packs) return null;
  const type = catalog.DEFAULT_PACK;
  await TcgPack.insertMany(Array.from({ length: packs }, () => ({ user: beneficiaryId, type, source: 'einladung', cost: 0 })), { session });
  return { userId: beneficiaryId, packs, type };
}

/** Glocke beim Mitglied: "Max hat sich über deinen Einladungslink registriert …" */
async function notifyReward(reward, newUser) {
  if (!reward) return;
  const t = catalog.packTypeByKey[reward.type];
  const what = reward.packs > 1 ? `${reward.packs}× ${t.label}` : `ein ${t.label}`;
  await notify(reward.userId, { area: 'Inventar', href: '/inventar', text: `${newUser.username} hat sich über deinen Einladungslink registriert – du bekommst ${what}.` });
}

module.exports = { MAX_PACKS, parsePacks, packsText, linkUrl, rewardDecision, createLink, linksFor, invitedMembers, rewardInviter, notifyReward };

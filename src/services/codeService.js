const crypto = require('crypto');
const RegistrationCode = require('../models/RegistrationCode');
const { str } = require('../lib/util');

// Wählbare Gültigkeitsdauern in Minuten; die erste ist der Standard
const CODE_TTL_OPTIONS = [30, 60, 6 * 60, 24 * 60, 3 * 24 * 60, 7 * 24 * 60];
const CODE_TTL_MINUTES = CODE_TTL_OPTIONS[0];
// Ohne leicht verwechselbare Zeichen (0/O, 1/I/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** "abcd-2345 " -> "ABCD2345" */
const normalizeCode = (input) => String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "ABCD2345" -> "ABCD-2345" */
const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

function randomCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/** 30 -> "30 Minuten", 60 -> "1 Stunde", 1440 -> "1 Tag" */
function ttlText(minutes) {
  if (minutes % 1440 === 0) return minutes === 1440 ? '1 Tag' : `${minutes / 1440} Tage`;
  if (minutes % 60 === 0) return minutes === 60 ? '1 Stunde' : `${minutes / 60} Stunden`;
  return minutes === 1 ? '1 Minute' : `${minutes} Minuten`;
}

/** Restlaufzeit kurz: "noch 12 Min.", "noch 5 Std.", "noch 2 Tage" */
function remainingText(expiresAt, now = Date.now()) {
  const minutes = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 60000));
  if (minutes < 60) return `noch ${minutes} Min.`;
  if (minutes < 48 * 60) return `noch ${Math.ceil(minutes / 60)} Std.`;
  return `noch ${Math.ceil(minutes / 1440)} Tage`;
}

/** Eingabe aus dem Formular -> erlaubte Dauer in Minuten (sonst der Standard) */
function parseTtl(input) {
  const n = typeof input === 'number' ? input : Number(str(input));
  return CODE_TTL_OPTIONS.includes(n) ? n : CODE_TTL_MINUTES;
}

/**
 * Neuen Code erzeugen – Admin oder Dev lädt damit jemanden ein (einmal nutzbar, gültig für ttlMinutes).
 * Einladungslink mit Provision (services/inviteService): reward = true, beneficiary = { _id, username } des Mitglieds,
 * rewardPacks = Booster Packs je Registrierung.
 */
async function createCode(admin, ttlMinutes = CODE_TTL_MINUTES, { reward = false, beneficiary = null, rewardPacks = 0 } = {}) {
  const ttl = parseTtl(ttlMinutes);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await RegistrationCode.create({
        code: randomCode(),
        createdBy: admin._id,
        createdByName: admin.username,
        expiresAt: new Date(Date.now() + ttl * 60 * 1000),
        reward,
        beneficiary: beneficiary ? beneficiary._id : null,
        beneficiaryName: beneficiary ? beneficiary.username : null,
        rewardPacks,
      });
    } catch (err) {
      if (err.code !== 11000) throw err; // Kollision: neuen Code würfeln
    }
  }
  throw new Error('Konnte keinen eindeutigen Code erzeugen.');
}

/**
 * Code innerhalb der Registrierungs-Transaktion einlösen. Gibt das Code-Dokument zurück
 * oder null, wenn der Code ungültig, abgelaufen oder schon benutzt ist.
 */
async function redeemCode(rawCode, user, session) {
  const code = normalizeCode(rawCode);
  if (code.length !== CODE_LENGTH) return null;
  return RegistrationCode.findOneAndUpdate(
    { code, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date(), usedBy: user._id, usedByName: user.username } },
    { new: true, session }
  );
}

/** Alle noch nicht abgelaufenen Codes (für das Admin-Panel) */
async function listActiveCodes() {
  return RegistrationCode.find({ expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(100).lean();
}

/** Code vorzeitig löschen: der Admin jeden, Devs nur ihre eigenen. Gibt true zurück, wenn gelöscht. */
async function revokeCode(id, actor) {
  const filter = actor && !actor.isAdmin ? { _id: id, createdBy: actor._id } : { _id: id };
  const res = await RegistrationCode.deleteOne(filter);
  return res.deletedCount === 1;
}

module.exports = { CODE_TTL_MINUTES, CODE_TTL_OPTIONS, ttlText, remainingText, parseTtl, normalizeCode, formatCode, createCode, redeemCode, listActiveCodes, revokeCode };

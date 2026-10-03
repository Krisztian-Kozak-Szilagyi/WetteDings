const crypto = require('crypto');
const RegistrationCode = require('../models/RegistrationCode');

const CODE_TTL_MINUTES = 30;
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

/** Neuen Code erzeugen – Admin oder Dev lädt damit jemanden ein (30 Minuten gültig, einmal nutzbar). */
async function createCode(admin) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await RegistrationCode.create({
        code: randomCode(),
        createdBy: admin._id,
        createdByName: admin.username,
        expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
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

module.exports = { CODE_TTL_MINUTES, normalizeCode, formatCode, createCode, redeemCode, listActiveCodes, revokeCode };

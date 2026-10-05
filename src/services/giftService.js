const mongoose = require('mongoose');
const Gift = require('../models/Gift');

// Geschenke vom Team: Fenster "Geschenk vom Team" mit Inhalt und Grund (wie das Fenster für neue Erfolge).

const REASON_MIN = 5;
const REASON_MAX = 300;

/** Grund aus dem Formular: Leerzeichen zusammenfassen; zu kurz -> null, zu lang wird gekürzt */
function cleanReason(input) {
  const text = (typeof input === 'string' ? input : '').replace(/\s+/g, ' ').trim();
  if (Array.from(text).length < REASON_MIN) return null;
  return Array.from(text).slice(0, REASON_MAX).join('');
}

/** Geschenk für jedes Mitglied in userIds merken */
async function record({ userIds, kind, key = null, label, count = 1, reason, byName }) {
  if (!userIds.length) return;
  await Gift.insertMany(userIds.map((user) => ({ user, kind, key, label, count, reason, byName })));
}

/** Ältestes noch nicht bestätigtes Geschenk (mit Zahl der wartenden) oder null */
async function nextUnseen(userId) {
  const [doc, left] = await Promise.all([
    Gift.findOne({ user: userId, seenAt: null }).sort({ createdAt: 1 }).lean(),
    Gift.countDocuments({ user: userId, seenAt: null }),
  ]);
  return doc ? { ...doc, left } : null;
}

/**
 * Daten für das Fenster. images: { pack(key), karte(key), item(key) } -> Bild-URL oder null (aus Katalog/Items).
 * Ergebnis: { id, title, image, chip, chipClass, reason, byName, left }
 */
function popupJson(g, { euro, images = {} } = {}) {
  if (!g) return null;
  const money = g.kind === 'geld';
  const image = !money && images[g.kind] ? images[g.kind](g.key) : null;
  return {
    id: String(g._id),
    title: money ? `${euro(g.count)} Spielgeld` : g.count > 1 ? `${g.count}× ${g.label}` : g.label,
    image: image || null,
    chip: money ? `+${euro(g.count)}` : `+${g.count}`,
    chipClass: money ? 'is-money' : g.kind === 'karte' ? 'is-card' : g.kind === 'item' ? 'is-foil' : 'is-money',
    rowName: money ? 'Gutgeschrieben' : g.kind === 'pack' ? 'Liegt in deinem Inventar' : g.kind === 'karte' ? 'In deiner Sammlung' : 'In deinem Inventar',
    reason: g.reason,
    byName: g.byName,
    left: g.left || 1,
  };
}

/** popupJson mit den echten Bildern aus Katalog und Gegenständen (für Seiten und app.js) */
function popup(g) {
  if (!g) return null;
  const catalog = require('../tcg/catalog');
  const { itemTypeByKey } = require('../items/itemService');
  const { euro } = require('../lib/viewHelpers');
  return popupJson(g, {
    euro,
    images: {
      pack: (key) => (catalog.packTypeByKey[key] || {}).image,
      karte: (key) => (catalog.cardById[key] || {}).image,
      item: (key) => (itemTypeByKey[key] || {}).image,
    },
  });
}

/** Fenster bestätigt */
async function markSeen(userId, id) {
  if (!mongoose.isValidObjectId(id)) return;
  await Gift.updateOne({ _id: id, user: userId, seenAt: null }, { $set: { seenAt: new Date() } });
}

module.exports = { REASON_MIN, REASON_MAX, cleanReason, record, nextUnseen, popupJson, popup, markSeen };

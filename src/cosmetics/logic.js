// Kosmetik: reine Rechenregeln (ohne Datenbank), getestet in test/cosmetics.test.js.
const catalog = require('./catalog');

const MAX_PRICE = 1000000;
const NAME_MAX = 30;

/** Konfetti für eine zerkleinerte Karte: ihr Bankwert in ganzen Euro (abgerundet), auch bei Boss-Karten */
const konfettiFor = (sellCents) => (Number.isInteger(sellCents) && sellCents > 0 ? Math.floor(sellCents / 100) : 0);

const validPrice = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_PRICE;

/** Währungsname: 2–20 Zeichen, Buchstaben, Ziffern, Leerzeichen und Bindestrich */
const validCurrencyName = (v) => typeof v === 'string' && /^[\p{L}\d][\p{L}\d \-]{1,19}$/u.test(v.trim());

const cleanName = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '');

/**
 * Gilt für einen Eintrag: gespeicherte Admin-Werte (falls gültig) über den Startwerten.
 * stored = { price, effect, name } oder undefined
 */
function withSettings(item, stored) {
  const s = stored || {};
  return {
    ...item,
    price: validPrice(s.price) ? s.price : item.price,
    effect: typeof s.effect === 'string' && catalog.findEffect(s.effect) ? s.effect : item.effect,
    name: cleanName(s.name) || item.name,
  };
}

/** Darf der Nutzer dieses Profilbild tragen? Shop-Avatare nur, wenn gekauft. */
const ownsAvatar = (owned, key) => (owned || []).includes(catalog.ownedKey('avatar', key));

/** Wie viele der Shop-Avatare besitzt jemand? */
const ownedAvatarCount = (owned) => catalog.AVATARS.filter((a) => ownsAvatar(owned, a.key)).length;

module.exports = { MAX_PRICE, NAME_MAX, konfettiFor, validPrice, validCurrencyName, cleanName, withSettings, ownsAvatar, ownedAvatarCount };

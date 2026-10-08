// Profilbilder: die vier Logos (nur für Admin und Devs, siehe POST /profil/bild) und die Avatare aus dem
// Kosmetik-Shop (src/cosmetics/catalog.js, gekauft mit Konfetti).
// Gespeichert wird nur die ID (User.avatar); unbekannte oder fehlende IDs zeigen den Platzhalter.
const cosmetics = require('../cosmetics/catalog');

const PLACEHOLDER = '/img/avatar-placeholder.svg';

const AVATARS = [
  { id: 'logo-klassisch', name: 'Logo – Gold und Weinrot' },
  { id: 'logo-silber', name: 'Logo – Silber und Blau' },
  { id: 'logo-smaragd', name: 'Logo – Gold und Smaragd' },
  { id: 'logo-elfenbein', name: 'Logo – Elfenbein' },
].map((a) => ({ ...a, url: `/img/avatars/${a.id}.svg` }));

const byId = new Map([...AVATARS, ...cosmetics.AVATARS.map((a) => ({ id: a.key, name: a.name, url: a.url }))].map((a) => [a.id, a]));

/** Ist es eines der Logos (nur Team)? (Nutzereingabe) */
const has = (id) => typeof id === 'string' && AVATARS.some((a) => a.id === id);

/** Bild-URL zu einer gespeicherten ID, sonst der Platzhalter */
const urlOf = (id) => (typeof id === 'string' && byId.has(id) ? byId.get(id).url : PLACEHOLDER);

module.exports = { AVATARS, PLACEHOLDER, has, urlOf };

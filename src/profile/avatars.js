// Profilbilder zur Auswahl (vorerst nur für Admin und Devs, siehe POST /profil/bild).
// Gespeichert wird nur die ID (User.avatar); unbekannte oder fehlende IDs zeigen den Platzhalter.
const PLACEHOLDER = '/img/avatar-placeholder.svg';

const AVATARS = [
  { id: 'logo-klassisch', name: 'Logo – Gold und Weinrot' },
  { id: 'logo-silber', name: 'Logo – Silber und Blau' },
  { id: 'logo-smaragd', name: 'Logo – Gold und Smaragd' },
  { id: 'logo-elfenbein', name: 'Logo – Elfenbein' },
].map((a) => ({ ...a, url: `/img/avatars/${a.id}.svg` }));

const byId = new Map(AVATARS.map((a) => [a.id, a]));

/** Gibt es das Bild? (Nutzereingabe) */
const has = (id) => typeof id === 'string' && byId.has(id);

/** Bild-URL zu einer gespeicherten ID, sonst der Platzhalter */
const urlOf = (id) => (has(id) ? byId.get(id).url : PLACEHOLDER);

module.exports = { AVATARS, PLACEHOLDER, has, urlOf };

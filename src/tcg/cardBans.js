// Kartensperren: Admin/Dev sperren eine zu starke Karte in einzelnen Spielmodi, bis ein Balance-Patch kommt.
// Gesperrt heißt: weder als Charakter noch als Boost wählbar, Bots nehmen sie auch nicht. Was schon läuft, läuft zu Ende;
// eine noch nicht gestartete Dungeon-Anmeldung mit der Karte fällt beim Start heraus (siehe dungeonService).
// Die Sperren liegen im Speicher (beim Start geladen, bei jeder Änderung aktualisiert) – sie werden bei jeder
// Kartenauswahl gebraucht.
const CardBan = require('../models/CardBan');
const catalog = require('./catalog');
const { UserError } = require('../lib/util');
const { logSettingsChange } = require('../stats/settingsLog');

/** Spielmodi, in denen gesperrt werden kann. Neuer Modus = neuer Eintrag hier + Prüfung im Modus selbst. */
const MODES = [
  { key: 'dungeon', label: 'Dungeon' },
  { key: 'tower', label: 'Mage Tower' },
];
const modeByKey = Object.fromEntries(MODES.map((m) => [m.key, m]));

let bans = new Map(); // Karten-ID -> Set der gesperrten Modi

async function load() {
  const docs = await CardBan.find().lean();
  bans = new Map(docs.filter((d) => d.modes.length).map((d) => [d._id, new Set(d.modes)]));
}

/** Ist die Karte in diesem Modus gesperrt? */
const isBanned = (cardId, mode) => !!cardId && !!bans.get(cardId) && bans.get(cardId).has(mode);

/** Gesperrte Karten-IDs eines Modus */
const bannedIn = (mode) => new Set([...bans].filter(([, modes]) => modes.has(mode)).map(([id]) => id));

/** Stand als einfaches Objekt { kartenId: [modi] } – für den Einstellungs-Verlauf */
const snapshot = () => Object.fromEntries([...bans].map(([id, modes]) => [id, MODES.filter((m) => modes.has(m.key)).map((m) => m.key)]));

/** Alle Sperren für das Panel: [{ card, modes: [{ key, label }] }], nach Name */
const list = () =>
  [...bans]
    .map(([id, modes]) => ({ card: catalog.cardById[id], modes: MODES.filter((m) => modes.has(m.key)) }))
    .filter((b) => b.card && b.modes.length)
    .sort((a, b) => a.card.name.localeCompare(b.card.name, 'de'));

/** Gewählte Modi aus dem Formular: nur bekannte (feste Liste) */
const pickModes = (input) => {
  const wanted = [].concat(input || []).map(String);
  return MODES.filter((m) => wanted.some((w) => w === m.key)).map((m) => m.key);
};

/**
 * Sperren einer Karte setzen (modes = alle Modi, in denen sie gesperrt sein soll; leer = Sperre aufheben).
 * Gibt { card, added, removed } zurück (Modus-Schlüssel, die neu dazu- bzw. weggekommen sind).
 */
async function setBan({ cardId, modes, admin }) {
  const card = catalog.cardById[String(cardId || '')];
  if (!card) throw new UserError('Bitte eine Karte auswählen.');
  const next = pickModes(modes);
  const before = snapshot();
  const prev = bans.get(card.id) || new Set();
  if (next.length) {
    await CardBan.updateOne({ _id: card.id }, { $set: { modes: next, by: admin ? admin._id : null, byName: admin ? admin.username : null } }, { upsert: true });
    bans.set(card.id, new Set(next));
  } else {
    await CardBan.deleteOne({ _id: card.id });
    bans.delete(card.id);
  }
  await logSettingsChange({ area: 'karten', before, after: snapshot(), by: admin });
  return { card, added: next.filter((m) => !prev.has(m)), removed: [...prev].filter((m) => !next.includes(m)) };
}

/** "Dungeon und Mage Tower" */
const modesText = (keys) => {
  const labels = keys.map((k) => (modeByKey[k] || { label: k }).label);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} und ${labels[labels.length - 1]}` : labels[0] || '';
};

module.exports = { MODES, modeByKey, load, isBanned, bannedIn, list, setBan, pickModes, modesText, snapshot };

// Von der Seite selbst geschriebene Forum-Beiträge (z. B. der tägliche Börsenbericht). Dahinter steht kein Konto:
// feste ID ohne User-Dokument, Name mit Umlaut (bei echten Benutzernamen nicht erlaubt), eigenes Bild, kein Profil-Link.
// Dazu kommen die eSports-Teams: Ihre Wochenberichte erscheinen im Namen des Teams (ID = Team-ID, register()).
const mongoose = require('mongoose');

const BOERSE = { id: new mongoose.Types.ObjectId('000000000000000000b0e250'), name: 'Börse', avatar: '/img/avatars/logo-silber.svg' };
const ALL = [BOERSE];
const TEAM_AVATAR = '/img/avatars/logo-silber.svg';
let teams = new Map(); // Name → Verfasser

/** eSports-Teams als Verfasser bekanntgeben ([{ id, name }]) – ersetzt die bisherige Liste */
function register(list) {
  teams = new Map(list.map((t) => [t.name, { id: t.id, name: t.name, avatar: TEAM_AVATAR }]));
}

/** System-Verfasser zu einem Namen oder null */
const systemAuthor = (name) => ALL.find((a) => a.name === name) || teams.get(name) || null;

module.exports = { BOERSE, systemAuthor, register };

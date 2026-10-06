// Von der Seite selbst geschriebene Forum-Beiträge (z. B. der tägliche Börsenbericht). Dahinter steht kein Konto:
// feste ID ohne User-Dokument, Name mit Umlaut (bei echten Benutzernamen nicht erlaubt), eigenes Bild, kein Profil-Link.
const mongoose = require('mongoose');

const BOERSE = { id: new mongoose.Types.ObjectId('000000000000000000b0e250'), name: 'Börse', avatar: '/img/avatars/logo-silber.svg' };
const ALL = [BOERSE];

/** System-Verfasser zu einem Namen oder null */
const systemAuthor = (name) => ALL.find((a) => a.name === name) || null;

module.exports = { BOERSE, systemAuthor };

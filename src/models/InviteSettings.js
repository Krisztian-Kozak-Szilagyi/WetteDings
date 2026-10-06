const { Schema, model } = require('mongoose');

// Einladungslinks der Mitglieder: im Admin-Panel geändert (ein Dokument, _id "einladung")
const inviteSettingsSchema = new Schema({ _id: { type: String, default: 'einladung' }, open: Boolean, packs: Number, updatedByName: String }, { timestamps: true });

module.exports = model('InviteSettings', inviteSettingsSchema);

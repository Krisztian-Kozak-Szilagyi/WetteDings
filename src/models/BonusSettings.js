const { Schema, model } = require('mongoose');

// Tagesbonus: im Admin-Panel geänderter Betrag (ein Dokument, _id "bonus")
const bonusSettingsSchema = new Schema({ _id: { type: String, default: 'bonus' }, amount: Number, updatedByName: String }, { timestamps: true });

module.exports = model('BonusSettings', bonusSettingsSchema);

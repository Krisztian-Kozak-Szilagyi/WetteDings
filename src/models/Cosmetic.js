const { Schema, model } = require('mongoose');

// Admin-Einstellungen der Kosmetik (ein Dokument): Name der Währung und je Eintrag Preis, Effekt und Name.
// items: { "avatar:anna": { price, effect, name } } – fehlende Einträge haben die Startwerte aus src/cosmetics/catalog.js
const settingsSchema = new Schema(
  {
    _id: { type: String, default: 'kosmetik' },
    currencyName: String,
    items: { type: Schema.Types.Mixed, default: undefined },
    updatedByName: String,
  },
  { timestamps: true }
);

module.exports = { CosmeticSettings: model('CosmeticSettings', settingsSchema) };

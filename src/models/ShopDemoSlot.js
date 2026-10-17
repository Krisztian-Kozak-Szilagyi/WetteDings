const { Schema, model } = require('mongoose');

// Shop-Demo-Spielstände (Hauptmenü, 3 Plätze): der laufende Stand liegt in ShopDemo (active = true, data leer),
// die anderen hier als ganzer Zustand (data). _id = "<User>:<Platz>".
const shopDemoSlotSchema = new Schema(
  {
    _id: { type: String },
    user: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    slot: { type: Number, required: true },
    active: { type: Boolean, default: false },
    data: { type: Schema.Types.Mixed, default: null },
    summary: { type: Schema.Types.Mixed, default: null },
    savedAt: Date,
  },
  { minimize: false }
);

module.exports = model('ShopDemoSlot', shopDemoSlotSchema);

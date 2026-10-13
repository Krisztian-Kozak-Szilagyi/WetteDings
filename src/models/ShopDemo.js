const { Schema, model } = require('mongoose');

// Shop-Demo: eingerichteter Laden eines Admins (Regeln: src/shop/layout.js). Kanacoin = reines Demo-Geld,
// hat nichts mit dem Kontostand zu tun. _id = User.
const shopDemoSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, ref: 'User' },
    coins: { type: Number, required: true },
    units: { type: Number, required: true },
    nextUid: { type: Number, required: true },
    items: [
      {
        _id: false,
        uid: Number,
        id: String,
        x: Number,
        y: Number,
        rot: Number,
        wall: String,
      },
    ],
  },
  { timestamps: true, minimize: false }
);

module.exports = model('ShopDemo', shopDemoSchema);

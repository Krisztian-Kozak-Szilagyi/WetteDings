const { Schema, model } = require('mongoose');

// Shop-Demo: eingerichteter Laden eines Admins (Regeln: src/shop/layout.js). Kanacoin = reines Demo-Geld,
// hat nichts mit dem Kontostand zu tun. _id = User.
const shopDemoSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, ref: 'User' },
    coins: { type: Number, required: true },
    units: { type: Number, required: true },
    nextUid: { type: Number, required: true },
    nextBid: { type: Number, default: 1 },
    carry: { type: Number, default: null },
    prices: { type: Schema.Types.Mixed, default: {} },
    boxes: [{ _id: false, bid: Number, kind: String, id: String, qty: Number, x: Number, y: Number }],
    items: [
      {
        _id: false,
        uid: Number,
        id: String,
        x: Number,
        y: Number,
        rot: Number,
        wall: String,
        stock: Schema.Types.Mixed,
      },
    ],
  },
  { timestamps: true, minimize: false }
);

module.exports = model('ShopDemo', shopDemoSchema);

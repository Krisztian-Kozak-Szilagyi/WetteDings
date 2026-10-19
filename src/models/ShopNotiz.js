const { Schema, model } = require('mongoose');

// QA-Notizen aus der Shop-Demo (Taste O): was einem Tester aufgefallen ist, dazu der Moment im Spiel (ctx vom Browser:
// Tag, Uhrzeit, Ort der Figur …) und der gespeicherte Spielstand in diesem Moment (state, vom Server). Der Admin liest sie
// unter /shop-demo/notizen und exportiert sie als JSON.
const shopNotizSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    username: String,
    text: { type: String, required: true },
    ctx: { type: Schema.Types.Mixed, default: {} },
    state: { type: Schema.Types.Mixed, default: null },
    done: { type: Boolean, default: false },
  },
  { timestamps: true, minimize: false }
);

module.exports = model('ShopNotiz', shopNotizSchema);

const { Schema, model } = require('mongoose');

// Freigeschalteter Erfolg eines Mitglieds (Liste der Erfolge: src/achievements/list.js).
// Der eindeutige Index (user + key) sorgt dafür, dass jeder Erfolg – und damit seine Belohnung – nur einmal vergeben wird.
const achievementSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, required: true },
    reward: { type: Number, default: 0 }, // gutgeschriebene Belohnung in Cent
    earnedAt: { type: Date, default: Date.now },
    seenAt: { type: Date, default: null }, // Fenster mit OK bestätigt (bis dahin erscheint es auf jeder Seite)
  },
  { timestamps: false }
);
achievementSchema.index({ user: 1, key: 1 }, { unique: true });
achievementSchema.index({ user: 1, seenAt: 1 });

module.exports = model('Achievement', achievementSchema);

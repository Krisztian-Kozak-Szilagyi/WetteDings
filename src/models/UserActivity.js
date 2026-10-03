const { Schema, model } = require('mongoose');

// Aktivität eines Mitglieds an einem Tag (deutsche Zeit): Grundlage für aktive Spieler (DAU/WAU/MAU),
// Retention, Bereichsnutzung und die Uhrzeiten-Heatmap. Ein Dokument pro Mitglied und Tag.
const userActivitySchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true }, // "YYYY-MM-DD"
    views: { type: Number, default: 0 }, // aufgerufene Seiten
    actions: { type: Number, default: 0 }, // abgeschickte Formulare (setzen, kaufen, posten …)
    logins: { type: Number, default: 0 },
    areas: { type: Schema.Types.Mixed, default: {} }, // Seitenaufrufe + Aktionen je Bereich, z. B. { wetten: 5, tcg: 2 }
    hours: { type: [Number], default: [] }, // Stunden (0–23), in denen das Mitglied aktiv war
    firstAt: { type: Date, required: true },
    lastAt: { type: Date, required: true },
  },
  { versionKey: false }
);

userActivitySchema.index({ user: 1, day: 1 }, { unique: true });
userActivitySchema.index({ day: 1 });

module.exports = model('UserActivity', userActivitySchema);

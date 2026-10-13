const { Schema, model } = require('mongoose');

// Wochenrückblick im Forum (stats/weeklyReviewService.js): ein Dokument pro Freitag, _id = "YYYY-MM-DD" (deutsche Zeit).
// Sperre gegen Doppellauf und Verweis auf das Forum-Thema.
const weeklyReviewSchema = new Schema(
  {
    _id: { type: String }, // Tag des Rückblicks
    status: { type: String, enum: ['laeuft', 'fertig'], default: 'laeuft' },
    at: { type: Date, required: true },
    data: { type: Schema.Types.Mixed, default: null }, // ausgewertete Höhepunkte (zur Nachverfolgung)
    thread: { type: Schema.Types.ObjectId, ref: 'ForumThread', default: null },
  },
  { versionKey: false }
);

module.exports = model('WeeklyReview', weeklyReviewSchema);

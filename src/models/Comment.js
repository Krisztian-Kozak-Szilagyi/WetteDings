const { Schema, model } = require('mongoose');

// Kommentar unter einer Wette. Gelöschte Kommentare bleiben als Platzhalter stehen,
// damit der Gesprächsverlauf nachvollziehbar bleibt.
const commentSchema = new Schema(
  {
    bet: { type: Schema.Types.ObjectId, ref: 'Bet', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    text: { type: String, default: '', maxlength: 1000 },
    deleted: { type: Boolean, default: false },
    deletedByName: { type: String, default: null },
  },
  { timestamps: true }
);

commentSchema.index({ bet: 1, createdAt: 1 });

module.exports = model('Comment', commentSchema);

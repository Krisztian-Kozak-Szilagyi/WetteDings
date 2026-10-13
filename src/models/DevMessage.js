const { Schema, model } = require('mongoose');

// Pop-up-Nachricht vom Entwickler-Team (Dev-Panel, Reiter „Pop-ups“, #132): erscheint jedem Mitglied als Fenster –
// sofort, wenn es gerade online ist, sonst beim nächsten Besuch – und bleibt, bis es mit „Gelesen“ bestätigt ist.
// expiresAt: danach erscheint sie niemandem mehr (null = bleibt, bis jeder sie gelesen hat).
// endedAt: vom Team vorzeitig beendet.
const messageSchema = new Schema(
  {
    title: { type: String, required: true },
    text: { type: String, required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    byName: { type: String, required: true },
    expiresAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    endedByName: { type: String, default: null },
  },
  { timestamps: true }
);
messageSchema.index({ endedAt: 1, createdAt: 1 });

// Wer welche Nachricht gelesen hat (ein Eintrag je Mitglied und Nachricht)
const seenSchema = new Schema({
  message: { type: Schema.Types.ObjectId, ref: 'DevMessage', required: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  at: { type: Date, default: Date.now },
});
seenSchema.index({ message: 1, user: 1 }, { unique: true });
seenSchema.index({ user: 1, message: 1 });

module.exports = {
  DevMessage: model('DevMessage', messageSchema),
  DevMessageSeen: model('DevMessageSeen', seenSchema),
};

const { Schema, model } = require('mongoose');
const { KEEP_DAYS } = require('../chat/chatLogic');

const KEEP_SECONDS = KEEP_DAYS * 24 * 3600;

// Chat-Nachricht. conv = Gesprächsschlüssel (chat/chatLogic.js). Namen werden erst beim Anzeigen nachgeschlagen.
const messageSchema = new Schema(
  {
    conv: { type: String, required: true },
    from: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
messageSchema.index({ conv: 1, _id: -1 });
messageSchema.index({ from: 1 });
messageSchema.index({ createdAt: 1 }, { expireAfterSeconds: KEEP_SECONDS });

// Gesprächsliste: ein Eintrag pro Mitglied und Gespräch (letzte Nachricht, ungelesene)
const threadSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    conv: { type: String, required: true },
    partner: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // Zweier-Gespräch
    team: { type: Schema.Types.ObjectId, ref: 'EsportsTeam', default: null }, // Team-Chat
    lastAt: { type: Date, default: Date.now },
    lastText: { type: String, default: '' },
    lastFrom: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    unread: { type: Number, default: 0 },
  },
  { versionKey: false }
);
threadSchema.index({ user: 1, conv: 1 }, { unique: true });
threadSchema.index({ user: 1, lastAt: -1 });
threadSchema.index({ lastAt: 1 }, { expireAfterSeconds: KEEP_SECONDS });

// Meldung einer Nachricht: das Team sieht nur die gemeldete Nachricht und die fünf davor (Kopie)
const reportSchema = new Schema(
  {
    message: { type: Schema.Types.ObjectId, required: true },
    conv: { type: String, required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, default: '' },
    context: { type: [new Schema({ from: Schema.Types.ObjectId, text: String, at: Date, reported: Boolean }, { _id: false })], default: [] },
    done: { type: Boolean, default: false },
    doneByName: { type: String, default: null },
  },
  { timestamps: true }
);
reportSchema.index({ message: 1, by: 1 }, { unique: true });
reportSchema.index({ done: 1, createdAt: -1 });
reportSchema.index({ createdAt: 1 }, { expireAfterSeconds: KEEP_SECONDS });

module.exports = {
  ChatMessage: model('ChatMessage', messageSchema),
  ChatThread: model('ChatThread', threadSchema),
  ChatReport: model('ChatReport', reportSchema),
};

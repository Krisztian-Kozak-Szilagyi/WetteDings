const { Schema, model } = require('mongoose');

// Bereich des Forums. parent = null: Hauptbereich; sonst Unterbereich (eine Ebene tief).
const categorySchema = new Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: '' },
    parent: { type: Schema.Types.ObjectId, ref: 'ForumCategory', default: null },
    staffOnly: { type: Boolean, default: false }, // nur Admin/Dev eröffnen hier Themen (antworten dürfen alle)
    order: { type: Number, default: 0 },
    key: { type: String, default: null }, // feste Bereiche, z. B. 'patchnotes'
  },
  { timestamps: true }
);
categorySchema.index({ parent: 1, order: 1 });

// Ein Thema. Der Eröffnungsbeitrag ist der erste ForumPost (isFirst).
const threadSchema = new Schema(
  {
    category: { type: Schema.Types.ObjectId, ref: 'ForumCategory', required: true },
    title: { type: String, required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, required: true },
    pinned: { type: Boolean, default: false },
    locked: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false }, // von der Moderation entfernt (erscheint nirgends mehr)
    upvotes: { type: [Schema.Types.ObjectId], default: [] },
    replyCount: { type: Number, default: 0 },
    lastPostAt: { type: Date, required: true },
    lastPostBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    lastPostByName: { type: String, default: null },
    participants: { type: [Schema.Types.ObjectId], default: [] }, // wer das Thema eröffnet oder darin geschrieben hat
  },
  { timestamps: true }
);
threadSchema.index({ category: 1, deleted: 1, pinned: -1, lastPostAt: -1 });
threadSchema.index({ deleted: 1, lastPostAt: -1 });

// Ein Beitrag. Gelöschte Beiträge bleiben stehen (Text wird ersetzt), das Original sieht nur Admin/Dev.
const postSchema = new Schema(
  {
    thread: { type: Schema.Types.ObjectId, ref: 'ForumThread', required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, required: true },
    body: { type: String, default: '' }, // Text mit einfacher Auszeichnung und Rollen-Tags (siehe forum/render.js)
    isFirst: { type: Boolean, default: false },
    editedAt: { type: Date, default: null }, // vom Verfasser selbst bearbeitet
    staffEdited: { type: Boolean, default: false }, // Admin/Dev/Mod hat den Text geändert → Verfasser kann nicht mehr bearbeiten
    modEdited: { type: Boolean, default: false }, // ein Mod hat bearbeitet (wird angezeigt)
    deleted: { type: Boolean, default: false },
    deletedByRole: { type: String, default: null }, // 'autor' | 'admin' | 'dev' | 'mod'
    original: { type: String, default: null }, // Text vor dem Löschen (nur für Admin/Dev sichtbar)
  },
  { timestamps: true }
);
postSchema.index({ thread: 1, createdAt: 1 });

// Wann ein Mitglied ein Thema zuletzt gelesen hat (für "ungelesen" im Forum)
const readSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  thread: { type: Schema.Types.ObjectId, ref: 'ForumThread', required: true },
  at: { type: Date, required: true },
});
readSchema.index({ user: 1, thread: 1 }, { unique: true });

// Gemeldete Beiträge (für die Moderation)
const reportSchema = new Schema(
  {
    post: { type: Schema.Types.ObjectId, ref: 'ForumPost', required: true },
    thread: { type: Schema.Types.ObjectId, ref: 'ForumThread', required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    byName: { type: String, required: true },
    reason: { type: String, default: '' },
    done: { type: Boolean, default: false },
  },
  { timestamps: true }
);
reportSchema.index({ done: 1, createdAt: -1 });
reportSchema.index({ post: 1, by: 1 }, { unique: true });

module.exports = {
  ForumCategory: model('ForumCategory', categorySchema),
  ForumThread: model('ForumThread', threadSchema),
  ForumPost: model('ForumPost', postSchema),
  ForumRead: model('ForumRead', readSchema),
  ForumReport: model('ForumReport', reportSchema),
};

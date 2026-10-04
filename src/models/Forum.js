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
    starterKey: { type: String, default: null }, // von der Seite angelegtes Startthema (siehe forum/starters.js) – nur einmal
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

// Mod-Log: was die Moderation im Forum getan hat (Themen, Beiträge anderer, Meldungen)
const modLogSchema = new Schema(
  {
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    byName: { type: String, required: true },
    action: { type: String, required: true }, // siehe MODLOG_LABELS in forum/forumService.js
    thread: { type: Schema.Types.ObjectId, ref: 'ForumThread', default: null },
    threadTitle: { type: String, default: null },
    post: { type: Schema.Types.ObjectId, ref: 'ForumPost', default: null },
    detail: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
modLogSchema.index({ createdAt: -1 });

// Reaktion auf einen Beitrag (feste Auswahl, siehe forum/reactions.js) – je Mitglied, Beitrag und Reaktion höchstens einmal
const reactionSchema = new Schema(
  {
    post: { type: Schema.Types.ObjectId, ref: 'ForumPost', required: true },
    thread: { type: Schema.Types.ObjectId, ref: 'ForumThread', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, required: true }, // für den Tooltip "wer hat reagiert"
    reaction: { type: String, required: true }, // key aus REACTIONS
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
reactionSchema.index({ post: 1, user: 1, reaction: 1 }, { unique: true });
reactionSchema.index({ user: 1 });

// Umfrage in einem Thema (höchstens eine je Thema, angelegt mit dem Thema)
const pollSchema = new Schema(
  {
    thread: { type: Schema.Types.ObjectId, ref: 'ForumThread', required: true },
    question: { type: String, required: true },
    options: { type: [new Schema({ key: String, label: String }, { _id: false })], default: [] },
    endsAt: { type: Date, default: null }, // null = offen, bis das Thema geschlossen wird
  },
  { timestamps: true }
);
pollSchema.index({ thread: 1 }, { unique: true });

// Eine Stimme: je Mitglied und Umfrage genau eine
const pollVoteSchema = new Schema(
  {
    poll: { type: Schema.Types.ObjectId, ref: 'ForumPoll', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    option: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
pollVoteSchema.index({ poll: 1, user: 1 }, { unique: true });

module.exports = {
  ForumCategory: model('ForumCategory', categorySchema),
  ForumThread: model('ForumThread', threadSchema),
  ForumPost: model('ForumPost', postSchema),
  ForumRead: model('ForumRead', readSchema),
  ForumReport: model('ForumReport', reportSchema),
  ForumModLog: model('ForumModLog', modLogSchema),
  ForumReaction: model('ForumReaction', reactionSchema),
  ForumPoll: model('ForumPoll', pollSchema),
  ForumPollVote: model('ForumPollVote', pollVoteSchema),
};

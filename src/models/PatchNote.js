const { Schema, model } = require('mongoose');

// Patchnotes: Admins schreiben, alle Mitglieder lesen, kommentieren und geben Upvotes
const patchNoteSchema = new Schema(
  {
    title: { type: String, required: true },
    body: { type: String, required: true }, // einfacher Text mit Auszeichnung, siehe patchnotes/render.js
    authorName: { type: String, required: true },
    upvotes: { type: [Schema.Types.ObjectId], default: [] }, // Nutzer-IDs
    comments: {
      type: [
        new Schema({
          user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          username: { type: String, required: true },
          text: { type: String, required: true },
          createdAt: { type: Date, default: Date.now },
        }),
      ],
      default: [],
    },
  },
  { timestamps: true }
);
patchNoteSchema.index({ createdAt: -1 });

module.exports = model('PatchNote', patchNoteSchema);

const { Schema, model } = require('mongoose');

// Alte Patchnotes. Sie leben jetzt als Themen im Forum (Bereich "Patchnotes"); dieses Modell wird nur noch
// für die einmalige Übernahme gebraucht.
const patchNoteSchema = new Schema(
  {
    title: { type: String, required: true },
    body: { type: String, required: true }, // einfacher Text mit Auszeichnung, siehe patchnotes/render.js
    author: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // fehlt bei alten Einträgen
    authorName: { type: String, required: true },
    upvotes: { type: [Schema.Types.ObjectId], default: [] }, // Nutzer-IDs
    migrated: { type: Boolean, default: false }, // ins Forum übernommen (siehe forum/forumService)
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

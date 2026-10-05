const { Schema } = require('mongoose');

// Mängel einer Karte – gemeinsam für Kundenaufträge im Grading-Shop (GradingJob.defects) und den geheimen
// Zustand jeder Karte eines Mitglieds (TcgCard.condition.defects). Gewürfelt in src/grading/condition.js.
const defectsSchema = new Schema(
  {
    scratches: { type: [new Schema({ x: Number, y: Number, len: Number, angle: Number }, { _id: false })], default: [] },
    corners: { type: [Number], default: [] }, // 0 = oben links, 1 = oben rechts, 2 = unten rechts, 3 = unten links
    edges: { type: [new Schema({ side: Number, pos: Number }, { _id: false })], default: [] }, // side wie corners: 0 oben, 1 rechts, 2 unten, 3 links
    crease: { type: Boolean, default: false },
    // Zentrierung je Achse als Anteil der breiteren Seite (58 = 58/42); fehlt bei Kundenkarten (= perfekt)
    centering: { type: new Schema({ lr: Number, tb: Number }, { _id: false }), default: undefined },
  },
  { _id: false }
);

// Zustand einer Karte: Version der Würfel-Regeln, Note (1–10) und die Mängel, aus denen sie folgt
const conditionSchema = new Schema(
  {
    v: { type: Number, required: true },
    grade: { type: Number, required: true, min: 1, max: 10 },
    defects: { type: defectsSchema, required: true },
  },
  { _id: false }
);

module.exports = { defectsSchema, conditionSchema };

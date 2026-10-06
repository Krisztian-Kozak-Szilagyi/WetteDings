const { Schema, model } = require('mongoose');

// Ein Spieler mit Charakter- und Boost-Karte. Die Exemplare (cardDoc, boostDoc) sind bis zum Ende gesperrt (tcg/locks).
const memberFields = {
  user: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // null = Bot
  name: { type: String, required: true },
  card: { type: String, required: true }, // Karten-ID
  cardDoc: { type: Schema.Types.ObjectId, ref: 'TcgCard', default: null },
  boost: { type: String, default: null },
  boostDoc: { type: Schema.Types.ObjectId, ref: 'TcgCard', default: null },
};
const chatSchema = new Schema({ user: { type: Schema.Types.ObjectId, ref: 'User' }, name: String, text: String, at: { type: Date, default: Date.now } }, { _id: false });

// Anmeldung für den nächsten Dungeon: allein (solo, wird beim Start zugelost) oder als Gruppe mit Einladungen.
// Beim Start wird daraus ein DungeonRun, die Anmeldung samt Chat verschwindet.
const partySchema = new Schema(
  {
    slot: { type: Date, required: true }, // Startzeit des Dungeons
    solo: { type: Boolean, default: false },
    leader: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    members: { type: [new Schema({ ...memberFields, joinedAt: { type: Date, default: Date.now } }, { _id: false })], default: [] },
    invites: { type: [new Schema({ user: { type: Schema.Types.ObjectId, ref: 'User' }, name: String, at: { type: Date, default: Date.now } }, { _id: false })], default: [] },
    chat: { type: [chatSchema], default: [] },
  },
  { timestamps: true }
);
// Jeder Spieler steht höchstens in einer Anmeldung
partySchema.index({ 'members.user': 1 }, { unique: true });
partySchema.index({ 'invites.user': 1 });
partySchema.index({ slot: 1 });

// st = neue Kartenwerte [Speed, FIA, FIS, BWL] ab diesem Takt (Boost/Debuff), siehe ihkService.simulate
const tickSchema = new Schema({ m: Number, t: Number, p: Number, crit: Boolean, ability: Boolean, destroy: Boolean, st: { type: [Number], default: undefined } }, { _id: false });

// Ein Dungeon-Durchlauf (drei Spieler, Bots füllen auf). Alle Kämpfe werden beim Start ausgewürfelt und
// danach nur noch abgespielt; Lohn und Beute werden am Ende (endsAt) gutgeschrieben, der Chat gelöscht.
const runSchema = new Schema(
  {
    slot: { type: Date, required: true },
    dungeon: { type: String, required: true }, // Schlüssel aus src/dungeon/dungeons.js
    members: {
      type: [
        new Schema(
          {
            ...memberFields,
            leader: { type: Boolean, default: false },
            reward: { type: Number, default: 0 }, // Cent
            foil: { type: Boolean, default: false }, // Folie vom Boss
            bossCard: { type: Boolean, default: false }, // Boss-Karte (wird nachgereicht, sobald sie gezeichnet ist)
            seen: { type: Boolean, default: false }, // Beute-Fenster schon gezeigt
            joinedAt: { type: Date, default: null }, // Anmeldung (Manipulationserkennung: sofort nach Öffnen der Anmeldung?)
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    fights: {
      type: [
        new Schema(
          {
            key: String,
            boss: Boolean,
            required: Number,
            reward: Number, // Cent pro Spieler
            limit: Number, // Zeit für den Kampf in Spiel-Sekunden
            seconds: Number, // Dauer der Wiedergabe in echten Sekunden
            start: Number, // ab dieser Spielzeit wird abgespielt (kurz vor dem ersten Treffer)
            ticks: { type: [tickSchema], default: [] },
            abilities: { type: [new Schema({ m: Number, from: Number, team: Boolean, label: String, text: String }, { _id: false })], default: [] },
            total: Number,
            success: Boolean,
            doneAt: Number,
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    success: { type: Boolean, required: true }, // Boss besiegt
    startedAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    status: { type: String, enum: ['laeuft', 'fertig'], default: 'laeuft' },
    chat: { type: [chatSchema], default: [] },
  },
  { timestamps: true }
);
runSchema.index({ 'members.user': 1, status: 1 });
runSchema.index({ status: 1, endsAt: 1 });
runSchema.index({ startedAt: -1 }); // Protokolle: alle Durchläufe, neueste zuerst
runSchema.index({ 'members.user': 1, startedAt: -1 });

// Admin-Einstellungen (ein Dokument, _id "dungeon")
const settingsSchema = new Schema(
  {
    _id: { type: String, default: 'dungeon' },
    open: Boolean,
    intervalHours: Number,
    required: [Number],
    rewards: [Number],
    foilChance: Number,
    cardChance: Number,
    botWeights: Schema.Types.Mixed,
    updatedByName: String,
  },
  { timestamps: true }
);

module.exports = {
  DungeonParty: model('DungeonParty', partySchema),
  DungeonRun: model('DungeonRun', runSchema),
  DungeonSettings: model('DungeonSettings', settingsSchema),
};

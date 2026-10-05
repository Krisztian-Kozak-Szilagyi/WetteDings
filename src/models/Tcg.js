const { Schema, model } = require('mongoose');

// Eine Karte im Besitz eines Nutzers (jede gezogene Karte ist ein eigenes Dokument)
const cardSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    card: { type: String, required: true }, // Karten-ID aus dem Katalog, z. B. "krisz-6-glitch"
    rarity: { type: String, required: true },
    opening: { type: Schema.Types.ObjectId, ref: 'TcgOpening', default: null },
    foiledAt: { type: Date, default: null }, // foliert seit (null = ohne Folie) – siehe src/items
    lastClaimedAt: { type: Date }, // zuletzt für Quest/Handel beansprucht – nur Schreibzugriff gegen gleichzeitige Verkäufe, nicht die Sperre selbst (siehe tcg/locks)
  },
  { timestamps: true }
);
cardSchema.index({ user: 1, card: 1, createdAt: 1 });

// Ein ungeöffnetes Booster Pack im Inventar (wird beim Öffnen gelöscht)
const packSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true }, // Pack-Art aus dem Katalog (PACK_TYPES)
    source: { type: String, enum: ['kauf', 'quest', 'admin', 'lotto'], required: true },
    cost: { type: Number, default: 0 }, // bezahlter Preis in Cent (0 = geschenkt)
  },
  { timestamps: true }
);
packSchema.index({ user: 1, type: 1, createdAt: 1 });

// Protokoll: wer hat wem wann Booster Packs oder Karten geschenkt oder Karten entzogen (Admin/Dev)
const packGrantSchema = new Schema(
  {
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    byName: { type: String, required: true },
    to: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // null bei einer Vergabe an alle
    toName: { type: String, required: true }, // bei "an alle": "Alle Mitglieder (n)"
    all: { type: Boolean, default: false }, // an alle Mitglieder vergeben
    recipients: { type: Number, default: 1 }, // Zahl der beschenkten Mitglieder
    kind: { type: String, enum: ['pack', 'karte', 'entzug', 'item', 'geld', 'geldabzug', 'packentzug', 'itementzug'], default: 'pack' }, // entzug = Karte aus der Sammlung entfernt, item = Gegenstand (Folie), geld/geldabzug = Spielgeld (count = Betrag in Cent)
    type: { type: String, required: true }, // Pack-Art bzw. Karten-ID
    typeLabel: { type: String, required: true },
    count: { type: Number, required: true }, // je Mitglied
    reason: { type: String, default: null }, // Grund der Vergabe (Pflicht beim Vergeben, steht auch im Geschenk-Fenster)
  },
  { timestamps: true }
);
packGrantSchema.index({ createdAt: -1 });

// Ein geöffnetes Booster Pack (für Statistik und den Feed seltener Ziehungen)
const openingSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    cost: { type: Number, required: true }, // Cent
    cards: {
      type: [new Schema({ card: String, rarity: String }, { _id: false })],
      default: [],
    },
    best: { type: Number, required: true }, // Rang der seltensten Karte (0 = Crumpled … 5 = Glitch)
    type: { type: String, default: null }, // Pack-Art (ältere Öffnungen: null)
    source: { type: String, default: null }, // Herkunft des Packs: kauf | quest | admin | lotto (ältere Öffnungen: null)
  },
  { timestamps: true }
);
openingSchema.index({ user: 1, createdAt: -1 });
openingSchema.index({ best: -1, createdAt: -1 });

// Im Admin-Panel geänderte Preise (ein einziges Dokument mit _id "tcg")
const settingsSchema = new Schema(
  {
    _id: { type: String, default: 'tcg' },
    packPrice: { type: Number, required: true }, // Cent
    sell: { type: Schema.Types.Mixed, default: {} }, // { crumpled: Cent, … }
    weight: { type: Schema.Types.Mixed, default: null }, // { crumpled: Chance in 1/10.000, … }
    updatedByName: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = {
  TcgCard: model('TcgCard', cardSchema),
  TcgPack: model('TcgPack', packSchema),
  PackGrant: model('PackGrant', packGrantSchema),
  TcgOpening: model('TcgOpening', openingSchema),
  TcgSettings: model('TcgSettings', settingsSchema),
};

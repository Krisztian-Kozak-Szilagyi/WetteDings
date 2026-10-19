const { Schema, model } = require('mongoose');

// Shop-Demo: eingerichteter Laden eines Admins (Regeln: src/shop/layout.js). Kanacoin = reines Demo-Geld,
// hat nichts mit dem Kontostand zu tun. _id = User.
const shopDemoSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, ref: 'User' },
    coins: { type: Number, required: true },
    units: { type: Number, required: true },
    nextUid: { type: Number, required: true },
    nextBid: { type: Number, default: 1 },
    carry: { type: Number, default: null },
    prices: { type: Schema.Types.Mixed, default: {} },
    // Öffnungstage (Kunden): laufender Tag, offen?, Zahlen von heute, letzte Bewertungen, Tagesberichte
    day: { type: Number, default: 1 },
    open: { type: Boolean, default: false },
    today: { type: Schema.Types.Mixed, default: null },
    reviews: [{ _id: false, day: Number, stars: Number, text: String }],
    reports: { type: [Schema.Types.Mixed], default: [] },
    // Lizenzen, Preise für Dienste, Kunden-Aufträge (Karte, Mängel, erledigte Schritte – src/shop/layout.js)
    licenses: { type: [String], default: [] },
    servicePrices: { type: Schema.Types.Mixed, default: {} },
    jobs: { type: [Schema.Types.Mixed], default: [] },
    nextJid: { type: Number, default: 1 },
    // Sauberkeit: Flecken auf dem Boden, gekaufte Werkzeuge (Wischmopp)
    dirt: { type: [Schema.Types.Mixed], default: [] },
    nextDid: { type: Number, default: 1 },
    tools: { type: [String], default: [] },
    // bewegliche Marktpreise (src/shop/layout.js moveMarket)
    market: { type: Schema.Types.Mixed, default: {} },
    marketMoves: { type: [Schema.Types.Mixed], default: [] },
    marketDay: { type: Number, default: 0 },
    // Räume (Lager, Geheimraum) – src/shop/layout.js
    rooms: { type: [Schema.Types.Mixed], default: [] },
    nextRid: { type: Number, default: 1 },
    // Ruf & Stufe, Kleidung (src/shop/layout.js)
    ruf: { type: Number, default: 0 },
    level: { type: Number, default: 1 },
    wardrobe: { type: [String], default: [] },
    outfit: { type: Schema.Types.Mixed, default: {} },
    // Plakate: gedruckt (Typ → Stück), aufgehängt (Ort → Typ)
    posters: { type: Schema.Types.Mixed, default: {} },
    hung: { type: Schema.Types.Mixed, default: {} },
    // Tasche (Dungeon-Karten, Karten vom Brett) und Schwarzes Brett (Aushänge der NPCs) – src/shop/layout.js
    bag: { type: Schema.Types.Mixed, default: {} },
    board: { type: [Schema.Types.Mixed], default: [] },
    nextPid: { type: Number, default: 1 },
    boardDay: { type: Number, default: 0 },
    // Turniere: angekündigt (plan), heute laufend (active), letztes, Verlauf – src/shop/layout.js, Regeln src/shop/turnier.js
    turnier: { type: Schema.Types.Mixed, default: () => ({ plan: null, active: null, last: 0, history: [] }) },
    boxes: [{ _id: false, bid: Number, kind: String, id: String, qty: Number, x: Number, y: Number }],
    items: [
      {
        _id: false,
        uid: Number,
        id: String,
        x: Number,
        y: Number,
        rot: Number,
        wall: String,
        stock: Schema.Types.Mixed,
        posters: Schema.Types.Mixed, // Safe: gelagerte Plakate
        guest: Boolean,
        card: String, // Spielautomat: eingelegte Dungeon-Karte
        cardName: String, // Kühlschrank nur für wartende Gäste (gratis, kein Verkauf)
        rid: Number, // Geheimschrank: zu welchem Raum
        home: Schema.Types.Mixed, // Geheimschrank: Platz vor der Tür
      },
    ],
  },
  { timestamps: true, minimize: false }
);

module.exports = model('ShopDemo', shopDemoSchema);

const { Schema, model } = require('mongoose');

// Zustand der Kurs-Simulation (ein Dokument pro Coin)
const coinStateSchema = new Schema(
  {
    _id: { type: String }, // Symbol, z. B. "SAM"
    price: { type: Number, required: true }, // € pro Coin
    lv: { type: Number, required: true }, // log(Volatilität)
    lastTickAt: { type: Date, required: true },
    ath: { type: Number, required: true }, // Allzeithoch
    athAt: { type: Date, required: true },
    startedAt: { type: Date, required: true },
    // Großer Sprung im aktuellen 12-Stunden-Fenster: slot = Fensterbeginn (ms), at = geplanter Zeitpunkt (ms)
    // oder null (kein Sprung bzw. schon passiert), log = Änderung im Log-Maß
    surge: {
      type: new Schema({ slot: Number, at: Number, log: Number }, { _id: false }),
      default: null,
    },
    // Nur ETF: Trend (Log-Rendite pro Tag), sein Zielwert aus der Aktivität und die Marktstimmung (−1 … +1)
    mu: { type: Number, default: 0 },
    muTarget: { type: Number, default: 0 },
    sentiment: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const candle = {
  coin: { type: String, required: true },
  t: { type: Date, required: true }, // Beginn des Zeitraums
  o: Number,
  h: Number,
  l: Number,
  c: Number,
};

// Minutenkerzen – werden nach 3 Tagen automatisch gelöscht
const minuteSchema = new Schema(candle, { versionKey: false });
minuteSchema.index({ coin: 1, t: 1 }, { unique: true });
minuteSchema.index({ t: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

// Stundenkerzen – dauerhaft
const hourSchema = new Schema(candle, { versionKey: false });
hourSchema.index({ coin: 1, t: 1 }, { unique: true });

// Marktereignisse (große Sprünge, Pumps, Crashs)
const eventSchema = new Schema(
  {
    coin: { type: String, required: true },
    at: { type: Date, required: true },
    type: { type: String, required: true },
    change: { type: Number, required: true }, // relative Änderung, z. B. -0.35
    price: { type: Number, required: true },
  },
  { versionKey: false }
);
eventSchema.index({ coin: 1, at: -1 });

// Bestand eines Nutzers (in Einheiten von 1e-8 Coin, wie Satoshi)
const holdingSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    coin: { type: String, required: true },
    units: { type: Number, default: 0, min: 0 },
    costCents: { type: Number, default: 0 }, // Einstandswert des aktuellen Bestands
  },
  { timestamps: true }
);
holdingSchema.index({ user: 1, coin: 1 }, { unique: true });

// Ausgeführte Käufe/Verkäufe
const tradeSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    coin: { type: String, required: true },
    side: { type: String, enum: ['kauf', 'verkauf'], required: true },
    units: { type: Number, required: true },
    price: { type: Number, required: true },
    cents: { type: Number, required: true }, // beim Verkauf: Erlös nach Steuer
    tax: { type: Number, default: 0 }, // Cent, Steuer auf den Gewinn (nur Verkauf)
  },
  { timestamps: true }
);
tradeSchema.index({ user: 1, createdAt: -1 });
tradeSchema.index({ createdAt: -1 }); // Protokolle: alle Käufe und Verkäufe

module.exports = {
  CoinState: model('CoinState', coinStateSchema),
  CoinMinute: model('CoinMinute', minuteSchema),
  CoinHour: model('CoinHour', hourSchema),
  CoinEvent: model('CoinEvent', eventSchema),
  CoinHolding: model('CoinHolding', holdingSchema),
  CoinTrade: model('CoinTrade', tradeSchema),
};

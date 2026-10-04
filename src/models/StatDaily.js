const { Schema, model } = require('mongoose');

// Täglicher Stand der Wirtschaft (ein Dokument pro Tag, _id = "YYYY-MM-DD" deutsche Zeit). Hält Bestände fest,
// die sich später nicht mehr aus Verläufen rekonstruieren lassen: Vermögensverteilung, Coin- und Kartenbestand,
// offene Angebote. Wird von stats/snapshot.js einmal am Tag geschrieben.
const statDailySchema = new Schema(
  {
    _id: { type: String }, // Tag
    at: { type: Date, required: true }, // Zeitpunkt der Aufnahme
    users: { type: Schema.Types.Mixed, default: {} }, // { total, banned }
    wealth: { type: Schema.Types.Mixed, default: {} }, // Summen und Verteilung des Gesamtvermögens (Cent)
    coin: { type: Schema.Types.Mixed, default: {} }, // Samantha Coin: { price, units, holders }
    coins: { type: Schema.Types.Mixed, default: {} }, // alle Broker-Werte: { SAM: { price, units, holders }, COW: …, BTCG: … }
    cards: { type: Schema.Types.Mixed, default: {} }, // { total, byRarity, packsUnopened, packPrice }
    market: { type: Schema.Types.Mixed, default: {} }, // offene Handelsangebote je Art
    bets: { type: Schema.Types.Mixed, default: {} }, // { open, disputed }
    // Vermögen je Mitglied (Cent) – für Verläufe einzelner Spieler
    players: {
      type: [new Schema({ user: Schema.Types.ObjectId, balance: Number, inPlay: Number, coinValue: Number, cardValue: Number, total: Number }, { _id: false })],
      default: [],
    },
  },
  { versionKey: false }
);

module.exports = model('StatDaily', statDailySchema);

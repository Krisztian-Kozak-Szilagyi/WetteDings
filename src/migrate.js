const config = require('./config');
const Bet = require('./models/Bet');
const { TcgCard, TcgOpening } = require('./models/Tcg');
const { IhkRun } = require('./models/Ihk');
const { Trade } = require('./models/Trade');
const User = require('./models/User');
const Ledger = require('./models/Ledger');

/**
 * Datenbank-Migrationen, die beim Start laufen. Idempotent – mehrfaches Ausführen schadet nicht.
 */
async function migrate() {
  // v1 -> v2: totalJa/totalNein wurden zu einer Options-Liste
  const res = await Bet.collection.updateMany({ options: { $exists: false } }, [
    {
      $set: {
        type: 'janein',
        options: [
          { key: 'ja', label: 'Ja', total: { $ifNull: ['$totalJa', 0] } },
          { key: 'nein', label: 'Nein', total: { $ifNull: ['$totalNein', 0] } },
        ],
      },
    },
    { $unset: ['totalJa', 'totalNein'] },
  ]);
  if (res.modifiedCount) console.log(`Migration: ${res.modifiedCount} Wette(n) auf Options-Format umgestellt.`);

  // Provision gesenkt: noch offene Wetten mit höherer Provision auf den aktuellen Satz setzen
  // (nur zugunsten der Teilnehmer; abgeschlossene Wetten bleiben unverändert)
  const fee = await Bet.updateMany(
    { status: 'offen', creatorFeePercent: { $gt: config.creatorFeePercent } },
    { $set: { creatorFeePercent: config.creatorFeePercent } }
  );
  if (fee.modifiedCount) {
    console.log(`Migration: Provision bei ${fee.modifiedCount} offenen Wette(n) auf ${config.creatorFeePercent} % gesenkt.`);
  }

  // Schiedsrichter-Verfahren: Altbestand bekommt die neuen Felder (Wetten von davor haben keinen
  // Schiedsrichter – dort entscheidet weiterhin der Ersteller allein, siehe lib/verdict)
  const votes = await Bet.collection.updateMany({ votes: { $exists: false } }, { $set: { votes: [], disputed: false } });
  if (votes.modifiedCount) console.log(`Migration: ${votes.modifiedCount} Wette(n) auf das Schiedsrichter-Verfahren vorbereitet.`);

  // Good Boy wurde entfernt: Wer ihn hatte, bekommt stattdessen Lilly (auch in Quests, Angeboten und im Verlauf)
  const from = 'good-boy-holo';
  const to = 'lilly-holo';
  const dogs = await TcgCard.updateMany({ card: from }, { $set: { card: to } });
  if (dogs.modifiedCount) console.log(`Migration: ${dogs.modifiedCount}× Good Boy durch Lilly ersetzt.`);
  await IhkRun.updateMany({ card: from }, { $set: { card: to } });
  await IhkRun.updateMany({ boost: from }, { $set: { boost: to } });
  await Trade.updateMany({ card: from }, { $set: { card: to } });
  await Trade.updateMany({ wantCard: from }, { $set: { wantCard: to } });
  await TcgOpening.updateMany({ 'cards.card': from }, { $set: { 'cards.$[c].card': to } }, { arrayFilters: [{ 'c.card': from }] });

  // "Schon besessen" (tcgSeen) für Altbestand nachtragen: aktuelle Karten, alle geöffneten Packs und
  // alle über den Handel erhaltenen Karten. Läuft nur für Konten, die das Feld noch nicht haben.
  const todo = await User.find({ tcgSeen: { $exists: false } }).select('_id').lean();
  if (todo.length) {
    const ids = todo.map((u) => u._id);
    const seen = new Map(ids.map((id) => [String(id), new Set()]));
    const add = (user, card) => user && card && seen.has(String(user)) && seen.get(String(user)).add(card);
    const [cards, openings, trades] = await Promise.all([
      TcgCard.aggregate([{ $match: { user: { $in: ids } } }, { $group: { _id: { u: '$user', c: '$card' } } }]),
      TcgOpening.find({ user: { $in: ids } }).select('user cards.card').lean(),
      Trade.find({ status: 'verkauft' }).select('kind seller buyer to card wantCard').lean(),
    ]);
    for (const c of cards) add(c._id.u, c._id.c);
    for (const o of openings) for (const c of o.cards) add(o.user, c.card);
    for (const t of trades) {
      if (t.kind === 'tausch') {
        add(t.to, t.card);
        add(t.seller, t.wantCard);
      } else add(t.buyer, t.card);
    }
    await User.bulkWrite(
      ids.map((id) => ({ updateOne: { filter: { _id: id, tcgSeen: { $exists: false } }, update: { $set: { tcgSeen: [...seen.get(String(id))] } } } }))
    );
    console.log(`Migration: "schon besessen" für ${ids.length} Konto/Konten nachgetragen.`);
  }

  // Gelöschte Konten, auf denen sich (vor dem Fix in payOut) noch Auszahlungen gesammelt haben: Guthaben verfällt,
  // mit Buchung, damit die Summe aller Buchungen weiter der Geldmenge entspricht
  const shells = await User.find({ deletedAt: { $ne: null }, balance: { $gt: 0 } }).select('_id balance').lean();
  for (const u of shells) {
    const done = await User.updateOne({ _id: u._id, balance: u.balance }, { $set: { balance: 0 } });
    if (done.modifiedCount) await Ledger.create({ user: u._id, type: 'konto_geloescht', amount: -u.balance });
  }
  if (shells.length) console.log(`Migration: Guthaben von ${shells.length} gelöschten Konto/Konten verfallen lassen.`);
}

module.exports = { migrate };

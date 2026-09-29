/**
 * Totalisator-Prinzip (Pari-Mutuel):
 * Alle Einsätze einer Wette landen in einem Topf. Die Gewinnerseite bekommt ihren
 * Einsatz zurück und teilt sich zusätzlich den kompletten Einsatz der Verliererseite –
 * anteilig nach Höhe des eigenen Einsatzes. Es gibt keine Gebühr, nichts geht verloren.
 *
 * Sonderfälle (alle Einsätze werden erstattet):
 *  - Wette annulliert
 *  - Niemand hat auf die Gewinnerseite gesetzt
 *  - Niemand hat auf die Verliererseite gesetzt (es gibt nichts zu gewinnen)
 *
 * Alle Beträge sind Cent-Ganzzahlen. Rundungsreste werden nach dem
 * Größter-Rest-Verfahren verteilt, damit die Summe der Auszahlungen exakt dem Topf entspricht.
 *
 * @param {{id: string, side: 'ja'|'nein', amount: number}[]} positions  in Einsatz-Reihenfolge
 * @param {'ja'|'nein'|'annulliert'} outcome
 * @returns {{ payouts: Map<string, number>, refunded: boolean }}
 */
function computePayouts(positions, outcome) {
  const payouts = new Map();

  const refundAll = () => {
    for (const p of positions) payouts.set(p.id, p.amount);
    return { payouts, refunded: true };
  };

  if (outcome !== 'ja' && outcome !== 'nein') return refundAll();

  const winners = positions.filter((p) => p.side === outcome);
  const losers = positions.filter((p) => p.side !== outcome);
  const winTotal = winners.reduce((s, p) => s + p.amount, 0);
  const loseTotal = losers.reduce((s, p) => s + p.amount, 0);

  if (winTotal === 0 || loseTotal === 0) return refundAll();

  const W = BigInt(winTotal);
  const L = BigInt(loseTotal);
  let distributed = 0n;
  const remainders = [];

  winners.forEach((p, index) => {
    const numerator = BigInt(p.amount) * L;
    const share = numerator / W;
    distributed += share;
    payouts.set(p.id, p.amount + Number(share));
    remainders.push({ id: p.id, rem: numerator % W, index });
  });

  // Übrige Cents an die größten Rundungsreste (bei Gleichstand: wer früher gesetzt hat)
  let leftover = Number(L - distributed);
  remainders.sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  for (let i = 0; leftover > 0; i++, leftover--) {
    const r = remainders[i];
    payouts.set(r.id, payouts.get(r.id) + 1);
  }

  for (const p of losers) payouts.set(p.id, 0);
  return { payouts, refunded: false };
}

/** Aktuelle Quote einer Seite (Auszahlung pro 1 € Einsatz), oder null. */
function quote(sideTotal, otherTotal) {
  if (!sideTotal) return null;
  return (sideTotal + otherTotal) / sideTotal;
}

module.exports = { computePayouts, quote };

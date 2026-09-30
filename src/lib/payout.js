/**
 * Totalisator-Prinzip (Pari-Mutuel) mit Provision für den Wettersteller:
 * Alle Einsätze einer Wette landen in einem Topf. Vom Topf erhält der Wettersteller
 * feePercent % als Provision. Den Rest teilen sich alle, die auf die eingetretene Option
 * gesetzt haben – anteilig nach Höhe ihres Einsatzes.
 *
 * Sonderfälle (alle Einsätze werden vollständig erstattet, keine Provision):
 *  - Wette annulliert
 *  - Niemand hat auf die eingetretene Option gesetzt
 *  - Alle haben auf die eingetretene Option gesetzt (es gibt nichts zu gewinnen)
 *
 * Gewinner-Schutz: Die Provision ist höchstens so hoch wie die Einsätze der Verlierer.
 * Wer gewinnt, bekommt dadurch nie weniger zurück, als er eingesetzt hat – auch dann nicht,
 * wenn fast alle auf dieselbe Option gesetzt haben.
 *
 * Alle Beträge sind Cent-Ganzzahlen. Die Provision wird abgerundet, Rundungsreste der
 * Gewinner werden nach dem Größter-Rest-Verfahren verteilt – die Summe aus Auszahlungen
 * und Provision entspricht immer exakt dem Topf.
 *
 * @param {{id: string, side: string, amount: number}[]} positions  in Einsatz-Reihenfolge
 * @param {string} outcome  key der eingetretenen Option oder 'annulliert'
 * @param {number} feePercent  Provision des Wetterstellers in Prozent (0–100)
 * @returns {{ payouts: Map<string, number>, refunded: boolean, fee: number }}
 */
function computePayouts(positions, outcome, feePercent = 0) {
  const payouts = new Map();

  const refundAll = () => {
    for (const p of positions) payouts.set(p.id, p.amount);
    return { payouts, refunded: true, fee: 0 };
  };

  if (!outcome || outcome === 'annulliert') return refundAll();

  const winners = positions.filter((p) => p.side === outcome);
  const losers = positions.filter((p) => p.side !== outcome);
  const winTotal = winners.reduce((s, p) => s + p.amount, 0);
  const loseTotal = losers.reduce((s, p) => s + p.amount, 0);

  if (winTotal === 0 || loseTotal === 0) return refundAll();

  const pot = winTotal + loseTotal;
  const fee = feeFor(pot, loseTotal, feePercent);
  const W = BigInt(winTotal);
  const D = BigInt(pot - fee); // an die Gewinner zu verteilen
  let distributed = 0n;
  const remainders = [];

  winners.forEach((p, index) => {
    const numerator = BigInt(p.amount) * D;
    const share = numerator / W;
    distributed += share;
    payouts.set(p.id, Number(share));
    remainders.push({ id: p.id, rem: numerator % W, index });
  });

  // Übrige Cents an die größten Rundungsreste (bei Gleichstand: wer früher gesetzt hat)
  let leftover = Number(D - distributed);
  remainders.sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  for (let i = 0; leftover > 0; i++, leftover--) {
    const r = remainders[i];
    payouts.set(r.id, payouts.get(r.id) + 1);
  }

  for (const p of losers) payouts.set(p.id, 0);
  return { payouts, refunded: false, fee };
}

/**
 * Provision in Cent: feePercent % vom Topf, aber höchstens die Einsätze der Verlierer
 * (sonst müssten die Gewinner draufzahlen).
 */
function feeFor(pot, loseTotal, feePercent = 0) {
  const pct = Math.min(100, Math.max(0, feePercent));
  return Math.min(Math.floor((pot * pct) / 100), loseTotal);
}

/** Aktuelle Quote einer Option (Auszahlung pro 1 € Einsatz, nach Provision), oder null. Nie unter 1,00. */
function quote(sideTotal, otherTotal, feePercent = 0) {
  if (!sideTotal) return null;
  const pot = sideTotal + otherTotal;
  const payable = otherTotal ? pot - Math.min((pot * feePercent) / 100, otherTotal) : pot;
  return payable / sideTotal;
}

module.exports = { computePayouts, quote, feeFor };

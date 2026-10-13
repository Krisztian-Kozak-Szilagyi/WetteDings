// Wochenrückblick (jeden Freitag 11:30 Uhr im Forum, siehe weeklyReviewService.js): reine Auswertung ohne Datenbank.
//  - Top-Gewinner: größter Zuwachs des Gesamtvermögens (Rangliste) gegenüber dem Tagesstand vor einer Woche
//  - Größter Aufsteiger: die meisten gewonnenen Ranglistenplätze (unter denen, die es vor einer Woche schon gab)
//  - Seltenste Ziehung: seltenste Karte aus einer Pack-Öffnung der Woche (geheime Seltenheiten zählen nicht)
//  - Bester Trade: der teuerste abgeschlossene Verkauf im Handel (Karten/Gegenstände gegen Geld)
const { euro } = require('../lib/viewHelpers');

const REVIEW_TIME = '11:30';
const REVIEW_WEEKDAY = 5; // Freitag (0 = Sonntag)
const TOP_GAINERS = 3;
const DAY = 24 * 60 * 60 * 1000;

/** Tag "YYYY-MM-DD" um n Tage verschieben */
function shiftDay(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  return new Date(d.getTime() + n * DAY).toISOString().slice(0, 10);
}
const weekdayOf = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
/** "2026-10-09" → "09.10." bzw. mit Jahr "09.10.2026" */
const dateLabel = (day, year = false) => {
  const [y, m, d] = day.split('-');
  return `${d}.${m}.${year ? y : ''}`;
};

/**
 * Gewinner und Aufsteiger. now: aktuelle Rangliste [{ user, username, total }] (bestes zuerst, ohne Team);
 * past: Tagesstand vor einer Woche [{ user, total }]. Gezählt werden nur Mitglieder, die in beiden vorkommen
 * (wer neu ist, „gewinnt“ sonst sein Startguthaben); die Plätze werden innerhalb dieser Gruppe verglichen.
 */
function standings(now, past) {
  const before = new Map((past || []).map((p) => [String(p.user), p.total || 0]));
  const both = (now || []).filter((p) => before.has(String(p.user)));
  const pastOrder = [...both].sort((a, b) => before.get(String(b.user)) - before.get(String(a.user)));
  const pastRank = new Map(pastOrder.map((p, i) => [String(p.user), i + 1]));
  const rows = both.map((p, i) => {
    const id = String(p.user);
    return { user: id, name: p.username, gain: (p.total || 0) - before.get(id), from: pastRank.get(id), to: i + 1 };
  });
  const gainers = rows
    .filter((r) => r.gain > 0)
    .sort((a, b) => b.gain - a.gain || a.to - b.to)
    .slice(0, TOP_GAINERS);
  const climber =
    rows
      .filter((r) => r.from > r.to)
      .sort((a, b) => b.from - b.to - (a.from - a.to) || b.gain - a.gain || a.to - b.to)[0] || null;
  return { gainers, climber };
}

/**
 * Seltenste Ziehung: openings [{ username, cards, createdAt }], bestCard = hallOfFame.bestCard.
 * Höchste Seltenheit gewinnt, bei Gleichstand die frühere Öffnung.
 */
function rarestPull(openings, bestCard) {
  let top = null;
  for (const o of openings || []) {
    const best = bestCard(o.cards);
    if (!best) continue;
    if (!top || best.rarity.rank > top.rarity.rank || (best.rarity.rank === top.rarity.rank && o.createdAt < top.at)) {
      top = { user: o.user, name: o.username, card: best.card, rarity: best.rarity, at: o.createdAt };
    }
  }
  return top;
}

/** Bester Trade: der höchste Preis unter den Verkäufen [{ sellerName, buyerName, price, give, closedAt }] */
function bestTrade(trades) {
  let top = null;
  for (const t of trades || []) {
    if (!(t.price > 0) || !t.buyerName) continue;
    if (!top || t.price > top.price || (t.price === top.price && t.closedAt < top.closedAt)) top = t;
  }
  return top;
}

/**
 * Text für das Forum. data: { gainers, climber, pull, trade, from, to } – pull mit cardName, trade mit label
 * (Positionen als Text). from/to = Tage "YYYY-MM-DD" (Beginn/Ende der Woche).
 */
function reviewText(data) {
  const { gainers = [], climber = null, pull = null, trade = null, from, to } = data;
  const parts = [`Die Woche vom ${dateLabel(from)} bis ${dateLabel(to, true)} ist vorbei – das waren ihre Höhepunkte.`];

  parts.push('## Top-Gewinner der Woche');
  if (gainers.length) parts.push(gainers.map((g, i) => `- ${i + 1}. @${g.name} – **+${euro(g.gain)}**`).join('\n'));
  else parts.push('Diese Woche hat niemand an Vermögen zugelegt.');

  parts.push('## Seltenste Ziehung');
  if (pull) parts.push(`@${pull.name} hat **${pull.cardName}** (${pull.rarity.label}) gezogen.\n[karte:${pull.card}]`);
  else parts.push('Diese Woche wurde kein Pack geöffnet.');

  parts.push('## Bester Trade');
  if (trade) parts.push(`@${trade.buyerName} hat von @${trade.sellerName} **${trade.label}** für **${euro(trade.price)}** gekauft.`);
  else parts.push('Diese Woche wurde im Handel nichts verkauft.');

  parts.push('## Größter Aufsteiger in der Rangliste');
  if (climber) {
    const n = climber.from - climber.to;
    parts.push(`@${climber.name} ist von Platz ${climber.from} auf Platz **${climber.to}** geklettert – ${n === 1 ? 'ein Platz' : `${n} Plätze`} nach oben.`);
  } else parts.push('Diese Woche hat sich in der Rangliste niemand nach oben gearbeitet.');

  parts.push('Der nächste Rückblick erscheint am Freitag um 11:30 Uhr.');
  return { title: `Wochenrückblick ${dateLabel(from)} – ${dateLabel(to, true)}`, body: parts.join('\n\n') };
}

module.exports = { REVIEW_TIME, REVIEW_WEEKDAY, TOP_GAINERS, shiftDay, weekdayOf, dateLabel, standings, rarestPull, bestTrade, reviewText };

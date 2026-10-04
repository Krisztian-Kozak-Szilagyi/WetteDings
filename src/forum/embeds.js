// Daten für die Einbettungen in Forum-Beiträgen (siehe forum/render.js): erst alle Verweise der Seite sammeln,
// dann je Art eine Abfrage. Ergebnis ist der ctx für render(body, ctx).
const Bet = require('../models/Bet');
const User = require('../models/User');
const { collectRefs } = require('./render');

/**
 * Wetten zeigen nur, was alle Mitglieder sehen dürfen: keine Gruppen-Wetten und keine offenen Duell-Anfragen
 * (die bleiben ein einfacher Link – die Wett-Seite prüft selbst, wer sie sehen darf). Namen nur von bestehenden Konten.
 */
async function loadEmbeds(bodies) {
  const { bets, names } = collectRefs(bodies.filter(Boolean));
  const [betDocs, users] = await Promise.all([
    bets.length ? Bet.find({ _id: { $in: bets }, group: null, 'duel.state': { $ne: 'angefragt' } }).select('title status options.total duel.state').lean() : [],
    names.length ? User.find({ usernameLower: { $in: names }, deletedAt: null }).select('username usernameLower').lean() : [],
  ]);
  return {
    bets: new Map(betDocs.map((b) => [String(b._id), { title: b.title, status: b.status, pot: (b.options || []).reduce((s, o) => s + (o.total || 0), 0), duel: !!b.duel }])),
    users: new Map(users.map((u) => [u.usernameLower, u.username])),
  };
}

/** Bestehende Mitglieder zu den @Erwähnungen eines Textes (höchstens max) */
async function mentionedUsers(names, max = 20) {
  const list = names.slice(0, max);
  return list.length ? User.find({ usernameLower: { $in: list }, deletedAt: null }).select('_id username').lean() : [];
}

module.exports = { loadEmbeds, mentionedUsers };

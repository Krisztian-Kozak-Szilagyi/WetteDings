// Reaktionen auf Forum-Beiträge: eine kleine feste Auswahl (zusätzlich zu den Upvotes der Themen).
// Je Mitglied, Beitrag und Reaktion höchstens einmal – ein zweiter Klick nimmt sie zurück (forumService.toggleReaction).

const REACTIONS = [
  { key: 'daumen', emoji: '👍', label: 'Daumen hoch' },
  { key: 'lachen', emoji: '😂', label: 'Lachen' },
  { key: 'staunen', emoji: '😮', label: 'Staunen' },
  { key: 'traurig', emoji: '😢', label: 'Traurig' },
  { key: 'feuer', emoji: '🔥', label: 'Feuer' },
  { key: 'herz', emoji: '❤️', label: 'Herz' },
];
const reactionByKey = Object.fromEntries(REACTIONS.map((r) => [r.key, r]));
const NAMES_MAX = 15; // so viele Namen im Tooltip, danach "und n weitere"

/** Tooltip: wer hat reagiert */
function whoText(names) {
  if (!names.length) return '';
  const shown = names.slice(0, NAMES_MAX).join(', ');
  return names.length > NAMES_MAX ? `${shown} und ${names.length - NAMES_MAX} weitere` : shown;
}

/**
 * Reaktionen (alle Beiträge einer Seite, aus einer Abfrage) → Map postId → Liste in fester Reihenfolge:
 * [{ key, emoji, label, count, mine, who }]. Unbekannte Reaktionen (z. B. eine entfernte Auswahl) zählen nicht.
 */
function summarize(docs, meId) {
  const me = String(meId);
  const byPost = new Map();
  for (const d of docs) {
    if (!reactionByKey[d.reaction]) continue;
    const pid = String(d.post);
    if (!byPost.has(pid)) byPost.set(pid, Object.fromEntries(REACTIONS.map((r) => [r.key, { names: [], mine: false }])));
    const slot = byPost.get(pid)[d.reaction];
    slot.names.push(d.userName);
    if (String(d.user) === me) slot.mine = true;
  }
  const out = new Map();
  for (const [pid, slots] of byPost) {
    out.set(
      pid,
      REACTIONS.map((r) => ({ ...r, count: slots[r.key].names.length, mine: slots[r.key].mine, who: whoText(slots[r.key].names) }))
    );
  }
  return out;
}

/** Leere Liste (Beitrag ohne Reaktionen) */
const empty = () => REACTIONS.map((r) => ({ ...r, count: 0, mine: false, who: '' }));

module.exports = { REACTIONS, reactionByKey, whoText, summarize, empty };

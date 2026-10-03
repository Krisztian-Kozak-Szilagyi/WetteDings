// Einstimmigkeit beim Ergebnis: Wettersteller und Schiedsrichter müssen dasselbe Ergebnis nennen.
// Sind sie sich nicht einig, gilt die Wette als strittig – dann entscheidet ein Dev mit seiner Stimme.
// Reine Logik ohne Datenbank, damit sie prüfbar bleibt (siehe test/verdict.test.js).

/** Rollen, deren Stimmen übereinstimmen müssen */
const VOTER_ROLES = ['creator', 'referee'];

const ROLE_LABELS = {
  creator: 'Wettersteller',
  referee: 'Schiedsrichter',
  dev: 'Dev',
  system: 'System',
};

/**
 * Rolle des Handelnden bei der Ergebnisfindung: 'system' | 'creator' | 'referee' | 'dev' | null.
 * Die eigene Beteiligung wiegt schwerer als die Dev-Rolle: Ein Dev, der die Wette aufgestellt hat
 * (oder dort Schiedsrichter ist), stimmt als Beteiligter ab und kann seinen eigenen Streitfall
 * nicht allein entscheiden – dafür braucht es einen anderen Dev.
 */
function verdictRole(bet, actor) {
  if (!actor) return null;
  if (actor.system) return 'system';
  const id = actor._id ? String(actor._id) : null;
  if (id && String(bet.creator) === id) return 'creator';
  if (id && bet.referee && String(bet.referee) === id) return 'referee';
  if (actor.isAdmin || actor.isDev) return 'dev';
  return null;
}

/**
 * Darf ein unbeteiligter Dev hier eingreifen? Annullieren geht immer (z. B. bei Regelverstößen),
 * ein Ergebnis festlegen nur im Streitfall oder wenn der Auswertungstermin vorbei ist
 * (ohne Termin: der Einsatzschluss) – vorher entscheiden Wettersteller und Schiedsrichter.
 * outcome: 'annulliert' oder ein Options-key; null fragt, ob ein Ergebnis festgelegt werden darf.
 */
function devMayDecide(bet, outcome, now = new Date()) {
  if (outcome === 'annulliert' || bet.disputed) return true;
  const due = bet.resultAt || bet.deadline;
  return !!due && new Date(due) <= now;
}

/**
 * Wertet die abgegebenen Stimmen aus. votes: [{ role, outcome }] – je Rolle zählt eine Stimme.
 * Alte Wetten ohne Schiedsrichter (hasReferee = false): der Wettersteller entscheidet allein.
 * -> { decided, disputed, outcome, missing }
 */
function evaluateVotes(votes, { hasReferee = true } = {}) {
  const needed = hasReferee ? VOTER_ROLES : ['creator'];
  const given = new Map();
  for (const v of votes || []) {
    if (needed.includes(v.role)) given.set(v.role, v.outcome);
  }
  const missing = needed.filter((role) => !given.has(role));
  if (missing.length) return { decided: false, disputed: false, outcome: null, missing };

  const outcomes = [...given.values()];
  const agreed = outcomes.every((o) => o === outcomes[0]);
  return { decided: agreed, disputed: !agreed, outcome: agreed ? outcomes[0] : null, missing: [] };
}

module.exports = { VOTER_ROLES, ROLE_LABELS, verdictRole, devMayDecide, evaluateVotes };

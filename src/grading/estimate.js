// Grading-Shop: Schätzung, wie viel ein Mitglied an einem Tag verdient (Admin-Panel, Spielwerte).
// Dieselbe Rechnung läuft im Browser live mit (public/js/app.js, [data-grading-calc]) – Änderungen an beiden Stellen!

// Annahmen, wie gut jemand arbeitet: clean/seal in %, exact = Anteil exakter Noten, near = Anteil ±1
const PROFILES = [
  { key: 'perfekt', label: 'Perfekt', clean: 100, exact: 1, near: 0, seal: 100 },
  { key: 'geuebt', label: 'Geübt', clean: 95, exact: 0.6, near: 0.35, seal: 90 },
  { key: 'durchschnitt', label: 'Durchschnitt', clean: 85, exact: 0.35, near: 0.4, seal: 75 },
];

/** Durchschnittlicher Lohnfaktor durch die Seltenheit der Kundenkarten, z. B. 1,07 */
function rarityFactor(customerRarities, hasCards = () => true) {
  const list = customerRarities.filter(([k]) => hasCards(k));
  const total = list.reduce((s, [, w]) => s + w, 0);
  return total ? list.reduce((s, [, w, b]) => s + w * (1 + b / 100), 0) / total : 1;
}

/** Erwarteter Lohn eines Auftrags in Cent (ohne Folie) für eine Stufe und ein Profil */
function jobPay({ steps, premium }, pay, premiumPercent, profile, factor) {
  let p = (pay.clean * profile.clean) / 100;
  if (steps.includes('grade')) p += pay.grade * (profile.exact + profile.near / 2);
  if (steps.includes('slab')) p += (pay.slab * profile.seal) / 100;
  return p * (premium ? 1 + premiumPercent / 100 : 1) * factor;
}

/**
 * Schätzung je Stufe: { level, name, cost, perDay: { [profil]: Cent }, payback: Tage bis sich der Ausbau
 * (gegenüber der Stufe davor, Profil "Durchschnitt") bezahlt hat oder null }.
 * foilValue = erwarteter Wert der Folie pro versiegeltem Auftrag in Cent (Chance × Bankpreis).
 */
function estimate({ levels, settings, factor, foilValue = 0, profiles = PROFILES }) {
  const rows = levels.map((l, i) => {
    const perDay = {};
    for (const pr of profiles) {
      const foil = l.steps.includes('slab') && pr.seal > 0 ? foilValue : 0;
      perDay[pr.key] = Math.round(settings.jobs * (jobPay(l, settings.pay, settings.premium, pr, factor) + foil));
    }
    return { level: l.level, name: l.name, cost: i ? settings.costs[i - 1] : 0, perDay };
  });
  const ref = profiles[profiles.length - 1].key;
  rows.forEach((r, i) => {
    const gain = i ? r.perDay[ref] - rows[i - 1].perDay[ref] : 0;
    r.payback = i && gain > 0 ? Math.ceil(r.cost / gain) : null;
  });
  return rows;
}

module.exports = { PROFILES, rarityFactor, jobPay, estimate };

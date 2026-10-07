// Gleitflug: Ein Kurs läuft über einige Stunden gleichmäßig (im Log-Maß) auf einen Zielkurs zu und läuft danach
// normal weiter. Das Rauschen des Kursmodells bleibt, der Gleitflug zieht nur bei jedem Takt den passenden Anteil
// des restlichen Abstands nach – am Ende steht der Kurs genau auf dem Ziel. Rein und testbar (ohne Datenbank).

/**
 * Kurs nach einem Takt. glide: { target, endAt (ms) }; prevMs = Zeit des letzten Takts, atMs = jetzt.
 * Gibt { price, done } zurück; done = Ziel erreicht, Gleitflug beenden.
 */
function glideStep(price, glide, prevMs, atMs) {
  if (atMs >= glide.endAt) return { price: glide.target, done: true };
  if (atMs <= prevMs) return { price, done: false };
  const share = (atMs - prevMs) / (glide.endAt - prevMs);
  return { price: price * Math.exp(Math.log(glide.target / price) * share), done: false };
}

/** Gültiger Gleitflug aus der Datenbank oder null */
function glideFrom(doc) {
  if (!doc || !(doc.target > 0) || !Number.isFinite(doc.endAt)) return null;
  return { key: String(doc.key || ''), target: doc.target, endAt: doc.endAt };
}

module.exports = { glideStep, glideFrom };

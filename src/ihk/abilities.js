// Kartenfähigkeiten im IHK-Modus. Alle wirken zur Halbzeit der Quest und nur unter den Bedingungen
// aus dem Kartentext. main = Hauptkarte (arbeitet), boost = Karte im Boost-Slot (nur ihre Fähigkeit zählt).
// fx = CSS-Effekt beim Aktivieren, target = welcher Slot den Effekt bekommt.

const who = (card) => (card ? card.id.replace(/(-\d+)?-(crumpled|bfwler|gold|holo|bockhaber|glitch)$/, '') : null);
const isDog = (card) => who(card) === 'good-boy';

/**
 * Liefert die aktiven Fähigkeiten für diese Kombination.
 * Jede Fähigkeit: { key, label, text, fx, target, apply(state) }.
 * state: { speed, stats: { fia, fis, bwl }, extraTicks, fakeNext, tempSpeed: { factor, ticks } }
 */
function resolve(main, boost) {
  const m = who(main);
  const b = who(boost);
  const both = [m, b];
  const out = [];
  const add = (a) => out.push(a);

  // Krisz: nur mit einem Energydrink (BFW Energy) an seiner Seite
  if (m === 'krisz' && b === 'bfw-energy') {
    add({ key: 'nachtschicht', label: 'Nachtschicht', text: 'Energydrinks! Krisz arbeitet schneller (Speed ×1,5).', fx: 'fx-energy', target: 'player', apply: (s) => { s.speed *= 1.5; } });
  }
  if (m === 'krisz' && b === 'lili') {
    add({ key: 'lili', label: 'Lili an seiner Seite', text: 'Alle Eigenschaften von Krisz werden verdoppelt.', fx: 'fx-love', target: 'player', apply: (s) => { s.speed *= 2; s.stats.fia *= 2; s.stats.fis *= 2; s.stats.bwl *= 2; } });
  }
  if (m === 'luca') {
    add({ key: 'simulation', label: 'Simulationsspiel-Erfahrung', text: 'BWL +50 %.', fx: 'fx-buff', target: 'player', apply: (s) => { s.stats.bwl *= 1.5; } });
  }
  // Ömer verleiht die Macht den *anderen* (befreundeten) ITler-Karten – wirkt also nur aus dem Boost-Slot
  if (b === 'omer') {
    add({ key: 'osmanen', label: 'Macht der Osmanen', text: 'FIS +15 %.', fx: 'fx-aura', target: 'player', apply: (s) => { s.stats.fis *= 1.15; } });
  }
  if (m === 'aleks') {
    add({ key: 'faelschung', label: 'Russische Telefonnummer', text: 'Die nächsten Punkte werden auf das Maximum (99) gefälscht.', fx: 'fx-glitch', target: 'player', apply: (s) => { s.fakeNext = true; } });
  }
  if (both.includes('pascal')) {
    add({ key: 'bloodlust', label: 'Bloodlust', text: 'Die Aufgabe ist eine Runde lang gelähmt – die Deadline steht kurz still.', fx: 'fx-bloodlust', target: 'player', enemyFx: 'fx-frozen', apply: (s) => { s.extraTicks += 1; } });
  }
  // Matze stärkt sich selbst, wenn eine Hundekarte (Good Boy) mitgespielt wird – er ist kein Boost
  if (m === 'matze' && isDog(boost)) {
    add({ key: 'hundekarte', label: 'Hundekarte!', text: '+10 FIS und +5 auf alle anderen Stats.', fx: 'fx-buff', target: 'player', apply: (s) => { s.stats.fis += 10; s.stats.fia += 5; s.stats.bwl += 5; } });
  }
  if (isDog(boost) && !isDog(main)) {
    add({ key: 'good-boy', label: 'Good Boy', text: 'Alle Stats der ITler-Karte +3.', fx: 'fx-buff', target: 'player', apply: (s) => { s.stats.fia += 3; s.stats.fis += 3; s.stats.bwl += 3; } });
  }
  if (m === 'seven' && b === 'grafikkarte-nvidia') {
    add({ key: 'nvidia', label: 'NVIDIA-Grafikkarte', text: '7 ist glücklich: doppelte Geschwindigkeit für 3 Runden.', fx: 'fx-speed', target: 'player', apply: (s) => { s.tempSpeed = { factor: 2, ticks: 3 }; } });
  }
  if (m === 'seven' && b === 'grafikkarte-amd') {
    add({ key: 'amd', label: 'AMD-Grafikkarte', text: '7 ist traurig: halbe Geschwindigkeit für 3 Runden.', fx: 'fx-sad', target: 'player', apply: (s) => { s.tempSpeed = { factor: 0.5, ticks: 3 }; } });
  }
  if (b === 'bfw-energy') {
    add({ key: 'bfw-energy', label: 'BFW Energy', text: '10 % mehr Claude Pro: alle Stats +10 %.', fx: 'fx-energy', target: 'player', apply: (s) => { s.stats.fia *= 1.1; s.stats.fis *= 1.1; s.stats.bwl *= 1.1; } });
  }
  if (b === 'casino-kaffee' && boost.stats) {
    const plus = boost.stats.speed;
    add({ key: 'kaffee', label: 'Casino-Kaffee', text: `Speed +${plus}.`, fx: 'fx-coffee', target: 'player', apply: (s) => { s.speed += plus; } });
  }
  return out;
}

// Charaktere, deren Fähigkeit auch aus dem Boost-Slot wirkt (alle anderen wären dort nutzlos)
const BOOST_CHARACTERS = new Set(['pascal', 'omer', 'good-boy', 'lili']);

/** Darf diese Karte in den Boost-Slot? Items immer, Charaktere nur mit Boost-Fähigkeit. */
const canBoost = (card) => !!card && (!card.isCharacter || BOOST_CHARACTERS.has(who(card)));

module.exports = { resolve, who, canBoost };

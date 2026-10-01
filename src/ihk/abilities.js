// Kartenfähigkeiten im IHK-Modus. Alle wirken zur Halbzeit der Quest und nur unter den Bedingungen
// aus dem Kartentext. main = Hauptkarte (arbeitet), boost = Karte im Boost-Slot (nur ihre Fähigkeit zählt).
// fx = CSS-Effekt beim Aktivieren, target = welcher Slot den Effekt bekommt.

const who = (card) => (card ? card.id.replace(/(-\d+)?-(crumpled|bfwler|gold|holo|bockhaber|glitch|icon|sith)$/, '') : null);

// Spell-Karten: Stärke je Seltenheit, wie auf den Karten gedruckt (Prozent).
// Mauch: [Verlangsamung für 2 Runden, danach Bonus auf alle Werte]; Sigrist: verlorener Fortschritt des Gegners.
const MAUCH = { holo: [30, 10], bockhaber: [25, 15], glitch: [20, 20], icon: [15, 25] };
const SIGRIST = { holo: 5, bockhaber: 10, glitch: 15, icon: 20 };
// Hermann: so viel stärker wird der Gegner für zwei Runden, bevor er zerstört wird
const HERMANN = { holo: 45, bockhaber: 40, glitch: 35, icon: 30 };
const isCoffee = (card) => who(card) === 'casino-kaffee';
const isDog = (card) => who(card) === 'good-boy';

/**
 * Liefert die aktiven Fähigkeiten für diese Kombination.
 * Jede Fähigkeit: { key, label, text, fx, target, apply(state) }.
 * state: { speed, stats: { fia, fis, bwl }, extraTicks, extraTime, elapsed, fakeNext, tempSpeed: { factor, ticks, then }, doom: { factor, ticks } }
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
  // Spell: Mauch schickt die eigene Gruppe zum Gruschteln – erst langsamer, danach alle Werte höher
  if (b === 'mauch' && MAUCH[boost.rarity]) {
    const [slow, plus] = MAUCH[boost.rarity];
    const f = 1 + plus / 100;
    add({ key: 'gruschteln', label: 'Gruschteln', text: `Kein Witz, purer Ernst: 2 Runden lang ${slow} % langsamer, danach alle Werte +${plus} %.`, fx: 'fx-buff', target: 'player', apply: (s) => {
      s.tempSpeed = { factor: 1 - slow / 100, ticks: 2, then: (st) => { st.speed *= f; st.stats.fia *= f; st.stats.fis *= f; st.stats.bwl *= f; } };
    } });
  }
  // Spell: Sigrist – der Gegner ist in der IHK die Aufgabe, ihr "Projektfortschritt" die abgelaufene Deadline
  if (b === 'sigrist' && SIGRIST[boost.rarity]) {
    const pct = SIGRIST[boost.rarity];
    add({ key: 'reality-check', label: 'Absolute Reality Check', text: `Die Aufgabe verliert ${pct} % ihres Fortschritts – die Deadline wird entsprechend zurückgeworfen.`, fx: 'fx-aura', target: 'player', enemyFx: 'fx-frozen', apply: (s) => { s.extraTime += (pct / 100) * s.elapsed; } });
  }
  // Spell: Hermann – der gegnerische "Charakter" ist in der IHK die Aufgabe: zwei Runden lang ist sie stärker
  // (es gibt entsprechend weniger Punkte), danach wird sie vollständig zerstört = Quest geschafft.
  // Die Bedingung "Kaffee-Karte auf der Hand" prüft ihkService.start (Besitz einer Casino-Kaffee-Karte).
  if (b === 'hermann' && HERMANN[boost.rarity]) {
    const pct = HERMANN[boost.rarity];
    add({ key: 'hermann', label: 'Hermann', text: `Die Aufgabe ist zwei Runden lang ${pct} % stärker – danach wird sie vollständig zerstört.`, fx: 'fx-aura', target: 'player', enemyFx: 'fx-bloodlust', apply: (s) => { s.doom = { factor: 1 + pct / 100, ticks: 2 }; } });
  }
  return out;
}

// Charaktere, deren Fähigkeit auch aus dem Boost-Slot wirkt (alle anderen wären dort nutzlos)
const BOOST_CHARACTERS = new Set(['pascal', 'omer', 'good-boy', 'lili']);

// Oliver the Sigrist "kann nicht im Spiel eingesetzt werden"
const NO_BOOST = new Set(['oliver-the-sigrist']);

/** Darf diese Karte in den Boost-Slot? Items und Spells mit Wirkung immer, Charaktere nur mit Boost-Fähigkeit. */
const canBoost = (card) => !!card && !NO_BOOST.has(who(card)) && (!card.isCharacter || BOOST_CHARACTERS.has(who(card)));

/** Braucht diese Boost-Karte eine Kaffee-Karte im Besitz? (Hermann) */
const needsCoffee = (card) => who(card) === 'hermann';

module.exports = { resolve, who, canBoost, needsCoffee, isCoffee };

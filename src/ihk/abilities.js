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
// Mark, the Suntouched (Platzhalter-Werte): time = Anteil der vollen Zeit, refill = Bock in %, plus = auf alle Werte
const MARK = { time: 0.5, refill: 30, plus: 5 };
// Hundekarten (Spells): Hugo und Lilly. Treue Seele: die geboostete Karte bekommt DOG_PLUS auf alle Werte – ist sie
// Matze, bekommt stattdessen der Hund selbst DOG_MATZE auf alle Werte (seine Fenster stehen sonst auf 0) und greift mit
// jedem Schlag von Matze mit an. Höchstens MAX_DOGS Hunde spielen mit (im Dungeon und Turm je Team), jeder nur einmal.
const DOGS = new Set(['hugo', 'lilly']);
const isDog = (card) => DOGS.has(who(card));
const isMatze = (card) => who(card) === 'matze';
const DOG_PLUS = 5;
const DOG_MATZE = 25;
const MAX_DOGS = 2;
// Ömer (Mach das Unmögliche möglich): so viele Ömer zu Beginn und ab der Halbzeit; je Ömer läuft die Deadline rush
// schneller. grow = Multiplikator des Bonus je Angriff (je weiterem Ömer grow · (Grundwert + 1) / 2) – aus dem Grundwert je
// Ömer, nicht aus dem aktuellen Wert, damit er gleichmäßig wächst statt exponentiell
// Balance (Quests, 2026-10-21): 0,25 – Ömer Crumpled schafft Gold zu 70 %, Ömer Glitch Glitch zu 36 % (Luca Glitch: 1 %)
const OMER = { copies: [2, 3], rush: 0.15, grow: 0.25 };
// Luca (You can't handle my Potions): Boost-Effekte im Team so viel stärker, danach eigenes Tempo und BWL +LUCA_PLUS
const LUCA_AMP = 0.1;
const LUCA_PLUS = 50;
// Aleks (Gruß aus dem Osten): bis maxMoney Spielgeld (Cent) mit auf die Mission; ab der Halbzeit kostet jeder Angriff
// cost, mit chance landet die Münze auf Kopf – dann alle Werte +plus für den Rest (Quest, Dungeon oder Mage Tower)
const ALEKS = { maxMoney: 100000, cost: 5000, chance: 0.499, plus: 10 };
const isAleks = (card) => who(card) === 'aleks';
// Effekte, die aus einem Boost-Slot kommen (nur sie verstärkt Luca); Bloodlust nur, wenn Pascal der Boost ist
const BOOST_KEYS = new Set(['lili', 'treue-seele', 'treue-seele-matze', 'nvidia', 'amd', 'bfw-energy', 'kaffee', 'gruschteln', 'reality-check', 'hermann']);

/**
 * Liefert die aktiven Fähigkeiten für diese Kombination.
 * Jede Fähigkeit: { key, label, text, fx, target, apply(state) }.
 * state: { speed, stats: { fia, fis, bwl }, extraTicks, extraTime, elapsed, tempSpeed: { factor, ticks, then }, doom: { factor, ticks }, dogs, coinFlip }
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
  // You can't handle my Potions: Boost-Effekte (BOOST_KEYS) seines Teams wirken LUCA_AMP stärker – nur ihre Vorteile,
  // siehe ihkService.applyEffects (im Dungeon und Turm für die ganze Gruppe, TEAM_MAIN_KEYS). Danach Tempo und BWL +50.
  if (m === 'luca') {
    add({ key: 'potions', label: "You can't handle my Potions", text: `Boost-Effekte im Team ${LUCA_AMP * 100} % stärker, danach Tempo und BWL +${LUCA_PLUS}.`, fx: 'fx-buff', target: 'player', amp: LUCA_AMP, apply: (s) => { s.speed += LUCA_PLUS; s.stats.bwl += LUCA_PLUS; } });
  }
  // Mach das Unmögliche möglich: zu Beginn 2 Ömer (je halbe Werte), zur Halbzeit 3 (die Stärke verteilt sich auf alle).
  // Alle greifen gemeinsam an und wachsen dabei (simulate: s.omer). Je Ömer läuft die Deadline OMER.rush schneller – im
  // Dungeon und Turm für die ganze Gruppe (teamStart/teamApply, TEAM_MAIN_KEYS in dungeonService).
  if (m === 'omer') {
    const [first, second] = OMER.copies;
    add({
      key: 'omer',
      label: 'Mach das Unmögliche möglich',
      text: `Ein ${second}. Ömer kommt dazu – alle greifen gemeinsam an, die Deadline läuft ${Math.round(second * OMER.rush * 100)} % schneller.`,
      fx: 'fx-aura',
      target: 'player',
      start: (s) => {
        // base: Grundwert je Ömer (die Werte der Karte geteilt durch die Zahl der Ömer) – daraus wächst der Bonus
        s.omer = { n: first, card: { ...s.stats }, base: {} };
        for (const k of ['fia', 'fis', 'bwl']) {
          s.stats[k] /= first;
          s.omer.base[k] = s.omer.card[k] / first;
        }
        s.rush += first * OMER.rush;
      },
      apply: (s) => {
        if (s.omer) {
          for (const k of ['fia', 'fis', 'bwl']) {
            s.stats[k] = (s.stats[k] * s.omer.n) / second;
            s.omer.base[k] = s.omer.card[k] / second;
          }
          s.omer.n = second;
        }
        s.rush += (second - first) * OMER.rush;
      },
      teamStart: (s) => { s.rush += first * OMER.rush; },
      teamApply: (s) => { s.rush += (second - first) * OMER.rush; },
    });
  }
  // Gruß aus dem Osten: ab der Halbzeit Münzwürfe mit dem mitgegebenen Geld (ihkService.simulate, opts.coin)
  if (m === 'aleks') {
    add({ key: 'gruss-aus-dem-osten', label: 'Gruß aus dem Osten', text: `Münzwürfe: jeder Angriff kostet ${ALEKS.cost / 100} €, bei Kopf (${String(ALEKS.chance * 100).replace('.', ',')} %) alle Werte +${ALEKS.plus} für den Rest.`, fx: 'fx-glitch', target: 'player', apply: (s) => { s.coinFlip = true; } });
  }
  if (both.includes('pascal')) {
    add({ key: 'bloodlust', label: 'Bloodlust', text: 'Die Aufgabe ist eine Runde lang gelähmt – die Deadline steht kurz still.', fx: 'fx-bloodlust', target: 'player', enemyFx: 'fx-frozen', apply: (s) => { s.extraTicks += 1; } });
  }
  // Treue Seele (Hundekarten): an Matze greift der Hund mit eigenen Werten mit an (simulate: s.dogs), sonst +5 für die
  // geboostete Karte. Matzes eigene Fähigkeit „Yo Dawg“ ist der zusätzliche Hunde-Slot (checkDogs), kein Effekt hier.
  if (isDog(boost) && m === 'matze') {
    add({ key: 'treue-seele-matze', label: `${boost.name}: Treue Seele`, text: `${boost.name} bekommt +${DOG_MATZE} auf alle Werte und greift mit jedem Schlag von Matze mit an.`, fx: 'fx-buff', target: 'player', dog: boost.id, apply: (s) => { s.dogs.push({ id: boost.id, fia: DOG_MATZE, fis: DOG_MATZE, bwl: DOG_MATZE }); } });
  } else if (isDog(boost)) {
    add({ key: 'treue-seele', label: `${boost.name}: Treue Seele`, text: `Alle Werte +${DOG_PLUS}.`, fx: 'fx-buff', target: 'player', apply: (s) => { s.stats.fia += DOG_PLUS; s.stats.fis += DOG_PLUS; s.stats.bwl += DOG_PLUS; } });
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
  // St. Ivan, the Forsaken (Boss-Karte): Forkbomb – die Deadline läuft 30 % langsamer, jede Runde 2 % weniger.
  // Eigentlich für gegnerische Karten (kommender Spielmodus); in IHK und Dungeon trifft es die Aufgabe.
  if (m === 'st-ivan-boss') {
    add({ key: 'forkbomb', label: 'Forkbomb', text: 'Die Deadline läuft 30 % langsamer – jede Runde lässt der Effekt um 2 % nach.', fx: 'fx-glitch', target: 'player', enemyFx: 'fx-frozen', apply: (s) => { s.forkbomb = 30; } });
  }
  // Mark, the Suntouched: zur Halbzeit bricht die Sonne durch – Quest und Dungeon bekommen 50 % der vollen Zeit
  // dazu, im Mage Tower füllt er stattdessen den Bock der Gruppe um MARK.refill auf. Danach alle Werte +MARK.plus
  // (für die ganze Gruppe, siehe TEAM_MAIN_KEYS in dungeonService). s.mode: 'ihk' | 'dungeon' | 'tower'.
  if (m === 'mark') {
    add({ key: 'sonnendurchbruch', label: 'Sonnendurchbruch', text: `Die Sonne bricht durch: mehr Zeit (im Mage Tower +${MARK.refill} % Bock), alle Werte +${MARK.plus}.`, fx: 'fx-aura', target: 'player', refill: MARK.refill, apply: (s) => {
      if (s.mode !== 'tower') s.extraTime += MARK.time * s.duration;
      s.stats.fia += MARK.plus;
      s.stats.fis += MARK.plus;
      s.stats.bwl += MARK.plus;
    } });
  }
  // Mirjam, the Gracebringer: zur Halbzeit verdoppelt sich der niedrigste Wert (FIA, FIS oder BWL; bei Gleichstand
  // der erste) – bei ihr und, im Dungeon und Turm, bei jedem Gruppenmitglied (TEAM_MAIN_KEYS in dungeonService)
  if (m === 'mirjam') {
    add({ key: 'alles-pink', label: 'Alles Pink!', text: 'Der niedrigste Wert wird verdoppelt.', fx: 'fx-love', target: 'player', apply: (s) => {
      const low = ['fia', 'fis', 'bwl'].reduce((a, k) => (s.stats[k] < s.stats[a] ? k : a), 'fia');
      s.stats[low] *= 2;
    } });
  }
  // boost = Effekt einer Boost-Karte (Luca verstärkt ihn)
  for (const a of out) if (BOOST_KEYS.has(a.key) || (a.key === 'bloodlust' && b === 'pascal')) a.boost = true;
  return out;
}

/**
 * Fähigkeiten für eine Hauptkarte mit mehreren Boost-Karten (Hybrid-Quests haben zwei Boost-Slots).
 * Jede Fähigkeit zählt nur einmal – z. B. die eigene der Hauptkarte. Zwei verschiedene Hunde zählen beide.
 */
function resolveAll(main, boosts) {
  const list = boosts.filter(Boolean);
  const out = [];
  for (const a of (list.length ? list : [null]).flatMap((b) => resolve(main, b))) {
    if (!out.some((x) => x.key === a.key && x.label === a.label)) out.push(a);
  }
  return out;
}

// Charaktere, deren Fähigkeit auch aus dem Boost-Slot wirkt (alle anderen wären dort nutzlos)
const BOOST_CHARACTERS = new Set(['pascal', 'lili']);

// Oliver the Sigrist "kann nicht im Spiel eingesetzt werden".
// Hermann ist für einen kommenden Spielmodus gedacht und in den Quests gesperrt (er würde jede Quest
// sicher gewinnen); seine Fähigkeit oben bleibt für später erhalten.
const NO_BOOST = new Set(['oliver-the-sigrist', 'hermann']);

/** Darf diese Karte in den Boost-Slot? Items und Spells mit Wirkung immer, Charaktere nur mit Boost-Fähigkeit. */
const canBoost = (card) => !!card && !NO_BOOST.has(who(card)) && (!card.isCharacter || BOOST_CHARACTERS.has(who(card)));

/** Braucht diese Boost-Karte eine Kaffee-Karte im Besitz? (Hermann) */
const needsCoffee = (card) => who(card) === 'hermann';

/**
 * Yo Dawg (Matze): Steht schon genau ein Hund in seinen Boost-Slots, gibt es einen zusätzlichen Hunde-Slot für den
 * anderen Hund. boosts = Karten in den normalen Boost-Slots (Katalog-Karten oder null).
 */
const hasDogSlot = (main, boosts) => isMatze(main) && boosts.filter(isDog).length === 1;

/**
 * Hunde prüfen. boosts = normale Boost-Slots, dog = Karte im Hunde-Slot (oder null), others = Hunde, die schon im Team
 * mitspielen (Dungeon, Turm). Gibt eine Fehlermeldung zurück oder null.
 */
function checkDogs(main, boosts, dog, others = []) {
  const list = boosts.filter(Boolean);
  if (dog) {
    if (!isDog(dog)) return 'In den Hunde-Slot passt nur eine Hundekarte (Hugo oder Lilly).';
    if (!hasDogSlot(main, list)) return 'Den Hunde-Slot gibt es nur für Matze, wenn schon ein Hund in seinem Boost-Slot steht.';
  }
  const dogs = [...list, dog].filter(isDog);
  const seen = new Set(others.filter(isDog).map(who));
  for (const d of dogs) {
    if (seen.has(who(d))) return `${d.name} spielt schon mit – jede Hundekarte darf nur einmal ausgespielt werden.`;
    seen.add(who(d));
  }
  if (seen.size > MAX_DOGS) return `Insgesamt dürfen nur ${MAX_DOGS} Hundekarten ausgespielt werden.`;
  return null;
}

module.exports = { resolve, resolveAll, who, canBoost, needsCoffee, isCoffee, isDog, isMatze, hasDogSlot, checkDogs, MARK, DOG_PLUS, DOG_MATZE, MAX_DOGS, LUCA_AMP, LUCA_PLUS, ALEKS, isAleks, OMER };

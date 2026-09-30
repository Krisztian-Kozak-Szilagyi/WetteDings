// IHK-Quests (Mini-Game). Welche Fähigkeit gebraucht wird (stat), sehen die Spieler nicht –
// sie müssen es aus der Beschreibung erraten. Die Schwierigkeit wird pro Angebot zufällig gewählt.

/**
 * Schwierigkeit 1–6 nach den Kartenseltenheiten. required = nötige Punkte.
 * required ≈ 85 % der Punkte, die eine typische Karte dieser Seltenheit mit ihrer besten Fähigkeit
 * sammelt (simuliert: 304 / 405 / 528 / 613 / 748 / 1956) – mit der passenden Fähigkeit klappt es
 * also meistens, mit der falschen kaum.
 */
// Standardwerte (≈ +20 % für etwas mehr Herausforderung); im Admin-Panel änderbar (ihkService.settings.required)
const DIFFICULTIES = [
  { level: 1, label: 'Crumpled', required: 310 },
  { level: 2, label: 'BFWler', required: 415 },
  { level: 3, label: 'Gold', required: 540 },
  { level: 4, label: 'Holo', required: 625 },
  { level: 5, label: 'Bockhaber', required: 760 },
  { level: 6, label: 'Glitch', required: 1990 },
];

const QUESTS = [
  {
    id: 'compiler-fehler',
    title: 'Compiler-Fehler',
    stat: 'fia',
    image: '/img/ihk/quest-compiler-error_1.png',
    text: 'Dein Code will aus irgendeinem Grund nicht laufen und wirft ständig Fehlermeldungen aus. In einer der Zeilen sind seltsame, rote, wellenförmige Linien zu sehen. Könnte der Fehler vielleicht daher kommen?',
    success: 'Es hat sich herausgestellt, dass am Ende der Zeile nur ein Semikolon gefehlt hat. Gute Arbeit!',
    fail: 'Nach viel Leid hast du schließlich Claude gefragt. Es hat sich herausgestellt, dass nur ein Semikolon gefehlt hat. So einfach ist Programmieren dann doch nicht, oder?!',
  },
  {
    id: 'neuer-rauter',
    title: 'Neuer Rauter',
    stat: 'fis',
    image: '/img/ihk/quest-neuer-rauter_1.png',
    text: 'Du hast einen neuen Router und ein Kabel dafür bekommen. Die Aufgabe scheint einfach zu sein: Steck das Kabel an die richtige Stelle.',
    success: 'Gut gemacht, du hast es noch vor der Mittagspause geschafft!',
    fail: 'Du hast das Kabel erfolgreich eingesteckt, leider bist du stärker als schlauer: Du hast es an die falsche Stelle gesteckt und dabei den Anschluss kaputtgemacht!',
  },
  {
    id: 'datenschutz',
    title: 'Datenschutz',
    stat: 'bwl',
    image: '/img/ihk/quest-datenschutz_1.png',
    text: 'Jemand hat dich gefragt, ob er für seine Portfolio-Website eine Datenschutzerklärung braucht. Wirst du es schaffen, innerhalb einer für Menschen angemessenen Zeit eine Antwort auf diese Frage zu finden?',
    success: 'Du hast diese sehr schwierige rechtliche Frage erfolgreich gelöst. Ja, er braucht eine Datenschutzerklärung!',
    fail: 'Du hast die Frage beantwortet, aber kurze Zeit später wird die Person von der Polizei aus dem Gebäude geführt. Was könnte wohl passiert sein?',
  },
];

const questById = Object.fromEntries(QUESTS.map((q) => [q.id, q]));
const difficulty = (level) => DIFFICULTIES[level - 1];

module.exports = { DIFFICULTIES, QUESTS, questById, difficulty };

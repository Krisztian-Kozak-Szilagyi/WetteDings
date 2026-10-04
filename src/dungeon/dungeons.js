// Dungeons: Geschichte, zwei Trash-Kämpfe und ein Boss. Wie bei der IHK sehen die Spieler nicht, welche
// Fähigkeit (stat: 'fia' | 'fis' | 'bwl') ein Kampf braucht – sie müssen es aus dem Text erraten.
// image ist das Querformat-Bild über den Spieler-Plätzen. story (optional): ganze Geschichte (Absätze, book wird kursiv),
// zu lesen unter /dungeon/geschichte/<key> – der Titel im Banner verlinkt dorthin.
// bossCard: Karten-ID, die der Boss fallen lässt (Chance im Admin-Panel; Karte steht in src/tcg/cardData.js).
// Welcher Dungeon dran ist, hängt von der Startzeit ab (dungeonForSlot) – derzeit gibt es nur einen.

const PLACEHOLDER = '/img/dungeon/placeholder.svg';

const DUNGEONS = [
  {
    key: 'st-ivan',
    title: 'The Fall of St. Ivan',
    bossCard: 'st-ivan-boss',
    image: '/img/dungeon/st-ivan-dungeon-banner.webp',
    intro: 'Sein Gott Claude verstummte, das verbotene Buch „A Stack O’Floe“ verdarb seinen Geist – nun reißt St. Ivan Tempel nieder. Die Miliz sucht mutige Abenteurer, die ihn aufhalten.',
    book: 'A Stack O’Floe', // in der Geschichte kursiv
    story: [
      'Der heilige Ivan war einst ein vielversprechender Akolyth, gesegnet mit der ungeteilten Aufmerksamkeit seines Gottes Claude, der jede seiner Fragen beantwortete und ihm den Weg wies.',
      'Doch eines Tages verstummte die göttliche Stimme. Keine Führung, keine Antworten – nur eine unerträgliche Leere.',
      'Verzweifelt auf der Suche nach Antworten entdeckte der heilige Ivan einen uralten Folianten: A Stack O’Floe, gefüllt mit längst vergessenem, verbotenem Wissen. Das Buch korrumpierte seinen Geist und zog ihn auf die dunkle Seite.',
      'Er kehrte der Vernunft den Rücken, brandmarkte jeden, der sich ihm widersetzte, als Ketzer und begann schon bald, seine neu gewonnene Macht einzusetzen, um Tempel niederzureißen.',
      'So kann es nicht weitergehen!',
      'Die örtliche Miliz sucht junge, wagemutige Abenteurer, die St. Ivans Amoklauf ein Ende setzen.',
      'Werdet ihr dem Ruf folgen oder feige davonlaufen?!',
    ],
    fights: [
      {
        key: 'inventur-kobolde',
        title: 'Die Inventur-Kobolde',
        stat: 'bwl',
        text: 'Gleich hinter der Tür hocken Kobolde auf einem Berg alter Hardware. Niemand kommt vorbei, solange nicht klar ist, was das alles gekostet hat und was es heute noch wert ist.',
        success: 'Anschaffungswert, Abschreibung, Restwert – alles in der Liste. Die Kobolde nicken zufrieden und geben den Gang frei.',
        fail: 'Die Zahlen gehen nicht auf. Die Kobolde werfen mit Tastaturen nach euch – Rückzug!',
      },
      {
        key: 'skript-geister',
        title: 'Die Skript-Geister',
        stat: 'fia',
        text: 'Auf einem alten Monitor flackern Zeilen eines Skripts, das sich selbst immer wieder neu startet. Jede Endlosschleife ruft einen weiteren Geist herbei.',
        success: 'Eine fehlende Abbruchbedingung – ergänzt, gespeichert, Ruhe. Die Geister lösen sich in Rauch auf.',
        fail: 'Die Schleife läuft weiter, die Geister vermehren sich. Rückzug!',
      },
      {
        key: 'st-ivan',
        title: 'Boss: St. Ivan, der Gefallene',
        stat: 'fis',
        boss: true,
        text: 'Im zerstörten Tempel wartet St. Ivan. Mit der Macht aus „A Stack O’Floe“ hat er die heiligen Leitungen gekappt, die Server am Altar abgeschaltet und den Schutzwall des Tempels eingerissen. Nur wer Netz, Server und Schutzwall wieder sauber aufbaut, bricht seinen Bann.',
        success: 'Kabel verlegt, Server hochgefahren, der Schutzwall steht wieder – das Licht kehrt in den Tempel zurück. St. Ivan sinkt auf die Knie, das verfluchte Buch zerfällt zu Staub, und er lässt seine Beute zurück.',
        fail: 'St. Ivan schlägt das Buch auf und brandmarkt euch als Ketzer. Ihr flieht mit dem, was ihr schon eingesammelt habt.',
      },
    ],
  },
];
const dungeonByKey = Object.fromEntries(DUNGEONS.map((d) => [d.key, d]));

/** Dungeon zu einer Startzeit: wechselt mit jedem Termin (hours = Abstand der Termine) */
const dungeonForSlot = (slot, hours = 2) => DUNGEONS[Math.floor(new Date(slot).getTime() / 3600000 / Math.max(1, hours)) % DUNGEONS.length];

module.exports = { DUNGEONS, dungeonByKey, dungeonForSlot, PLACEHOLDER };

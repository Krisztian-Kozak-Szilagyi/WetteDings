// Dungeons: Geschichte, zwei Trash-Kämpfe und ein Boss. Wie bei der IHK sehen die Spieler nicht, welche
// Fähigkeit (stat: 'fia' | 'fis' | 'bwl') ein Kampf braucht – sie müssen es aus dem Text erraten.
// image ist das Querformat-Bild über den Spieler-Plätzen (vorerst dasselbe Banner für alle).
// Welcher Dungeon dran ist, hängt von der Startzeit ab (dungeonForSlot) – so kann man sich vorher darauf einstellen.

const PLACEHOLDER = '/img/dungeon/placeholder.svg';
const BANNER = '/img/dungeon/st-ivan-dungeon-banner.webp'; // vorerst für alle Dungeons

const DUNGEONS = [
  {
    key: 'serverraum',
    title: 'Der Serverraum im Keller',
    image: BANNER,
    intro: 'Seit Tagen dringt aus dem Keller ein seltsames Brummen. Niemand traut sich mehr hinunter – bis heute. Drei mutige Azubis nehmen die Taschenlampe und steigen die Treppe hinab.',
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
        key: 'kabel-hydra',
        title: 'Boss: Die Kabel-Hydra',
        stat: 'fis',
        boss: true,
        text: 'Im hintersten Rack windet sich die Kabel-Hydra: Hunderte Patchkabel, jedes in den falschen Port gesteckt. Für jedes gezogene Kabel wachsen zwei nach – nur ein sauber aufgebautes Netz bringt sie zur Ruhe.',
        success: 'Port für Port richtig gesteckt, beschriftet und mit Kabelbindern gezähmt. Die Hydra erschlafft und lässt ihre Beute zurück.',
        fail: 'Die Hydra verheddert euch im Kabelsalat und kappt das Licht. Ihr flieht mit dem, was ihr schon eingesammelt habt.',
      },
    ],
  },
  {
    key: 'pruefungsamt',
    title: 'Das verlorene Prüfungsamt',
    image: BANNER,
    intro: 'Ganz oben im Altbau soll es ein Büro geben, in dem alle verschwundenen Prüfungsunterlagen liegen. Der Aufzug fährt nur noch in den dritten Stock – den Rest müsst ihr euch erkämpfen.',
    fights: [
      {
        key: 'formular-golem',
        title: 'Der Formular-Golem',
        stat: 'bwl',
        text: 'Ein Riese aus Anträgen, Durchschlägen und Umlaufmappen versperrt den Flur. Er lässt nur durch, wer seine Reisekostenabrechnung korrekt ausfüllt.',
        success: 'Belege sortiert, Pauschalen eingetragen, abgezeichnet. Der Golem zerfällt zu einem ordentlichen Stapel.',
        fail: 'Ein falsches Kreuzchen – und der Golem begräbt euch unter Papier.',
      },
      {
        key: 'sortier-automat',
        title: 'Der Sortier-Automat',
        stat: 'fia',
        text: 'Im Aktenraum rattert ein uralter Sortier-Automat und wirft jede Akte an die falsche Stelle. Sein Programm liegt offen auf dem Bildschirm – irgendwo darin steckt der Fehler im Algorithmus.',
        success: 'Vergleich korrigiert, Schleife umgebaut – der Automat sortiert endlich alphabetisch und gibt die Tür frei.',
        fail: 'Der Automat sortiert euch gleich mit ein. Unter einem Aktenberg ist Schluss.',
      },
      {
        key: 'hoellendrucker',
        title: 'Boss: Der Höllendrucker',
        stat: 'fis',
        boss: true,
        text: 'Im letzten Büro thront der Höllendrucker: Papierstau, Toner leer, Netzwerkfehler – und er hält die verschwundenen Prüfungsunterlagen fest. Nur wer ihn sauber ins Netz bringt und neu einrichtet, bekommt sie zurück.',
        success: 'Neu verbunden, Treiber installiert, Papier nachgelegt – der Drucker spuckt die Unterlagen warm aus und lässt seine Beute zurück.',
        fail: 'Der Höllendrucker frisst euren letzten Versuch. Ihr flieht mit dem, was ihr schon eingesammelt habt.',
      },
    ],
  },
];
const dungeonByKey = Object.fromEntries(DUNGEONS.map((d) => [d.key, d]));

/** Dungeon zu einer Startzeit: wechselt mit jedem Termin (hours = Abstand der Termine) */
const dungeonForSlot = (slot, hours = 2) => DUNGEONS[Math.floor(new Date(slot).getTime() / 3600000 / Math.max(1, hours)) % DUNGEONS.length];

module.exports = { DUNGEONS, dungeonByKey, dungeonForSlot, PLACEHOLDER };

// Dungeons: Geschichte, zwei Trash-Kämpfe und ein Boss. Wie bei der IHK sehen die Spieler nicht, welche
// Fähigkeit (stat: 'fia' | 'fis' | 'bwl') ein Kampf braucht – sie müssen es aus dem Text erraten.
// image ist das Querformat-Bild über den Spieler-Plätzen. story (optional): ganze Geschichte (Absätze, book wird kursiv),
// zu lesen unter /dungeon/geschichte/<key> – der Titel im Banner verlinkt dorthin.
// bossCard: Karten-ID, die der Boss fallen lässt (Chance im Admin-Panel; Karte steht in src/tcg/cardData.js).
// Welcher Dungeon dran ist, hängt von der Startzeit ab (dungeonForSlot) – derzeit gibt es nur einen.

const { TOWER } = require('./tower');

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
        key: 'tempel-buchhalter',
        title: 'Die Buchhalter des Tempels',
        stat: 'bwl',
        text: 'Vor dem eingerissenen Tempeltor zählen entstellte Mönche die Spenden eines Gottes, der nicht mehr antwortet. Durchs Tor kommt nur, wer ihre Bücher schließt: Einnahmen, Ausgaben und was St. Ivans Amoklauf an Schaden wirklich wert war.',
        success: 'Soll und Haben stimmen, jede zerschlagene Säule steht mit Anschaffungswert und Restwert in der Liste. Die Buchhalter schlagen ihre Bücher zu und geben das Tor frei.',
        fail: 'Eine Position bleibt ungedeckt. Die Mönche buchen euch als Verlust ab und treiben euch mit ihren Abakus-Stäben vom Tor – Rückzug!',
      },
      {
        key: 'falsches-orakel',
        title: 'Das falsche Orakel',
        stat: 'fia',
        text: 'Mitten im Kreuzgang steht ein Orakel aus Messing und Pergament, das St. Ivan aus einer Seite des Folianten gebaut hat, als sein Gott nicht mehr antwortete. Es beantwortet jede Frage – nur gehört die Antwort stets zur Frage davor. Wer es befragt, ohne das zu merken, läuft im Kreis durch den Tempel.',
        success: 'Das Orakel zählt seine Fragen ab eins, greift die Antworten aber ab null – ein Schritt zu früh, jedes Mal. Einmal korrigiert, nennt es endlich den Weg zum Altar und zerfällt zu Pergamentstaub.',
        fail: 'Ihr folgt seinen Antworten und landet wieder am Tempeltor. Hinter euch fällt das Gitter – Rückzug!',
      },
      {
        key: 'st-ivan',
        title: 'St. Ivan, the Forsaken',
        stat: 'fis',
        boss: true,
        text: 'Im Herzen des Tempels steht St. Ivan über dem Altar, „A Stack O’Floe“ aufgeschlagen in der Hand. Die heiligen Leitungen hängen gekappt von den Säulen, die Server unter dem Altar sind kalt, und was noch läuft, zerlegt seine Forkbomb: ein Prozess wird zwei, zwei werden vier. Nur wer Netz, Dienste und Schutzwall wieder in Betrieb bringt, bricht seinen Bann.',
        success: 'Prozesse begrenzt, Leitungen neu verlegt, die Server fahren hoch, der Schutzwall steht – und die Stimme kehrt in den Tempel zurück. Nur zu ihm spricht sie nicht. St. Ivan sinkt auf die Knie, das verfluchte Buch zerfällt zu Staub, und er lässt seine Beute zurück.',
        fail: 'Die Forkbomb frisst den letzten Dienst, der Tempel fällt in Dunkelheit. St. Ivan brandmarkt euch als Ketzer, und ihr flieht mit dem, was ihr schon eingesammelt habt.',
      },
    ],
  },
];
const dungeonByKey = Object.fromEntries(DUNGEONS.map((d) => [d.key, d]));

/** Dungeon oder Mage Tower zu einem gespeicherten Schlüssel (DungeonRun.dungeon) – der Turm ist nicht in der Rotation */
const defOf = (key) => dungeonByKey[key] || (key === TOWER.key ? TOWER : null);

/** Dungeon zu einer Startzeit: wechselt mit jedem Termin (hours = Abstand der Termine) */
const dungeonForSlot = (slot, hours = 2) => DUNGEONS[Math.floor(new Date(slot).getTime() / 3600000 / Math.max(1, hours)) % DUNGEONS.length];

module.exports = { DUNGEONS, dungeonByKey, dungeonForSlot, defOf, TOWER, PLACEHOLDER };

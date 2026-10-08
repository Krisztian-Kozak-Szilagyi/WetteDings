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

// Geheimes Event: Beim Start von St. Ivan erscheint mit etwas Glück (Chance im Admin-Panel) ein neuer Teilnehmer –
// St. Ivan verschwindet und „Chaos & Demise“ beginnt. Der Dungeon steht nicht in der Rotation, hat keine Geschichten-Seite
// und ist der einzige Weg an seine Boss-Karte (nicht im Black Market, der nur DUNGEONS kennt).
// Flavour-Texte sind absichtlich nur zerfallener Binärcode: wahllos 0 und 1, dazwischen wahllos „?“.
// Lesbar bleiben nur die Meldung vom neuen Teilnehmer und die Namen der Kämpfe. Farbe: dunkles, kräftiges Lila (CSS .is-chaos).
// bossCard: die Season-1-Boss-Karte, die noch gezeichnet wird. Bis sie im Katalog steht, merkt sich der Lauf die
// Beute (members.bossCard) – dungeonService.grantPendingBossCards reicht die Karte nach, sobald es sie gibt.
const CHAOS = {
  key: 'chaos',
  title: 'Chaos & Demise',
  replaces: 'st-ivan',
  bossCard: 'chaos-boss',
  image: PLACEHOLDER,
  intro: '?11011 00110 ?000 11111 10110111 ?0111110 1??11110 00??0 00 1000110 ?01?0 0011 0?10? ??01 11111010 101 01??10 1?010 01 00? 000 0111',
  arrival: 'Ein neuer Teilnehmer ist erschienen …',
  fights: [
    {
      key: 'chaos-riss',
      title: 'Der Riss',
      stat: 'fia',
      text: '11?111 ??001 0000110 101 00 0000110 10? 000?11 1111 101?11 00011001 00011? ?110 ?0?1110',
      success: '1?01 1? 11?0101 1??1 001010? ?001?001 010? 10?111 ?01 011 11 00??',
      fail: '0111?0 1?0 001101 ?00 10 0?111?11 ??01 ?1?0 1010 ?110? 0110 01?0?1?0',
    },
    {
      key: 'chaos-schatten',
      title: 'Die Schatten',
      stat: 'bwl',
      text: '?100101 0101? 000 011011 11 011??11 1110010? 101? ??111 0101?1?1 00110 0000000 000101? ?0101',
      success: '1?0?? 00 010?0?11 111 1001? 10 001100 0000010? 1001?? 1?1?010 0011?1?1 00',
      fail: '1???0? ?11 1001000 110 111110 00 000 0111010? 0111?010 110?0 0010? 0??',
    },
    {
      key: 'der-fremde',
      title: 'Der Fremde',
      stat: 'fis',
      boss: true,
      text: '??10 001? ?100 110?1 000111? 0110110 11111 11111 1111 00 00011000 011011',
      success: '11 0?1 1??1?10 010 10 10??0 1? 101 101 10??11 11?10 0?1110',
      fail: '01 ?0 ?0 10110101 0011 10111 ?10 011011 011001 1100',
    },
  ],
};

/** Dungeon oder Mage Tower zu einem gespeicherten Schlüssel (DungeonRun.dungeon) – Turm und Chaos sind nicht in der Rotation */
const defOf = (key) => dungeonByKey[key] || (key === TOWER.key ? TOWER : key === CHAOS.key ? CHAOS : null);

/** Dungeon zu einer Startzeit: wechselt mit jedem Termin (hours = Abstand der Termine) */
const dungeonForSlot = (slot, hours = 2) => DUNGEONS[Math.floor(new Date(slot).getTime() / 3600000 / Math.max(1, hours)) % DUNGEONS.length];

module.exports = { DUNGEONS, dungeonByKey, dungeonForSlot, defOf, TOWER, CHAOS, PLACEHOLDER };

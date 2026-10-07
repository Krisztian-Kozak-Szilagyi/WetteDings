// Feste Bereiche und Startthemen des Forums (angelegt von forumService.ensureDefaults bei jedem Start,
// aber jeweils nur einmal). Die Texte nutzen die Forum-Auszeichnung (siehe forum/render.js).

/**
 * Bereiche mit festem key. Gefunden wird zuerst über den key, sonst über einen der Titel unter dem
 * übergeordneten Bereich (so werden die Bereiche aus seed() übernommen statt doppelt angelegt).
 * Ist der key einmal gesetzt, fasst ensureDefaults den Bereich nicht mehr an (Umbenennungen im Forum bleiben).
 *  titles: frühere Namen (aus seed), die übernommen und umbenannt werden
 *  create: false = nur übernehmen, nie neu anlegen
 */
const CATEGORIES = [
  { key: 'allgemein', title: 'Allgemein', description: 'Alles rund um BfW Holdings.', parent: null, order: 1 },
  { key: 'plauderecke', title: 'Plauderecke', description: 'Für alles, was sonst nirgends passt.', parent: 'allgemein', order: 0 },
  { key: 'wetten', title: 'Wetten & Duelle', titles: ['Wetten'], description: 'Ideen, Diskussionen und Streitfälle zu Wetten und Duellen.', parent: 'allgemein', order: 1 },
  { key: 'coins', title: 'Broker', titles: ['Coin Exchange'], description: 'Broker, Coins und ETFs: Kurse, Strategien, Prognosen.', parent: 'allgemein', order: 2 },
  { key: 'ihk', title: 'IHK-Quests', titles: ['IHK'], description: 'Quests, Karten-Kombinationen, Tipps.', parent: 'allgemein', order: 3 },
  { key: 'feedback', title: 'Feedback & Bugs', description: 'Wünsche, Fehler und Verbesserungen.', parent: 'allgemein', order: 4 },
  { key: 'halloffame', title: 'Hall of Fame', description: 'Die größten Gewinne und seltensten Pulls.', parent: 'allgemein', order: 5 },
  { key: 'boersenbericht', title: 'Börsenbericht', description: 'Der tägliche Bericht der Börse um 18:45 Uhr.', parent: 'allgemein', order: 6, staffOnly: true },
  // eSports: je Team ein Unterbereich (legt esportsService bei der Gründung an), dort erscheinen die Wochenberichte
  { key: 'esports', title: 'eSports', description: 'Die eSports-Teams und ihre Wochenberichte.', parent: null, order: 2, staffOnly: true },
  { key: 'ankuendigungen', title: 'Ankündigungen', description: 'Wichtiges und Geplantes.', parent: null, create: false },
];

const HALL_OF_FAME_KEY = 'halloffame';

/** Startthemen: angepinnt, vom ersten Admin, je Merkmal (starterKey) nur einmal */
const STARTERS = [
  {
    key: 'regeln',
    category: 'plauderecke',
    title: 'Forenregeln – bitte zuerst lesen',
    body: `# Willkommen im Forum von BfW Holdings!

Hier geht es um Spielgeld, Karten und Spaß unter Freunden. Damit das so bleibt, ein paar einfache Regeln:

- **Freundlich bleiben.** Kein Beleidigen, kein Bloßstellen, keine Hetze – auch nicht nach einer verlorenen Wette.
- **Beim Thema bleiben.** Wetten nach „Wetten & Duelle“, Karten nach „TCG & Handel“, Fehler nach „Feedback & Bugs“.
- **Kein Echtgeld.** Alles hier ist Spielgeld. Keine Geschäfte mit echtem Geld, auch nicht „unter der Hand“.
- **Keine fremden Daten.** Keine privaten Infos, Fotos oder Nachrichten anderer ohne deren Einverständnis.
- **Streit um eine Wette?** Erst mit dem Schiedsrichter klären. Hilft das nicht, sachlich hier im Forum schreiben.
- **Fehler gefunden?** Bitte melden statt ausnutzen – siehe die Bug-Vorlage in „Feedback & Bugs“.

## Moderation

Admin, Devs und Mods können Beiträge bearbeiten, löschen und Themen schließen. Siehst du etwas, das nicht passt, nutze **Melden** unter dem Beitrag und schreib kurz dazu, warum.

## Kleine Hilfen

- Mit __@Name__ erwähnst du jemanden – er bekommt eine Benachrichtigung.
- __[karte:id]__, __[wette:id]__ und __[profil:Name]__ zeigen eine Vorschau von Karte, Wette oder Profil.

Viel Spaß beim Schreiben!`,
  },
  {
    key: 'bug-vorlage',
    category: 'feedback',
    title: 'Vorlage: So meldest du einen Fehler',
    body: `Danke, dass du hilfst, die Seite besser zu machen! Je genauer die Meldung, desto schneller ist der Fehler behoben. Eröffne für jeden Fehler ein eigenes Thema und kopiere diese Vorlage hinein:

## Vorlage

- **Wo:** Welche Seite oder welcher Bereich? (z. B. Wette, TCG, IHK, Dungeon, Broker, Lotterie, Grading)
- **Was hast du gemacht:** Schritt für Schritt, was du geklickt oder eingegeben hast
- **Was ist passiert:** die Fehlermeldung oder was falsch aussah
- **Was hättest du erwartet:** wie es eigentlich sein sollte
- **Wann:** ungefähre Uhrzeit (hilft beim Suchen in den Protokollen)
- **Gerät:** Handy oder PC, welcher Browser

## Bitte beachten

- **Keine Passwörter** oder andere Zugangsdaten posten.
- Fehler, mit denen man sich Spielgeld, Karten oder Packs verschaffen kann, bitte **nicht ausnutzen**, sondern melden.
- Wünsche und Ideen sind hier genauso willkommen – schreib dann einfach „Idee“ in den Titel.`,
  },
  {
    key: 'roadmap',
    category: 'ankuendigungen',
    title: 'Roadmap: Woran wir arbeiten',
    body: `Hier sammeln wir, was als Nächstes kommen soll. Feste Termine gibt es keine – BfW Holdings ist ein Hobbyprojekt, und manches dauert länger, als man denkt.

## Forum

- Reaktionen auf Beiträge
- Umfragen in Themen
- Weitere Verbesserungen an Benachrichtigungen und Moderation

## Spiel und Wirtschaft

- Neue Karten und Seasons im TCG
- Feinschliff an IHK-Quests und Dungeon
- Ausgewogene Preise, Steuern und Belohnungen im Broker, in der Lotterie und beim Grading

## Und du?

Ideen und Wünsche bitte in „Feedback & Bugs“ posten. Was oft gewünscht wird, rutscht in der Liste nach oben. Was fertig ist, steht in den Patchnotes.`,
  },
  {
    key: 'vorstellung',
    category: 'plauderecke',
    title: 'Vorstellungsrunde – wer bist du?',
    body: `Neu hier oder schon lange dabei? Stell dich kurz vor! Ein paar Fragen als Anregung:

- Wie bist du zu BfW Holdings gekommen?
- Deine beste (oder schlimmste) Wette bisher?
- Deine Lieblingskarte im TCG?
- Eher Broker, Lotterie, IHK-Quests oder Dungeon?

Wer mag, verlinkt sein Profil mit __[profil:Name]__ oder zeigt seine liebste Karte mit __[karte:id]__.`,
  },
];

module.exports = { CATEGORIES, STARTERS, HALL_OF_FAME_KEY };

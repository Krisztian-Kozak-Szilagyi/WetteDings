// IHK-Quests (Mini-Game). Welche Fähigkeit gebraucht wird (stat), sehen die Spieler nicht –
// sie müssen es aus der Beschreibung erraten. Die Schwierigkeit wird pro Angebot zufällig gewählt.
// stat: 'fia' | 'fis' | 'bwl' oder zwei davon als Hybrid-Quest (z. B. ['fia', 'bwl'] → Durchschnitt beider Werte).
// image ist optional – ohne eigenes Bild wird eine neutrale Platzhalter-Karte gezeigt.

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
    image: '/img/ihk/quest-compiler-error_1.webp',
    text: 'Dein Code will aus irgendeinem Grund nicht laufen und wirft ständig Fehlermeldungen aus. In einer der Zeilen sind seltsame, rote, wellenförmige Linien zu sehen. Könnte der Fehler vielleicht daher kommen?',
    success: 'Es hat sich herausgestellt, dass am Ende der Zeile nur ein Semikolon gefehlt hat. Gute Arbeit!',
    fail: 'Nach viel Leid hast du schließlich Claude gefragt. Es hat sich herausgestellt, dass nur ein Semikolon gefehlt hat. So einfach ist Programmieren dann doch nicht, oder?!',
  },
  {
    id: 'neuer-rauter',
    title: 'Neuer Rauter',
    stat: 'fis',
    image: '/img/ihk/quest-neuer-rauter_1.webp',
    text: 'Du hast einen neuen Router und ein Kabel dafür bekommen. Die Aufgabe scheint einfach zu sein: Steck das Kabel an die richtige Stelle.',
    success: 'Gut gemacht, du hast es noch vor der Mittagspause geschafft!',
    fail: 'Du hast das Kabel erfolgreich eingesteckt, leider bist du stärker als schlauer: Du hast es an die falsche Stelle gesteckt und dabei den Anschluss kaputtgemacht!',
  },
  {
    id: 'datenschutz',
    title: 'Datenschutz',
    stat: 'bwl',
    image: '/img/ihk/quest-datenschutz_1.webp',
    text: 'Jemand hat dich gefragt, ob er für seine Portfolio-Website eine Datenschutzerklärung braucht. Wirst du es schaffen, innerhalb einer für Menschen angemessenen Zeit eine Antwort auf diese Frage zu finden?',
    success: 'Du hast diese sehr schwierige rechtliche Frage erfolgreich gelöst. Ja, er braucht eine Datenschutzerklärung!',
    fail: 'Du hast die Frage beantwortet, aber kurze Zeit später wird die Person von der Polizei aus dem Gebäude geführt. Was könnte wohl passiert sein?',
  },

  // ---------- FIA ----------
  {
    id: 'npm-package',
    title: 'NPM-Package',
    stat: 'fia',
    text: 'Für das neue Feature fehlt nur noch eine Kleinigkeit. Zum Glück gibt es dafür bestimmt schon ein Package. Installier es und binde es ins Projekt ein.',
    success: 'Package installiert, Feature läuft, und npm audit meldet sogar null Schwachstellen. Ein seltener Moment!',
    fail: 'Das Package hatte eine Sicherheitslücke. Dein Arbeitgeber möchte mit dir darüber sprechen, dass wegen dir 3500 PCs im Unternehmen mit Ransomware angegriffen wurden.',
  },
  {
    id: 'merge-konflikt',
    title: 'Merge-Konflikt',
    stat: 'fia',
    text: 'Zwei Kollegen haben gleichzeitig an derselben Datei gearbeitet. Git weigert sich zu mergen und überall stehen plötzlich <<<<<<< und >>>>>>>. Löse den Merge-Konflikt.',
    success: 'Konflikt sauber aufgelöst, beide Änderungen sind drin und die Tests laufen grün. Niemand hat etwas gemerkt.',
    fail: 'Du hast einen Force Push gemacht und eure Codebase sieht jetzt aus wie ein italienisches Pastagericht.',
  },
  {
    id: 'regex',
    title: 'Regulärer Ausdruck',
    stat: 'fia',
    text: 'Im Anmeldeformular sollen nur gültige E-Mail-Adressen akzeptiert werden. Schreib dafür einen regulären Ausdruck.',
    success: 'Dein Regex funktioniert. Du verstehst ihn zwar selbst nicht mehr, aber er funktioniert.',
    fail: 'Dein Regex akzeptiert jetzt ausschließlich die E-Mail-Adresse deiner Mutter. Und jede Zeichenkette, die mit einem kleinen "a" beginnt.',
  },
  {
    id: 'code-review',
    title: 'Code-Review',
    stat: 'fia',
    text: 'Ein Pull Request mit 4000 geänderten Zeilen wartet auf dein Review. Lies den Code und gib Feedback, bevor er in den Hauptbranch kommt.',
    success: 'Du hast drei Bugs und eine fehlende Fehlerbehandlung gefunden. Der Kollege ist dankbar, und ein bisschen beleidigt.',
    fail: 'Du hast "LGTM" geschrieben, ohne eine einzige Zeile zu lesen. In Zeile 2731 stand die Kündigung des Kollegen, und sie ist jetzt live auf der Startseite.',
  },

  // ---------- FIS ----------
  {
    id: 'nas-einrichten',
    title: 'NAS einrichten',
    stat: 'fis',
    text: 'Die Abteilung braucht endlich einen zentralen Speicher. Auf deinem Schreibtisch steht ein nagelneues NAS, noch originalverpackt. Richte es ein, inklusive Benutzer und Freigaben.',
    success: 'Das NAS läuft, das RAID ist sauber konfiguriert und die Freigaben passen. Ab heute speichert niemand mehr alles auf dem Desktop. Theoretisch.',
    fail: 'Du hast deine Anmeldedaten sofort nach der Installation vergessen und darfst jetzt wieder von vorne anfangen.',
  },
  {
    id: 'druckerwarteschlange',
    title: 'Druckerwarteschlange',
    stat: 'fis',
    text: 'Der Drucker im zweiten Stock druckt seit gestern nichts mehr. In der Warteschlange hängen 412 Aufträge. Bring ihn wieder zum Laufen.',
    success: 'Spooler neu gestartet, Warteschlange geleert, Drucker druckt. Die Kollegen halten dich jetzt für einen Hacker.',
    fail: 'Du hast alle 412 Aufträge gleichzeitig freigegeben. Der Drucker druckt bis Donnerstag in Dauerschleife die Steuererklärung vom Chef.',
  },
  {
    id: 'server-updates',
    title: 'Server-Updates',
    stat: 'fis',
    text: 'Für den Produktivserver stehen wichtige Sicherheitsupdates an. Plane ein Wartungsfenster, spiel die Updates ein und starte den Server neu.',
    success: 'Updates installiert, Server läuft wieder, und das Wartungsfenster hast du sogar eingehalten.',
    fail: 'Du hast die Updates freitags um 16:55 Uhr eingespielt. Der Server kommt nicht mehr hoch, und dein Wochenende auch nicht.',
  },

  // ---------- BWL ----------
  {
    id: 'gesetzesfreie-zone',
    title: 'Gesetzesfreie Zone',
    stat: 'bwl',
    text: 'In der Mittagspause gibt es nur eine Regel: Sprich 30 Minuten lang nicht über Gesetze. Kein HGB, kein BGB, keine Datenschutzgrundverordnung.',
    success: 'Unglaublich, du hast 30 Minuten über das Wetter geredet. Die Kollegen sind beeindruckt und leicht verunsichert.',
    fail: 'Ja, was soll ich sagen? Du bist halt ein typischer BWLer.',
  },
  {
    id: 'inventur',
    title: 'Inventur',
    stat: 'bwl',
    text: 'Das Geschäftsjahr endet und die Inventur steht an. Zähle alle Bestände im Lager und gleiche sie mit der Buchhaltung ab.',
    success: 'Jede Schraube gezählt, alle Bestände stimmen mit der Buchhaltung überein. Der Wirtschaftsprüfer ist sprachlos.',
    fail: 'Dein undiagnostiziertes ADHS schlägt zu und du hast einfach irgendwelche Zahlen aufgeschrieben, die in diesem Moment Sinn für dich gemacht haben.',
  },
  {
    id: 'angebotsvergleich',
    title: 'Angebotsvergleich',
    stat: 'bwl',
    text: 'Drei Lieferanten haben Angebote für neue Bürostühle geschickt. Führe einen Angebotsvergleich durch, inklusive Rabatt, Skonto und Lieferkosten.',
    success: 'Du hast das günstigste Angebot gefunden und dank Skonto sogar noch 3 % rausgeholt. Die Einkaufsabteilung ist stolz auf dich.',
    fail: 'Du hast Skonto mit einem italienischen Espresso verwechselt und für 4000 Euro Kaffee bestellt.',
  },
  {
    id: 'buchungssatz',
    title: 'Buchungssatz',
    stat: 'bwl',
    text: 'Die Firma hat einen neuen Laptop auf Ziel gekauft. Bilde den passenden Buchungssatz für die Buchhaltung.',
    success: 'Betriebs- und Geschäftsausstattung und Vorsteuer an Verbindlichkeiten. Lehrbuchreif!',
    fail: 'Du hast Soll und Haben vertauscht. Laut Bilanz schuldet der Laptop der Firma jetzt Geld.',
  },

  // ---------- Hybrid: FIA/FIS ----------
  {
    id: 'sql-abfrage',
    title: 'Komplexe SQL-Abfrage',
    stat: ['fia', 'fis'],
    text: 'Auf dem Datenbankserver liegen die Kundendaten aus fünf Tabellen. Schreib eine komplexe SQL-Abfrage mit mehreren Joins, die alles in einem Bericht zusammenführt.',
    success: 'Die Abfrage läuft in unter einer Sekunde, und der Index war sogar schon da. Respekt!',
    fail: 'Du hast statt "SELECT * FROM kunden" einfach "DROP TABLE kunden" geschrieben.',
  },
  {
    id: 'docker-deployment',
    title: 'Docker-Deployment',
    stat: ['fia', 'fis'],
    text: 'Die neue Web-App ist fertig programmiert und soll jetzt in einem Container auf dem Firmenserver laufen. Schreib das Dockerfile und bring sie online.',
    success: 'Container gebaut, App läuft, Ports sauber freigegeben. "Works on my machine" gilt jetzt auch für den Server.',
    fail: 'Du hast den Container mit vollen Root-Rechten und offenem SSH-Port ins Internet gestellt. Jetzt schürft ein Fremder auf eurem Server Kryptowährung.',
  },
  {
    id: 'backup-skript',
    title: 'Backup-Skript',
    stat: ['fia', 'fis'],
    text: 'Die Datenbank soll jede Nacht automatisch gesichert werden. Schreib ein Skript dafür und richte einen Cronjob auf dem Server ein.',
    success: 'Das Backup läuft jede Nacht, und der Restore-Test hat auch funktioniert. Du gehörst zu den 3 % der ITler, die das jemals getestet haben.',
    fail: 'Dein Skript sichert zuverlässig jede Nacht einen leeren Ordner. Aufgefallen ist es beim ersten Restore.',
  },

  // ---------- Hybrid: FIA/BWL ----------
  {
    id: 'online-casino',
    title: 'Online-Casino',
    stat: ['fia', 'bwl'],
    text: 'Ein Kunde möchte ein eigenes Online-Casino. Programmier die Plattform, inklusive Einzahlung, Roulette und Geschäftsmodell.',
    success: 'Das Casino läuft, die Bank gewinnt immer, und die Lizenz ist auch da. Der Kunde ist begeistert.',
    fail: 'Dein BFW liegt nicht in Schleswig-Holstein, und du hast jetzt Probleme mit der Glücksspielbehörde.',
  },
  {
    id: 'rechnungs-tool',
    title: 'Rechnungs-Tool',
    stat: ['fia', 'bwl'],
    text: 'Die Buchhaltung schreibt Rechnungen noch von Hand. Programmier ein Tool, das Rechnungen inklusive Umsatzsteuer und Zahlungsziel automatisch erstellt.',
    success: 'Rechnungen werden automatisch erstellt, die Umsatzsteuer stimmt, und die Buchhaltung hat dir Kuchen gebacken.',
    fail: 'Du hast die Umsatzsteuer mit 190 % berechnet. Die Kunden zahlen trotzdem, aber das Finanzamt hat jetzt Fragen.',
  },
  {
    id: 'webshop',
    title: 'Webshop',
    stat: ['fia', 'bwl'],
    text: 'Das Unternehmen möchte seine Produkte online verkaufen. Entwickle einen Webshop mit Warenkorb, Preiskalkulation und Rabattaktionen.',
    success: 'Der Shop ist online, die Preise stimmen und die ersten Bestellungen sind schon da.',
    fail: 'Der Warenkorb rundet alle Preise auf 0 Euro ab. Der Umsatz war nie höher, der Gewinn nie niedriger.',
  },

  // ---------- Hybrid: FIS/BWL ----------
  {
    id: 'nas-verkaufen',
    title: 'NAS-Verkauf',
    stat: ['fis', 'bwl'],
    text: 'Ein Kunde braucht mehr Speicherplatz für sein Büro. Berate ihn und verkaufe ihm ein passendes NAS-System.',
    success: 'Der Kunde hat ein NAS gekauft, dazu zwei Festplatten Reserve und einen Wartungsvertrag. Provision gesichert!',
    fail: 'Du hast etwas falsch verstanden und einfach die Systeme des Kunden nass gemacht.',
  },
  {
    id: 'it-budget',
    title: 'IT-Budget',
    stat: ['fis', 'bwl'],
    text: 'Für das nächste Geschäftsjahr muss das IT-Budget geplant werden: neue Hardware, Lizenzen, Wartung und Abschreibungen.',
    success: 'Das Budget ist realistisch, die Abschreibungen stimmen und der Controller hat nur zweimal nachgefragt.',
    fail: 'Du hast 80 % des Budgets für RGB-Beleuchtung im Serverraum eingeplant. Der Controller hat geweint.',
  },
  {
    id: 'lizenzaudit',
    title: 'Lizenzaudit',
    stat: ['fis', 'bwl'],
    text: 'Ein Softwarehersteller hat ein Lizenzaudit angekündigt. Prüfe, ob alle Installationen im Netzwerk korrekt lizenziert sind und was eine Nachlizenzierung kosten würde.',
    success: 'Alle Installationen erfasst, zwei Lizenzen nachgekauft, Audit bestanden. Die Geschäftsführung schläft wieder ruhig.',
    fail: 'Du hast stolz 300 Installationen gemeldet. Gekauft wurden 12 Lizenzen.',
  },
];

// Ohne eigenes Bild: neutrale Platzhalter-Karte (verrät nicht, welche Fähigkeit gebraucht wird)
for (const q of QUESTS) if (!q.image) q.image = '/img/ihk/quest-platzhalter.svg';

/** Fähigkeiten, mit denen eine Quest Punkte sammelt (eine oder zwei bei Hybrid-Quests) */
const statsOf = (quest) => [].concat(quest.stat);
/** Hybrid-Quest (zwei Fähigkeiten) – hat im Admin-Panel eigene Einstellungen */
const isHybrid = (quest) => statsOf(quest).length > 1;

const questById = Object.fromEntries(QUESTS.map((q) => [q.id, q]));
const difficulty = (level) => DIFFICULTIES[level - 1];

module.exports = { DIFFICULTIES, QUESTS, questById, difficulty, statsOf, isHybrid };

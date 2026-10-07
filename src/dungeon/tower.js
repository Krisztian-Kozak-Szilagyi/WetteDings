// Mage Tower: zweiter Dungeon-Modus, einmal am Tag. Statt drei fester Kämpfe geht es Stockwerk für Stockwerk nach
// oben, bis die Gruppe eine Runde nicht schafft. Jede Runde zieht zufällig eine Begegnung aus floors – welche
// Fähigkeit (stat) sie braucht, müssen die Spieler wie im Dungeon aus dem Text erraten.
// bossCard: Karte, die man mit genug Runden erbeuten kann (Chancen im Admin-Panel, siehe dungeonService.towerChances).

const TOWER = {
  key: 'mage-tower',
  title: 'Mage Tower',
  image: '/img/dungeon/placeholder.svg', // wie dungeons.PLACEHOLDER, bis es ein eigenes Bild gibt
  intro: 'Ein Turm ohne Dach: Jedes Stockwerk prüft euch härter als das letzte. Wie weit kommt ihr heute?',
  bossCard: 'st-ivan-boss', // bis der Turm eine eigene Karte hat
  floors: [
    // ---------- FIA ----------
    {
      key: 'endlosschleife',
      stat: 'fia',
      title: 'Die Treppe ohne Ende',
      text: 'Die Wendeltreppe führt euch Stufe um Stufe wieder an dieselbe Fackel. Ein Zauberer hat sie mit einer Bedingung verflucht, die nie falsch wird – wer den Fehler im Bann nicht findet, steigt bis ans Ende aller Tage.',
      success: 'Die Abbruchbedingung steht, die letzte Stufe führt endlich nach oben.',
      fail: 'Ihr steigt und steigt – und steht wieder am Eingang. Rückzug!',
    },
    {
      key: 'golem-schnittstelle',
      stat: 'fia',
      title: 'Der Golem mit der falschen Schnittstelle',
      text: 'Ein Lehmgolem versperrt den Gang und wartet auf Befehle. Er versteht nur Runen in genau dem Format, das in seinem verstaubten Handbuch steht – und das Handbuch ist zur Hälfte veraltet.',
      success: 'Eingabe geprüft, Antwort richtig gelesen: Der Golem nickt und tritt zur Seite.',
      fail: 'Der Golem missversteht euch und trägt euch höflich, aber bestimmt die Treppe hinunter.',
    },
    {
      key: 'spiegel-kopie',
      stat: 'fia',
      title: 'Das Spiegelkabinett',
      text: 'In jedem Spiegel steht eine Kopie von euch – aber verändert man das Spiegelbild, ändert sich das Original mit. Nur wer sauber trennt, was geteilt und was kopiert ist, findet die echte Tür.',
      success: 'Echte Kopien statt Verweise: Die Spiegelbilder zerspringen, die Tür bleibt.',
      fail: 'Ihr zerschlagt einen Spiegel – und mit ihm euren Weg nach oben.',
    },
    // ---------- FIS ----------
    {
      key: 'brennender-serverschrein',
      stat: 'fis',
      title: 'Der glühende Serverschrein',
      text: 'Hinter einer Eisentür summt ein Schrein voller Kristalle, die Lüfter verstummt, die Luft flimmert vor Hitze. Ein Kristall nach dem anderen fällt aus – und mit jedem erlischt ein Teil der Turmmagie.',
      success: 'Lüfter getauscht, Last verteilt, der Schrein läuft wieder ruhig – die Treppe glüht auf.',
      fail: 'Der letzte Kristall bricht, und im Dunkeln findet ihr nur noch den Weg nach unten.',
    },
    {
      key: 'portal-netz',
      stat: 'fis',
      title: 'Das Netz der Portale',
      text: 'Ein Saal voller Portale, jedes führt in ein anderes. Manche Wege sind gesperrt, andere führen im Kreis, und irgendwo hat jemand zwei Portale denselben Namen gegeben.',
      success: 'Jedes Portal bekommt seinen eigenen Namen und die richtige Route – das letzte führt ins nächste Stockwerk.',
      fail: 'Ihr tretet durch das falsche Portal und landet vor dem Turm im Gras.',
    },
    {
      key: 'wachen-runen',
      stat: 'fis',
      title: 'Die Runenwache',
      text: 'Am Tor glüht ein Runenschild, das jeden durchlässt – auch die Kobolde, die schon im Stockwerk herumschleichen. Ein Wächter verlangt, dass ihr das Schild neu ausrichtet, bevor er euch passieren lässt.',
      success: 'Nur noch, wer hinein darf, kommt hinein. Die Kobolde prallen ab, der Wächter salutiert.',
      fail: 'Die Kobolde schlüpfen durch eure Lücke und jagen euch die Treppe hinunter.',
    },
    // ---------- BWL ----------
    {
      key: 'turmkasse',
      stat: 'bwl',
      title: 'Die Turmkasse',
      text: 'Ein Kobold mit Monokel verlangt Eintritt – aber nur, wenn ihr ihm vorrechnet, ob sich der Turm dieses Jahr überhaupt noch lohnt. Seine Bücher sind ein einziges Durcheinander aus Gold, Schulden und verzauberten Rechnungen.',
      success: 'Gewinn, Verlust und Abschreibungen stehen sauber auf dem Pergament. Der Kobold öffnet grummelnd die Schranke.',
      fail: 'Die Zahlen gehen nicht auf. Der Kobold stellt euch eine Rechnung – und euch vor die Tür.',
    },
    {
      key: 'lieferant-alchemist',
      stat: 'bwl',
      title: 'Der Alchemist will verhandeln',
      text: 'Ohne Tränke kommt hier niemand weiter, und der Alchemist im Erker weiß das genau. Er nennt Preise, die jeden Monat steigen, und hat drei Angebote, die alle gleich aussehen – bis man nachrechnet.',
      success: 'Das günstigste Angebot gefunden, Skonto mitgenommen – die Tränke reichen bis zum nächsten Stockwerk.',
      fail: 'Ihr zahlt zu viel, die Tränke sind leer, bevor die Treppe endet. Rückzug!',
    },
    {
      key: 'gilde-vertrag',
      stat: 'bwl',
      title: 'Der Vertrag der Magiergilde',
      text: 'Die Gilde lässt nur Mitglieder weiter, und der Vertrag ist dick wie ein Zauberbuch. Irgendwo darin stehen Kündigungsfristen, Haftung und ein Kleingedrucktes, das eure Seele kostet.',
      success: 'Jede Klausel geprüft, die Falle gestrichen – die Gilde unterschreibt und öffnet das Tor.',
      fail: 'Ihr unterschreibt das Kleingedruckte und werdet höflich, aber verbindlich hinausbegleitet.',
    },
  ],
};
const floorByKey = Object.fromEntries(TOWER.floors.map((f) => [f.key, f]));

module.exports = { TOWER, floorByKey };

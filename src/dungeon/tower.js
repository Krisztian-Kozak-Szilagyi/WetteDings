// Mage Tower: zweiter Dungeon-Modus, Läufe pro Tag im Admin-Panel (Standard 1). Statt drei fester Kämpfe geht es Stockwerk für Stockwerk nach
// oben, bis die Gruppe eine Runde nicht schafft. Jede Runde zieht zufällig eine Begegnung aus floors – welche
// Fähigkeit (stat) sie braucht, müssen die Spieler wie im Dungeon aus dem Text erraten.
// bossCard: Karte, die man mit genug Runden erbeuten kann (Chancen im Admin-Panel, siehe dungeonService.towerChances).

const TOWER = {
  key: 'mage-tower',
  title: 'Mage Tower',
  image: '/img/dungeon/st-ivan-dungeon-banner.webp', // vorerst das St.-Ivan-Banner, bis der Turm ein eigenes Bild hat
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
    {
      key: 'speicherleck',
      stat: 'fia',
      title: 'Der Brunnen, der nie voll wird',
      text: 'Ein Zauberbrunnen schöpft bei jedem Schritt mehr Mana ab, gibt aber nie etwas zurück. Bald ist der ganze Turm leergesaugt – irgendwo im Zauber wird etwas angelegt und nie wieder freigegeben.',
      success: 'Ihr findet den vergessenen Bann und gebt das Mana frei – der Brunnen plätschert friedlich.',
      fail: 'Das Mana versiegt, eure Fackeln erlöschen – im Dunkeln tastet ihr euch hinaus.',
    },
    {
      key: 'zwillingsgeister',
      stat: 'fia',
      title: 'Die Zwillingsgeister',
      text: 'Zwei Geister schreiben gleichzeitig in dieselbe Schriftrolle, und jedes Mal steht etwas anderes darauf. Wer zuerst schreibt, entscheidet der Zufall – bis ihr eine Reihenfolge erzwingt.',
      success: 'Ein Geist wartet jetzt brav auf den anderen. Die Rolle ist lesbar, die Tür springt auf.',
      fail: 'Die Geister überschreiben eure Lösung – und euch gleich mit. Rückzug!',
    },
    {
      key: 'grimoire',
      stat: 'fia',
      title: 'Das Grimoire ohne Kommentare',
      text: 'Ein uraltes Zauberbuch steuert die Aufzüge des Turms. Niemand weiß mehr, warum es funktioniert, und jede geänderte Zeile lässt irgendwo eine Treppe einstürzen.',
      success: 'Zeile für Zeile verstanden, aufgeräumt und erklärt – der Aufzug fährt sanft nach oben.',
      fail: 'Eine harmlose Änderung, und der Aufzug rauscht ins Erdgeschoss.',
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
    {
      key: 'sicherungsgruft',
      stat: 'fis',
      title: 'Die Gruft der verlorenen Sicherungen',
      text: 'Die Archivare des Turms haben jeden Tag Sicherungskristalle angelegt – aber nie geprüft, ob man sie zurückspielen kann. Jetzt ist das Archiv zerstört, und alle Augen richten sich auf euch.',
      success: 'Der dritte Kristall ist heil, die Wiederherstellung gelingt – das Archiv leuchtet wieder.',
      fail: 'Alle Kristalle sind leer. Die Archivare weinen, ihr geht.',
    },
    {
      key: 'kabellabyrinth',
      stat: 'fis',
      title: 'Das Kabellabyrinth',
      text: 'Hinter einer Wand wuchern Leuchtfäden in allen Farben, ohne Beschriftung, kreuz und quer verknotet. Irgendwo darin hängt die Verbindung zum nächsten Stockwerk.',
      success: 'Gebündelt, beschriftet, gesteckt – das Licht fließt die Treppe hinauf.',
      fail: 'Ihr zieht am falschen Faden, und das halbe Stockwerk geht aus.',
    },
    {
      key: 'golem-update',
      stat: 'fis',
      title: 'Der Golem im Update',
      text: 'Ein Wächtergolem hat mitten im Kampf beschlossen, sich zu aktualisieren. Er rührt sich nicht, die Tür hinter ihm bleibt zu – und der Balken steht seit einer Stunde bei 99 %.',
      success: 'Neustart im richtigen Moment, Treiber nachgelegt – der Golem erwacht und tritt beiseite.',
      fail: 'Der Golem startet neu. Und noch einmal. Ihr gebt auf.',
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
    {
      key: 'zinsdrache',
      stat: 'bwl',
      title: 'Der Zinsdrache',
      text: 'Ein Drache hockt auf einem Goldberg und verleiht Münzen an jeden, der vorbeikommt. Die Zinsen wachsen schneller als sein Hort, und wer nicht nachrechnet, schuldet ihm am Ende sich selbst.',
      success: 'Ihr rechnet ihm den Effektivzins vor. Der Drache räuspert sich verlegen und lässt euch passieren.',
      fail: 'Ihr unterschreibt den Kredit – der Drache besitzt jetzt eure Stiefel.',
    },
    {
      key: 'inventur',
      stat: 'bwl',
      title: 'Die Inventur der Zauberkammer',
      text: 'Der Kämmerer will wissen, was im Lager wirklich liegt: Tränke, Schriftrollen, ein Zauberstab, der vielleicht nur ein Stock ist. Ohne saubere Inventur bleibt die Kammer zu.',
      success: 'Gezählt, bewertet, abgeschrieben – der Kämmerer stempelt euren Bericht ab.',
      fail: 'Am Ende fehlen drei Tränke, und der Verdacht fällt auf euch.',
    },
    {
      key: 'marktorakel',
      stat: 'bwl',
      title: 'Das Marktorakel',
      text: 'Ein Orakel verkauft Weissagungen über die Preise von morgen. Wer kauft, soll beweisen, dass sich die Weissagung lohnt – mit Angebot, Nachfrage und einer Prise Verstand.',
      success: 'Ihr durchschaut die Preisfalle und kauft nur, was sich rechnet. Das Orakel nickt anerkennend.',
      fail: 'Ihr kauft die teuerste Weissagung. Sie lautet: „Ihr geht jetzt.“',
    },
  ],
};
const floorByKey = Object.fromEntries(TOWER.floors.map((f) => [f.key, f]));

// ---------- Texte im Admin-Panel (Spielwerte → Dungeon) ----------
// Die Texte oben sind die Startwerte. Gespeicherte Änderungen (nur die Abweichungen) überschreiben sie beim Start
// und nach dem Speichern – die Stockwerk-Objekte werden dafür direkt geändert, damit floorByKey & Co. sie sehen.
const TEXT_FIELDS = { title: 80, text: 600, success: 300, fail: 300 };
const FLOOR_DEFAULTS = Object.fromEntries(TOWER.floors.map((f) => [f.key, Object.fromEntries(Object.keys(TEXT_FIELDS).map((k) => [k, f[k]]))]));

/**
 * Eingabe prüfen. input: { [floorKey]: { title, text, success, fail } } (fehlend/leer = Startwert).
 * Es zählen nur bekannte Stockwerke und Felder. → { texts } mit nur den Abweichungen, oder { error }
 */
function cleanFloorTexts(input) {
  const texts = {};
  for (const f of TOWER.floors) {
    const given = input && typeof input[f.key] === 'object' && input[f.key] ? input[f.key] : {};
    for (const [field, max] of Object.entries(TEXT_FIELDS)) {
      const raw = given[field];
      const value = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
      if (!value || value === FLOOR_DEFAULTS[f.key][field]) continue;
      if (value.length > max) return { error: `„${FLOOR_DEFAULTS[f.key].title}“: höchstens ${max} Zeichen (${field === 'title' ? 'Name' : field === 'text' ? 'Beschreibung' : field === 'success' ? 'Sieg-Text' : 'Niederlage-Text'}).` };
      (texts[f.key] = texts[f.key] || {})[field] = value;
    }
  }
  return { texts };
}

/** Texte übernehmen: Abweichungen aus texts, sonst Startwert */
function applyFloorTexts(texts) {
  for (const f of TOWER.floors) {
    for (const field of Object.keys(TEXT_FIELDS)) f[field] = (texts && texts[f.key] && texts[f.key][field]) || FLOOR_DEFAULTS[f.key][field];
  }
}

// ---------- Läufe pro Tag ----------
/**
 * Wie viele Läufe hat ein Spieler heute noch? counts = bisher heute { total, esports } (eSports-Läufe zählen auch
 * zu total – ein gemeinsames Kontingent). opts = { dailyRuns, esportsRuns }. → { left, esportsLeft }
 */
function towerQuota(counts, opts) {
  const total = (counts && counts.total) || 0;
  const esports = (counts && counts.esports) || 0;
  const left = Math.max(0, opts.dailyRuns - total);
  return { left, esportsLeft: Math.min(left, Math.max(0, opts.esportsRuns - esports)) };
}

module.exports = { TOWER, floorByKey, TEXT_FIELDS, FLOOR_DEFAULTS, cleanFloorTexts, applyFloorTexts, towerQuota };

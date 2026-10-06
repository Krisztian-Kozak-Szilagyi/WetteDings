/**
 * Börsenbericht: tägliche Auswertung der Aktivität der Seite (18:45 Uhr deutscher Zeit) und daraus der Kurssprung
 * des BfW-TCG ETF. Reine Logik ohne Datenbank – der Zufall kommt als Parameter (rng), gleiche Eingabe → gleiches Ergebnis.
 *
 * Jede Kennzahl wird mit dem Schnitt der 7 Vortage verglichen: m = log2(heute / Schnitt), begrenzt auf −1 … +1
 * (doppelt so viel = +1, halb so viel = −1). So zählt die Richtung, nicht das Ausmaß: 50 % mehr Geld im Spiel
 * heißt nicht 50 % Kurs. Dazu kommen Rekorde (mehr als an jedem der bis zu 30 Vortage).
 * Sprung (Log-Rendite) = SCORE_WEIGHT · Stimmung + RECORD_WEIGHT · Rekordanteil + kleines Rauschen, begrenzt.
 * Beispiele: alles verdoppelt und überall Rekord ≈ +60 %, ein guter Tag ≈ +10–20 %, ein normaler Tag ≈ 0,
 * ein schwacher Tag ≈ −10–15 %, alles halbiert ≈ −25 %.
 *
 * Gegen Hochtreiben durch Einzelne zählen die Kennzahlen Aktionen je Mitglied höchstens PER_USER_CAP-mal pro Tag
 * (wird beim Sammeln angewendet, siehe reportService.js).
 */

const SCORE_WEIGHT = 0.3;
const RECORD_WEIGHT = 0.18;
const NOISE = 0.03;
const MIN_LOG = -0.35; // ≈ −30 %
const MAX_LOG = 0.55; // ≈ +73 %
const BASE_DAYS = 7;
const RECORD_MIN_DAYS = 3; // Rekorde erst, wenn es genug Vergleichstage gibt
const PER_USER_CAP = 20;

// Kennzahlen: types = Buchungsarten im Kontoauszug (Ledger); anleger/aktionen aus ActivityPulse, forum aus Beiträgen
const METRICS = [
  { key: 'anleger', label: 'Aktive Anleger', unit: 'Anleger', weight: 2 },
  { key: 'aktionen', label: 'Transaktionen', unit: 'Transaktionen', weight: 2 },
  { key: 'wetten', label: 'Wettgeschäft', unit: 'Einsätze', types: ['einsatz'] },
  { key: 'broker', label: 'Broker-Handel', unit: 'Orders', types: ['coin_kauf', 'coin_verkauf'] },
  { key: 'packs', label: 'Booster-Absatz', unit: 'Käufe', types: ['tcg_pack'] },
  { key: 'handel', label: 'Kartenhandel', unit: 'Abschlüsse', types: ['handel_kauf', 'black_market'] },
  { key: 'lotterie', label: 'Lotterie', unit: 'Lose', types: ['lotto_los'] },
  { key: 'ihk', label: 'IHK-Aufträge', unit: 'Quests', types: ['ihk_lohn'] },
  { key: 'dungeon', label: 'Dungeon-Expeditionen', unit: 'Siege', types: ['dungeon_lohn'] },
  { key: 'grading', label: 'Grading-Gewerbe', unit: 'Aufträge', types: ['grading_lohn'] },
  { key: 'forum', label: 'Forum', unit: 'Beiträge' },
];

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/**
 * Auswertung eines Tages.
 * @param {Object<string, number>} today  Kennzahl → Wert des Tages
 * @param {Array<Object<string, number>>} history  Vortage, neuester zuerst (bis zu 30)
 * @param {() => number} rng
 */
function evaluate(today, history = [], rng = Math.random) {
  const base = history.slice(0, BASE_DAYS);
  const rows = [];
  let wSum = 0;
  let sSum = 0;
  let records = 0;
  for (const m of METRICS) {
    const value = Math.max(0, Number(today[m.key]) || 0);
    // null = an diesem Tag nicht erfasst (zählt weder zum Schnitt noch zum Rekord)
    const known = (list) => list.map((d) => d[m.key]).filter((v) => v !== null && v !== undefined).map(Number);
    const baseVals = known(base);
    const pastVals = known(history);
    const avg = baseVals.length ? baseVals.reduce((s, v) => s + v, 0) / baseVals.length : null;
    const best = pastVals.length ? Math.max(...pastVals) : 0;
    const active = avg !== null && (value > 0 || avg > 0);
    const score = active ? clamp(Math.log2((value + 1) / (avg + 1)), -1, 1) : 0;
    const record = pastVals.length >= RECORD_MIN_DAYS && value > 0 && value > best;
    const weight = m.weight || 1;
    if (active) {
      wSum += weight;
      sSum += weight * score;
      if (record) records += 1;
    }
    rows.push({ key: m.key, label: m.label, unit: m.unit, value, avg, change: avg ? value / avg - 1 : null, score, record });
  }
  const count = rows.filter((r) => r.avg !== null && (r.value > 0 || r.avg > 0)).length;
  const sentiment = wSum ? sSum / wSum : 0;
  const recordShare = count ? records / count : 0;
  const noise = count ? (rng() * 2 - 1) * NOISE : 0;
  const log = count ? clamp(SCORE_WEIGHT * sentiment + RECORD_WEIGHT * recordShare + noise, MIN_LOG, MAX_LOG) : 0;
  return { rows, sentiment, records, recordShare, log, change: Math.expm1(log), mood: moodOf(log) };
}

/** Stimmung für Text und Anzeige: 'crash' | 'schwach' | 'seitwaerts' | 'fest' | 'stark' | 'euphorie' */
function moodOf(log) {
  if (log <= -0.15) return 'crash';
  if (log <= -0.04) return 'schwach';
  if (log < 0.04) return 'seitwaerts';
  if (log < 0.15) return 'fest';
  if (log < 0.3) return 'stark';
  return 'euphorie';
}

// ---------- Text ----------
// Der Bericht ist ein kleiner Zeitungsartikel aus der Welt von BfW Holdings: Schlagzeile, Lage auf dem Parkett,
// Gewinner und Verlierer als Fließtext, Rekorde, ein Zitat aus der Analyse-Abteilung. Er nennt keine Kurse.

const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];
const intFmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

const HEADLINES = {
  crash: ['Schwarzer Tag auf dem Parkett', 'Ausverkauf in der Altstadt', 'Die Bären übernehmen das Kommando'],
  schwach: ['Zäher Handel, gedrückte Stimmung', 'Die Händler halten sich zurück', 'Ein Tag zum Vergessen – fast'],
  seitwaerts: ['Ruhige Hand am Parkett', 'Weder Rausch noch Kater', 'Business as usual bei BfW Holdings'],
  fest: ['Freundlicher Handel, gute Laune', 'Die Bullen recken die Köpfe', 'Rückenwind für die Altstadt'],
  stark: ['Das Parkett brummt', 'Kräftige Zuwächse auf breiter Front', 'Die Bullen geben den Ton an'],
  euphorie: ['Rekordjagd auf dem Parkett', 'Historischer Handelstag', 'Das Parkett steht Kopf'],
};

const OPENERS = {
  crash: [
    'Wer heute über das Parkett von BfW Holdings ging, hörte vor allem eines: das Echo der eigenen Schritte. Die Umsätze brachen auf breiter Front ein, die Händler verließen am Abend mit hängenden Köpfen den Saal.',
    'Tiefrot leuchteten heute die Anzeigetafeln. Schon am Vormittag war klar, dass dies kein gewöhnlicher Handelstag werden würde – bis zum Abend rauschte eine Kennzahl nach der anderen in den Keller.',
  ],
  schwach: [
    'Ein zäher Tag liegt hinter dem Parkett. Die Geschäfte liefen, aber sie liefen spürbar langsamer als in den vergangenen Tagen, und mancher Makler griff schon am Nachmittag zum Mantel.',
    'Zurückhaltung prägte heute das Bild. Viele Marktteilnehmer schienen lieber abzuwarten, als neue Positionen einzugehen – die Stimmung am Abend: gedrückt, aber nicht verzweifelt.',
  ],
  seitwaerts: [
    'Ein unaufgeregter Handelstag geht zu Ende. Die Geschäfte bewegten sich ziemlich genau im Rahmen der vergangenen Woche – keine Panik, keine Euphorie, solides Handwerk.',
    'Seitwärts ist auch eine Richtung, sagen die alten Hasen auf dem Parkett. Heute hatten sie recht: Die meisten Kennzahlen pendelten um ihren Wochenschnitt.',
  ],
  fest: [
    'Freundlicher Handel bei BfW Holdings: Die Aktivität lag heute spürbar über dem Schnitt der Woche, und am Abend war in den Gängen wieder öfter ein Lachen zu hören.',
    'Die Händler sind gut gelaunt aus dem Tag gegangen. Mehrere Sektoren legten zu, die Stimmung hellte sich im Laufe des Nachmittags merklich auf.',
  ],
  stark: [
    'Was für ein Tag! Das Parkett brummte von der ersten bis zur letzten Minute, die Telefone standen kaum still, und die Makler kamen mit dem Notieren der Abschlüsse kaum hinterher.',
    'Die Bullen haben heute das Kommando übernommen. Auf breiter Front zogen die Geschäfte an, und selbst skeptische Beobachter mussten am Abend anerkennen: Das war ein starker Tag.',
  ],
  euphorie: [
    'Historischer Handelstag bei BfW Holdings! Rekorde purzelten im Stundentakt, auf dem Parkett lagen sich wildfremde Händler in den Armen, und in der Analyse-Abteilung wurde der Kaffee knapp.',
    'Das Parkett steht Kopf. Was sich heute abgespielt hat, werden die Chronisten noch lange erzählen – ein wahres Feuerwerk an Zuwächsen und Bestmarken.',
  ],
};

// Sätze je Sektor: {v} = Wert, {p} = Änderung in Prozent (ohne Vorzeichen)
const SECTOR = {
  anleger: {
    up: ['Auf dem Parkett drängten sich {v} aktive Anleger – {p} % mehr als im Wochenschnitt.', 'Der Andrang war beachtlich: {v} Anleger fanden heute den Weg aufs Parkett, ein Plus von {p} %.'],
    down: ['Das Parkett wirkte leerer als sonst: Nur {v} Anleger ließen sich blicken, {p} % weniger als im Wochenschnitt.', 'Viele Plätze blieben heute frei – {v} aktive Anleger, ein Rückgang um {p} %.'],
    flat: ['{v} Anleger waren heute aktiv, ziemlich genau so viele wie im Wochenschnitt.'],
  },
  aktionen: {
    up: ['Insgesamt wurden {v} Transaktionen gezählt, {p} % mehr als üblich.'],
    down: ['Gezählt wurden {v} Transaktionen – {p} % unter dem Schnitt.'],
    flat: ['Mit {v} Transaktionen bewegte sich das Volumen im gewohnten Rahmen.'],
  },
  wetten: {
    up: ['Die Buchmacher reiben sich die Hände: {v} Einsätze gingen über den Tresen, {p} % mehr als im Wochenschnitt.', 'Im Wettgeschäft herrschte Hochbetrieb – {v} Einsätze, ein Plus von {p} %.'],
    down: ['Bei den Buchmachern blieb es auffällig still. Nur {v} Einsätze, {p} % weniger als sonst.', 'Das Wettgeschäft schwächelte: {v} Einsätze, ein Minus von {p} %.'],
  },
  broker: {
    up: ['Im Broker-Saal liefen die Orderbücher heiß: {v} Orders, {p} % mehr als im Schnitt.', 'Die Broker hatten alle Hände voll zu tun – {v} Orders, ein Zuwachs von {p} %.'],
    down: ['Im Broker-Saal herrschte vornehme Zurückhaltung: {v} Orders, {p} % unter dem Schnitt.', 'Die Broker drehten heute Däumchen – nur {v} Orders, ein Minus von {p} %.'],
  },
  packs: {
    up: ['Die Booster-Händler kamen mit dem Nachfüllen der Regale kaum hinterher: {v} Käufe, {p} % mehr als üblich.', 'Booster Packs gingen weg wie warme Semmeln – {v} Käufe, ein Plus von {p} %.'],
    down: ['Die Booster-Regale blieben voller als gewohnt: {v} Käufe, {p} % weniger als im Wochenschnitt.', 'Bei den Booster-Händlern war wenig los – {v} Käufe, ein Minus von {p} %.'],
  },
  handel: {
    up: ['Auf dem Kartenmarkt wechselten heute {v}-mal Karten den Besitzer, {p} % öfter als im Schnitt.', 'Der Kartenhandel blühte auf: {v} Abschlüsse, ein Plus von {p} %.'],
    down: ['Der Kartenmarkt zeigte sich müde: {v} Abschlüsse, {p} % weniger als sonst.', 'Auf dem Kartenmarkt wurde mehr geschaut als gekauft – {v} Abschlüsse, ein Minus von {p} %.'],
  },
  lotterie: {
    up: ['An den Losbuden bildeten sich Schlangen: {v} Lose, {p} % mehr als im Wochenschnitt.', 'Das Glücksspiel boomt – {v} verkaufte Lose, ein Plus von {p} %.'],
    down: ['Das Lotteriegeschäft lahmte: {v} Lose, {p} % weniger als sonst.', 'An den Losbuden war es ruhig – {v} Lose, ein Minus von {p} %.'],
  },
  ihk: {
    up: ['Die IHK meldet {v} erledigte Quests, {p} % mehr als im Schnitt – in der Kammer knallten die Korken.', 'Die IHK verbucht {v} Quests, ein Plus von {p} % – fleißige Azubis, wohin man schaut.'],
    down: ['Die IHK verbucht nur {v} Quests, {p} % weniger als üblich, und mahnt mehr Fleiß an.', 'In der Kammer blieben die Akten liegen – {v} Quests, ein Minus von {p} %.'],
  },
  dungeon: {
    up: ['Aus den Hallen von St. Ivan kehrten {v} siegreiche Trupps zurück, {p} % mehr als im Wochenschnitt.', 'Die Abenteurer waren heute nicht zu bremsen: {v} Siege im Dungeon, ein Plus von {p} %.'],
    down: ['In den Dungeon wagten sich heute weniger Abenteurer: {v} Siege, {p} % unter dem Schnitt.', 'St. Ivan hatte einen ruhigen Tag – nur {v} Siege, ein Minus von {p} %.'],
  },
  grading: {
    up: ['Das Grading-Gewerbe boomt: {v} Aufträge, {p} % mehr als üblich – die Lupen glühen.', 'In den Grading-Shops wurde geputzt, benotet und versiegelt, was das Zeug hält: {v} Aufträge, ein Plus von {p} %.'],
    down: ['Im Grading-Gewerbe gab es Leerlauf: {v} Aufträge, {p} % weniger als im Schnitt.', 'Die Grading-Shops meldeten eine flaue Auftragslage – {v} Aufträge, ein Minus von {p} %.'],
  },
  forum: {
    up: ['In den Kaffeehäusern der Stadt – sprich: im Forum – wurde eifrig debattiert: {v} Beiträge, {p} % mehr als sonst.', 'Im Forum brodelte die Gerüchteküche: {v} Beiträge, ein Plus von {p} %.'],
    down: ['Im Forum war es ruhig, nur {v} Beiträge ({p} % weniger als im Schnitt).', 'In den Kaffeehäusern blieb es still – {v} Beiträge, ein Minus von {p} %.'],
  },
};

const DOWN_INTRO = ['Doch nicht überall lief es rund. ', 'Schattenseiten gab es trotzdem. ', 'Weniger erfreulich: '];
const FLAT_LINE = ['Kaum Bewegung gab es {list}.', 'Ruhig verlief der Tag {list}.'];
const RECORD_LINE = {
  one: ['Und dann war da noch ein Rekord: {list} erreichte einen neuen Höchststand.', 'Eine Bestmarke gab es obendrein – {list} kletterte auf ein Allzeithoch.'],
  many: ['Gleich {n} Allzeithochs notierten die Chronisten – {list}.', 'Die Rekordbücher müssen neu geschrieben werden: Bestmarken {list}.'],
};
const ANALYSTS = ['Bettina Bulle, Chefanalystin der Börse', 'Bernd Bärmann, Leiter der Marktbeobachtung', 'Gerda Groschen vom Analyse-Desk', 'Theo Tendenz, Marktstratege'];
const QUOTES = {
  crash: ['„Solche Tage gehören dazu. Wer jetzt die Nerven behält, wird es später nicht bereuen.“', '„Ich habe schon viele schwarze Tage gesehen. Aber dieser hier war besonders dunkel.“'],
  schwach: ['„Eine Delle, kein Absturz. Morgen ist ein neuer Handelstag.“', '„Die Leute sind vorsichtig geworden. Das muss nichts Schlechtes sein.“'],
  seitwaerts: ['„Ruhige Tage sind die besten Tage zum Nachdenken.“', '„Kein Grund zur Sorge, aber auch kein Grund für Champagner.“'],
  fest: ['„Die Richtung stimmt. Wenn das so weitergeht, wird es spannend.“', '„Man spürt, dass wieder Leben in der Bude ist.“'],
  stark: ['„So einen Tag wünscht man sich öfter. Die Zahlen sprechen für sich.“', '„Das ist kein Strohfeuer – da steckt echte Nachfrage dahinter.“'],
  euphorie: ['„Ich mache das seit Jahren, aber so etwas habe ich selten erlebt.“', '„Heute Abend wird gefeiert – solche Tage gibt es nicht oft.“'],
};
const CLOSERS = ['Der nächste Bericht folgt morgen um 18:45 Uhr.', 'Die Börse meldet sich morgen um 18:45 Uhr zurück.', 'Wie es weitergeht, entscheidet der Markt – morgen um 18:45 Uhr wissen wir mehr.'];

const LABEL_DE = { anleger: 'bei den Anlegerzahlen', aktionen: 'bei den Transaktionen', wetten: 'im Wettgeschäft', broker: 'im Broker-Handel', packs: 'beim Booster-Absatz', handel: 'im Kartenhandel', lotterie: 'in der Lotterie', ihk: 'bei der IHK', dungeon: 'im Dungeon', grading: 'im Grading-Gewerbe', forum: 'im Forum' };
const LABEL_NOM = { anleger: 'die Zahl der Anleger', aktionen: 'das Transaktionsvolumen', wetten: 'das Wettgeschäft', broker: 'der Broker-Handel', packs: 'der Booster-Absatz', handel: 'der Kartenhandel', lotterie: 'die Lotterie', ihk: 'die IHK', dungeon: 'der Dungeon', grading: 'das Grading-Gewerbe', forum: 'das Forum' };

const joinDe = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} und ${list[list.length - 1]}`);
const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function sectorLine(rng, r, dir) {
  const set = SECTOR[r.key];
  const list = set[dir] || set.up;
  const p = r.change === null ? 0 : Math.abs(r.change * 100);
  return pick(rng, list).replace('{v}', intFmt.format(r.value)).replace('{p}', pctFmt.format(p));
}

/** Titel und Text (Forum-Auszeichnung) des Berichts – ein kleiner Artikel, nennt keine Kurse */
function reportText(result, dateLabel, rng = Math.random) {
  const rows = result.rows.filter((r) => r.avg !== null && (r.value > 0 || r.avg > 0));
  const isUp = (r) => r.score > 0.1;
  const isDown = (r) => r.score < -0.1;
  const crowd = rows.find((r) => r.key === 'anleger');
  const sectors = rows.filter((r) => r.key !== 'anleger' && r.key !== 'aktionen');
  const paras = [];

  // 1. Lage auf dem Parkett
  let intro = pick(rng, OPENERS[result.mood]);
  if (crowd) intro += ' ' + sectorLine(rng, crowd, isUp(crowd) ? 'up' : isDown(crowd) ? 'down' : 'flat');
  paras.push(intro);

  // 2. Gewinner (bis zu drei), 3. Verlierer (bis zu zwei)
  const allUps = sectors.filter(isUp).sort((a, b) => b.score - a.score);
  const ups = allUps.slice(0, 3);
  const moreUps = allUps.slice(3).map((r) => LABEL_DE[r.key]);
  if (ups.length) paras.push([...ups.map((r) => sectorLine(rng, r, 'up')), ...(moreUps.length ? [`Zuwächse gab es außerdem ${joinDe(moreUps)}.`] : [])].join(' '));
  const allDowns = sectors.filter(isDown).sort((a, b) => a.score - b.score);
  const downs = allDowns.slice(0, 2);
  const moreDowns = allDowns.slice(2).map((r) => LABEL_DE[r.key]);
  if (downs.length) paras.push([(ups.length ? pick(rng, DOWN_INTRO) : '') + downs.map((r) => sectorLine(rng, r, 'down')).join(' '), ...(moreDowns.length ? [`Rückgänge auch ${joinDe(moreDowns)}.`] : [])].join(' '));
  const flats = sectors.filter((r) => !isUp(r) && !isDown(r)).map((r) => LABEL_DE[r.key]);
  if (flats.length && flats.length <= 4) paras.push(pick(rng, FLAT_LINE).replace('{list}', joinDe(flats)));

  // 4. Rekorde
  const recs = result.rows.filter((r) => r.record);
  if (recs.length === 1) paras.push(pick(rng, RECORD_LINE.one).replace('{list}', upper(LABEL_NOM[recs[0].key])));
  else if (recs.length >= 6) paras.push(`Rekorde, wohin man schaut: In ${recs.length} von ${result.rows.length} Bereichen notierten die Chronisten neue Höchststände.`);
  else if (recs.length > 1) paras.push(pick(rng, RECORD_LINE.many).replace('{n}', recs.length).replace('{list}', joinDe(recs.map((r) => LABEL_DE[r.key]))));

  // 5. Stimme aus der Analyse und Abschluss
  paras.push(`${pick(rng, QUOTES[result.mood])} – ${pick(rng, ANALYSTS)}`);
  paras.push(`**${pick(rng, CLOSERS)}**`);

  const headline = pick(rng, HEADLINES[result.mood]);
  return { title: `Börsenbericht vom ${dateLabel}: ${headline}`, body: paras.join('\n\n') };
}

module.exports = { METRICS, PER_USER_CAP, BASE_DAYS, MIN_LOG, MAX_LOG, evaluate, moodOf, reportText };

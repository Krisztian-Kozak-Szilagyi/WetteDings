// Manipulationserkennung: reine Hilfsfunktionen (ohne Datenbank, damit sie sich einfach testen lassen).
// Sucht in Zeitstempeln und Geschäften nach Mustern, die auf Skripte oder Wertverschiebung hindeuten. Das Ergebnis
// sind nur Hinweise fürs Dev-Panel (siehe suspicionService.js) – gesperrt wird dadurch niemand.
const { LEVEL } = require('../device/deviceLogic');

// wie euro() aus lib/viewHelpers – hier eigenständig, damit die Datei ohne Konfiguration testbar bleibt
const euroFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const euro = (cents) => euroFmt.format((cents || 0) / 100);

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

// ---------- Schwellen (bei Bedarf hier nachjustieren) ----------

// Aktionen, deren Abstände geprüft werden. floorMs = schneller klickt kein Mensch über mehrere Aktionen hinweg:
// Pack kaufen ist ein Formular mit Neuladen, Pack öffnen braucht Anfrage, Aufreißen (650 ms), Aufdecken und den
// Knopf "Nächstes Pack", ein Bank-Verkauf lädt das Album neu. log = passendes Protokoll im Panel.
const ACTIONS = {
  kaufen: { label: 'Pack-Käufe', floorMs: 400, log: 'konto' },
  oeffnen: { label: 'Pack-Öffnungen', floorMs: 1500, log: 'packs' },
  verkaufen: { label: 'Bank-Verkäufe', floorMs: 800, log: 'verkauf' },
  broker: { label: 'Broker-Aufträge', floorMs: 1000, log: 'broker' },
  wetten: { label: 'Wett-Einsätze', floorMs: 1500, log: 'einsaetze' },
};

const TEMPO_RUN = 5; // so viele Abstände in Folge unter der Untergrenze
const TEMPO_RUN_STRONG = 10;

const BURST_GAP = MIN; // längere Pause = neue Serie
const RHYTHM_MIN = 12; // Takt: Serie mit mindestens so vielen Aktionen
const RHYTHM_MIN_STRONG = 20;
const RHYTHM_MAX_MEDIAN = 10 * SEC; // nur schnelle Serien – langsame Abstände dürfen gleichmäßig sein
// Streuung = mittlere Abweichung vom Median-Abstand (MAD) im Verhältnis zum Median. Menschen liegen auch bei
// konzentriertem Durchklicken bei 8 % und mehr; ein Skript mit fester Pause kommt nur auf das Netz-Rauschen.
const RHYTHM_SPREAD = 0.03;
const RHYTHM_SPREAD_STRONG = 0.015;

const IHK_MIN_RUNS = 8; // so viele abgeholte Quests braucht es für eine Aussage
const IHK_REACT_MS = 5 * SEC; // Median: abgeholt so kurz nach Ablauf …
const IHK_RESTART_MS = 15 * SEC; // … und die nächste Quest so kurz danach gestartet
const IHK_NIGHT = [0, 6]; // Uhrzeiten (deutsche Zeit), zu denen kaum jemand zuschaut
const IHK_NIGHT_STRONG = 3;

const SCALP_HOLD_MS = 5 * MIN; // Kauf und Verkauf desselben Werts innerhalb dieser Zeit = eine Runde
const SCALP_MIN_ROUNDS = 8;
const SCALP_WIN_RATE = 0.75; // bei einem Zufallskurs wäre etwa die Hälfte der Runden im Plus
const SCALP_STRONG_ROUNDS = 15;
const SCALP_STRONG_WIN_RATE = 0.9;

const VALUE_MIN_CENTS = 5000; // Wertverschiebung erst ab einem Kartenwert von 50 €
const VALUE_SHARE = 0.2; // die andere Seite ist weniger als 20 % davon wert
const VALUE_STRONG_CENTS = 50000; // ab 500 € insgesamt verschoben
const VALUE_STRONG_COUNT = 3; // oder ab so vielen Geschäften zwischen denselben Konten

const DUNGEON_MIN_RUNS = 6; // so viele Durchläufe braucht es für eine Aussage
const DUNGEON_JOIN_MS = MIN; // Median: angemeldet so kurz, nachdem die Anmeldung für den Termin aufging
const DUNGEON_STREAK_MS = 20 * HOUR; // an jedem Termin dabei, ohne Lücke über so lange (auch nachts)
const DUNGEON_UNSEEN_SHARE = 0.8; // Beute so oft nie angeschaut (die Seite meldet das beim Ansehen)
const DUNGEON_NIGHT = 2; // so viele Termine zwischen 0 und 6 Uhr machen schnelles Anmelden wahrscheinlich

const GRADING_MIN_JOBS = 6;
const GRADING_EXCESS_MS = 4 * SEC; // Median: fertig gemeldet so kurz nach der Mindestzeit (Putzen, Drehen, Benoten dauern)
const GRADING_EXCESS_STRONG_MS = 1500;
const GRADING_PERFECT_SHARE = 0.9; // und dabei fast immer perfekt geputzt und versiegelt

const AWAKE_GAP_MS = 3 * HOUR; // längere Pause = geschlafen
const AWAKE_MS = 20 * HOUR; // so lange ohne solche Pause aktiv …
const AWAKE_STRONG_MS = 30 * HOUR;
const AWAKE_NIGHT_HOURS = 3; // … und dabei in mindestens so vielen Nachtstunden (0–6 Uhr)

const BROWSER_MIN = 10; // so viele Aktionen ohne Fingerabdruck und ohne Browser-Kopfzeilen
const BROWSER_SHARE = 0.5; // und mindestens dieser Anteil aller Spiel-Aktionen
const BROWSER_NOPROBE_MIN = 20; // nur ohne Fingerabdruck (die Seite lief ohne JavaScript): schwächer

const INCOME_MIN_PLAYERS = 8; // Vergleich erst ab so vielen Spielern mit Einnahmen
const INCOME_FACTOR = 5; // Einnahmen mindestens das Fünffache des Medians …
const INCOME_MIN_CENTS = 10000; // … und mindestens 100 €
const INCOME_SOURCES = { ihk_lohn: 'IHK', dungeon_lohn: 'Dungeon', grading_lohn: 'Grading', tcg_verkauf: 'Bank-Verkäufe', item_verkauf: 'Bank-Verkäufe' };

const KIND_LABEL = {
  tempo: 'Tempo',
  takt: 'Takt',
  ihk: 'IHK sekundengenau',
  scalping: 'Broker-Scalping',
  wert: 'Wertverschiebung',
  dungeon: 'Dungeon-Automatik',
  grading: 'Grading zur Mindestzeit',
  dauer: 'Rund um die Uhr',
  browser: 'Kein normaler Browser',
  ertrag: 'Ungewöhnliche Einnahmen',
};

// ---------- Hilfen ----------

const toMs = (t) => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : new Date(t).getTime());
const sortedMs = (times) => times.map(toMs).filter(Number.isFinite).sort((a, b) => a - b);

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Abstände zwischen aufeinanderfolgenden Zeitpunkten in ms */
function gaps(times) {
  const ms = sortedMs(times);
  return ms.slice(1).map((t, i) => t - ms[i]);
}

/** Zeitpunkte in Serien teilen: eine Pause länger als maxGap beginnt eine neue Serie */
function bursts(times, maxGap = BURST_GAP) {
  const out = [];
  let cur = [];
  for (const t of sortedMs(times)) {
    if (cur.length && t - cur[cur.length - 1] > maxGap) {
      out.push(cur);
      cur = [];
    }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

const hoursText = (ms) => `${Math.round(ms / HOUR)} Std.`;
const seconds = (ms) => `${(ms / 1000).toLocaleString('de-DE', { maximumFractionDigits: ms < 10 * SEC ? 1 : 0 })} s`;
const percent = (x) => `${Math.round(x * 100)} %`;

/** Stunde (0–23) eines Zeitpunkts in der Zeitzone */
function hourIn(t, timeZone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(toMs(t))));
}

// ---------- Tempo und Takt ----------

/** Mehrere auffällige Folgen: die stärkste beschreiben, Zeitraum von der ersten bis zur letzten (neue Belege) */
function spanOf(hits, best) {
  return { runs: hits.length, from: new Date(Math.min(...hits.map((h) => h.from))), to: new Date(Math.max(...hits.map((h) => h.to))), more: hits.length > 1 ? ` (${hits.length}× in diesem Zeitraum)` : '', best };
}

/**
 * Tempo: mindestens TEMPO_RUN Abstände in Folge unter floorMs. Beschreibt die längste solche Folge, der Zeitraum
 * reicht bis zur letzten. null, wenn es keine gibt. { level, count, medianMs, runs, from, to, summary }
 */
function tempoFinding(times, action) {
  const a = ACTIONS[action];
  const ms = sortedMs(times);
  const hits = [];
  let start = 0;
  for (let i = 1; i <= ms.length; i++) {
    const fast = i < ms.length && ms[i] - ms[i - 1] < a.floorMs;
    if (fast) continue;
    const run = i - 1 - start; // Abstände in Folge unter der Untergrenze
    if (run >= TEMPO_RUN) hits.push({ run, from: ms[start], to: ms[i - 1] });
    start = i;
  }
  if (!hits.length) return null;
  const { best, ...span } = spanOf(hits, hits.reduce((x, y) => (y.run > x.run ? y : x)));
  const count = best.run + 1;
  const medianMs = median(gaps(ms.filter((t) => t >= best.from && t <= best.to)));
  return {
    level: best.run >= TEMPO_RUN_STRONG ? LEVEL.wahrscheinlich : LEVEL.moeglich,
    count,
    medianMs,
    runs: span.runs,
    from: span.from,
    to: span.to,
    summary: `${count} ${a.label} in Folge, je ${seconds(medianMs)} Abstand (schneller als ${seconds(a.floorMs)} ist kaum von Hand möglich)${span.more}`,
  };
}

/**
 * Takt: schnelle Serien mit auffällig gleichmäßigen Abständen. Beschreibt die gleichmäßigste, der Zeitraum reicht
 * bis zur letzten. null, wenn es keine gibt. { level, count, medianMs, spread, runs, from, to, summary }
 */
function rhythmFinding(times, action) {
  const a = ACTIONS[action];
  const hits = [];
  for (const b of bursts(times)) {
    if (b.length < RHYTHM_MIN) continue;
    const g = gaps(b);
    const med = median(g);
    if (!med || med > RHYTHM_MAX_MEDIAN) continue;
    const spread = median(g.map((x) => Math.abs(x - med))) / med;
    if (spread < RHYTHM_SPREAD) hits.push({ count: b.length, medianMs: med, spread, from: b[0], to: b[b.length - 1] });
  }
  if (!hits.length) return null;
  const { best, ...span } = spanOf(hits, hits.reduce((x, y) => (y.spread < x.spread ? y : x)));
  const strong = best.count >= RHYTHM_MIN_STRONG && best.spread < RHYTHM_SPREAD_STRONG;
  return {
    level: strong ? LEVEL.wahrscheinlich : LEVEL.moeglich,
    count: best.count,
    medianMs: best.medianMs,
    spread: best.spread,
    runs: span.runs,
    from: span.from,
    to: span.to,
    summary: `${best.count} ${a.label} im Takt von ${seconds(best.medianMs)}, Abweichung ${best.spread < 0.01 ? 'unter 1 %' : `nur ${percent(best.spread)}`} (von Hand meist 8 % und mehr)${span.more}`,
  };
}

// ---------- IHK ----------

/**
 * IHK sekundengenau: Quests werden fast immer direkt bei Ablauf abgeholt und gleich die nächste gestartet.
 * runs: [{ createdAt, endsAt, collectedAt }] eines Mitglieds (nur abgeholte). null, wenn unauffällig.
 */
function ihkFinding(runs, timeZone) {
  const list = runs.filter((r) => r.collectedAt && r.endsAt).sort((x, y) => toMs(x.createdAt) - toMs(y.createdAt));
  if (list.length < IHK_MIN_RUNS) return null;
  const react = list.map((r) => Math.max(0, toMs(r.collectedAt) - toMs(r.endsAt)));
  const restart = [];
  for (let i = 1; i < list.length; i++) {
    const gap = toMs(list[i].createdAt) - toMs(list[i - 1].collectedAt);
    if (gap >= 0) restart.push(gap);
  }
  const reactMs = median(react);
  const restartMs = median(restart);
  if (reactMs > IHK_REACT_MS || restartMs === null || restartMs > IHK_RESTART_MS) return null;
  // neue Belege nur durch sekundengenaue Abholungen – eine normale Abholung danach öffnet einen erledigten Hinweis nicht
  const exact = list.filter((r, i) => react[i] <= IHK_REACT_MS);
  const night = list.filter((r) => {
    const h = hourIn(r.collectedAt, timeZone);
    return h >= IHK_NIGHT[0] && h < IHK_NIGHT[1];
  }).length;
  return {
    level: night >= IHK_NIGHT_STRONG ? LEVEL.wahrscheinlich : LEVEL.moeglich,
    count: list.length,
    reactMs,
    restartMs,
    night,
    from: new Date(toMs(list[0].createdAt)),
    to: new Date(toMs(exact[exact.length - 1].collectedAt)),
    summary:
      `${list.length} Quests im Schnitt ${seconds(reactMs)} nach Ablauf abgeholt und ${seconds(restartMs)} später die nächste gestartet` +
      (night ? `, ${night}× zwischen ${IHK_NIGHT[0]} und ${IHK_NIGHT[1]} Uhr` : ''),
  };
}

// ---------- Broker ----------

/**
 * Scalping: viele schnelle Kauf-Verkauf-Runden mit auffällig hoher Trefferquote.
 * trades: [{ coin, side: 'kauf'|'verkauf', units, cents, createdAt }] eines Mitglieds. null, wenn unauffällig.
 * Ein Verkauf verbraucht die Käufe in ihrer Reihenfolge (FIFO), auch über mehrere Käufe oder nur einen Teil davon;
 * Gewinn = Erlös minus anteiliger Einstand, Haltedauer ab dem ältesten verbrauchten Kauf. Verkäufe von Einheiten,
 * die vor dem Zeitraum gekauft wurden (oder nach einem Split), zählen nicht – ihr Einstand ist unbekannt.
 */
function scalpFinding(trades) {
  const list = [...trades].sort((x, y) => toMs(x.createdAt) - toMs(y.createdAt));
  const lots = new Map(); // Wert -> offene Käufe [{ units, cents, at }], älteste zuerst
  const rounds = [];
  for (const t of list) {
    const units = t.units || 0;
    if (!(units > 0)) continue;
    const at = toMs(t.createdAt);
    if (!lots.has(t.coin)) lots.set(t.coin, []);
    const queue = lots.get(t.coin);
    if (t.side === 'kauf') {
      queue.push({ units, cents: t.cents, at });
      continue;
    }
    let left = units;
    let cost = 0;
    let first = null;
    while (left > 0 && queue.length) {
      const lot = queue[0];
      const used = Math.min(left, lot.units);
      const part = (lot.cents * used) / lot.units;
      cost += part;
      lot.cents -= part;
      lot.units -= used;
      left -= used;
      if (first === null) first = lot.at;
      if (lot.units <= 0) queue.shift();
    }
    if (left > 0 || first === null) continue;
    const hold = at - first;
    if (hold <= SCALP_HOLD_MS) rounds.push({ hold, gain: t.cents - Math.round(cost), at });
  }
  if (rounds.length < SCALP_MIN_ROUNDS) return null;
  const wins = rounds.filter((r) => r.gain > 0).length;
  const rate = wins / rounds.length;
  if (rate < SCALP_WIN_RATE) return null;
  const gain = rounds.reduce((s, r) => s + r.gain, 0);
  const holdMs = median(rounds.map((r) => r.hold));
  const strong = rounds.length >= SCALP_STRONG_ROUNDS && rate >= SCALP_STRONG_WIN_RATE;
  return {
    level: strong ? LEVEL.wahrscheinlich : LEVEL.moeglich,
    count: rounds.length,
    wins,
    rate,
    gain,
    holdMs,
    from: new Date(rounds[0].at),
    // neue Belege nur durch Runden im Plus – eine normale Runde danach öffnet einen erledigten Hinweis nicht
    to: new Date(rounds.filter((r) => r.gain > 0).pop().at),
    summary: `${rounds.length} Kauf-Verkauf-Runden mit je ${seconds(holdMs)} Haltedauer, ${wins} davon im Plus (${percent(rate)}, Zufall wäre etwa 50 %), zusammen ${euro(gain)}`,
  };
}

// ---------- Wertverschiebung ----------

/**
 * Ein abgeschlossenes Geschäft mit sehr ungleichem Wert. valueOf(cardId) = Bankwert in Cent.
 * trade: { seller, buyer, to, give, want, price, extraFrom } wie im Trade-Modell: der Anbieter gibt give, die
 * Gegenseite (buyer bzw. to) gibt want, das Geld zahlt extraFrom (ohne Angabe die Gegenseite, siehe trade/lines.js).
 * Liefert { from, to, given, received, shifted } (from gibt viel und bekommt wenig) oder null.
 */
function valueFinding(trade, valueOf) {
  const other = trade.buyer || trade.to;
  if (!other) return null;
  const sum = (lines) => (lines || []).reduce((s, l) => s + (valueOf(l.card) || 0), 0);
  const sellerPays = trade.extraFrom === 'seller';
  const a = sum(trade.give) + (sellerPays ? trade.price || 0 : 0); // Anbieter-Seite
  const b = sum(trade.want) + (sellerPays ? 0 : trade.price || 0); // Gegenseite
  const big = Math.max(a, b);
  const small = Math.min(a, b);
  if (big < VALUE_MIN_CENTS || small >= big * VALUE_SHARE) return null;
  const [from, to] = a > b ? [trade.seller, other] : [other, trade.seller];
  return { from, to, given: big, received: small, shifted: big - small };
}

/**
 * Funde zwischen denselben zwei Konten zusammenfassen. items: [{ from, to, shifted, given, received, at, text }],
 * names: Map userId -> Name, flagged: auch als Mehrfach-Konto erkannt.
 */
function valuePairFinding(items, names, flagged = false) {
  const total = items.reduce((s, i) => s + i.shifted, 0);
  const gain = new Map(); // wer wie viel bekommen hat
  for (const i of items) gain.set(String(i.to), (gain.get(String(i.to)) || 0) + i.shifted);
  const [winner] = [...gain].sort((x, y) => y[1] - x[1])[0];
  const strong = flagged || total >= VALUE_STRONG_CENTS || items.length >= VALUE_STRONG_COUNT;
  const sorted = [...items].sort((x, y) => toMs(x.at) - toMs(y.at));
  return {
    level: strong ? LEVEL.wahrscheinlich : LEVEL.moeglich,
    count: items.length,
    total,
    winner,
    from: new Date(toMs(sorted[0].at)),
    to: new Date(toMs(sorted[sorted.length - 1].at)),
    summary:
      `${items.length === 1 ? 'Ein Geschäft' : `${items.length} Geschäfte`} mit sehr ungleichem Wert, zusammen ${euro(total)} zugunsten von ${names.get(winner) || 'unbekannt'}` +
      (flagged ? ' – die Konten sind auch als Mehrfach-Konto erkannt' : ''),
    trades: sorted.slice(-5).map((i) => i.text),
  };
}

// ---------- Dungeon ----------

/**
 * Dungeon-Automatik: an jedem Termin dabei (auch nachts), immer sofort angemeldet, wenn die Anmeldung aufgeht, oder
 * die Beute nie angeschaut. runs: [{ slot, joinedAt, seen, finished }] eines Mitglieds; intervalMs = Abstand der
 * Termine, lockMs = so lange vor dem Start schließt die Anmeldung (danach gilt sie für den nächsten Termin).
 */
function dungeonFinding(runs, { intervalMs, lockMs = 0, timeZone }) {
  const list = runs.filter((r) => r.slot).sort((x, y) => toMs(x.slot) - toMs(y.slot));
  if (list.length < DUNGEON_MIN_RUNS) return null;
  const slotMs = list.map((r) => toMs(r.slot));

  // Anmelde-Verzögerung: Zeit zwischen Öffnen der Anmeldung und Anmeldung
  const joined = list.filter((r) => r.joinedAt).map((r) => ({ at: toMs(r.slot), delay: Math.max(0, toMs(r.joinedAt) - (toMs(r.slot) - intervalMs - lockMs)) }));
  const joinMs = joined.length >= DUNGEON_MIN_RUNS ? median(joined.map((j) => j.delay)) : null;
  const joinHit = joinMs !== null && joinMs <= DUNGEON_JOIN_MS;

  // längste Serie aufeinanderfolgender Termine ohne Lücke
  let best = { from: slotMs[0], to: slotMs[0], count: 1 };
  let cur = { ...best };
  for (let i = 1; i < slotMs.length; i++) {
    if (Math.abs(slotMs[i] - slotMs[i - 1] - intervalMs) < MIN) cur = { ...cur, to: slotMs[i], count: cur.count + 1 };
    else cur = { from: slotMs[i], to: slotMs[i], count: 1 };
    if (cur.count > best.count) best = { ...cur };
  }
  const streakHit = best.to - best.from >= DUNGEON_STREAK_MS;

  const finished = list.filter((r) => r.finished);
  const unseen = finished.filter((r) => !r.seen);
  const unseenHit = finished.length >= DUNGEON_MIN_RUNS && unseen.length / finished.length >= DUNGEON_UNSEEN_SHARE;
  if (!joinHit && !streakHit && !unseenHit) return null;

  const night = slotMs.filter((t) => {
    const h = hourIn(t, timeZone);
    return h >= IHK_NIGHT[0] && h < IHK_NIGHT[1];
  }).length;
  const strong = streakHit || (joinHit && (night >= DUNGEON_NIGHT || unseenHit));
  const parts = [];
  if (streakHit) parts.push(`${best.count} Termine in Folge ohne Lücke (${hoursText(best.to - best.from)})`);
  if (joinHit) parts.push(`im Schnitt ${seconds(joinMs)} nach Öffnen der Anmeldung angemeldet`);
  if (unseenHit) parts.push(`Beute ${unseen.length} von ${finished.length} Mal nie angeschaut`);
  const ends = [];
  if (streakHit) ends.push(best.to);
  if (joinHit) ends.push(Math.max(...joined.filter((j) => j.delay <= DUNGEON_JOIN_MS).map((j) => j.at)));
  if (unseenHit) ends.push(toMs(unseen[unseen.length - 1].slot));
  return {
    level: strong ? LEVEL.wahrscheinlich : LEVEL.moeglich,
    count: list.length,
    joinMs,
    streak: best.count,
    night,
    unseen: unseen.length,
    from: new Date(slotMs[0]),
    to: new Date(Math.max(...ends)),
    summary: `${list.length} Dungeons: ${parts.join(', ')}` + (night ? `, ${night}× zwischen ${IHK_NIGHT[0]} und ${IHK_NIGHT[1]} Uhr` : ''),
  };
}

// ---------- Grading ----------

/**
 * Grading zur Mindestzeit: Aufträge werden fast genau dann fertig gemeldet, wenn der Server es frühestens erlaubt
 * (Flecken × msPerSpot × Sauberkeit). Von Hand dauern Putzen, Drehen, Benoten und Versiegeln deutlich länger.
 * jobs: [{ createdAt, doneAt, clean, seal, spots }] eines Mitglieds (nur fertige; spots = Zahl der Flecken).
 */
function gradingFinding(jobs, msPerSpot) {
  const list = jobs
    .filter((j) => j.doneAt && j.createdAt)
    .map((j) => ({ at: toMs(j.doneAt), excess: toMs(j.doneAt) - toMs(j.createdAt) - ((j.spots || 0) * msPerSpot * (j.clean || 0)) / 100, perfect: j.clean >= 100 && (j.seal == null || j.seal >= 99) }))
    .sort((x, y) => x.at - y.at);
  if (list.length < GRADING_MIN_JOBS) return null;
  const excessMs = median(list.map((j) => j.excess));
  if (excessMs > GRADING_EXCESS_MS) return null;
  const perfect = list.filter((j) => j.perfect).length;
  const strong = excessMs <= GRADING_EXCESS_STRONG_MS || perfect / list.length >= GRADING_PERFECT_SHARE;
  const fast = list.filter((j) => j.excess <= GRADING_EXCESS_MS);
  return {
    level: strong ? LEVEL.wahrscheinlich : LEVEL.moeglich,
    count: list.length,
    excessMs,
    perfect,
    from: new Date(list[0].at),
    to: new Date(fast[fast.length - 1].at),
    summary: `${list.length} Aufträge im Schnitt nur ${seconds(Math.max(0, excessMs))} nach der frühestmöglichen Zeit fertig gemeldet, ${perfect} davon perfekt`,
  };
}

// ---------- Rund um die Uhr ----------

/**
 * Rund um die Uhr: über viele Stunden ohne längere Pause aktiv, auch nachts – ein Mensch schläft irgendwann.
 * times: Zeitpunkte aller Aktionen eines Mitglieds. null, wenn unauffällig.
 */
function activityFinding(times, timeZone) {
  let best = null;
  for (const b of bursts(times, AWAKE_GAP_MS)) {
    const span = b[b.length - 1] - b[0];
    if (!best || span > best.span) best = { span, list: b };
  }
  if (!best || best.span < AWAKE_MS) return null;
  // verschiedene Nachtstunden (Stunde + Tag), in denen etwas passiert ist
  const nightHours = new Set(
    best.list
      .filter((t) => {
        const h = hourIn(t, timeZone);
        return h >= IHK_NIGHT[0] && h < IHK_NIGHT[1];
      })
      .map((t) => Math.floor(t / HOUR))
  ).size;
  if (nightHours < AWAKE_NIGHT_HOURS) return null;
  return {
    level: best.span >= AWAKE_STRONG_MS ? LEVEL.wahrscheinlich : LEVEL.moeglich,
    count: best.list.length,
    spanMs: best.span,
    nightHours,
    from: new Date(best.list[0]),
    to: new Date(best.list[best.list.length - 1]),
    summary: `${best.list.length} Aktionen über ${hoursText(best.span)} ohne Pause von mehr als ${hoursText(AWAKE_GAP_MS)}, davon in ${nightHours} Nachtstunden (${IHK_NIGHT[0]}–${IHK_NIGHT[1]} Uhr)`,
  };
}

// ---------- Kein normaler Browser ----------

/**
 * Spiel-Aktionen, die nicht aus einem normalen Browser kommen (models/ScriptSignal, je Tag). signals: [{ actions,
 * noProbe, noFetchMeta, bare, webdriver, botUa, uas, firstAt, lastAt }] eines Mitglieds. null, wenn unauffällig.
 */
function browserFinding(signals) {
  const sum = (k) => signals.reduce((s, x) => s + (x[k] || 0), 0);
  const actions = sum('actions');
  const [bare, noProbe, webdriver, botUa] = ['bare', 'noProbe', 'webdriver', 'botUa'].map(sum);
  const bareHit = bare >= BROWSER_MIN && bare / actions >= BROWSER_SHARE;
  const probeHit = noProbe >= BROWSER_NOPROBE_MIN && noProbe / actions >= BROWSER_SHARE;
  if (!webdriver && !botUa && !bareHit && !probeHit) return null;
  const parts = [];
  if (webdriver) parts.push(`${webdriver}× aus einem ferngesteuerten Browser`);
  if (botUa) parts.push(`${botUa}× mit dem User-Agent eines Skript-Werkzeugs`);
  if (bareHit) parts.push(`${bare}× ohne Fingerabdruck und ohne Browser-Kopfzeilen`);
  else if (probeHit) parts.push(`${noProbe}× ohne Fingerabdruck (Seite lief ohne JavaScript)`);
  const uas = [...new Set(signals.flatMap((x) => x.uas || []))].slice(0, 3);
  return {
    level: webdriver || botUa || bareHit ? LEVEL.wahrscheinlich : LEVEL.moeglich,
    count: actions,
    uas,
    from: new Date(Math.min(...signals.map((x) => toMs(x.firstAt || x.lastAt)))),
    to: new Date(Math.max(...signals.map((x) => toMs(x.lastAt)))),
    summary: `Von ${actions} Spiel-Aktionen: ${parts.join(', ')}` + (uas.length ? ` – ${uas.join(' | ')}` : ''),
  };
}

// ---------- Ungewöhnliche Einnahmen ----------

/**
 * Einnahmen aus IHK, Dungeon, Grading und Bank-Verkäufen weit über dem üblichen Maß. entries: [{ user, type, amount,
 * createdAt }] (Kontobuchungen, nur Einnahmen) oder zusammengefasst [{ user, type, amount, from, to }]. Liefert [{ user, level, total, factor, bySource, from, to, summary }].
 * Nur ein Hinweis (möglich): Fleißige Spieler verdienen auch viel – zusammen mit anderen Mustern aussagekräftig.
 */
function incomeFindings(entries) {
  const byUser = new Map();
  for (const e of entries) {
    const label = INCOME_SOURCES[e.type];
    if (!label || !(e.amount > 0)) continue;
    const k = String(e.user);
    const u = byUser.get(k) || { total: 0, bySource: {}, from: Infinity, to: 0 };
    u.total += e.amount;
    u.bySource[label] = (u.bySource[label] || 0) + e.amount;
    u.from = Math.min(u.from, toMs(e.from || e.createdAt));
    u.to = Math.max(u.to, toMs(e.to || e.createdAt));
    byUser.set(k, u);
  }
  if (byUser.size < INCOME_MIN_PLAYERS) return [];
  const med = median([...byUser.values()].map((u) => u.total));
  const out = [];
  for (const [user, u] of byUser) {
    if (u.total < INCOME_MIN_CENTS || u.total < med * INCOME_FACTOR) continue;
    const factor = u.total / med;
    const sources = Object.entries(u.bySource)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k} ${euro(v)}`)
      .join(', ');
    out.push({
      user,
      level: LEVEL.moeglich,
      total: u.total,
      factor,
      from: new Date(u.from),
      to: new Date(u.to),
      summary: `${euro(u.total)} eingenommen, das ${Math.round(factor)}-Fache des Üblichen (${euro(med)}): ${sources}`,
    });
  }
  return out;
}

module.exports = {
  ACTIONS,
  KIND_LABEL,
  TEMPO_RUN,
  RHYTHM_MIN,
  RHYTHM_SPREAD,
  IHK_MIN_RUNS,
  SCALP_MIN_ROUNDS,
  VALUE_MIN_CENTS,
  INCOME_SOURCES,
  median,
  gaps,
  bursts,
  hourIn,
  tempoFinding,
  rhythmFinding,
  ihkFinding,
  scalpFinding,
  valueFinding,
  valuePairFinding,
  dungeonFinding,
  gradingFinding,
  activityFinding,
  browserFinding,
  incomeFindings,
};

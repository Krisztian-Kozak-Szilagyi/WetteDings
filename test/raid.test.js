process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const R = require('../public/js/bossfight-regeln');
const logic = require('../src/raid/logic');
const catalog = require('../src/tcg/catalog');

const opts = JSON.parse(JSON.stringify(logic.DEFAULTS));
const ids = catalog.CARDS.filter((c) => c.isCharacter && ['gold', 'holo'].includes(c.rarity)).slice(0, 15).flatMap((c) => [c.id, c.id]);
const snap = () => ({ spieler: logic.spielerDef(opts), boss: logic.bossDef(opts), karten: logic.deckCards(ids, opts) });

test('Raid: Standardwerte sind gültig und vollständig einstellbar', () => {
  assert.deepEqual(logic.cleanSettings(opts), opts);
  assert.equal(opts.open, false);
  assert.equal(opts.boss.hp, 285);
  assert.equal(opts.spieler.hp, 200);
  assert.equal(opts.angriffe.length, logic.ATTACKS.length);
  assert.ok(opts.angriffe.some((a) => a.muenze));
  assert.throws(() => logic.cleanSettings({ ...opts, boss: { ...opts.boss, hp: 0 } }), /Boss hp/);
  assert.throws(() => logic.cleanSettings({ ...opts, angriffe: opts.angriffe.map((a) => ({ ...a, gewicht: 0 })) }), /Gewicht/);
  assert.throws(() => logic.cleanSettings({ ...opts, angriffe: opts.angriffe.map((a, i) => (i ? a : { ...a, min: 50, max: 10 })) }), /min größer als max/);
  // gespeicherte Teilwerte: der Rest bleibt beim Standard, ungültige Speicherstände fallen ganz auf den Standard zurück
  const merged = logic.mergeSettings({ boss: { hp: 500 }, angriffe: [{ key: 'allin', name: 'Alles auf Rot', min: 40, max: 50 }] });
  assert.equal(merged.boss.hp, 500);
  assert.equal(merged.boss.kopfChance, 50);
  assert.equal(merged.angriffe.find((a) => a.key === 'allin').name, 'Alles auf Rot');
  assert.deepEqual(logic.mergeSettings({ boss: { hp: -5 } }), logic.DEFAULTS);
});

test('Raid: Kampfwerte aus den IHK-Werten – Rolle nach dem stärksten Wert', () => {
  const krisz = logic.kampfFor(catalog.cardById['krisz-6-glitch'], opts); // FIA 99
  const ivan = logic.kampfFor(catalog.cardById['st-ivan-boss'], opts); // FIS 99
  const luca = logic.kampfFor(catalog.cardById['luca-6-glitch'], opts); // BWL 97
  assert.equal(krisz.rolle, 'Angreifer');
  assert.equal(ivan.rolle, 'Verteidiger');
  assert.equal(luca.rolle, 'Heiler');
  assert.ok(krisz.ang > krisz.sch * 3, 'Angreifer: Hauptwert zählt voll, Nebenwerte schwach');
  assert.ok(ivan.sch > ivan.ang * 3);
  assert.equal(krisz.kosten, opts.karten.kosten.glitch);
  // Items ohne Kampfwerte spielen nicht mit, Test-Karten behalten ihre eigenen
  assert.equal(logic.kampfFor(catalog.cardById['casino-kaffee-6-glitch'], opts), null);
  const test1 = catalog.TEST_CARDS.find((c) => c.kampf);
  assert.equal(logic.kampfFor(test1, opts), test1.kampf);
  // Kosten nach Seltenheit: die günstige Crumpled-Karte ist schwächer, aber nicht viel (1 Karte je Zug)
  const crumpled = logic.kampfFor(catalog.cardById['krisz-1-crumpled'], opts);
  assert.ok(crumpled.kosten < krisz.kosten && crumpled.ang < krisz.ang);
  assert.ok(crumpled.ang > krisz.ang * 0.4, 'flache Kurve: auch günstige Karten zählen');
});

test('Raid: Münzwurf-Angriff – Kopf trifft doppelt, Zahl gibt Dio einen Glücks-Token', () => {
  // nur der Münzwurf-Angriff, ohne Krit-Lotterie (die prüft der nächste Test)
  const boss = { ...logic.bossDef(opts), lotterie: null, angriffe: [{ key: 'lotterie', name: 'Krit-Lotterie', schaden: [20, 20], gewicht: 1, muenze: true }] };
  // Zufall fest: erst Kopf (0.1 < 0.5), dann Zahl (0.9)
  const play = (coin) => {
    let n = 0;
    const rng = () => {
      n++;
      return n === 100 ? coin : 0.42; // der Münzwurf ist der erste Wurf nach dem Start (s. unten)
    };
    const { s } = R.neu(logic.deckCards(ids, opts), { rng, spieler: logic.spielerDef(opts), boss });
    n = 99;
    const hpBefore = s.spieler.hp;
    const ev = R.rundeEnde(s);
    return { s, ev, lost: hpBefore - s.spieler.hp };
  };
  const kopf = play(0.1);
  assert.ok(kopf.ev.some((e) => e.t === 'muenze' && e.seite === 'kopf'));
  assert.equal(kopf.lost, 40, 'Kopf: 20 × 2');
  assert.equal(kopf.s.boss.tokens, 0);
  const zahl = play(0.9);
  assert.ok(zahl.ev.some((e) => e.t === 'muenze' && e.seite === 'zahl' && e.tokens === 1));
  assert.equal(zahl.lost, 20);
  assert.equal(zahl.s.boss.tokens, 1);
});

test('Raid: Dios Krit-Lotterie – Krit nach Chance, danach Münzwurf mit Zusatztreffer; Zahl gibt Krit-Chance', () => {
  const boss = { ...logic.bossDef(opts), angriffe: [{ key: 'dolch', name: 'Dolchstich', schaden: [20, 20], gewicht: 1 }], lotterie: { kopfChance: 0.5, kritFaktor: 2, grundKrit: 0.1, tokenKrit: 0.01, zusatz: [5, 5] } };
  // Zufall der Reihe nach: Krit-Wurf, Münze, Zusatztreffer-Schaden
  const fight = (krit, muenze) => {
    const { s } = R.neu(logic.deckCards(ids, opts), { rng: () => 0.5, spieler: logic.spielerDef(opts), boss });
    const queue = [krit, muenze, 0.5];
    s.rng = () => (queue.length ? queue.shift() : 0.5);
    const hp = s.spieler.hp;
    const ev = R.rundeEnde(s);
    return { s, ev, lost: hp - s.spieler.hp };
  };
  const normalZahl = fight(0.9, 0.9); // kein Krit, Zahl
  assert.equal(normalZahl.lost, 20 + 5);
  assert.equal(normalZahl.s.boss.tokens, 1);
  assert.ok(normalZahl.ev.some((e) => e.t === 'zusatz' && e.seite === 'zahl' && e.waffe === 'Dolch'));
  const kritKopf = fight(0.05, 0.1); // Krit, Kopf
  assert.equal(kritKopf.lost, 40 + 10, 'Krit ×2 und kritischer Armbrust-Zusatztreffer ×2');
  assert.equal(kritKopf.s.boss.tokens, 0);
  // Block fängt erst den Angriff, der Rest auch den Zusatztreffer
  const { s } = R.neu(logic.deckCards(ids, opts), { rng: () => 0.5, spieler: logic.spielerDef(opts), boss });
  s.effekte.push({ art: 'block', key: 'block:x', card: null, name: 'Block', wert: 22, runden: 1, max: 1 });
  const queue = [0.9, 0.9, 0.5];
  s.rng = () => (queue.length ? queue.shift() : 0.5);
  const hp = s.spieler.hp;
  R.rundeEnde(s);
  assert.equal(hp - s.spieler.hp, 3, '20 geblockt, vom Zusatztreffer (5) bleiben 2 Block übrig');
  // Tokens erhöhen die Krit-Chance: mit 5 Tokens krittet ein Wurf von 0,12 (10 % + 5 %)
  const t = R.neu(logic.deckCards(ids, opts), { rng: () => 0.5, spieler: logic.spielerDef(opts), boss }).s;
  t.boss.tokens = 5;
  const q2 = [0.12, 0.9, 0.5];
  t.rng = () => (q2.length ? q2.shift() : 0.5);
  const hp2 = t.spieler.hp;
  R.rundeEnde(t);
  assert.equal(hp2 - t.spieler.hp, 40 + 5);
});

test('Raid: Kampf lässt sich aus Startwert und Zügen genau nachspielen', () => {
  const sn = snap();
  const a = logic.replay(1234, sn, []);
  const b = logic.replay(1234, sn, []);
  assert.deepEqual(a.s.hand.map((i) => i.card.id), b.s.hand.map((i) => i.card.id));
  // ein paar Züge spielen und mitschreiben
  const actions = [];
  const s = a.s;
  for (let r = 0; r < 6 && !s.vorbei; r++) {
    for (const inst of s.hand.slice()) {
      if (R.spielbar(s, inst.uid).ok) {
        const action = { a: 'spielen', uid: inst.uid };
        if (logic.accepted(logic.applyAction(s, action))) actions.push(action);
      }
    }
    actions.push({ a: 'ende' });
    logic.applyAction(s, { a: 'ende' });
  }
  const again = logic.replay(1234, sn, actions).s;
  assert.equal(again.boss.hp, s.boss.hp);
  assert.equal(again.spieler.hp, s.spieler.hp);
  assert.equal(again.runde, s.runde);
  // anderer Startwert, anderer Kampf
  assert.notDeepEqual(logic.replay(99, sn, []).s.deck.map((i) => i.card.id), logic.replay(1234, sn, []).s.deck.map((i) => i.card.id));
  // abgelehnte Züge (zu wenig Energie, unbekannt) zählen nicht
  assert.equal(logic.accepted(logic.applyAction(logic.replay(1, sn).s, { a: 'spielen', uid: 9999 })), false);
  assert.equal(logic.accepted(logic.applyAction(logic.replay(1, sn).s, { a: 'mogeln' })), false);
});

test('Raid: der Browser sieht weder Zufall noch die Reihenfolge des Nachziehstapels', () => {
  const { s } = logic.replay(42, snap(), []);
  const pub = logic.publicState(s);
  assert.equal(typeof pub.deck, 'number');
  assert.equal(pub.deck, s.deck.length);
  assert.equal(pub.rng, undefined);
  assert.equal(pub.bd.angriffe, undefined, 'Angriffs-Gewichte bleiben auf dem Server');
  assert.ok(pub.absicht && pub.hand.length);
  assert.doesNotThrow(() => JSON.stringify(pub));
});

test('Raid: Spielfeld – permanente Karten bleiben liegen, wirken jede Runde, Effektkarten gehen auf die Ablage', () => {
  const o = JSON.parse(JSON.stringify(opts));
  const permId = ids[0];
  o.karten.permanent = [permId];
  assert.deepEqual(logic.cleanSettings(o).karten.permanent, [permId]);
  assert.deepEqual(logic.cleanSettings({ ...o, karten: { ...o.karten, permanent: ['gibt-es-nicht', 'casino-kaffee-6-glitch'] } }).karten.permanent, [], 'nur Charakterkarten');
  assert.equal(logic.kampfFor(catalog.cardById[permId], o).dauer, 'permanent');
  assert.equal(logic.kampfFor(catalog.cardById[ids[2]], o).dauer, 'effekt');
  // Boss ohne Feld-Angriffe und ohne Krit-Lotterie, damit nur das Spielfeld zählt
  const boss = { ...logic.bossDef(o), lotterie: null, feldZiel: 0, angriffe: [{ key: 'dolch', name: 'Dolch', schaden: [10, 10], gewicht: 1 }] };
  const { s } = R.neu(logic.deckCards(ids, o), { rng: () => 0.3, spieler: { ...logic.spielerDef(o), energieStart: 10 }, boss });
  s.hand = [];
  const karte = (id) => ({ id, name: id, image: '', kampf: logic.kampfFor(catalog.cardById[id], o) });
  s.hand.push({ uid: 900, card: karte(permId), buffs: [] }, { uid: 901, card: karte(ids[2]), buffs: [] });
  const ev = R.spielen(s, 900);
  assert.ok(ev.some((e) => e.t === 'feld'));
  assert.equal(s.feld.length, 1);
  assert.equal(s.feld[0].hp, o.karten.leben);
  R.spielen(s, 901);
  assert.equal(s.feld.length, 1, 'Effektkarte bleibt nicht liegen');
  assert.equal(s.exil.length, 1);
  // nächste Runde: die permanente Karte wirkt erneut
  const hp = s.boss.hp;
  const runde = R.rundeEnde(s);
  assert.ok(runde.some((e) => e.t === 'feldwirkt' && e.uid === 900));
  const ang = s.feld[0].card.kampf.ang;
  if (ang) assert.equal(hp - s.boss.hp, ang);
  // kein Limit: beliebig viele permanente Karten, jede an ihrem Platz
  for (let i = 0; i < 8; i++) {
    s.hand.push({ uid: 910 + i, card: karte(permId), buffs: [] });
    s.energie = 10;
    R.spielen(s, 910 + i, undefined, { x: i * 12, y: 90 });
  }
  assert.equal(s.feld.length, 9);
  assert.deepEqual([s.feld[3].x, s.feld[3].y], [24, 90]);
  assert.deepEqual([s.feld[0].x, s.feld[0].y], [50, 50], 'ohne Platz: Mitte');
  s.feld.splice(1);
  // ein Effekt nimmt die Karte vom Feld
  const out = [];
  assert.ok(R.verlassen(s, 900, 'Rauchbombe', out));
  assert.equal(s.feld.length, 0);
  assert.equal(out[0].t, 'verlassen');
  assert.equal(R.verlassen(s, 900, 'x', []), null);
});

test('Raid: Dio greift Karten auf dem Spielfeld an und zerstört sie', () => {
  const o = JSON.parse(JSON.stringify(opts));
  o.karten.permanent = [ids[0]];
  o.karten.leben = 15;
  const boss = { ...logic.bossDef(o), lotterie: null, feldZiel: 1, angriffe: [{ key: 'dolch', name: 'Dolch', schaden: [10, 10], gewicht: 1 }] };
  const { s } = R.neu(logic.deckCards(ids, o), { rng: () => 0.3, spieler: { ...logic.spielerDef(o), energieStart: 10 }, boss });
  s.hand = [{ uid: 900, card: { id: ids[0], name: 'Wache', image: '', kampf: logic.kampfFor(catalog.cardById[ids[0]], o) }, buffs: [] }];
  R.spielen(s, 900);
  // die Ankündigung wurde vor dem Legen gewürfelt – neu ankündigen lassen (Ziel: die Karte)
  R.rundeEnde(s);
  assert.equal(s.absicht.ziel.uid, 900, 'feldZiel 100 % → die Karte ist das Ziel');
  assert.equal(R.angriffsZiel(s).uid, 900);
  const hpSpieler = s.spieler.hp;
  s.effekte = s.effekte.filter((e) => e.art !== 'block'); // eigener Block der Karte zählt hier nicht
  const ev = R.rundeEnde(s);
  assert.ok(ev.some((e) => e.t === 'feldschaden' && e.uid === 900));
  assert.equal(s.spieler.hp, hpSpieler, 'der Spieler bleibt verschont');
  // nach dem zweiten Treffer (15 Leben, 10 Schaden je Angriff) ist sie zerstört
  s.effekte = s.effekte.filter((e) => e.art !== 'block');
  const ev2 = R.rundeEnde(s);
  assert.ok(ev2.some((e) => e.t === 'verlassen' && e.grund === 'zerstoert'));
  assert.equal(s.feld.length, 0);
  assert.ok(s.exil.some((i) => i.uid === 900));
  assert.equal(s.absicht.ziel, null, 'leeres Feld → Dio zielt wieder auf den Spieler');
  // der Browser sieht das Spielfeld
  assert.ok(Array.isArray(logic.publicState(s).feld));
});

test('Raid: Platz auf dem Spielfeld – vorne wird öfter angegriffen, weit hinten trifft nur die Armbrust', () => {
  const o = JSON.parse(JSON.stringify(opts));
  o.karten.permanent = [ids[0]];
  const kampf = logic.kampfFor(catalog.cardById[ids[0]], o);
  const lege = (s, uid, y) => {
    s.hand.push({ uid, card: { id: ids[0], name: 'K' + uid, image: '', kampf }, buffs: [] });
    s.energie = 10;
    R.spielen(s, uid, undefined, { x: 50, y });
  };
  const neu = (angriffe) => {
    const boss = { ...logic.bossDef(o), lotterie: null, feldZiel: 1, angriffe };
    let n = 0;
    const { s } = R.neu(logic.deckCards(ids, o), { rng: () => ((n = (n * 9301 + 49297) % 233280) / 233280), spieler: logic.spielerDef(o), boss });
    s.hand = [];
    return s;
  };
  // Nahkampf (Dolch): Reichweite 50 % – die Karte ganz hinten ist nie Ziel, vorne öfter als in der Mitte
  const dolch = neu([{ key: 'dolch', name: 'Dolch', schaden: [10, 10], gewicht: 1 }]);
  lege(dolch, 801, 0);
  lege(dolch, 802, 50);
  lege(dolch, 803, 100);
  assert.deepEqual(R.erreichbar(dolch, false).map((f) => f.uid), [801, 802]);
  // viele Ankündigungen hintereinander: wie oft ist welche Karte (oder der Spieler) das Ziel?
  const zaehle = (s) => {
    const n = {};
    for (let i = 0; i < 3000; i++) {
      R.rundeEnde(s);
      s.feld.forEach((x) => { x.hp = x.max; });
      Object.assign(s.spieler, { hp: s.spieler.max });
      Object.assign(s.boss, { hp: s.boss.max });
      s.vorbei = null;
      const z = s.absicht.ziel;
      n[z ? z.uid : 'spieler'] = (n[z ? z.uid : 'spieler'] || 0) + 1;
    }
    return n;
  };
  const nd = zaehle(dolch);
  assert.equal(nd[803], undefined, 'Dolch erreicht hinten nichts');
  assert.ok(nd[801] > nd[802] * 1.3, `vorne öfter: ${JSON.stringify(nd)}`);
  // Armbrust (fern): erreicht auch die Karte ganz hinten
  const armbrust = neu([{ key: 'armbrust', name: 'Armbrust', schaden: [10, 10], gewicht: 1, fern: true }]);
  lege(armbrust, 801, 0);
  lege(armbrust, 803, 100);
  assert.equal(R.erreichbar(armbrust, true).length, 2);
  const na = zaehle(armbrust);
  assert.ok(na[803] > 0, 'Armbrust trifft auch hinten');
  assert.ok(na[801] > na[803] * 2, `vorneFaktor 4: ${JSON.stringify(na)}`);
  // nur Karten hinten und ein Nahkampf-Angriff → Dio greift den Spieler an
  const hinten = neu([{ key: 'dolch', name: 'Dolch', schaden: [10, 10], gewicht: 1 }]);
  lege(hinten, 803, 90);
  R.rundeEnde(hinten);
  assert.equal(hinten.absicht.ziel, null);
});

test('Raid: 30 Karten, 5 auf der Hand, 1 je Zug; Energie wächst jede Runde; Kosten je Karte; Exil', () => {
  const o = JSON.parse(JSON.stringify(opts));
  assert.deepEqual([o.spieler.startHand, o.spieler.ziehen, o.spieler.energieStart, o.spieler.energieMax], [5, 1, 1, 10]);
  // Kosten: Seltenheit, einzelne Karte überschreibt
  const krisz = catalog.cardById['krisz-6-glitch'];
  assert.equal(logic.kampfFor(krisz, o).kosten, o.karten.kosten.glitch);
  o.karten.kostenKarte = { 'krisz-6-glitch': 7 };
  assert.equal(logic.cleanSettings(o).karten.kostenKarte['krisz-6-glitch'], 7);
  assert.equal(logic.kampfFor(krisz, o).kosten, 7);
  assert.throws(() => logic.cleanSettings({ ...o, spieler: { ...o.spieler, energieStart: 5, energieMax: 3 } }), /Start größer als Maximum/);
  // Ablauf
  const boss = { ...logic.bossDef(o), lotterie: null, angriffe: [{ key: 'dolch', name: 'Dolch', schaden: [1, 1], gewicht: 1 }] };
  const { s } = R.neu(logic.deckCards(ids, o), { rng: () => 0.4, spieler: logic.spielerDef(o), boss });
  assert.equal(s.hand.length + s.deck.length, 30);
  assert.equal(s.hand.length, 5);
  assert.deepEqual([s.energie, s.maxEnergie], [1, 1]);
  R.rundeEnde(s);
  assert.equal(s.hand.length, 6, 'eine Karte je Zug');
  assert.deepEqual([s.energie, s.maxEnergie], [2, 2]);
  for (let i = 0; i < 12; i++) R.rundeEnde(s);
  assert.equal(s.maxEnergie, 10, 'höchstens energieMax');
  // Effektkarte: an einen Platz gelegt, wirkt, kommt ins Exil
  s.energie = 10;
  const inst = s.hand.find((i) => R.spielbar(s, i.uid).ok);
  const ev = R.spielen(s, inst.uid, undefined, { x: 20, y: 30 });
  assert.deepEqual(ev[0].pos, { x: 20, y: 30 });
  assert.ok(ev.some((e) => e.t === 'exil' && e.uid === inst.uid));
  assert.equal(s.exil.length, 1);
  assert.ok(logic.publicState(s).exil.length === 1 && logic.publicState(s).maxEnergie === 10);
  // Bosskampf (ohne energieStart) bleibt bei fester Energie je Runde
  const spinne = R.neu(logic.deckCards(ids, o), { rng: () => 0.4 }).s;
  R.rundeEnde(spinne);
  assert.equal(spinne.energie, R.SPIELER.energie);
});

test('Dio Schattenpfeil: neue Boss-Karte mit Angriff, Abwehr, Lebenspunkten, Kosten und Klasse [Schurke]', () => {
  const dio = catalog.cardById['dio-schattenpfeil-boss'];
  assert.ok(dio && catalog.CARDS.includes(dio));
  assert.equal(catalog.cardById['lucky-dio-boss'], undefined, 'alte Karte ist weg');
  assert.equal(dio.name, 'Dio Schattenpfeil');
  assert.equal(dio.rarity, 'boss');
  assert.equal(dio.isCharacter, false, 'keine IHK-Werte – spielt nicht in IHK, Dungeon oder Turm');
  assert.deepEqual(dio.typen, ['Schurke']);
  const k = logic.kampfFor(dio, opts);
  assert.deepEqual([k.kosten, k.ang, k.sch, k.leben, k.dauer], [5, 60, 20, 60, 'permanent']);
  // Karte: ANG/ABW/LP und Kosten auf der Plakette, Klasse oben im Textfeld
  const svg = require('../src/tcg/cardSvg').render(dio).replace(/<image[^>]*\/>/, ''); // ohne eingebettetes Bild (Base64)
  for (const t of ['ANG', 'ABW', 'LP', '>60<', '>20<', '>5<', '[Schurke]', 'Effekt folgt', 'Dio Schattenpfeil']) assert.ok(svg.includes(t), t);
  assert.ok(!/FIA|FIS|BWL/.test(svg));
  // im Raid spielbar und landet als permanente Karte auf dem Feld
  const [karte] = logic.deckCards(['dio-schattenpfeil-boss'], opts);
  assert.ok(R.istPermanent(karte.kampf));
});

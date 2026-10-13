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
  // Stärke je Seltenheit gleicht aus: Crumpled-Angreifer nicht viel schwächer als Glitch-Angreifer
  const crumpled = logic.kampfFor(catalog.cardById['krisz-1-crumpled'], opts);
  assert.ok(crumpled.ang > krisz.ang * 0.6, `Crumpled ${crumpled.ang} vs. Glitch ${krisz.ang}`);
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

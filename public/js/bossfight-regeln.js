// Bosskampf-Regeln: reine Spiellogik ohne DOM – läuft im Browser (window.BossRegeln, gezeichnet von bossfight-hud.js)
// und in Node (scripts/bossfight-sim.js simuliert damit tausende Kämpfe für die Balance). Jede Aktion verändert den
// Zustand und gibt eine Liste von Ereignissen zurück, die die Oberfläche der Reihe nach animiert.
//
// Ablauf einer Runde: Spieler spielt Karten (Energie), setzt Waffen/Zauber ein → „Runde beenden“ → der Boss führt den
// angekündigten Angriff aus → neue Runde: Effekte ticken (Fluch, Gift, Nachladen), Energie voll, Karten ziehen,
// der Boss kündigt den nächsten Angriff an.
// Karten-Werte (kampf) stehen in src/tcg/cardData.js; Boss und Spieler-Grundwerte hier unten.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BossRegeln = factory();
})(this, function () {
  'use strict';

  var SPIELER = { hp: 100, energie: 3, startHand: 5, ziehen: 2, handMax: 8, haende: 2 };

  // Balance (2026-10-07, npm run sim:bosskampf): wer plant (Ankündigung beachten, Energie einteilen), gewinnt etwa
  // 57 %, wer nur Schaden macht oder zufällig spielt, etwa 6 % – Kämpfe dauern im Schnitt 7–8 Runden.
  // Höhlenspinne: kündigt jeden Angriff eine Runde vorher an. Ab der Hälfte ihres Lebens wütend (mehr Schaden,
  // öfter Sprung). Ein Sprung folgt nie direkt auf einen Sprung.
  var SPINNE = {
    key: 'spinne',
    name: 'Höhlenspinne',
    hp: 200,
    wutAb: 0.5,
    wutFaktor: 1.25,
    angriffe: [
      { key: 'biss', name: 'Biss', schaden: [16, 20], gewicht: 4 },
      { key: 'giftbiss', name: 'Giftbiss', schaden: [10, 12], gift: { schaden: 4, runden: 3 }, gewicht: 2 },
      { key: 'netz', name: 'Netz', schaden: [9, 11], netz: 1, gewicht: 2 },
      { key: 'sprung', name: 'Sprung', schaden: [34, 40], gewicht: 1.5, schwer: true },
    ],
  };

  // ---------- Hilfen ----------
  function wuerfel(s, von, bis) {
    return von + Math.floor(s.rng() * (bis - von + 1));
  }
  function mischen(s, list) {
    for (var j = list.length - 1; j > 0; j--) {
      var r = Math.floor(s.rng() * (j + 1));
      var tmp = list[j];
      list[j] = list[r];
      list[r] = tmp;
    }
    return list;
  }
  function summe(list, fn) {
    return list.reduce(function (a, x) { return a + fn(x); }, 0);
  }
  function finde(list, fn) {
    for (var i = 0; i < list.length; i++) if (fn(list[i])) return list[i];
    return null;
  }
  var istAusruestung = function (k) { return !!k && (k.typ === 'waffe' || k.typ === 'zauber' || k.typ === 'schild'); };
  var istAngriffsItem = function (k) { return !!k && (k.typ === 'waffe' || k.typ === 'zauber'); };

  // ---------- Zustand ----------
  /**
   * Neuer Kampf. karten: Deck als Liste von Karten { id, name, image, kampf } (Wiederholung = mehrere Exemplare).
   * Gibt { s, ev } zurück – s ist der Zustand, ev die Ereignisse (Startkarten ziehen, erste Ankündigung).
   */
  function neu(karten, opt) {
    opt = opt || {};
    var sp = opt.spieler || SPIELER;
    var bd = opt.boss || SPINNE;
    var s = {
      rng: opt.rng || Math.random,
      sp: sp,
      bd: bd,
      uid: 0,
      runde: 1,
      energie: sp.energie,
      spieler: { hp: sp.hp, max: sp.hp },
      boss: { hp: bd.hp, max: bd.hp },
      deck: [],
      hand: [],
      gear: [], // { uid, card, used, hits, bonus }
      effekte: [], // { art, key, card, name, wert, runden, max }
      gespielt: 0,
      absicht: null,
      vorbei: null, // 'sieg' | 'niederlage'
      log: { bossSchaden: 0, spielerSchaden: 0, geheilt: 0, karten: 0 },
    };
    s.deck = mischen(s, karten.filter(function (c) { return c && c.kampf; }).map(function (c) { return instanz(s, c); }));
    var ev = ziehen(s, sp.startHand);
    s.absicht = ankuendigen(s);
    ev.push({ t: 'absicht', absicht: s.absicht });
    return { s: s, ev: ev };
  }

  function instanz(s, card) {
    return { uid: ++s.uid, card: card, buffs: [] }; // buffs: { von (Karten-ID), name, ang, sch, kosten }
  }

  /** Flache Kopie für Vorausschau (KI im Simulator): Karten selbst werden geteilt, alles Veränderliche kopiert */
  function klon(s) {
    var k = {};
    for (var key in s) if (Object.prototype.hasOwnProperty.call(s, key)) k[key] = s[key];
    k.spieler = { hp: s.spieler.hp, max: s.spieler.max };
    k.boss = { hp: s.boss.hp, max: s.boss.max };
    k.deck = s.deck.slice();
    k.hand = s.hand.map(function (i) { return { uid: i.uid, card: i.card, buffs: i.buffs.slice() }; });
    k.gear = s.gear.map(function (g) { return { uid: g.uid, card: g.card, used: g.used, hits: g.hits, bonus: g.bonus }; });
    k.effekte = s.effekte.map(function (e) { var c = {}; for (var x in e) c[x] = e[x]; return c; });
    k.log = { bossSchaden: s.log.bossSchaden, spielerSchaden: s.log.spielerSchaden, geheilt: s.log.geheilt, karten: s.log.karten };
    return k;
  }

  // ---------- Boss: Ankündigung ----------
  function wuetend(s) {
    return s.boss.hp <= s.boss.max * s.bd.wutAb;
  }
  function ankuendigen(s) {
    var wut = wuetend(s);
    var letzte = s.absicht;
    var pool = s.bd.angriffe.filter(function (a) { return !(a.schwer && letzte && letzte.schwer); });
    var gewicht = function (a) { return a.gewicht * (wut && a.schwer ? 2 : 1); };
    var r = s.rng() * summe(pool, gewicht);
    var a = pool[pool.length - 1];
    for (var i = 0; i < pool.length; i++) {
      r -= gewicht(pool[i]);
      if (r < 0) { a = pool[i]; break; }
    }
    var schaden = wuerfel(s, a.schaden[0], a.schaden[1]);
    if (wut) schaden = Math.round(schaden * s.bd.wutFaktor);
    return { key: a.key, name: a.name, schaden: schaden, gift: a.gift || null, netz: a.netz || 0, schwer: !!a.schwer, wut: wut };
  }

  // ---------- Werte einer Karte (mit Stärkungen) ----------
  function buffSumme(inst, feld) {
    return summe(inst.buffs, function (b) { return b[feld] || 0; });
  }
  function kosten(s, inst) {
    var k = inst.card.kampf;
    var basis = k.typ === 'held' ? k.kosten || 0 : Math.min(s.sp.haende, k.haende || 1);
    return Math.max(0, basis - buffSumme(inst, 'kosten'));
  }

  /** Darf diese Karte jetzt gespielt werden? { ok, grund, ziel } – ziel: braucht eine Zielkarte (Druiden) */
  function spielbar(s, uid) {
    if (s.vorbei) return { ok: false, grund: 'Der Kampf ist vorbei.' };
    var inst = finde(s.hand, function (i) { return i.uid === uid; });
    if (!inst) return { ok: false, grund: 'Karte nicht in der Hand.' };
    var k = inst.card.kampf;
    if (!k || (k.typ !== 'held' && !istAusruestung(k))) return { ok: false, grund: 'Kann im Bosskampf nicht gespielt werden.' };
    if (kosten(s, inst) > s.energie) return { ok: false, grund: 'Zu wenig Energie' };
    var st = k.effekt && k.effekt.staerken;
    if (st && !ziele(s, uid).length) return { ok: false, grund: 'Keine Karte zum Stärken in der Hand' };
    return { ok: true, ziel: !!st };
  }

  /** Mögliche Ziele einer Stärkung: andere Helden, Waffen und Zauber in der Hand */
  function ziele(s, uid) {
    return s.hand.filter(function (i) {
      var k = i.card.kampf;
      return i.uid !== uid && k && (k.typ === 'held' || istAngriffsItem(k));
    }).map(function (i) { return i.uid; });
  }

  // ---------- Schaden und Heilung ----------
  function bossTreffer(s, wert, quelle, ev) {
    if (s.vorbei || wert <= 0) return 0;
    var echt = Math.min(wert, s.boss.hp);
    s.boss.hp -= echt;
    s.log.bossSchaden += echt;
    ev.push({ t: 'boss', wert: wert, hp: s.boss.hp, card: quelle.card || null, fx: quelle.fx || 'feuer', von: quelle.von || 'karte', uid: quelle.uid || null });
    if (s.boss.hp <= 0) ende(s, 'sieg', ev);
    return echt;
  }
  function spielerTreffer(s, wert, text, ev) {
    if (s.vorbei || wert <= 0) return;
    s.spieler.hp = Math.max(0, s.spieler.hp - wert);
    s.log.spielerSchaden += wert;
    ev.push({ t: 'spieler', wert: wert, hp: s.spieler.hp, text: text || '' });
    if (s.spieler.hp <= 0) ende(s, 'niederlage', ev);
  }
  function heilen(s, wert, ev) {
    if (s.vorbei || wert <= 0) return;
    var echt = Math.min(wert, s.spieler.max - s.spieler.hp);
    s.spieler.hp += echt;
    s.log.geheilt += echt;
    ev.push({ t: 'heil', wert: wert, hp: s.spieler.hp });
  }
  function ende(s, wie, ev) {
    if (s.vorbei) return;
    s.vorbei = wie;
    ev.push({ t: 'ende', sieg: wie === 'sieg' });
  }

  // Effekt setzen; dieselbe Karte (bzw. derselbe Boss-Angriff) frischt nur auf – Dauer wieder voll, Wert nicht addiert
  function effekt(s, e) {
    var alt = finde(s.effekte, function (x) { return x.key === e.key; });
    if (alt) {
      alt.runden = alt.max = e.runden;
      alt.wert = Math.max(alt.wert || 0, e.wert || 0);
      return alt;
    }
    s.effekte.push(e);
    return e;
  }
  function effekteVon(s, art) {
    return s.effekte.filter(function (e) { return e.art === art; });
  }

  // ---------- Karten spielen ----------
  /** Karte aus der Hand spielen. zielUid: Zielkarte einer Stärkung (Druiden). Gibt Ereignisse zurück. */
  function spielen(s, uid, zielUid) {
    var ev = [];
    var ok = spielbar(s, uid);
    if (!ok.ok) return [{ t: 'nein', uid: uid, grund: ok.grund }];
    var inst = finde(s.hand, function (i) { return i.uid === uid; });
    var k = inst.card.kampf;
    var e = k.effekt || {};
    var ziel = null;
    if (e.staerken) {
      ziel = finde(s.hand, function (i) { return i.uid === zielUid; });
      if (!ziel || ziele(s, uid).indexOf(zielUid) < 0) return [{ t: 'nein', uid: uid, grund: 'Wähle eine Karte zum Stärken.' }];
    }
    s.energie -= kosten(s, inst);
    s.hand.splice(s.hand.indexOf(inst), 1);
    var vorher = s.gespielt;
    s.gespielt++;
    s.log.karten++;
    ev.push({ t: 'gespielt', inst: inst });
    if (k.typ === 'held') held(s, inst, vorher, ziel, ev);
    else ausruesten(s, inst, ev);
    return ev;
  }

  function held(s, inst, vorher, ziel, ev) {
    var k = inst.card.kampf;
    var e = k.effekt || {};
    var quelle = { card: inst.card, fx: k.fx, von: 'karte', uid: inst.uid };
    var faktor = 1;
    var lg = e.letztesGefecht;
    var verzweifelt = lg && s.spieler.hp < lg.grenze;
    if (verzweifelt) faktor *= lg.faktor;
    var ang = ((k.ang || 0) + buffSumme(inst, 'ang')) * faktor;
    var sch = ((k.sch || 0) + buffSumme(inst, 'sch')) * (verzweifelt ? lg.faktor : 1);
    if (e.hinterhalt && vorher > 0) ang *= e.hinterhalt;
    if (e.krit && ang && s.rng() < e.krit.chance) {
      ang *= e.krit.faktor;
      ev.push({ t: 'info', wo: 'boss', text: 'Kritisch!' });
    }
    ang = Math.round(ang);

    if (sch) {
      effekt(s, { art: 'block', key: 'block:' + inst.card.id, card: inst.card, name: 'Block', wert: sch, runden: 1, max: 1 });
      ev.push({ t: 'info', wo: 'spieler', text: '+' + sch + ' Block' });
    }
    if (k.hei) heilen(s, k.hei, ev);
    if (e.selbst) spielerTreffer(s, e.selbst, inst.card.name, ev);
    if (e.energie) {
      s.energie += e.energie;
      ev.push({ t: 'info', wo: 'energie', text: '+' + e.energie + ' Energie' });
    }
    if (e.dot) effekt(s, { art: 'dot', key: 'dot:' + inst.card.id, card: inst.card, name: e.dot.name || 'Fluch', wert: e.dot.schaden, runden: e.dot.runden, max: e.dot.runden, fx: k.fx });
    if (e.betaeuben) effekt(s, { art: 'betaeubt', key: 'betaeubt:' + inst.card.id, card: inst.card, name: 'Betäubt', wert: 0, runden: 1, max: 1 });
    if (e.schwaechen) effekt(s, { art: 'schwach', key: 'schwach:' + inst.card.id, card: inst.card, name: 'Geschwächt', wert: e.schwaechen, runden: 1, max: 1 });
    if (e.staerken && ziel) {
      var st = e.staerken;
      ziel.buffs = ziel.buffs.filter(function (b) { return b.von !== inst.card.id; }); // gleiche Karte: auffrischen, nicht stapeln
      ziel.buffs.push({ von: inst.card.id, name: inst.card.name, ang: st.ang || 0, sch: st.sch || 0, kosten: st.kosten || 0 });
      ev.push({ t: 'buff', ziel: ziel });
    }
    if (ang) {
      if (e.verzoegert) {
        effekt(s, { art: 'nachladen', key: 'nachladen:' + inst.card.id, card: inst.card, name: 'Nachladen', wert: ang, runden: 1, max: 1, fx: k.fx });
      } else {
        var gesamt = 0;
        for (var i = 0; i < (e.treffer || 1); i++) gesamt += bossTreffer(s, ang, quelle, ev);
        if (e.lebensraub) heilen(s, gesamt, ev);
      }
    }
  }

  // Ausrüsten: zwei Hände; was keinen Platz hat, ist weg (erst gleiche Art, dann das älteste). Hat ein Ersetztes in
  // der Runde schon angegriffen, greift das neue erst nächste Runde an (höchstens ein Angriff pro Hand und Runde).
  function ausruesten(s, inst, ev) {
    var k = inst.card.kampf;
    var need = Math.min(s.sp.haende, k.haende || 1);
    var schild = k.typ === 'schild';
    var benutzt = false;
    var weg = [];
    var haende = function () { return summe(s.gear, function (g) { return Math.min(s.sp.haende, g.card.kampf.haende || 1); }); };
    while (s.gear.length && s.sp.haende - haende() < need) {
      var gleich = s.gear.filter(function (g) { return (g.card.kampf.typ === 'schild') === schild; });
      var raus = gleich[0] || s.gear[0];
      if (raus.used) benutzt = true;
      s.gear.splice(s.gear.indexOf(raus), 1);
      weg.push(raus);
    }
    var g = { uid: inst.uid, card: inst.card, used: benutzt && !schild, hits: 0, bonus: buffSumme(inst, 'ang') };
    s.gear.push(g);
    ev.push({ t: 'ausgeruestet', g: g, weg: weg });
  }

  /** Waffe/Zauber einsetzen: einmal pro Runde */
  function einsetzen(s, uid) {
    var g = finde(s.gear, function (x) { return x.uid === uid; });
    if (s.vorbei || !g || !istAngriffsItem(g.card.kampf) || g.used) return [];
    var ev = [];
    g.used = true;
    ev.push({ t: 'eingesetzt', g: g });
    bossTreffer(s, (g.card.kampf.schaden || 0) + (g.bonus || 0), { card: g.card, fx: g.card.kampf.fx, von: 'gear', uid: g.uid }, ev);
    return ev;
  }

  // ---------- Boss-Angriff und neue Runde ----------
  /** Was würde der angekündigte Angriff jetzt anrichten? { roh, wert, details, aus } (auch für die Anzeige) */
  function vorschau(s) {
    var a = s.absicht;
    if (!a) return { roh: 0, wert: 0, details: [], aus: false };
    if (effekteVon(s, 'betaeubt').length) return { roh: a.schaden, wert: 0, details: ['betäubt'], aus: true };
    var wert = a.schaden;
    var details = [];
    var schwach = effekteVon(s, 'schwach');
    if (schwach.length) {
      var p = Math.max.apply(null, schwach.map(function (e) { return e.wert; }));
      wert = Math.round(wert * (100 - p) / 100);
      details.push('−' + p + ' % geschwächt');
    }
    var pct = Math.min(90, summe(s.gear.filter(function (g) { return g.card.kampf.typ === 'schild'; }), function (g) { return g.card.kampf.schutz || 0; }));
    if (pct) {
      wert = Math.round(wert * (100 - pct) / 100);
      details.push('−' + pct + ' % Schild');
    }
    var block = summe(effekteVon(s, 'block'), function (e) { return e.wert; });
    if (block) {
      var geblockt = Math.min(block, wert);
      wert -= geblockt;
      details.push(geblockt + ' geblockt');
    }
    return { roh: a.schaden, wert: wert, details: details, aus: false, schild: pct > 0 || block > 0 };
  }

  /** Runde beenden: Boss greift an, dann beginnt die nächste Runde */
  function rundeEnde(s) {
    var ev = [];
    if (s.vorbei) return ev;
    var a = s.absicht;
    var v = vorschau(s);
    ev.push({ t: 'bossangriff', absicht: a, roh: v.roh, wert: v.wert, details: v.details, aus: v.aus, schild: !!v.schild });
    if (!v.aus) {
      spielerTreffer(s, v.wert, a.name, ev);
      s.gear.filter(function (g) { return g.card.kampf.typ === 'schild'; }).forEach(function (g) {
        var max = g.card.kampf.haltbarkeit;
        if (!max) return;
        g.hits++;
        if (g.hits >= max) {
          s.gear.splice(s.gear.indexOf(g), 1);
          ev.push({ t: 'zerbrochen', g: g });
        }
      });
      if (a.gift) effekt(s, { art: 'gift', key: 'gift:' + a.key, card: null, name: 'Gift', wert: a.gift.schaden, runden: a.gift.runden, max: a.gift.runden });
      if (a.netz) effekt(s, { art: 'netz', key: 'netz:' + a.key, card: null, name: 'Netz', wert: a.netz, runden: 1, max: 1 });
    }
    // Block, Schwächung und Betäubung gelten nur für diesen einen Angriff
    s.effekte = s.effekte.filter(function (e) { return e.art !== 'block' && e.art !== 'schwach' && e.art !== 'betaeubt'; });
    if (s.vorbei) return ev;
    rundeStart(s, ev);
    return ev;
  }

  function rundeStart(s, ev) {
    s.runde++;
    s.gespielt = 0;
    var netz = summe(effekteVon(s, 'netz'), function (e) { return e.wert; });
    s.energie = Math.max(0, s.sp.energie - netz);
    s.gear.forEach(function (g) { g.used = false; });
    ev.push({ t: 'runde', nr: s.runde, energie: s.energie, netz: netz });
    // Effekte zu Rundenbeginn: Nachladen schlägt ein, Fluch/Blutung trifft den Boss, Gift den Spieler
    s.effekte.slice().forEach(function (e) {
      if (s.vorbei) return;
      if (e.art === 'nachladen' || e.art === 'dot') bossTreffer(s, e.wert, { card: e.card, fx: e.art === 'dot' ? e.fx || 'nekro' : e.fx || 'feuer', von: 'effekt' }, ev);
      if (e.art === 'gift') spielerTreffer(s, e.wert, 'Gift', ev);
      if (e.art !== 'netz') e.runden--;
    });
    s.effekte = s.effekte.filter(function (e) { return e.art !== 'netz' && e.runden > 0; });
    if (s.vorbei) return;
    ziehen(s, s.sp.ziehen).forEach(function (x) { ev.push(x); });
    s.absicht = ankuendigen(s);
    ev.push({ t: 'absicht', absicht: s.absicht });
  }

  function ziehen(s, n) {
    var ev = [];
    for (var i = 0; i < n && s.deck.length && s.hand.length < s.sp.handMax; i++) {
      var inst = s.deck.pop();
      s.hand.push(inst);
      ev.push({ t: 'ziehen', inst: inst });
    }
    return ev;
  }

  return {
    SPIELER: SPIELER,
    SPINNE: SPINNE,
    neu: neu,
    klon: klon,
    spielbar: spielbar,
    ziele: ziele,
    kosten: kosten,
    spielen: spielen,
    einsetzen: einsetzen,
    rundeEnde: rundeEnde,
    vorschau: vorschau,
    buffSumme: buffSumme,
    istAusruestung: istAusruestung,
    istAngriffsItem: istAngriffsItem,
  };
});

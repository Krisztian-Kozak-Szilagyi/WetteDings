process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { render, parseMentions, collectRefs } = require('../src/forum/render');
const { CATEGORIES, STARTERS, HALL_OF_FAME_KEY } = require('../src/forum/starters');
const { TITLE_MAX, BODY_MAX, MODLOG_LABELS } = require('../src/forum/forumService');
const hof = require('../src/forum/hallOfFame');
const catalog = require('../src/tcg/catalog');

const BET = '0123456789abcdef01234567';
const ctx = {
  users: new Map([['max', 'Max'], ['anna.b', 'Anna.B']]),
  bets: new Map([[BET, { title: '<b>Regen</b> morgen?', status: 'offen', pot: 12345, duel: false }]]),
};

test('Erwähnungen: Namen erkennen, ohne E-Mail-Adressen, Pfade und Satzzeichen', () => {
  assert.deepEqual(parseMentions('Hallo @Max und @anna.b. Mail: a@max.de, Pfad /x@max'), ['max', 'anna.b']);
  assert.deepEqual(parseMentions('@ab zu kurz, @Max @MAX doppelt'), ['max']);
  assert.deepEqual(parseMentions('__@max__'), ['max__', 'max']);
  assert.deepEqual(parseMentions(''), []);
});

test('Erwähnungen: nur bestehende Mitglieder werden zum Profil-Link (Schreibweise wie im Konto)', () => {
  const html = render('Danke @max! @niemand **@Anna.B**', ctx);
  assert.ok(html.includes('<a class="user-link forum-mention" href="/profil/Max">@Max</a>!'));
  assert.ok(html.includes('@niemand') && !html.includes('/profil/niemand'));
  assert.ok(html.includes('<strong><a class="user-link forum-mention" href="/profil/Anna.B">@Anna.B</a></strong>'));
  assert.ok(render('__@max__', ctx).includes('<u><a class="user-link forum-mention" href="/profil/Max">@Max</a></u>'));
  // ohne geladene Namen bleibt alles Text
  assert.equal(render('@max'), '<p>@max</p>');
});

test('Einbettungen: Wette, Profil und Karte als Kärtchen, alles maskiert', () => {
  const html = render(`Schau: [wette:${BET}] und [profil:MAX]`, ctx);
  assert.ok(html.includes(`<a class="forum-embed forum-embed-bet" href="/wetten/${BET}">`));
  assert.ok(html.includes('&lt;b&gt;Regen&lt;/b&gt; morgen?') && !html.includes('<b>Regen'));
  assert.ok(html.includes('Offen · Topf 123,45'));
  assert.ok(html.includes('<a class="forum-embed forum-embed-user" href="/profil/Max">'));
  const card = catalog.CARDS.find((c) => !catalog.rarityByKey[c.rarity].hidden);
  const cardHtml = render(`[karte:${card.id.toUpperCase()}]`);
  assert.ok(cardHtml.includes(`forum-embed-card r-${card.rarity}`) && cardHtml.includes(catalog.rarityByKey[card.rarity].label));
});

test('Einbettungen: alleinstehende interne Links, ungültige IDs, fremde Adressen', () => {
  // eine Zeile nur mit dem Link → Kärtchen; mitten im Satz bleibt er Text
  assert.ok(render(`/wetten/${BET}`, ctx).includes('forum-embed-bet'));
  assert.ok(render('  /profil/max  ', ctx).includes('forum-embed-user'));
  assert.ok(!render(`siehe /wetten/${BET} dort`, ctx).includes('forum-embed'));
  // fremde Seiten werden nie eingebettet
  assert.ok(!render(`https://boese.example/wetten/${BET}`, ctx).includes('<a'));
  assert.ok(!render(`//boese.example/profil/max`, ctx).includes('<a'));
  // ungültige IDs bleiben Text, unbekannte Karten auch
  assert.equal(render('[wette:xyz] [wette:0123] [karte:gibts-nicht]', ctx), '<p>[wette:xyz] [wette:0123] [karte:gibts-nicht]</p>');
  // gültige, aber nicht geladene Wette (Gruppen-Wette, Duell-Anfrage, gelöscht): nur ein Link ohne Details
  const other = 'fedcba9876543210fedcba98';
  assert.equal(render(`[wette:${other}]`, ctx), `<p><a href="/wetten/${other}">/wetten/${other}</a></p>`);
  // Versuch, über die Kurzform HTML einzuschleusen
  const evil = render('[profil:"><script>] [karte:<img src=x>] @<script>', ctx);
  assert.ok(!evil.includes('<script>') && !evil.includes('<img src=x'));
  // geheime Seltenheiten verrät die Vorschau nicht
  const secret = catalog.CARDS.find((c) => catalog.rarityByKey[c.rarity].hidden);
  if (secret) assert.ok(!render(`[karte:${secret.id}]`).includes('forum-embed'));
});

test('Einbettungen: Verweise einer ganzen Seite werden auf einmal gesammelt', () => {
  const refs = collectRefs([`[wette:${BET}] @Max`, `/wetten/${BET.toUpperCase()}\n[profil:Anna.B] [wette:nix]`, null, `@max [wette:${'f'.repeat(24)}]`]);
  assert.deepEqual(refs.bets.sort(), [BET, 'f'.repeat(24)].sort());
  assert.deepEqual(refs.names.sort(), ['anna.b', 'max']);
});

test('Startthemen und Bereiche: Definitionen passen zusammen', () => {
  const keys = CATEGORIES.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, 'keys eindeutig');
  for (const c of CATEGORIES) if (c.parent) assert.ok(keys.includes(c.parent) && keys.indexOf(c.parent) < keys.indexOf(c.key), `Eltern von ${c.key} vorher definiert`);
  for (const k of ['wetten', 'coins', 'ihk', HALL_OF_FAME_KEY]) assert.equal(CATEGORIES.find((c) => c.key === k).parent, 'allgemein');
  assert.deepEqual(CATEGORIES.find((c) => c.key === 'wetten').titles, ['Wetten']);
  assert.deepEqual(CATEGORIES.find((c) => c.key === 'ihk').titles, ['IHK']);
  assert.ok(!keys.includes('patchnotes'), 'Patchnotes legt seed() an');
  const starterKeys = STARTERS.map((s) => s.key);
  assert.equal(new Set(starterKeys).size, starterKeys.length);
  assert.deepEqual(starterKeys, ['regeln', 'bug-vorlage', 'roadmap', 'vorstellung']);
  for (const s of STARTERS) {
    assert.ok(keys.includes(s.category), `${s.key}: Bereich ${s.category} definiert`);
    assert.ok(s.title.length >= 3 && s.title.length <= TITLE_MAX, `${s.key}: Titellänge`);
    assert.ok(s.body.length > 50 && s.body.length <= BODY_MAX, `${s.key}: Textlänge`);
    assert.ok(!/<\/?(admin|dev|mod)>/i.test(s.body), `${s.key}: keine Rollen-Tags`);
    assert.ok(render(s.body).length > 0);
  }
  assert.ok(Object.keys(MODLOG_LABELS).length >= 9);
});

test('Hall of Fame: Wettgewinne mit Titel und Link, Gruppen-Wetten ohne', () => {
  const pub = { _id: 'b1', title: 'Öffentlich', group: null };
  const grp = { _id: 'b2', title: 'Geheim', group: 'g1' };
  const rows = hof.mapBetWins(
    [
      { username: 'Max', bet: 'b1', profit: 5000 },
      { username: 'Anna', bet: 'b2', profit: 3000 },
      { username: 'Tom', bet: 'b3', profit: 1000 },
    ],
    new Map([['b1', pub], ['b2', grp]])
  );
  assert.deepEqual(rows.map((r) => [r.name, r.profit, r.title, r.href]), [
    ['Max', 5000, 'Öffentlich', '/wetten/b1'],
    ['Anna', 3000, 'Gruppen-Wette', null],
    ['Tom', 1000, 'Gelöschte Wette', null],
  ]);
  assert.equal(hof.mapBetWins(Array.from({ length: 15 }, (_, i) => ({ username: `u${i}`, bet: 'b1', profit: 100 })), new Map([['b1', pub]])).length, hof.TOP);
});

test('Hall of Fame: seltenste Karte je Öffnung, unbekannte Seltenheiten zählen nicht', () => {
  const glitch = catalog.CARDS.find((c) => c.rarity === 'glitch');
  const at = new Date('2026-01-02');
  const rows = hof.mapPulls([
    { username: 'Max', createdAt: at, cards: [{ card: 'x', rarity: 'crumpled' }, { card: glitch ? glitch.id : 'g', rarity: 'glitch' }, { card: 'y', rarity: 'holo' }] },
    { username: 'Alt', createdAt: at, cards: [{ card: 'z', rarity: 'gibtsnicht' }] },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Max');
  assert.equal(rows[0].rarity, 'glitch');
  assert.equal(rows[0].rarityLabel, 'Glitch');
  assert.equal(rows[0].card, glitch ? glitch.name : 'g');
  assert.equal(hof.bestCard([]), null);
});

test('Hall of Fame: Lottogewinne nur mit bekanntem (nicht gelöschtem) Namen', () => {
  const rows = hof.mapLotto(
    [
      { user: 'u1', amount: 90000, createdAt: new Date() },
      { user: 'weg', amount: 80000, createdAt: new Date() },
      { user: 'u2', amount: 1000, createdAt: new Date() },
    ],
    new Map([['u1', 'Max'], ['u2', 'Anna']])
  );
  assert.deepEqual(rows.map((r) => [r.name, r.amount]), [['Max', 90000], ['Anna', 1000]]);
});

// Menüpunkte samt Abzeichen (Leiste in partials/head.ejs, Profil-Menü auf Handy/Tablet und das HUD der Taverne in hub.ejs).
// l = die Locals der Seite (currentUser, currentPath, Zähler aus der Middleware, Helfer wie ihkOpen aus app.locals).
// Ein Eintrag: { href, label, active, badges: [{ n, cls, title, aria }], live } – Gruppen (Aufklappmenü) haben
// zusätzlich group und items; ihre Abzeichen sind die Summe der Unterpunkte (je Farbe).

function navGroup(key, label, items) {
  const sum = {};
  items.forEach((it) =>
    it.badges.forEach((bd) => {
      if (!sum[bd.cls]) sum[bd.cls] = { n: 0, cls: bd.cls, title: [], aria: [] };
      sum[bd.cls].n += bd.n;
      sum[bd.cls].title.push(it.label + ': ' + bd.title);
      sum[bd.cls].aria.push(bd.aria);
    })
  );
  const badges = Object.values(sum).map((bd) => ({ n: bd.n, cls: bd.cls, title: bd.title.join(' · '), aria: bd.aria.join(', ') }));
  const live = items
    .filter((it) => it.live)
    .map((it) => it.live)
    .join(' · ');
  return { group: key, label, items, badges, live, active: items.some((it) => it.active) };
}

function buildNav(l) {
  const u = l.currentUser;
  if (!u) return [];
  const path = l.currentPath || '';
  const navItems = [];
  // Abzeichen: neue Gruppen-Wetten (eigene Farbe) haben Vorrang vor neuen öffentlichen; fehlende eigene Stimmen zählen immer
  const betRed = l.betVotePending + (l.betNewGroup ? 0 : l.betNewPublic);
  const betBadges = [];
  if (l.betNewGroup) betBadges.push({ n: l.betNewGroup, cls: 'nav-badge-group', title: 'Neue Wetten in deinen Gruppen', aria: l.betNewGroup + ' neue Wetten in deinen Gruppen' });
  if (betRed) betBadges.push({ n: betRed, cls: '', title: l.betVotePending ? 'Wetten, in denen deine Stimme zum Ergebnis fehlt' + (l.betNewGroup || !l.betNewPublic ? '' : ', und neue Wetten') : 'Neue Wetten', aria: betRed + ' Wetten: neu oder deine Stimme fehlt' });
  navItems.push({ href: '/rangliste', label: 'Rangliste', active: path === '/rangliste', badges: [] });
  // Wetten, Broker und Lotterie stecken im Aufklappmenü "Gambling"
  const gambling = [
    { href: '/wetten', label: 'Wetten', active: path === '/wetten' || path.startsWith('/wetten/'), badges: betBadges },
    { href: '/broker', label: 'Broker', active: path === '/broker' || path.startsWith('/broker/'), badges: [] },
    { href: '/lotterie', label: 'Lotterie', active: path === '/lotterie' || path.startsWith('/lotterie/'), badges: [] },
  ];
  navItems.push(navGroup('gambling', 'Gambling', gambling));
  navItems.push({ href: '/tcg', label: 'TCG', active: path.startsWith('/tcg') || path.startsWith('/inventar'), badges: l.newPacks ? [{ n: l.newPacks, cls: '', title: 'Neue Booster Packs im Inventar', aria: l.newPacks + ' neue Booster Packs' }] : [], live: l.newItems ? 'Neuer Gegenstand im Inventar' : '' });
  const tradeBadges = [];
  if (l.tradeMarketNew) tradeBadges.push({ n: l.tradeMarketNew, cls: 'nav-badge-market', title: 'Neu auf dem Markt', aria: l.tradeMarketNew + ' neue Markt-Angebote' });
  if (l.tradeIncoming) tradeBadges.push({ n: l.tradeIncoming, cls: '', title: 'Angebote, Verhandlungen und abgeschlossene Geschäfte für dich', aria: l.tradeIncoming + ' Angebote und Verhandlungen für dich' });
  navItems.push({ href: '/handel', label: 'Handel', active: path === '/handel', badges: tradeBadges, live: l.blackMarketOpen() ? 'Black Market geöffnet' : '' });
  if (l.ihkOpen() || u.isAdmin) navItems.push({ href: '/ihk', label: 'IHK', active: path === '/ihk', badges: [] });
  // Dungeon: mit eSports als Aufklappmenü (eSports hängt am Mage Tower), sonst ein einfacher Link
  if (l.dungeonOpen() || u.isAdmin) {
    const dungeonItem = { href: '/dungeon', label: 'Dungeon', active: path === '/dungeon' || path.startsWith('/dungeon/'), badges: [] };
    navItems.push(l.esportsOpen(u) ? navGroup('dungeon', 'Dungeon', [dungeonItem, { href: '/esports', label: 'eSports', active: path === '/esports', badges: [] }]) : dungeonItem);
  }
  if (l.gradingOpen() || u.isAdmin) navItems.push({ href: '/grading', label: 'Grading', active: path === '/grading', badges: [] });
  const forumBadges = [];
  if (l.forumOther) forumBadges.push({ n: l.forumOther, cls: 'nav-badge-market', title: 'Neues im Forum', aria: l.forumOther + ' Themen mit neuen Beiträgen' });
  if (l.forumMine) forumBadges.push({ n: l.forumMine, cls: '', title: 'Neues in deinen Themen', aria: l.forumMine + ' deiner Themen mit neuen Beiträgen' });
  navItems.push({ href: '/forum', label: 'Forum', active: path.startsWith('/forum'), badges: forumBadges });
  if (u.isStaff) {
    const adminBadges = [];
    if (l.betDisputes) adminBadges.push({ n: l.betDisputes, cls: 'nav-badge-dispute', title: 'Strittige Wetten, die ein Dev entscheiden muss', aria: l.betDisputes + ' strittige Wetten' });
    if (l.tradeAlerts) adminBadges.push({ n: l.tradeAlerts, cls: 'nav-badge-suspicious', title: 'Handel zwischen Mehrfach-Konten', aria: l.tradeAlerts + ' Geschäfte zwischen Mehrfach-Konten' });
    if (l.deviceAlerts) adminBadges.push({ n: l.deviceAlerts, cls: 'nav-badge-device', title: 'Konten, die dasselbe Gerät benutzen', aria: l.deviceAlerts + ' Hinweise auf Mehrfach-Konten' });
    if (l.suspicionAlerts) adminBadges.push({ n: l.suspicionAlerts, cls: 'nav-badge-suspicion', title: 'Auffälligkeiten: Spieler mit Verdacht auf Skript oder Wertverschiebung', aria: l.suspicionAlerts + ' verdächtige Spieler' });
    if (l.suspicionRepeats) adminBadges.push({ n: l.suspicionRepeats, cls: 'nav-badge-suspicion-repeat', title: 'Auffälligkeiten: bereits beurteilte Fälle, die erneut aufgetreten sind', aria: l.suspicionRepeats + ' beurteilte Fälle erneut aufgetreten' });
    if (l.packLogNew) adminBadges.push({ n: l.packLogNew, cls: '', title: 'Neue Vergaben und entfernte Karten (Vergabe-Log)', aria: l.packLogNew + ' neue Einträge im Vergabe-Log' });
    navItems.push({ href: '/admin', label: u.isAdmin ? 'Admin' : 'Dev', active: path.startsWith('/admin'), badges: adminBadges });
  }
  return navItems;
}

// Seiten im Taverne-Stil: erscheinen als Fenster über der Taverne (wie Gambling/PVE auf der Startseite), ohne Leiste,
// mit „Zur Taverne“ (partials/head.ejs, public/css/taverne.css). Jeder Bereich ist ein Ort der Taverne.
//   tabs:  Reiter im Fensterkopf – href (Text oder Funktion der Locals), show(l): nur zeigen, wenn erlaubt (wie in der Navigation)
//   paths: weitere Seiten des Bereichs ohne eigenen Reiter (z. B. Impressum im Aushang)
//   icon:  Pfad im 24er-Raster; title: Text oder Funktion der Locals; show(l): ganzer Bereich nur für bestimmte Mitglieder
// Jede andere Seite eines angemeldeten Mitglieds (Fehlerseiten, neue Seiten) erscheint im allgemeinen Fenster (GENERAL).
const ICON = {
  gambling: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01',
  rangliste: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3',
  tcg: 'M8 3h9a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM3 7v12a2 2 0 0 0 2 2M12 9l1.2 2.4 2.6.4-1.9 1.8.5 2.6-2.4-1.3-2.4 1.3.5-2.6-1.9-1.8 2.6-.4z',
  handel: 'M4 8h14l-3-3M20 16H6l3 3',
  pve: 'M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2',
  forum: 'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z',
  admin: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  profil: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21c1-4 4-6 8-6s7 2 8 6',
  aushang: 'M5 4h12a2 2 0 0 1 2 2v12a2 2 0 0 0 2 2H7a2 2 0 0 1-2-2zM9 9h6M9 13h6',
};
const me = (l) => '/profil/' + encodeURIComponent(l.currentUser.username);
const TAVERNE_SECTIONS = [
  { key: 'gambling', title: 'Gambling', sub: 'HÄNDLERSTAND', icon: ICON.gambling, tabs: [{ href: '/wetten', label: 'Wetten' }, { href: '/broker', label: 'Broker' }, { href: '/lotterie', label: 'Lotterie' }], paths: ['/duell'] },
  { key: 'rangliste', title: 'Rangliste', sub: 'EHRENHALLE', icon: ICON.rangliste, tabs: [{ href: '/rangliste', label: 'Rangliste' }] },
  { key: 'tcg', title: 'TCG', sub: 'KARTENTISCH', icon: ICON.tcg, tabs: [{ href: '/tcg', label: 'TCG' }, { href: '/inventar', label: 'Inventar' }], paths: ['/slab', '/deck'] },
  { key: 'handel', title: 'Handel', sub: 'MARKTPLATZ', icon: ICON.handel, tabs: [{ href: '/handel', label: 'Handel' }] },
  {
    key: 'pve', title: 'PVE', sub: 'ABENTEUER', icon: ICON.pve,
    tabs: [
      { href: '/dungeon', label: 'Dungeon', show: (l) => l.dungeonOpen() || l.currentUser.isAdmin },
      { href: '/ihk', label: 'IHK', show: (l) => l.ihkOpen() || l.currentUser.isAdmin },
      { href: '/grading', label: 'Grading', show: (l) => l.gradingOpen() || l.currentUser.isAdmin },
      { href: '/esports', label: 'eSports', show: (l) => l.esportsOpen(l.currentUser) },
    ],
  },
  { key: 'forum', title: 'Forum', sub: 'STAMMTISCH', icon: ICON.forum, tabs: [{ href: '/forum', label: 'Forum' }] },
  // nur Staff – ein normales Mitglied sieht unter /admin die 404-Seite im allgemeinen Fenster (verrät den Bereich nicht)
  { key: 'admin', title: (l) => (l.currentUser.isAdmin ? 'Admin' : 'Dev'), sub: 'HINTERZIMMER', icon: ICON.admin, show: (l) => !!l.currentUser.isStaff, tabs: [{ href: '/admin', label: 'Admin' }] },
  {
    key: 'profil', title: 'Profil', sub: 'DEIN ZIMMER', icon: ICON.profil,
    tabs: [{ href: me, label: 'Profil', match: '/profil' }, { href: '/konto', label: 'Konto' }, { href: '/kosmetik', label: 'Kosmetik' }],
    paths: ['/benachrichtigungen'],
  },
  {
    key: 'aushang', title: 'Aushang', sub: 'SCHWARZES BRETT', icon: ICON.aushang,
    // Patchnotes sind ein Forum-Bereich (Fenster „Forum“), „So geht's“ leitet auf die Regeln weiter
    tabs: [{ href: '/regeln', label: 'Regeln' }, { href: '/impressum', label: 'Impressum' }, { href: '/datenschutz', label: 'Datenschutz' }],
    paths: ['/so-gehts'],
  },
];
const GENERAL = { key: 'allgemein', sub: 'TAVERNE', icon: ICON.aushang };
const inPath = (path, p) => path === p || path.startsWith(p + '/');
/**
 * Bereich der Seite im Taverne-Stil für diese Locals (currentUser, currentPath, Helfer wie ihkOpen):
 * { key, title, sub, icon, tabs: [{ href, label, active }], tab (aktiver Reiter oder null), root } oder null.
 * root = Startseite eines Reiters (die Überschrift der Seite steht dann schon im Fensterkopf).
 */
function taverneSection(l) {
  const p = l.currentPath || '';
  if (!l.currentUser) return null;
  for (const s of TAVERNE_SECTIONS) {
    const all = s.tabs.map((t) => ({ ...t, href: typeof t.href === 'function' ? t.href(l) : t.href }));
    const hit = all.find((t) => inPath(p, t.match || t.href)) || null;
    if (!hit && !(s.paths || []).some((x) => inPath(p, x))) continue;
    if (s.show && !s.show(l)) break;
    const tabs = all.filter((t) => t === hit || !t.show || t.show(l)).map((t) => ({ href: t.href, label: t.label, active: t === hit }));
    return { key: s.key, title: typeof s.title === 'function' ? s.title(l) : s.title, sub: s.sub, icon: s.icon, tabs, tab: hit, root: !!hit && p === hit.href };
  }
  return { ...GENERAL, title: l.title || 'Taverne', tabs: [], tab: null, root: false };
}
const taverneTheme = (l) => !!taverneSection(l);

// ---------- HTML der Einträge (Leiste, Profil-Menü, HUD) – Texte sind eigene, feste Bezeichnungen ----------
const cap = (n) => (n > 99 ? '99+' : n);

function badgesHtml(it) {
  let h = '';
  it.badges.forEach((b) => {
    h += '<span class="nav-badge ' + b.cls + '" title="' + b.title + '" aria-label="' + b.aria + '">' + cap(b.n) + '</span>';
  });
  if (it.live) h += '<span class="nav-live" title="' + it.live + '" aria-label="' + it.live + '"></span>';
  return h;
}

function linkHtml(it) {
  return '<a href="' + it.href + '"' + (it.active ? ' class="active" aria-current="page"' : '') + '>' + it.label + badgesHtml(it) + '</a>';
}

// Leiste: Gruppe = Aufklappmenü (details, Animation in style.css, Hover/Schließen in app.js)
function topHtml(it) {
  if (!it.group) return linkHtml(it);
  return (
    '<details class="nav-group' + (it.active ? ' active' : '') + '" data-nav-group>' +
    '<summary' + (it.active ? ' class="active"' : '') + '>' + it.label + badgesHtml(it) +
    '<svg class="nav-group-chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>' +
    '<div class="nav-group-panel">' + it.items.map(linkHtml).join('') + '</div></details>'
  );
}

// Profil-Menü (Handy/Tablet): Gruppe = kleine Überschrift + Unterpunkte
function menuHtml(it) {
  if (!it.group) return linkHtml(it);
  return '<div class="menu-nav-group"><span class="menu-nav-head">' + it.label + '</span>' + it.items.map(linkHtml).join('') + '</div>';
}

module.exports = { buildNav, navGroup, cap, badgesHtml, linkHtml, topHtml, menuHtml, TAVERNE_SECTIONS, taverneSection, taverneTheme };

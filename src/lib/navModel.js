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

module.exports = { buildNav, navGroup, cap, badgesHtml, linkHtml, topHtml, menuHtml };

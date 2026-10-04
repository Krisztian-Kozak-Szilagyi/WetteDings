// Forum-Beiträge → sicheres HTML. Grundlage ist die einfache Auszeichnung der Patchnotes
// (# Überschrift, ## kleine Überschrift, - Liste, **fett**, __unterstrichen__).
// Dazu kommen die Rollen-Tags <admin>…</admin>, <dev>…</dev> und <mod>…</mod> (Groß-/Kleinschreibung egal):
// Sie werden als farbiger Kasten dargestellt. Fälschen geht nicht, weil beim Speichern alle Tags entschärft
// werden, die der Schreibende nicht benutzen darf (sanitizeTags) – im gespeicherten Text stehen nur echte.
// Außerdem Einbettungen als Vorschau-Kärtchen: [karte:<id>], [wette:<id>], [profil:<Name>] sowie eine Zeile, die nur
// aus /wetten/<id> oder /profil/<Name> besteht; @Name wird zum Profil-Link. Wetten und Namen lädt forum/embeds.js
// vorher für die ganze Seite (ctx) – was dort fehlt (unbekannt, nicht sichtbar), bleibt gewöhnlicher Text.
const mongoose = require('mongoose');
const { render: renderMarkup } = require('../patchnotes/render');
const catalog = require('../tcg/catalog');

const ROLE_TAGS = ['admin', 'dev', 'mod'];
const TAG_BLOCK = /<(admin|dev|mod)>([\s\S]*?)<\/\1>/gi;
const TAG_ANY = /<(\/?)(admin|dev|mod)>/gi;
const LABEL = { admin: 'ADMIN', dev: 'DEV', mod: 'MOD' };

/** Welche Tags darf eine Rolle schreiben? Der Admin alle, Dev und Mod nur das eigene. */
function tagsFor(role) {
  if (role === 'admin') return ['admin', 'dev', 'mod'];
  return ROLE_TAGS.includes(role) ? [role] : [];
}

/** Rollen-Tags, die in einem (gespeicherten) Text tatsächlich vorkommen */
function tagsIn(body) {
  const found = new Set();
  String(body || '').replace(TAG_ANY, (m, slash, tag) => found.add(tag.toLowerCase()));
  return [...found];
}

/** Nicht erlaubte Rollen-Tags entschärfen: <dev> wird zu ‹dev› und bleibt gewöhnlicher Text. */
function sanitizeTags(body, allowed) {
  const ok = new Set(allowed);
  return String(body || '').replace(TAG_ANY, (m, slash, tag) => (ok.has(tag.toLowerCase()) ? `<${slash}${tag.toLowerCase()}>` : `‹${slash}${tag}›`));
}

// ---------- Einbettungen ----------
const NAME = '[A-Za-z0-9_.-]{3,20}'; // wie usernameRules.NAME_PATTERN
const RE_CARD = /\[karte:([a-z0-9-]{1,80})\]/gi;
const RE_BET = /\[wette:([0-9a-f]{24})\]/gi;
const RE_PROFILE = new RegExp(`\\[profil:(${NAME})\\]`, 'gi');
// @Name: nicht mitten in einem Wort, einer Adresse (a@b.de) oder einem Pfad (davor darf "_" stehen: __@Name__);
// endet nicht auf . oder - (Satzzeichen)
const RE_MENTION = /(?<![A-Za-z0-9@/.-])@([A-Za-z0-9_][A-Za-z0-9_.-]{1,18}[A-Za-z0-9_])/g;
// alleinstehende interne Links (die ganze Zeile) – nur Pfade dieser Seite, nie fremde Adressen
const RE_BARE = new RegExp(`^([ \\t]*)(?:/wetten/([0-9a-f]{24})|/profil/(${NAME}))[ \\t]*$`, 'gim');
const REFS_MAX = 200; // je Art und Seite
const STATUS = { offen: 'Offen', entschieden: 'Entschieden', annulliert: 'Annulliert' };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const euroFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const validBetId = (id) => /^[0-9a-f]{24}$/i.test(id) && mongoose.isValidObjectId(id);

/** Zeilen, die nur aus /wetten/<id> oder /profil/<Name> bestehen, in die Kurzform umschreiben */
const bareToShort = (text) => String(text || '').replace(RE_BARE, (m, sp, bet, name) => (bet ? `${sp}[wette:${bet}]` : `${sp}[profil:${name}]`));

/** Erwähnte Namen (klein geschrieben, ohne Doppelte) – für Benachrichtigungen und das Nachladen */
function parseMentions(body) {
  const out = new Set();
  for (const m of String(body || '').matchAll(RE_MENTION)) {
    const name = m[1].toLowerCase();
    out.add(name);
    const short = name.replace(/[_.-]+$/, ''); // "@max__" kann auch "max" meinen (siehe embedder)
    if (short !== name && short.length >= 3) out.add(short);
  }
  return [...out];
}

/** Alle Verweise aus mehreren Beiträgen sammeln (je Art eine Abfrage statt einer pro Beitrag) */
function collectRefs(bodies) {
  const bets = new Set();
  const names = new Set();
  for (const raw of bodies) {
    const text = bareToShort(raw);
    for (const m of text.matchAll(RE_BET)) if (validBetId(m[1])) bets.add(m[1].toLowerCase());
    for (const m of text.matchAll(RE_PROFILE)) names.add(m[1].toLowerCase());
    parseMentions(text).forEach((n) => names.add(n));
  }
  return { bets: [...bets].slice(0, REFS_MAX), names: [...names].slice(0, REFS_MAX) };
}

const profileHref = (name) => `/profil/${encodeURIComponent(name)}`;

function cardHtml(id) {
  const card = catalog.cardById[id.toLowerCase()];
  const r = card && catalog.rarityByKey[card.rarity];
  if (!card || !r || r.hidden) return null; // geheime Seltenheiten verrät die Vorschau nicht
  return (
    `<span class="forum-embed forum-embed-card r-${esc(card.rarity)}"><img src="${esc(card.image)}" alt="" width="36" height="50" loading="lazy">` +
    `<span class="forum-embed-text"><span class="forum-embed-title">${esc(card.name)}</span><span class="forum-embed-sub"><span class="tcg-dot"></span>${esc(r.label)}</span></span></span>`
  );
}

function betHtml(id, bets) {
  const key = id.toLowerCase();
  const bet = bets && bets.get(key);
  // unbekannt oder für alle nicht sichtbar (Gruppen-Wette, Duell-Anfrage): nur der Link, ohne Details
  if (!bet) return validBetId(key) ? `<a href="/wetten/${key}">/wetten/${key}</a>` : null;
  return (
    `<a class="forum-embed forum-embed-bet" href="/wetten/${key}"><span class="forum-embed-text"><span class="forum-embed-kicker">${bet.duel ? 'Duell' : 'Wette'}</span>` +
    `<span class="forum-embed-title">${esc(bet.title)}</span><span class="forum-embed-sub">${esc(STATUS[bet.status] || bet.status)} · Topf ${esc(euroFmt.format((bet.pot || 0) / 100))}</span></span></a>`
  );
}

function profileHtml(name, users) {
  const real = users && users.get(name.toLowerCase());
  if (!real) return null;
  return `<a class="forum-embed forum-embed-user" href="${esc(profileHref(real))}"><img class="forum-embed-avatar" src="/img/avatar-placeholder.svg" alt="" width="24" height="24"><span class="forum-embed-title">${esc(real)}</span></a>`;
}

// Einbettungen im (schon maskierten) Text einer Zeile ersetzen; keep schützt das HTML vor Fett und Unterstreichen
const embedder =
  ({ bets = null, users = null } = {}) =>
  (h, keep) => {
    const swap = (html, m) => (html ? keep(html) : m);
    return h
      .replace(RE_CARD, (m, id) => swap(cardHtml(id), m))
      .replace(RE_BET, (m, id) => swap(betHtml(id, bets), m))
      .replace(RE_PROFILE, (m, name) => swap(profileHtml(name, users), m))
      .replace(RE_MENTION, (m, name) => {
        // "@max__" (z. B. in __@max__): erst den ganzen Namen, dann ohne die Zeichen am Ende versuchen
        const short = name.replace(/[_.-]+$/, '');
        const hit = users && (users.has(name.toLowerCase()) ? name : users.has(short.toLowerCase()) ? short : null);
        if (!hit) return m;
        const real = users.get(hit.toLowerCase());
        return keep(`<a class="user-link forum-mention" href="${esc(profileHref(real))}">@${esc(real)}</a>`) + name.slice(hit.length);
      });
  };

/** ctx (optional): { bets: Map id → { title, status, pot, duel }, users: Map Name (klein) → Name } aus forum/embeds.js */
function render(body, ctx = {}) {
  const text = bareToShort(body);
  const opts = { embed: embedder(ctx) };
  const out = [];
  let last = 0;
  text.replace(TAG_BLOCK, (m, tag, inner, index) => {
    const before = text.slice(last, index);
    if (before.trim()) out.push(renderMarkup(before, opts));
    const role = tag.toLowerCase();
    out.push(`<div class="role-say role-say-${role}"><span class="role-say-label" data-text="${LABEL[role]}">${LABEL[role]}</span>${renderMarkup(inner, opts)}</div>`);
    last = index + m.length;
    return m;
  });
  const rest = text.slice(last);
  if (rest.trim()) out.push(renderMarkup(rest, opts));
  return out.join('\n');
}

module.exports = { ROLE_TAGS, tagsFor, tagsIn, sanitizeTags, parseMentions, collectRefs, render };

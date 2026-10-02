// Forum-Beiträge → sicheres HTML. Grundlage ist die einfache Auszeichnung der Patchnotes
// (# Überschrift, ## kleine Überschrift, - Liste, **fett**, __unterstrichen__).
// Dazu kommen die Rollen-Tags <admin>…</admin>, <dev>…</dev> und <mod>…</mod> (Groß-/Kleinschreibung egal):
// Sie werden als farbiger Kasten dargestellt. Fälschen geht nicht, weil beim Speichern alle Tags entschärft
// werden, die der Schreibende nicht benutzen darf (sanitizeTags) – im gespeicherten Text stehen nur echte.
const { render: renderMarkup } = require('../patchnotes/render');

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

function render(body) {
  const text = String(body || '');
  const out = [];
  let last = 0;
  text.replace(TAG_BLOCK, (m, tag, inner, index) => {
    const before = text.slice(last, index);
    if (before.trim()) out.push(renderMarkup(before));
    const role = tag.toLowerCase();
    out.push(`<div class="role-say role-say-${role}"><span class="role-say-label" data-text="${LABEL[role]}">${LABEL[role]}</span>${renderMarkup(inner)}</div>`);
    last = index + m.length;
    return m;
  });
  const rest = text.slice(last);
  if (rest.trim()) out.push(renderMarkup(rest));
  return out.join('\n');
}

module.exports = { ROLE_TAGS, tagsFor, tagsIn, sanitizeTags, render };

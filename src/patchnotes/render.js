// Einfache Auszeichnung für Patchnotes → sicheres HTML. Alles wird zuerst maskiert, erlaubt ist nur:
//   "# Text"   große Überschrift        "## Text"  kleine Überschrift
//   "- Text"   Aufzählungspunkt         Leerzeile  neuer Absatz
//   **fett**   __unterstrichen__

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// Eine Zeile → HTML. embed (optional, z. B. aus forum/render.js) bekommt den bereits maskierten Text und eine
// Funktion keep(html): Was damit ersetzt wird, bleibt von Fett und Unterstreichen unberührt.
function inline(s, embed) {
  let h = esc(s);
  const kept = [];
  if (embed) h = embed(h, (html) => `\u0000${kept.push(html) - 1}\u0000`);
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<u>$1</u>');
  return kept.length ? h.replace(/\u0000(\d+)\u0000/g, (m, i) => kept[i]) : h;
}

function render(text, { embed = null } = {}) {
  const out = [];
  let list = [];
  let para = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join('')}</ul>`);
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
    list = [];
    para = [];
  };
  for (const raw of String(text || '').replace(/\u0000/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if (!line) flush();
    else if ((m = line.match(/^(#{1,2})\s+(.+)$/))) {
      flush();
      out.push(m[1].length === 1 ? `<h3 class="pn-h1">${inline(m[2], embed)}</h3>` : `<h4 class="pn-h2">${inline(m[2], embed)}</h4>`);
    } else if ((m = line.match(/^[-*]\s+(.+)$/))) {
      if (para.length) flush();
      list.push(inline(m[1], embed));
    } else {
      if (list.length) flush();
      para.push(inline(line, embed));
    }
  }
  flush();
  return out.join('\n');
}

module.exports = { render };

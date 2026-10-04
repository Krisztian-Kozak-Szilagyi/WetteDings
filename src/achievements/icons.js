// Symbole der Erfolge als SVG (/img/erfolge/<key>.svg): sechseckige Medaille mit Metallrahmen und Motiv.
// F = Füllung des Motivs (Metallverlauf), S = Linienfarbe des Motivs, D = dunkle Farbe für Ausschnitte.

const TONES = {
  bronze: ['#ffe0bd', '#d0915a', '#6e3f1c'],
  silver: ['#ffffff', '#bcc4d8', '#5e667a'],
  gold: ['#fff3c4', '#e7b84a', '#8c5f16'],
  violet: ['#efedff', '#a99cf0', '#4a4078'],
  green: ['#dcffe9', '#4ade80', '#14633a'],
  red: ['#ffdada', '#f87171', '#7f1d1d'],
  blue: ['#e6f5ff', '#9fd3ff', '#28598a'],
  legend: ['#ffd6f6', '#b48cf2', '#45d9ff'],
};

const GLYPHS = {
  hermann:
    '<rect x="45" y="30" width="38" height="56" rx="6" fill="F" transform="rotate(-8 64 58)"/>' +
    '<path d="M69 38 L54 62 H64 L58 82 L77 54 H67 L73 38Z" fill="D"/>' +
    '<circle cx="64" cy="60" r="33" fill="none" stroke="#ff5b5b" stroke-width="7"/><path d="M41 37 L87 83" stroke="#ff5b5b" stroke-width="7" stroke-linecap="round"/>',
  oemer:
    '<path d="M32 80 L28 44 L46 60 L64 34 L82 60 L100 44 L96 80Z" fill="F"/><rect x="32" y="84" width="64" height="9" rx="3" fill="F"/>' +
    '<circle cx="28" cy="42" r="5" fill="F"/><circle cx="64" cy="32" r="5" fill="F"/><circle cx="100" cy="42" r="5" fill="F"/>' +
    '<text x="64" y="75" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="17" fill="D">21%</text>',
  aleks:
    '<path d="M34 64 C34 40 48 30 64 30 C80 30 94 40 94 64Z" fill="F"/>' +
    '<path d="M32 70 v20 a6 6 0 0 0 12 0 v-20z M84 70 v20 a6 6 0 0 0 12 0 v-20z" fill="F" opacity=".8"/>' +
    '<path d="M64 31 V58" stroke="D" stroke-width="2" opacity=".45"/>' +
    '<path d="M28 66 q4 -9 9 -7 q4 -4 9 -1 q4 -4 9 -1 q4 -4 9 -1 q5 -3 9 1 q5 -3 9 1 q5 -2 9 1 q6 0 6 7 q0 7 -6 8 h-58 q-6 -1 -6 -8z" fill="F"/>' +
    '<path d="M28 66 q4 -9 9 -7 q4 -4 9 -1 q4 -4 9 -1 q4 -4 9 -1 q5 -3 9 1 q5 -3 9 1 q5 -2 9 1 q6 0 6 7 q0 7 -6 8 h-58 q-6 -1 -6 -8z" fill="#fff" opacity=".22"/>' +
    '<g stroke="D" stroke-width="1.6" opacity=".35" stroke-linecap="round"><path d="M36 64 v6 M44 63 v7 M52 63 v7 M76 63 v7 M84 63 v7 M92 64 v6"/></g>' +
    '<path d="M64 57 l3.1 6.3 7 1 -5 4.9 1.2 6.9 -6.3 -3.3 -6.3 3.3 1.2 -6.9 -5 -4.9 7 -1z" fill="#ff4d4d"/>',
  target:
    '<circle cx="62" cy="66" r="30" fill="none" stroke="S" stroke-width="6"/><circle cx="62" cy="66" r="17" fill="none" stroke="S" stroke-width="6"/>' +
    '<circle cx="62" cy="66" r="6" fill="F"/><path d="M64 64 L92 36" stroke="S" stroke-width="5" stroke-linecap="round"/>' +
    '<path d="M90 26 l4 10 10 4 -8 6 -10 -4 -4 -10z" fill="F"/>',
  orb:
    '<circle cx="64" cy="56" r="27" fill="F"/><circle cx="64" cy="56" r="27" fill="none" stroke="D" stroke-width="2" opacity=".5"/>' +
    '<path d="M49 49 a16 16 0 0 1 13 -12" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" opacity=".85"/>' +
    '<path d="M73 60 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" fill="#fff" opacity=".9"/>' +
    '<path d="M42 96 h44 l-7 -13 h-30z" fill="F"/><rect x="38" y="95" width="52" height="6" rx="3" fill="F"/>',
  dice:
    '<rect x="34" y="34" width="60" height="60" rx="13" fill="F" transform="rotate(-10 64 64)"/>' +
    '<g fill="D" transform="rotate(-10 64 64)"><circle cx="48" cy="48" r="6"/><circle cx="80" cy="48" r="6"/><circle cx="64" cy="64" r="6"/><circle cx="48" cy="80" r="6"/><circle cx="80" cy="80" r="6"/></g>',
  sabers:
    '<g stroke="S" stroke-linecap="round"><path d="M36 32 L86 82" stroke-width="6"/><path d="M92 32 L42 82" stroke-width="6"/>' +
    '<path d="M78 92 L94 76" stroke-width="5"/><path d="M34 76 L50 92" stroke-width="5"/><path d="M88 86 L96 94" stroke-width="7"/><path d="M40 86 L32 94" stroke-width="7"/></g>',
  scales:
    '<path d="M64 32 V92 M46 94 H82 M34 42 H94" stroke="S" stroke-width="5" stroke-linecap="round" fill="none"/>' +
    '<path d="M34 42 L24 66 M34 42 L44 66 M94 42 L84 66 M94 42 L104 66" stroke="S" stroke-width="2.5" stroke-linecap="round"/>' +
    '<path d="M22 66 a12 8 0 0 0 24 0z M82 66 a12 8 0 0 0 24 0z" fill="F"/><circle cx="64" cy="30" r="5" fill="F"/>',
  clover:
    '<path d="M66 64 q14 16 6 34" stroke="S" stroke-width="5" fill="none" stroke-linecap="round"/>' +
    '<g fill="F"><circle cx="51" cy="49" r="14"/><circle cx="77" cy="49" r="14"/><circle cx="51" cy="75" r="14"/><circle cx="77" cy="75" r="14"/></g>' +
    '<g stroke="D" stroke-width="2" opacity=".55"><path d="M64 62 L52 50 M64 62 L76 50 M64 62 L52 74 M64 62 L76 74"/></g>',
  chart:
    '<path d="M30 94 H100 M30 94 V34" stroke="S" stroke-width="4" stroke-linecap="round" opacity=".7"/>' +
    '<path d="M36 84 L54 64 L68 74 L92 46" stroke="S" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M78 40 H100 V62 Z" fill="F"/>',
  glitch:
    '<g fill="none" stroke-width="6"><rect x="35" y="38" width="50" height="50" rx="7" stroke="#ff4fd8" opacity=".85"/>' +
    '<rect x="44" y="40" width="50" height="50" rx="7" stroke="#45d9ff" opacity=".85"/><rect x="39" y="39" width="50" height="50" rx="7" stroke="S"/></g>' +
    '<rect x="28" y="58" width="44" height="5" fill="F"/><rect x="58" y="72" width="42" height="4" fill="#45d9ff"/><rect x="40" y="48" width="18" height="3" fill="#ff4fd8"/>',
  cards:
    '<rect x="46" y="34" width="36" height="52" rx="5" fill="F" opacity=".45" transform="rotate(-16 64 60)"/>' +
    '<rect x="46" y="34" width="36" height="52" rx="5" fill="F" opacity=".7" transform="rotate(9 64 60)"/>' +
    '<rect x="46" y="40" width="36" height="52" rx="5" fill="F"/>' +
    '<path d="M64 54 l4 8.5 9.3 1.2 -6.8 6.4 1.7 9.2 -8.2 -4.5 -8.2 4.5 1.7 -9.2 -6.8 -6.4 9.3 -1.2z" fill="D"/>',
  swap:
    '<path d="M32 50 H84" stroke="S" stroke-width="7" stroke-linecap="round"/><path d="M82 36 L100 50 L82 64 Z" fill="F"/>' +
    '<path d="M96 80 H44" stroke="S" stroke-width="7" stroke-linecap="round"/><path d="M46 66 L28 80 L46 94 Z" fill="F"/>',
  briefcase:
    '<path d="M52 46 V38 a5 5 0 0 1 5 -5 h14 a5 5 0 0 1 5 5 V46" fill="none" stroke="S" stroke-width="5"/>' +
    '<rect x="28" y="45" width="72" height="48" rx="8" fill="F"/>' +
    '<path d="M49 69 l10 10 l21 -21" stroke="D" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  loupe:
    '<circle cx="57" cy="57" r="23" fill="none" stroke="S" stroke-width="7"/><path d="M74 74 L96 96" stroke="S" stroke-width="11" stroke-linecap="round"/>' +
    '<text x="57" y="65" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="22" fill="F">10</text>',
  hourglass:
    '<path d="M40 34 H88 M40 96 H88" stroke="S" stroke-width="7" stroke-linecap="round"/>' +
    '<path d="M46 36 C46 56 61 59 61 65 C61 71 46 74 46 94 H82 C82 74 67 71 67 65 C67 59 82 56 82 36Z" fill="none" stroke="S" stroke-width="4"/>' +
    '<path d="M51 91 Q64 74 77 91Z M54 44 H74 Q64 57 54 44Z" fill="F"/><path d="M64 60 V80" stroke="F" stroke-width="2" stroke-dasharray="3 3"/>',
  secret: '<text x="64" y="84" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="58" fill="F">?</text>',
  halo:
    '<path d="M42 34 a22 7 0 0 1 36 -5" fill="none" stroke="S" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M84 32 a22 7 0 0 1 -30 9" fill="none" stroke="S" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M64 46 V92" stroke="S" stroke-width="7" stroke-linecap="round"/><path d="M47 58 H81" stroke="S" stroke-width="6" stroke-linecap="round"/>' +
    '<path d="M57 92 L64 106 L71 92Z" fill="F"/><circle cx="64" cy="46" r="5" fill="F"/>',
};

const DARK = '#171826';

/** SVG eines Erfolgs; `icon` aus list.js */
function render(icon) {
  const glyph = GLYPHS[icon.glyph] || '';
  const [g1, g2, g3] = TONES[icon.tone] || TONES.silver;
  const [f1, f2, f3] = TONES[icon.frame] || TONES.silver;
  const body = glyph.replace(/="F"/g, '="url(#g)"').replace(/="S"/g, '="url(#g)"').replace(/="D"/g, `="${DARK}"`);
  const hex = (r) => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      pts.push(`${(64 + r * Math.cos(a)).toFixed(1)},${(64 + r * Math.sin(a)).toFixed(1)}`);
    }
    return pts.join(' ');
  };
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">' +
    '<defs>' +
    `<linearGradient id="f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${f1}"/><stop offset=".5" stop-color="${f2}"/><stop offset="1" stop-color="${f3}"/></linearGradient>` +
    `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="28" x2="0" y2="104"><stop offset="0" stop-color="${g1}"/><stop offset=".55" stop-color="${g2}"/><stop offset="1" stop-color="${g3}"/></linearGradient>` +
    '<radialGradient id="b" cx=".5" cy=".35" r=".75"><stop offset="0" stop-color="#34304f"/><stop offset="1" stop-color="#11121c"/></radialGradient>' +
    '</defs>' +
    `<polygon points="${hex(58)}" fill="url(#f)" stroke="url(#f)" stroke-width="8" stroke-linejoin="round"/>` +
    `<polygon points="${hex(50)}" fill="url(#b)" stroke="${DARK}" stroke-width="3" stroke-linejoin="round"/>` +
    `<polygon points="${hex(46)}" fill="none" stroke="url(#f)" stroke-width="1" opacity=".35" stroke-linejoin="round"/>` +
    `<g>${body}</g>` +
    '<path d="M20 40 L64 12 L108 40" fill="none" stroke="#fff" stroke-width="2" opacity=".18" stroke-linecap="round"/>' +
    '</svg>'
  );
}

module.exports = { render, GLYPHS, TONES };

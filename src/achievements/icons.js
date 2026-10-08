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

/** Kette aus Gliedern von (x1,y1) nach (x2,y2): abwechselnd von oben und von der Seite gesehen */
function chain(x1, y1, x2, y2, n = 9) {
  const ang = ((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI).toFixed(1);
  let out = '';
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const x = +(x1 + (x2 - x1) * t).toFixed(1);
    const y = +(y1 + (y2 - y1) * t).toFixed(1);
    const rot = `transform="rotate(${ang} ${x} ${y})"`;
    out +=
      i % 2
        ? `<rect x="${x - 6}" y="${y - 1.6}" width="12" height="3.2" rx="1.6" fill="#d7dde9" stroke="#3b4150" stroke-width="1" ${rot}/>`
        : `<ellipse cx="${x}" cy="${y}" rx="6.5" ry="3.8" fill="none" stroke="#3b4150" stroke-width="4.6" ${rot}/>` +
          `<ellipse cx="${x}" cy="${y}" rx="6.5" ry="3.8" fill="none" stroke="#d7dde9" stroke-width="2.6" ${rot}/>`;
  }
  return out;
}

const GLYPHS = {
  // zu starke Karte: glüht vor Kraft, liegt aber in Ketten mit Schloss
  hermann:
    '<g stroke="F" stroke-width="3" stroke-linecap="round" opacity=".9"><path d="M40 30 l-7 -7 M88 30 l7 -7 M34 58 h-9 M94 58 h9 M64 18 v-8"/></g>' +
    '<rect x="44" y="24" width="40" height="60" rx="6" fill="F"/>' +
    '<rect x="48" y="28" width="32" height="52" rx="4" fill="none" stroke="D" stroke-width="1.5" opacity=".35"/>' +
    '<path d="M69 32 L55 56 H64 L58 76 L76 49 H67 L73 32Z" fill="D"/>' +
    chain(30, 43, 98, 90) +
    chain(98, 43, 30, 90) +
    '<path d="M56 76 v-6 a8 8 0 0 1 16 0 v6" fill="none" stroke="#d7dde9" stroke-width="4"/>' +
    '<rect x="51" y="75" width="26" height="21" rx="4" fill="#e04848" stroke="#5a1010" stroke-width="2"/>' +
    '<circle cx="64" cy="84" r="3" fill="#3a0a0a"/><rect x="62.6" y="85" width="2.8" height="6" rx="1" fill="#3a0a0a"/>',
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
  // Karte mit Regenbogen-Schimmer
  holo:
    '<rect x="42" y="30" width="44" height="64" rx="6" fill="F"/>' +
    '<g opacity=".8"><path d="M46 62 L70 34 H78 L46 72Z" fill="#ff4fd8"/><path d="M46 76 L80 36 V44 L50 84 H46Z" fill="#45d9ff"/><path d="M58 90 L82 62 V70 L66 90Z" fill="#fde047"/></g>' +
    '<rect x="42" y="30" width="44" height="64" rx="6" fill="none" stroke="D" stroke-width="2" opacity=".5"/>',
  // Los mit Lochrand und Stern
  ticket:
    '<path d="M28 46 H100 V56 a8 8 0 0 0 0 16 V82 H28 V72 a8 8 0 0 0 0 -16Z" fill="F"/>' +
    '<path d="M48 48 V80" stroke="D" stroke-width="2" stroke-dasharray="4 3" opacity=".6"/>' +
    '<path d="M74 52 l3.4 7 7.6 1 -5.5 5.3 1.4 7.6 -6.9 -3.7 -6.9 3.7 1.4 -7.6 -5.5 -5.3 7.6 -1z" fill="D"/>',
  // aufgeschlagenes Album mit Haken
  album:
    '<path d="M64 40 C54 33 40 32 28 34 V90 C40 88 54 89 64 96 C74 89 88 88 100 90 V34 C88 32 74 33 64 40Z" fill="F"/>' +
    '<path d="M64 40 V96" stroke="D" stroke-width="2" opacity=".5"/>' +
    '<g fill="D" opacity=".35"><rect x="35" y="44" width="10" height="14" rx="1.5"/><rect x="48" y="44" width="10" height="14" rx="1.5"/><rect x="35" y="63" width="10" height="14" rx="1.5"/><rect x="48" y="63" width="10" height="14" rx="1.5"/></g>' +
    '<path d="M72 64 l7 7 l14 -16" stroke="D" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  loupe50:
    '<circle cx="57" cy="57" r="23" fill="none" stroke="S" stroke-width="7"/><path d="M74 74 L96 96" stroke="S" stroke-width="11" stroke-linecap="round"/>' +
    '<text x="57" y="65" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="22" fill="F">50</text>',
  // Dungeon-Tor mit Fallgitter und „10“
  gate:
    '<path d="M32 98 V54 a32 32 0 0 1 64 0 V98Z" fill="F"/>' +
    '<path d="M42 98 V56 a22 22 0 0 1 44 0 V98Z" fill="D"/>' +
    '<g stroke="S" stroke-width="3" opacity=".75"><path d="M50 40 V98 M64 34 V98 M78 40 V98 M42 62 H86 M42 80 H86"/></g>' +
    '<text x="64" y="76" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="20" fill="F" stroke="#171826" stroke-width="3" paint-order="stroke">10</text>',
  // Energydrink-Dose mit Blitz
  can:
    '<rect x="44" y="30" width="40" height="68" rx="7" fill="F"/>' +
    '<path d="M48 30 H80 M48 98 H80" stroke="D" stroke-width="3" opacity=".45"/><rect x="56" y="24" width="16" height="6" rx="2" fill="F"/>' +
    '<path d="M68 40 L54 66 H63 L57 88 L75 58 H66 L72 40Z" fill="D"/>',
  // Profilbild: Kopf und Schultern im abgerundeten Rahmen
  avatar:
    '<rect x="32" y="30" width="64" height="68" rx="10" fill="none" stroke="S" stroke-width="5"/>' +
    '<circle cx="64" cy="56" r="13" fill="F"/><path d="M40 92 C42 76 52 71 64 71 C76 71 86 76 88 92Z" fill="F"/>',
  // Karte im Schredder: oben ein Kartenrest, unten die Streifen
  shredder:
    '<rect x="46" y="26" width="36" height="26" rx="4" fill="F"/>' +
    '<rect x="30" y="50" width="68" height="16" rx="4" fill="S"/>' +
    '<g fill="F"><rect x="48" y="70" width="5" height="26" rx="1.5"/><rect x="57" y="70" width="5" height="20" rx="1.5"/><rect x="66" y="70" width="5" height="28" rx="1.5"/><rect x="75" y="70" width="5" height="22" rx="1.5"/></g>',
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

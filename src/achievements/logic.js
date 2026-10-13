// Reine Hilfsfunktionen für Profiltext und Erfolge (ohne Datenbank, siehe test/achievements.test.js)

const BIO_MAX = 300;
const BIO_MAX_LINES = 8;
const PIN_MAX = 2;

/**
 * Profiltext bereinigen: Steuerzeichen raus, Zeilenenden vereinheitlichen, höchstens eine Leerzeile am Stück,
 * höchstens BIO_MAX_LINES Zeilen und BIO_MAX Zeichen (nach Unicode-Zeichen gezählt, Emojis zählen einfach).
 */
function cleanBio(input) {
  let t = typeof input === 'string' ? input : '';
  t = t.replace(/\r\n?/g, '\n');
  t = t.replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ''); // auch Richtungs-Steuerzeichen
  t = t
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const lines = t.split('\n');
  if (lines.length > BIO_MAX_LINES) t = lines.slice(0, BIO_MAX_LINES).join('\n');
  const chars = Array.from(t);
  if (chars.length > BIO_MAX) t = chars.slice(0, BIO_MAX).join('').trim();
  return t;
}

/**
 * Erfolg an- oder abheften. Schon angeheftet → wird gelöst; sonst hinten angefügt, bei mehr als PIN_MAX fällt
 * der älteste heraus. Nur Erfolge aus `earned` (die man hat) zählen; Unbekanntes verschwindet.
 */
function togglePin(pinned, key, earned) {
  const have = new Set(earned);
  const list = (Array.isArray(pinned) ? pinned : []).filter((k) => have.has(k));
  if (list.includes(key)) return list.filter((k) => k !== key);
  if (!have.has(key)) return list.slice(-PIN_MAX);
  return [...list, key].slice(-PIN_MAX);
}

/** Stufe des Abzeichens mit der Zahl der Erfolge (Farbe in "Spielt oft mit") */
function countTier(n) {
  if (n >= 10) return 'mythic';
  if (n >= 6) return 'gold';
  if (n >= 3) return 'silver';
  if (n >= 1) return 'bronze';
  return 'none';
}

/**
 * Liste für das Profil: freigeschaltete zuerst (neueste oben), danach die gesperrten in Listenreihenfolge.
 * Einzelstücke, die man nicht hat, erscheinen gar nicht; geheime gesperrte ohne Namen und Text.
 * `share` = Anteil der Mitglieder (0–1) mit diesem Erfolg.
 */
function profileList(all, earnedDocs, counts = {}, members = 0) {
  const got = new Map(earnedDocs.map((d) => [d.key, d]));
  const rows = all
    .filter((a) => got.has(a.key) || !a.unique)
    .map((a) => {
      const doc = got.get(a.key);
      const n = counts[a.key] || 0;
      return {
        key: a.key,
        earned: !!doc,
        earnedAt: doc ? doc.earnedAt : null,
        hidden: !doc && !!a.secret,
        name: !doc && a.secret ? 'Geheimer Erfolg' : a.name,
        text: !doc && a.secret ? 'Was hier freigeschaltet wird, findest du selbst heraus.' : a.text,
        unique: !!a.unique,
        share: members ? Math.min(1, n / members) : 0,
      };
    });
  const earned = rows.filter((r) => r.earned).sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt));
  return [...earned, ...rows.filter((r) => !r.earned)];
}

const num = (n, digits = 0) => n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** Ein Wert eines Fortschritt-Teils als Text (kind wie in list.js: euro = Cent, hours = Sekunden, times = Faktor) */
function amountText(v, kind) {
  if (kind === 'euro') return `${num(Math.trunc(v / 100))} €`;
  if (kind === 'hours') return `${num(Math.floor(v / 3600))} Std.`;
  if (kind === 'times') return `${num(v, Number.isInteger(v) ? 0 : 1)}×`;
  return num(v);
}

/**
 * Fortschritt eines gesperrten Erfolgs für die Anzeige: pct = Mittel der (auf 0–100 % begrenzten) Teile,
 * text z. B. "12 / 25 gewonnene Wetten" oder "3 / 5 Siege · 1 / 3 Gegner". Ohne gültige Teile: null.
 */
function progressView(parts) {
  const list = (Array.isArray(parts) ? parts : []).filter((p) => p && Number.isFinite(p.have) && Number.isFinite(p.need) && p.need > 0);
  if (!list.length) return null;
  const pct = Math.floor((list.reduce((s, p) => s + Math.min(1, Math.max(0, p.have / p.need)), 0) / list.length) * 100);
  const text = list.map((p) => `${amountText(p.have, p.kind)} / ${amountText(p.need, p.kind)}${p.label ? ` ${p.label}` : ''}`).join(' · ');
  return { pct: Math.min(pct, 99), text }; // gesperrt = nie ganz voll (fertig zeigt erst die Vergabe)
}

/** Anteil als Text, z. B. "12 %", unter 1 % "< 1 %" */
function shareText(share) {
  if (!share) return '0 %';
  const p = share * 100;
  return p < 1 ? '< 1 %' : `${Math.round(p)} %`;
}

module.exports = { BIO_MAX, BIO_MAX_LINES, PIN_MAX, cleanBio, togglePin, countTier, profileList, shareText, progressView };

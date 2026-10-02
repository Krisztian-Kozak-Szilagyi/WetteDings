class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

/** Formularfelder können bei doppelten Namen Arrays sein – wir akzeptieren nur Strings. */
function str(value) {
  return typeof value === 'string' ? value : '';
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "12,50" / "12.5" / "1.000" / "1.000,50" -> Cent. Ungültig -> null */
function parseEuro(input) {
  let s = str(input).trim().replace(/[\s€]/g, '');
  if (!s) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d{1,9}([.,]\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split(/[.,]/);
  return parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
}

/** Zeigt die Adresse auf diese Seite selbst? (nur Pfade wie "/konto", keine fremden Hosts) */
function isLocalUrl(target) {
  const t = str(target);
  if (!t.startsWith('/') || t.startsWith('//') || t.startsWith('/\\')) return false;
  try {
    return new URL(t, 'https://lokal.invalid').origin === 'https://lokal.invalid';
  } catch {
    return false;
  }
}

/** Sicheres Weiterleitungsziel (nur lokale Pfade) */
function safeRedirect(target, fallback = '/') {
  const t = str(target);
  return isLocalUrl(t) ? t : fallback;
}

module.exports = { UserError, str, escapeRegex, parseEuro, isLocalUrl, safeRedirect };

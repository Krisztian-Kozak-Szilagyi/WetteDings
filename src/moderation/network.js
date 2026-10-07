// Manipulationserkennung: Kommt eine Anfrage aus einem Rechenzentrum (gemieteter Server, Cloud)? Von zu Hause oder
// unterwegs spielt niemand von dort – ein Skript läuft dagegen oft auf einem Server. Dafür wird die IP beim Eintreffen
// in der Datenbank GeoLite2-ASN nachgeschlagen; gespeichert wird nur das Ergebnis (Netzbetreiber), nie die IP.
// Ohne Datenbank (Umgebungsvariable GEOIP_ASN_DB nicht gesetzt) ist diese Prüfung aus.
const maxmind = require('maxmind');

// Netze großer Hoster und Cloud-Anbieter (Autonome Systeme)
const HOSTING_ASN = new Set([
  16509, 14618, 8987, // Amazon AWS
  15169, 396982, 19527, // Google Cloud
  8075, 8068, // Microsoft Azure
  24940, 213230, // Hetzner
  16276, 35540, // OVH
  14061, // DigitalOcean
  63949, // Linode/Akamai Cloud
  20473, // Vultr
  51167, // Contabo
  31898, // Oracle Cloud
  45102, 37963, // Alibaba
  132203, 45090, // Tencent
  12876, // Scaleway
  60781, 28753, // Leaseweb
  9009, // M247
  212238, // Datacamp
  197540, // netcup
  8560, // IONOS
  46606, // Unified Layer
  36352, // ColoCrossing
  62240, // Clouvider
  40021, // Contabo US
]);
// iCloud Private Relay und Cloudflare WARP laufen über diese Netze – das sind normale Handys, keine Server
const RELAY_ASN = new Set([13335, 36183, 20940, 54113]);
const HOSTING_WORDS = /hosting|server|data ?cent(er|re)|colo(cation)?|vps|dedicated|cloud/i;

let reader = null;
let loading = null;

/** Datenbank einmal laden (im Hintergrund); bis dahin liefert lookup() null */
function ensure() {
  if (reader || loading || !process.env.GEOIP_ASN_DB) return;
  loading = maxmind
    .open(process.env.GEOIP_ASN_DB)
    .then((r) => {
      reader = r;
    })
    .catch((err) => console.error('GeoLite2-ASN konnte nicht geladen werden:', err.message));
}

/** Gehört dieser Netzbetreiber zu einem Rechenzentrum? */
function isHosting(asn, org = '') {
  if (!asn || RELAY_ASN.has(asn)) return false;
  return HOSTING_ASN.has(asn) || HOSTING_WORDS.test(org);
}

/** { asn, org, hosting } zu einer IP oder null (keine Datenbank, unbekannte IP) */
function lookup(ip) {
  ensure();
  if (!reader || !ip) return null;
  try {
    const r = reader.get(String(ip).replace(/^::ffff:/, ''));
    if (!r) return null;
    const asn = r.autonomous_system_number;
    const org = r.autonomous_system_organization || '';
    return { asn, org, hosting: isHosting(asn, org) };
  } catch {
    return null;
  }
}

/** Netz einer IP für den Vergleich: IPv4 ganz, IPv6 nur der Netzanteil (/64) – der Rest wechselt von selbst */
function netOf(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (!s.includes(':')) return s;
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return full.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

module.exports = { lookup, isHosting, netOf, ensure, HOSTING_ASN, RELAY_ASN };

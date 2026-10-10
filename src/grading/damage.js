// Schaden im Spiel (#204): Wer eine Quest, einen Dungeon oder den Mage Tower verliert, riskiert Kratzer auf den
// eingesetzten Karten – selten auch einen Knick. Je knapper verloren, desto geringer das Risiko. Folierte Karten sind
// geschützt und bekommen nie Schaden. Frische Karten haben keine Kratzer und Knicke (condition.js, Version 3):
// die entstehen nur hier.
const crypto = require('crypto');
const { TcgCard } = require('../models/Tcg');
const { addDamage, gradeFor, CONDITION_VERSION } = require('./condition');

// Chance je eingesetzter Karte: [knappe Niederlage, Totalausfall] – dazwischen linear nach der Schwere
const CHANCE = { kratzer: [0.08, 0.2], knick: [0.005, 0.03] };

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
/** Chance für 'kratzer' oder 'knick' bei Schwere s (0 = knapp, 1 = Totalausfall) */
const chanceFor = (kind, s) => CHANCE[kind][0] + (CHANCE[kind][1] - CHANCE[kind][0]) * clamp01(s);

/**
 * Würfelt den Schaden einer Karte: null, 'kratzer' oder 'knick'. rand: Zahl in [0, 1) – erst der seltene Knick,
 * im Rest der Kratzer (ein Wurf, damit beide Chancen genau stimmen).
 */
function rollDamage(s, rand = crypto.randomInt(1000000) / 1000000) {
  const knick = chanceFor('knick', s);
  if (rand < knick) return 'knick';
  if (rand < knick + chanceFor('kratzer', s)) return 'kratzer';
  return null;
}

/** Wie weit unter dem Ziel: 0 = knapp verfehlt, 1 = nichts geschafft. Ohne Angaben: mittel */
const shortfall = (total, required) => (required > 0 && Number.isFinite(total) ? clamp01(1 - total / required) : 0.5);

/** Schwere einer verlorenen IHK-Quest – bei Hybrid-Quests zählt der schwächere Balken */
function ihkSeverity(run) {
  if (!run || run.success) return 0;
  const bars = [run.total, run.total2].filter((t) => Number.isFinite(t));
  return bars.length ? Math.max(...bars.map((t) => shortfall(t, run.required))) : 0.5;
}

/** Schwere eines verlorenen Dungeons oder Turms: der Kampf, an dem es scheiterte */
function dungeonSeverity(run) {
  if (!run || run.success) return 0;
  const lost = (run.fights || []).find((f) => !f.success);
  return lost ? shortfall(lost.total, lost.required) : 0.5;
}

/**
 * Würfelt für jedes Exemplar (unfoliert) Schaden aus und schreibt ihn – in der Transaktion des Abschlusses.
 * Mängel und Note in einem einzigen Update, damit sie nie auseinanderlaufen. Der Schaden ist danach sichtbar (damaged,
 * bei einem Knick zusätzlich creased).
 * Gibt [{ card, kind }] zurück (für die Benachrichtigung), rand nur für Tests.
 */
async function damageCards({ userId, docs, severity, session = null, rand }) {
  if (!(severity > 0)) return [];
  const ids = [...new Set(docs.filter(Boolean).map(String))];
  if (!ids.length) return [];
  const cards = await TcgCard.find({ _id: { $in: ids }, user: userId, foiledAt: null }).select('card condition').session(session).lean();
  const out = [];
  for (const c of cards) {
    const kind = rollDamage(severity, rand && rand());
    if (!kind || !c.condition) continue;
    const defects = addDamage(c.condition.defects, kind);
    const res = await TcgCard.updateOne(
      { _id: c._id, user: userId, foiledAt: null },
      { $set: { 'condition.defects': defects, 'condition.grade': gradeFor(defects), 'condition.v': Math.max(c.condition.v || 0, CONDITION_VERSION), creased: !!defects.crease, damaged: true } },
      { session }
    );
    if (res.modifiedCount) out.push({ card: c.card, kind: defects.crease && !c.condition.defects.crease ? 'knick' : 'kratzer' });
  }
  return out;
}

/** Text für die Benachrichtigung, z. B. „Deine Karte „X“ hat einen Kratzer abbekommen.“ */
function damageText(hits, cardName, where) {
  if (!hits.length) return null;
  const what = (h) => `„${cardName(h.card)}“ ${h.kind === 'knick' ? 'einen Knick' : 'einen Kratzer'}`;
  const list = hits.map(what);
  const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} und ${list[list.length - 1]}` : list[0];
  return `${where}: Deine Karte${hits.length > 1 ? 'n haben' : ' hat'} etwas abbekommen – ${joined}. Folierte Karten sind geschützt.`;
}

module.exports = { CHANCE, chanceFor, rollDamage, shortfall, ihkSeverity, dungeonSeverity, damageCards, damageText };

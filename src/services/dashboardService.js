// Startseite nach der Anmeldung (die Taverne, views/hub.ejs): sammelt, was für ein Mitglied gerade wichtig ist –
// Vermögen, was heute ansteht, Termine, Kurse und die Orte der PVE-Weltkarte. Alles wird parallel geladen; die reinen
// Hilfsfunktionen (Veränderung, Termine, Heute, Weltkarte) sind ohne Datenbank getestet.
const config = require('../config');
const StatDaily = require('../models/StatDaily');
const { LotteryEntry } = require('../models/Lottery');
const { DungeonParty } = require('../models/Dungeon');
const { GradingShop } = require('../models/Grading');
const rankService = require('./rankService');
const bonusService = require('./bonusService');
const lottery = require('./lotteryService');
const markets = require('../coin/markets');
const blackMarket = require('../tcg/blackMarket');
const ihk = require('../ihk/ihkService');
const grading = require('../grading/gradingService');
const dungeon = require('../dungeon/dungeonService');

const CURVE_DAYS = 7; // Vermögensänderung: höchstens so viele Tage zurück

// ---------- Reine Hilfsfunktionen ----------

/** "YYYY-MM-DD" days Tage vor day */
function dayBefore(day, days) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

/** Veränderung in Cent und Prozent zwischen erstem und letztem Wert (null, wenn es nichts zu vergleichen gibt) */
function change(values) {
  if (!values || values.length < 2) return null;
  const first = values[0];
  const diff = values[values.length - 1] - first;
  return { diff, pct: first > 0 ? diff / first : null };
}

/** Termine sortieren, vergangene weglassen */
const upcoming = (list, now = Date.now()) => list.filter((e) => e && e.at && e.at.getTime() > now).sort((a, b) => a.at - b.at);

// ---------- Laden ----------

/** Vermögen jetzt (aus der Rangliste, damit es exakt dieselbe Rechnung ist), Platz und Veränderung der letzten Tage */
async function wealth(user) {
  const today = bonusService.today();
  const [list, days] = await Promise.all([
    rankService.ranking({ team: true }), // mit Team: auch Admin und Devs sehen ihr Vermögen
    StatDaily.aggregate([
      { $match: { _id: { $gte: dayBefore(today, CURVE_DAYS - 1), $lt: today } } },
      { $project: { p: { $filter: { input: '$players', cond: { $eq: ['$$this.user', user._id] } } } } },
      { $sort: { _id: 1 } },
    ]),
  ]);
  const mine = list.find((r) => r._id.equals(user._id));
  const me = mine || { balance: user.balance, inPlay: 0, coinValue: 0, cardValue: 0, shopValue: 0, total: user.balance - (user.debt || 0) };
  // Platz nur unter den Spielern – das Team ist nicht in der Wertung
  const ranked = list.filter((r) => !r.team);
  const i = ranked.findIndex((r) => r._id.equals(user._id));
  const points = days.filter((d) => d.p.length).map((d) => ({ day: d._id, total: d.p[0].total }));
  points.push({ day: today, total: me.total });
  const values = points.map((p) => p.total);
  // days: über wie viele Tage die Veränderung reicht (erster gespeicherter Tag bis heute)
  return { ...me, team: !!(mine && mine.team), rank: i >= 0 ? i + 1 : null, players: ranked.length, days: points.length - 1, change: change(values) };
}

/** Erledigt / gesamt – ausgegraute Punkte (off) zählen nicht mit, z. B. 4/4 statt 4/5 */
const tally = (items) => {
  const counted = items.filter((i) => !i.off);
  return { items, done: counted.filter((i) => i.done).length, total: counted.length };
};

/** Was heute ansteht: Tagesbonus, IHK, Grading, Dungeon, Tages-Lotterie */
async function todayStatus(user) {
  const isAdmin = user.isAdmin;
  const show = { ihk: ihk.settings.open || isAdmin, grading: grading.settings.open || isAdmin, dungeon: dungeon.settings.open || isAdmin };
  const round = await lottery.ensureOpenRound(Date.now(), 'taeglich');
  const [working, ihkState, gradingState, party, entry] = await Promise.all([
    GradingShop.exists({ _id: user._id, active: true }),
    show.ihk ? ihk.getState(user._id) : null,
    show.grading ? grading.getState(user._id) : null,
    show.dungeon ? DungeonParty.findOne({ 'members.user': user._id }).select('slot').lean() : null,
    LotteryEntry.findOne({ round: round._id, user: user._id }).select('tickets').lean(),
  ]);
  // Tagesbonus und Grading-Job schließen sich aus: wer im Grading-Shop arbeitet, bekommt keinen Tagesbonus – und wer
  // den Tagesbonus bekommt, hat keinen Job. Der jeweils andere Punkt ist ausgegraut (off) und zählt nicht mit.
  const items = [];
  const bonus = bonusService.settings.amount;
  if (bonus) {
    const got = !working && user.lastBonusDay === bonusService.today();
    items.push({ key: 'bonus', label: 'Tagesbonus', href: '/konto/auszug', done: got, off: !!working, text: working ? 'Entfällt – du arbeitest im Grading-Shop' : got ? `${(bonus / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })} gutgeschrieben` : `Ab ${config.bonusTime} Uhr` });
  }
  if (ihkState) {
    const run = ihkState.running;
    items.push({ key: 'ihk', label: 'IHK-Quests', href: '/ihk', done: ihkState.used >= ihkState.limit && !run, progress: [ihkState.used, ihkState.limit], text: run ? 'Quest läuft' : ihkState.used >= ihkState.limit ? 'Für heute erledigt' : `Noch ${ihkState.limit - ihkState.used} offen`, at: run ? run.endsAt : null });
  }
  if (gradingState) {
    const active = gradingState.shop && gradingState.shop.active;
    // ohne Job (und mit Tagesbonus): ausgegraut, zählt nicht – bewerben geht über den Link trotzdem
    const off = !active && !!bonus;
    items.push({ key: 'grading', label: 'Grading-Shop', href: '/grading', done: active && gradingState.used >= gradingState.limit, off, progress: active ? [gradingState.used, gradingState.limit] : null, text: !active ? (off ? 'Entfällt – du bekommst den Tagesbonus' : 'Kein Job – jetzt bewerben') : gradingState.open ? 'Auftrag offen' : gradingState.used >= gradingState.limit ? 'Alle Aufträge erledigt' : `${gradingState.limit - gradingState.used} Aufträge warten` });
  }
  if (show.dungeon) {
    const slot = party ? party.slot : dungeon.registrationSlot();
    items.push({ key: 'dungeon', label: 'Dungeon', href: '/dungeon', done: !!party, text: party ? 'Angemeldet' : 'Noch nicht angemeldet', at: slot });
  }
  const tickets = entry ? entry.tickets : 0;
  items.push({ key: 'lotto', label: 'Tages-Lotterie', href: '/lotterie', done: tickets > 0, text: tickets ? `${tickets} ${tickets === 1 ? 'Los' : 'Lose'} im Topf` : 'Noch kein Los', at: round.drawAt });
  return tally(items);
}

/** Termine: Black Market, Ziehungen der Lotterien, nächster Dungeon */
async function countdowns(user) {
  const [week, month] = await Promise.all(['woche', 'monat'].map((k) => lottery.ensureOpenRound(Date.now(), k)));
  const bm = blackMarket.windowAt();
  const list = [
    { key: 'bm', label: bm.open ? 'Black Market schließt' : 'Black Market öffnet', href: '/handel#blackmarket', at: bm.open ? bm.closesAt : bm.opensAt, live: bm.open },
    { key: 'woche', label: 'Wochen-Lotterie', href: '/lotterie/woche', at: week.drawAt },
    { key: 'monat', label: 'Monats-Lotterie', href: '/lotterie/monat', at: month.drawAt },
  ];
  if (dungeon.settings.open || user.isAdmin) list.push({ key: 'dungeon', label: 'Nächster Dungeon', href: '/dungeon', at: dungeon.slotAfter() });
  return upcoming(list);
}

/** Broker-Werte für den Kurs-Ticker am Händlerstand: Symbol, Preis, Veränderung über 24 h */
function ticker() {
  return markets.LIST.map((e) => {
    const s = e.snapshot();
    return { symbol: s.symbol, price: s.price, change: s.change24h, href: `/broker/${s.symbol.toLowerCase()}` };
  });
}

/**
 * Orte der PVE-Weltkarte (Dungeon, IHK, Mage Tower, Grading) – nur Bereiche, die das Mitglied sehen darf (wie in der
 * Navigation: freigegeben oder Admin). x/y: Position der Pins in Prozent (Desktop, mobil etwas höher: yMobile).
 * today = todayStatus(), dungeonAt = nächster Dungeon, towerLeft = Turm-Läufe heute (null = Turm nicht sichtbar).
 */
function pvePlaces({ today, dungeonAt, towerLeft, show }) {
  const item = (key) => today.items.find((i) => i.key === key);
  const places = [];
  if (show.dungeon) {
    const it = item('dungeon');
    places.push({ key: 'dungeon', label: 'Dungeon', href: '/dungeon', x: 20, y: 62, yMobile: 58, at: dungeonAt, text: it ? it.text : '' });
  }
  if (item('ihk')) places.push({ key: 'ihk', label: 'IHK', href: '/ihk', x: 50, y: 36, yMobile: 30, text: item('ihk').text, at: item('ihk').at || null });
  if (towerLeft !== null && towerLeft !== undefined) {
    const text = towerLeft > 0 ? `Heute noch ${towerLeft} ${towerLeft === 1 ? 'Lauf' : 'Läufe'} – Runde für Runde schwerer.` : 'Für heute bist du durch – ab Mitternacht geht es wieder.';
    places.push({ key: 'tower', label: 'Mage Tower', href: '/dungeon#mage-tower', x: 77, y: 58, yMobile: 54, text });
  }
  if (item('grading')) places.push({ key: 'grading', label: 'Grading', href: '/grading', x: 50, y: 68, yMobile: 64, text: item('grading').text });
  return places;
}

async function load(user) {
  const show = { dungeon: dungeon.settings.open || user.isAdmin, tower: dungeon.towerOpen(user) };
  const [w, today, cds, towerLeft] = await Promise.all([wealth(user), todayStatus(user), countdowns(user), show.tower ? dungeon.towerRunsLeft(user._id) : null]);
  const dungeonAt = show.dungeon ? dungeon.slotAfter() : null;
  return { wealth: w, today, countdowns: cds, ticker: ticker(), dungeonAt, pve: pvePlaces({ today, dungeonAt, towerLeft, show }) };
}

module.exports = { CURVE_DAYS, dayBefore, change, upcoming, tally, pvePlaces, ticker, load };

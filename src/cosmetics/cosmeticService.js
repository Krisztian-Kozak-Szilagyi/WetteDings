// Kosmetik-Shop: Einstellungen (Admin), Liste für den Shop, Kauf mit Konfetti, Profilbild tragen.
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { CosmeticSettings } = require('../models/Cosmetic');
const { inTransaction } = require('../services/betService');
const { UserError } = require('../lib/util');
const { logSettingsChange } = require('../stats/settingsLog');
const catalog = require('./catalog');
const logic = require('./logic');

const SETTINGS_ID = 'kosmetik';
const DEFAULT_CURRENCY = 'Konfetti';

const settings = { currencyName: DEFAULT_CURRENCY, items: {} };

function apply(doc) {
  if (!doc) return;
  if (logic.validCurrencyName(doc.currencyName)) settings.currencyName = doc.currencyName.trim();
  if (doc.items && typeof doc.items === 'object') settings.items = { ...doc.items };
}

async function loadSettings() {
  apply(await CosmeticSettings.findById(SETTINGS_ID).lean());
}

/** Name der Währung (im Admin-Panel änderbar) */
const currencyName = () => settings.currencyName;

/** Ein Eintrag mit den geltenden Werten (Preis, Effekt, Name) */
const item = (kind, key) => {
  const base = catalog.findItem(kind, key);
  return base ? logic.withSettings(base, settings.items[catalog.ownedKey(kind, key)]) : null;
};

/** Alle Avatare mit geltenden Werten */
const avatars = () => catalog.AVATARS.map((a) => item('avatar', a.key));

/** Effekt des getragenen Avatars ('' ohne) – für die Profilbild-Klasse */
const avatarEffect = (avatarKey) => {
  const a = typeof avatarKey === 'string' ? item('avatar', avatarKey) : null;
  return a ? a.effect : '';
};

/** Shop-Ansicht für ein Mitglied: jede Art mit ihren Einträgen, Besitz markiert */
function shop(user) {
  const owned = user.cosmetics || [];
  return catalog.KINDS.map((k) => ({
    ...k,
    items: (k.key === 'avatar' ? avatars() : []).map((it) => ({ ...it, owned: owned.includes(catalog.ownedKey(k.key, it.key)), worn: k.key === 'avatar' && user.avatar === it.key })),
  }));
}

/** Kaufen: Konfetti abziehen und den Eintrag dem Konto gutschreiben (einmalig, kein Handel) */
async function buy({ user, kind, key }) {
  const it = item(kind, key);
  if (!it) throw new UserError('Diesen Gegenstand gibt es nicht.');
  const owned = catalog.ownedKey(kind, key);
  return inTransaction(async (session) => {
    const updated = await User.findOneAndUpdate(
      { _id: user._id, deletedAt: null, konfetti: { $gte: it.price }, cosmetics: { $ne: owned } },
      { $inc: { konfetti: -it.price }, $addToSet: { cosmetics: owned } },
      { new: true, session, projection: { konfetti: 1, cosmetics: 1 } }
    );
    if (!updated) {
      const now = await User.findById(user._id).select('konfetti cosmetics').session(session).lean();
      if (now && (now.cosmetics || []).includes(owned)) throw new UserError('Das hast du schon.');
      throw new UserError(`Dafür reicht dein ${currencyName()} nicht.`);
    }
    await Ledger.create([{ user: user._id, type: 'kosmetik_kauf', amount: 0, betTitle: it.name, meta: { kind, item: key, konfetti: -it.price } }], { session });
    return { item: it, konfetti: updated.konfetti };
  });
}

/** Gekauften Avatar als Profilbild tragen (nur eigene) */
async function wearAvatar({ user, key }) {
  if (!logic.ownsAvatar(user.cosmetics, key)) throw new UserError('Diesen Avatar besitzt du nicht.');
  await User.updateOne({ _id: user._id }, { $set: { avatar: key } });
}

/** Admin: Währungsname und je Avatar Preis, Effekt, Name speichern */
async function saveSettings({ admin, currency, entries }) {
  if (!logic.validCurrencyName(currency)) throw new UserError('Name der Währung: 2 bis 20 Zeichen (Buchstaben, Ziffern, Leerzeichen, Bindestrich).');
  const items = {};
  for (const a of catalog.AVATARS) {
    const e = entries[a.key] || {};
    if (!logic.validPrice(e.price)) throw new UserError(`${a.name}: Preis 0 bis ${logic.MAX_PRICE.toLocaleString('de-DE')}.`);
    if (!catalog.findEffect(e.effect)) throw new UserError(`${a.name}: unbekannter Effekt.`);
    items[catalog.ownedKey('avatar', a.key)] = { price: e.price, effect: e.effect, name: logic.cleanName(e.name) || a.name };
  }
  const before = current();
  await CosmeticSettings.updateOne({ _id: SETTINGS_ID }, { $set: { currencyName: currency.trim(), items, updatedByName: admin.username } }, { upsert: true });
  apply({ currencyName: currency, items });
  await logSettingsChange({ area: 'kosmetik', before, after: current(), by: admin });
}

const current = () => ({ currencyName: settings.currencyName, items: Object.fromEntries(avatars().map((a) => [a.key, { price: a.price, effect: a.effect, name: a.name }])) });

module.exports = { loadSettings, saveSettings, currencyName, item, avatars, avatarEffect, shop, buy, wearAvatar, DEFAULT_CURRENCY };

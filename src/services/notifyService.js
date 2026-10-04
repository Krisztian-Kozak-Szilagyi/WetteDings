// Benachrichtigungen (Glocke oben rechts): persönliche Ereignisse wie Handelsangebote, Duell-Anfragen,
// entschiedene Wetten oder Antworten in eigenen Forenthemen. Sie bleiben ungelesen, bis das Mitglied sie
// anklickt oder als gelesen markiert (einzeln oder alle auf einmal).
const mongoose = require('mongoose');
const Notification = require('../models/Notification');

const LIST_MAX = 30; // so viele zeigt die Glocke (ungelesene immer alle, bis UNREAD_MAX)
const UNREAD_MAX = 50;
const TEXT_MAX = 300;

/** Nur Pfade dieser Seite als Ziel – nie eine fremde Adresse (auch nicht "//andere-seite") */
const safeHref = (href) => (typeof href === 'string' && /^\/(?![/\\])/.test(href) ? href : '/');

const clip = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > TEXT_MAX ? t.slice(0, TEXT_MAX - 1) + '…' : t;
};

/** Titel (von Nutzern) für den Text kürzen */
const short = (s, n = 60) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/**
 * Benachrichtigung an ein oder mehrere Mitglieder. Wirft nie: Ein Fehler hier darf die eigentliche Aktion
 * (Kauf, Auszahlung …) nicht scheitern lassen. Deshalb immer NACH der Transaktion aufrufen.
 * - except: dieses Mitglied bekommt nichts (meist der Auslöser selbst)
 * - key + many(n): Gibt es schon eine ungelesene Meldung mit diesem key, wird sie hochgezählt und bekommt den
 *   Text many(n) – statt einer neuen Meldung pro Nachricht.
 */
async function notify(users, { area, text, href, key = null, many = null, except = null }) {
  try {
    const skip = except ? String(except._id || except) : null;
    const ids = [...new Set([].concat(users || []).filter(Boolean).map((u) => String(u._id || u)))].filter((id) => id !== skip && mongoose.isValidObjectId(id));
    if (!ids.length) return;
    const doc = { area, text: clip(text), href: safeHref(href) };
    if (!key) {
      await Notification.insertMany(ids.map((user) => ({ ...doc, user, at: new Date() })));
      return;
    }
    await Promise.all(
      ids.map(async (user) => {
        const open = await Notification.findOne({ user, key, readAt: null }).select('count').lean();
        if (!open) return Notification.create({ ...doc, user, key, at: new Date() });
        const count = (open.count || 1) + 1;
        return Notification.updateOne({ _id: open._id, readAt: null }, { $set: { ...doc, text: clip(many ? many(count) : text), count, at: new Date() } });
      })
    );
  } catch (err) {
    console.error('Benachrichtigung fehlgeschlagen:', err.message);
  }
}

/** Für die Glocke: alle ungelesenen (bis UNREAD_MAX), aufgefüllt mit den neuesten gelesenen bis LIST_MAX; dazu die Zahl der ungelesenen */
async function forBell(userId) {
  const [unread, read, unreadCount] = await Promise.all([
    Notification.find({ user: userId, readAt: null }).sort({ at: -1 }).limit(UNREAD_MAX).select('area text href at readAt').lean(),
    Notification.find({ user: userId, readAt: { $ne: null } }).sort({ at: -1 }).limit(LIST_MAX).select('area text href at readAt').lean(),
    Notification.countDocuments({ user: userId, readAt: null }),
  ]);
  const list = [...unread, ...read.slice(0, Math.max(0, LIST_MAX - unread.length))].sort((a, b) => b.at - a.at);
  return { list, unread: unreadCount };
}

const unreadCount = (userId) => Notification.countDocuments({ user: userId, readAt: null });

/** Eine Meldung als gelesen markieren; gibt sie zurück (oder null, wenn sie nicht diesem Mitglied gehört) */
async function markRead(userId, id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const n = await Notification.findOne({ _id: String(id), user: userId }).select('href readAt').lean();
  if (n && !n.readAt) await Notification.updateOne({ _id: n._id }, { $set: { readAt: new Date() } });
  return n;
}

const markAllRead = (userId) => Notification.updateMany({ user: userId, readAt: null }, { $set: { readAt: new Date() } });

/** Ziel ändern, wenn es eine Seite nicht mehr gibt (z. B. gelöschte Wette) */
const retarget = (href, newHref) => Notification.updateMany({ href }, { $set: { href: safeHref(newHref) } });

module.exports = { LIST_MAX, UNREAD_MAX, safeHref, short, notify, forBell, unreadCount, markRead, markAllRead, retarget };

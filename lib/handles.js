// ── HANDLE RULES (single source of truth) ────────────────────
// Used by routes/auth.js (check-handle, set-handle) and anywhere else a
// handle is validated. Rules:
//
//  1. Format: 3–30 characters, letters / numbers / "-" / "_" only.
//     Stored lowercase; matching is case-insensitive.
//  2. Reserved words can never be claimed (RESERVED_HANDLES).
//  3. A handle must be unique across every account's CURRENT handle and
//     every account's PREVIOUS handles. A released handle is never
//     re-issued to someone else, because old links and printed QR codes
//     still redirect through it.
//  4. First handle is set freely. After that, a handle can be changed
//     once every HANDLE_COOLDOWN_DAYS (default 30). Set the
//     HANDLE_COOLDOWN_DAYS env var to change this; 0 disables the cooldown.
//  5. Every old handle keeps redirecting to the current one permanently
//     (301). There is no cap on how many old handles are kept.
//  6. An account may take back one of its own previous handles at any time
//     the cooldown allows.
//  7. Same rules for personal and venue accounts.

const User = require('../models/User');

const HANDLE_RE = /^[a-zA-Z0-9_-]{3,30}$/;

const RESERVED_HANDLES = [
  'admin','api','app','eventstrand','www','support','help','static','assets',
  's','b','p','spec','verify','reset-password','forgot-password','sitemap',
  'health','ssr','qr','dashboard','notifications','analytics','account',
  'subscriptions','interested','directory','developers',
  // added: paths/names the app or curated content already uses
  'library','login','logout','signin','signup','register','settings','profile',
  'strand','strands','braid','braids','workspace','workspaces','builder',
  'privacy-policy','terms-of-service','cookie-policy','manifest','robots',
  'null','undefined','root','system','official','staff','moderator','mod',
];

function cooldownDays() {
  const n = Number(process.env.HANDLE_COOLDOWN_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}
const DAY_MS = 24 * 60 * 60 * 1000;

// Date the user may next change their handle, or null if they can now.
function handleChangeableAt(user) {
  const days = cooldownDays();
  if (!days || !user.handle || !user.handleChangedAt) return null;
  const at = new Date(user.handleChangedAt.getTime() + days * DAY_MS);
  return at > new Date() ? at : null;
}

// true when `handle` (already lowercased) is free for `userId` to take.
async function isHandleAvailable(handle, userId) {
  if (RESERVED_HANDLES.includes(handle)) return false;
  const clash = await User.findOne({
    _id: { $ne: userId || null },
    $or: [{ handle }, { previousHandles: handle }],
  }).select('_id').lean();
  return !clash;
}

module.exports = {
  HANDLE_RE, RESERVED_HANDLES, cooldownDays, handleChangeableAt, isHandleAvailable,
};

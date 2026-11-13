// ── PASSCODE-PROTECTED CONTENT ─────────────────────────────────
// One place decides whether a caller may read a protected strand or braid, so
// every route (public page, subscribe, dashboard, braids) applies the same rule.
const crypto = require('crypto');

// Constant-time comparison; a wrong length or a non-string never matches.
function passcodeMatches(supplied, actual) {
  if (typeof supplied !== 'string' || typeof actual !== 'string' || !actual) return false;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(actual).digest();
  return crypto.timingSafeEqual(a, b);
}

// Wrong-passcode throttle: 10 misses per 15 minutes for one caller on one item.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_MISSES = 10;
const misses = new Map(); // key -> { count, resetAt }

function throttleKey(req, id) { return `${req.ip}|${id}`; }

function isThrottled(req, id) {
  const e = misses.get(throttleKey(req, id));
  return !!e && e.resetAt > Date.now() && e.count >= MAX_MISSES;
}
function recordMiss(req, id) {
  const now = Date.now();
  if (misses.size > 5000) for (const [k, v] of misses) if (v.resetAt <= now) misses.delete(k);
  const key = throttleKey(req, id);
  const e = misses.get(key);
  if (!e || e.resetAt <= now) misses.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else e.count++;
}

// The passcode may arrive in the X-Passcode header, the JSON body or, for older
// clients, the query string.
function suppliedPasscode(req) {
  const v = req.get('x-passcode') || (req.body && req.body.passcode) || req.query.passcode;
  return typeof v === 'string' ? v : '';
}

// Checks a protected item. Returns null when access is allowed, otherwise
// { status, error } to send. `item` must be loaded with its accessCode.
function checkPasscode(req, item) {
  if (!item || item.visibility !== 'protected') return null;
  if (req.user && String(item.publisher) === String(req.user._id)) return null;
  const id = String(item._id);
  if (isThrottled(req, id)) return { status: 429, error: 'Too many wrong passcodes — try again in 15 minutes' };
  const supplied = suppliedPasscode(req);
  if (passcodeMatches(supplied, item.accessCode)) return null;
  if (supplied) recordMiss(req, id);
  return { status: 403, error: 'Passcode required', passcodeHeader: true };
}

module.exports = { checkPasscode, passcodeMatches };

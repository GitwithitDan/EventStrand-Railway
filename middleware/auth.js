const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ApiKey = require('../models/ApiKey');

// What an API key may reach. Anything not listed is session-only: an API key
// can never manage the account, other keys, subscriptions or the directory.
const API_KEY_RULES = [
  { method: 'GET',  path: /^\/api\/dashboard\//,             scopes: ['portal:read'] },
  { method: 'GET',  path: /^\/api\/user\/subscriptions\/?$/, scopes: ['subscriptions:read'] },
  { method: 'GET',  path: /^\/api\/strands\/[^/]+\/?$/,      scopes: ['strand:read'] },
  { method: 'POST', path: /^\/api\/strands\/?$/,             scopes: ['strand:write'] },
  { method: 'PUT',  path: /^\/api\/strands\/[^/]+\/?$/,      scopes: ['strand:write', 'events:create', 'events:update'] },
];

function bearer(req) {
  const header = req.headers.authorization;
  return header && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

// Resolves the caller. Returns { user } on success, { status, error } when the
// credentials are present but not acceptable, or {} when there are none.
// Database failures throw, so an outage is never mistaken for a bad session.
async function resolveUser(req) {
  const headerToken = bearer(req);

  // API key (esk_...) in the Authorization header.
  if (headerToken && headerToken.startsWith('esk_')) {
    const apiKey = await ApiKey.findByRaw(headerToken);
    if (!apiKey || !apiKey.user) return { status: 401, error: 'Invalid or revoked API key' };
    const path = (req.originalUrl || req.url || '').split('?')[0];
    const rule = API_KEY_RULES.find(r => r.method === req.method && r.path.test(path));
    if (!rule) return { status: 403, error: 'API keys cannot be used for this endpoint' };
    if (!rule.scopes.some(s => apiKey.scopes.includes(s))) {
      return { status: 403, error: `This key does not have the required scope: ${rule.scopes.join(' or ')}` };
    }
    ApiKey.updateOne({ _id: apiKey._id }, { lastUsed: new Date() }).exec().catch(() => {});
    req.apiKey = apiKey;
    return { user: apiKey.user };
  }

  // Session token: httpOnly cookie first, then Authorization Bearer.
  const token = req.cookies?.es_jwt || headerToken;
  if (!token) return {};
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError' || e.name === 'NotBeforeError') {
      return { status: 401, error: 'Invalid or expired token' };
    }
    throw e;
  }
  const user = await User.findById(payload.userId).select('-__v');
  if (!user) return { status: 401, error: 'User not found' };
  // tokenVersion is bumped on password reset and "sign out everywhere", which
  // invalidates every token issued before it.
  if ((payload.tv || 0) !== (user.tokenVersion || 0)) return { status: 401, error: 'Invalid or expired token' };
  req.authViaCookie = !!req.cookies?.es_jwt;
  return { user };
}

module.exports = async (req, res, next) => {
  try {
    const r = await resolveUser(req);
    if (r.user) { req.user = r.user; return next(); }
    // The frontend signs the user out on any 401, so only genuinely bad
    // credentials get one. Real errors go to the error handler (503 for DB).
    return res.status(r.status || 401).json({ error: r.error || 'No token provided' });
  } catch (e) {
    return next(e);
  }
};
module.exports.resolveUser = resolveUser;

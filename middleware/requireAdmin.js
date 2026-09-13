// Chain after the `auth` middleware on any admin-only route.
// isAdmin is never settable through the API (see models/User.js) — it's
// flipped by hand directly in the database — so this check is the entire
// gate, and there is no self-service way for any account to reach it.
module.exports = function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

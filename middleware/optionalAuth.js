const { resolveUser } = require('./auth');

// Same credential resolution as middleware/auth.js but never rejects the
// request. With no token, or an invalid/expired one, req.user is left
// undefined and the route continues as an anonymous request. Routes using
// this middleware must treat req.user as optional at every read.
module.exports = async (req, res, next) => {
  try {
    const r = await resolveUser(req);
    if (r.user && !req.apiKey) req.user = r.user;
  } catch (e) {
    // Lookup failure on a public route — proceed anonymously.
  }
  next();
};

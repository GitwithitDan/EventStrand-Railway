const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Same token resolution as middleware/auth.js (cookie first, then Bearer
// header) but never rejects the request. If no token, or an invalid/expired
// one, req.user is simply left undefined and the route continues as an
// anonymous request. Routes using this middleware must treat req.user as
// optional at every read.
module.exports = async (req, res, next) => {
  const cookieToken = req.cookies?.es_jwt;
  const header = req.headers.authorization;
  const token = cookieToken || (header?.startsWith('Bearer ') ? header.slice(7) : null);

  if (!token) return next();

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.userId).select('-__v');
    if (user) req.user = user;
  } catch (e) {
    // Invalid/expired token on a public route — proceed anonymously
    // rather than failing the request.
  }
  next();
};

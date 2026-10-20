const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async (req, res, next) => {
  // Prefer httpOnly cookie (browser clients); fall back to Authorization Bearer (API key users)
  const cookieToken = req.cookies?.es_jwt;
  const header = req.headers.authorization;
  const token = cookieToken || (header?.startsWith('Bearer ') ? header.slice(7) : null);

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.userId).select('-__v');
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (e) {
    // Only a bad/expired token is a 401. A database failure while looking up
    // the user must NOT look like a bad session — the frontend signs the
    // user out on any 401, so an outage would log everyone out. Pass real
    // errors to the error handler (503 for database errors).
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError' || e.name === 'NotBeforeError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    return next(e);
  }
};

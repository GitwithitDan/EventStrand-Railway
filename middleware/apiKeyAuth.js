const ApiKey = require('../models/ApiKey');

/**
 * Middleware that accepts either a JWT (handled by auth.js) or an
 * EventStrand API key (esk_...) in the Authorization: Bearer header.
 *
 * Usage: require('./middleware/apiKeyAuth')(requiredScope)
 * Returns a middleware function that attaches req.user if valid.
 *
 * Scope validation is optional — pass null to allow any valid key.
 */
module.exports = function apiKeyAuth(requiredScope = null) {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = header.slice(7).trim();

    // API keys always start with esk_ — fall through to JWT if not
    if (!token.startsWith('esk_')) {
      return res.status(401).json({ error: 'Invalid API key format' });
    }

    try {
      const apiKey = await ApiKey.findByRaw(token);
      if (!apiKey) {
        return res.status(401).json({ error: 'Invalid or revoked API key' });
      }

      if (requiredScope && !apiKey.scopes.includes(requiredScope)) {
        return res.status(403).json({
          error: `This key does not have the required scope: ${requiredScope}`,
        });
      }

      // Update last-used timestamp (fire and forget — don't block the request)
      ApiKey.updateOne({ _id: apiKey._id }, { lastUsed: new Date() }).exec();

      req.user    = apiKey.user;
      req.apiKey  = apiKey;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'API key validation failed' });
    }
  };
};

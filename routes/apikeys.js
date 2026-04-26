const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const ApiKey   = require('../models/ApiKey');
const { VALID_SCOPES } = require('../models/ApiKey');

// All routes require a signed-in user (JWT)
router.use(auth);

// POST /api/apikeys — generate a new key
router.post('/', async (req, res, next) => {
  try {
    const { label, scopes } = req.body;

    if (!label || typeof label !== 'string' || !label.trim()) {
      return res.status(400).json({ error: 'A label is required' });
    }

    // Validate requested scopes
    const requestedScopes = Array.isArray(scopes) ? scopes : ['portal:read', 'strand:read'];
    const invalidScopes = requestedScopes.filter(s => !VALID_SCOPES.includes(s));
    if (invalidScopes.length) {
      return res.status(400).json({
        error: `Invalid scopes: ${invalidScopes.join(', ')}`,
        validScopes: VALID_SCOPES,
      });
    }

    // Cap at 10 active keys per user
    const count = await ApiKey.countDocuments({ user: req.user._id, revoked: false });
    if (count >= 10) {
      return res.status(400).json({ error: 'Maximum of 10 active API keys reached. Revoke one to create another.' });
    }

    const { raw, hash, prefix } = ApiKey.generateKey();

    const key = await ApiKey.create({
      user:      req.user._id,
      label:     label.trim(),
      keyHash:   hash,
      keyPrefix: prefix,
      scopes:    requestedScopes,
    });

    // Return raw key ONCE — it is never stored and cannot be retrieved again
    res.status(201).json({
      id:        key._id,
      label:     key.label,
      prefix:    key.keyPrefix,
      scopes:    key.scopes,
      createdAt: key.createdAt,
      key:       raw, // shown once only
    });
  } catch (e) { next(e); }
});

// GET /api/apikeys — list keys (no raw values)
router.get('/', async (req, res, next) => {
  try {
    const keys = await ApiKey.find({ user: req.user._id, revoked: false })
      .select('-keyHash')
      .sort({ createdAt: -1 });

    res.json({
      keys: keys.map(k => ({
        id:        k._id,
        label:     k.label,
        prefix:    k.keyPrefix,
        scopes:    k.scopes,
        lastUsed:  k.lastUsed,
        createdAt: k.createdAt,
      })),
      validScopes: VALID_SCOPES,
    });
  } catch (e) { next(e); }
});

// PATCH /api/apikeys/:id — update label or scopes
router.patch('/:id', async (req, res, next) => {
  try {
    const key = await ApiKey.findOne({ _id: req.params.id, user: req.user._id, revoked: false });
    if (!key) return res.status(404).json({ error: 'Key not found' });

    if (req.body.label) key.label = req.body.label.trim();
    if (Array.isArray(req.body.scopes)) {
      const invalid = req.body.scopes.filter(s => !VALID_SCOPES.includes(s));
      if (invalid.length) return res.status(400).json({ error: `Invalid scopes: ${invalid.join(', ')}` });
      key.scopes = req.body.scopes;
    }

    await key.save();
    res.json({ id: key._id, label: key.label, scopes: key.scopes });
  } catch (e) { next(e); }
});

// DELETE /api/apikeys/:id — revoke a key
router.delete('/:id', async (req, res, next) => {
  try {
    const key = await ApiKey.findOne({ _id: req.params.id, user: req.user._id });
    if (!key) return res.status(404).json({ error: 'Key not found' });
    key.revoked = true;
    await key.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;

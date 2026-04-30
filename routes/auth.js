const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const User     = require('../models/User');
const auth     = require('../middleware/auth');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const RESERVED_HANDLES = ['admin','api','app','eventstrand','www','support','help','static','assets','s','b','p','spec'];

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '90d' });
}

// POST /api/auth/register — email + password account creation
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, displayName, accountType } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      email: email.toLowerCase(),
      passwordHash,
      displayName: displayName ? displayName.trim().slice(0, 60) : email.split('@')[0],
      accountType: accountType === 'venue' ? 'venue' : 'personal',
    });

    const token = signToken(user._id);
    res.status(201).json({
      token,
      user: { id: user._id, email: user.email, displayName: user.displayName, picture: user.picture, handle: user.handle || null, accountType: user.accountType },
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/login — email + password sign in
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.passwordHash) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken(user._id);
    res.json({
      token,
      user: { id: user._id, email: user.email, displayName: user.displayName, picture: user.picture, handle: user.handle || null },
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/google — verify GIS credential, sign in or create user
router.post('/google', async (req, res, next) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Missing credential' });

    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    let user = await User.findOne({ googleId });
    if (!user) user = await User.findOne({ email });

    if (!user) {
      user = await User.create({ googleId, email, displayName: name, picture });
    } else {
      user.googleId    = googleId;
      user.picture     = picture || user.picture;
      user.displayName = user.displayName || name;
      await user.save();
    }

    const token = signToken(user._id);
    res.json({
      token,
      user: {
        id:          user._id,
        email:       user.email,
        displayName: user.displayName,
        picture:     user.picture,
        handle:      user.handle || null,
      },
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/auth/check-handle?handle=xxx
router.get('/check-handle', async (req, res, next) => {
  try {
    const { handle } = req.query;
    if (!handle || !/^[a-zA-Z0-9_-]{3,30}$/.test(handle)) {
      return res.status(400).json({ error: 'Invalid handle format' });
    }
    if (RESERVED_HANDLES.includes(handle.toLowerCase())) {
      return res.json({ available: false });
    }
    const exists = await User.findOne({ handle: handle.toLowerCase() });
    res.json({ available: !exists });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/set-handle
router.post('/set-handle', auth, async (req, res, next) => {
  try {
    const { handle } = req.body;
    if (!handle || !/^[a-zA-Z0-9_-]{3,30}$/.test(handle)) {
      return res.status(400).json({ error: 'Invalid handle format' });
    }
    const lower = handle.toLowerCase();

    // Apply the same reserved list check as check-handle
    if (RESERVED_HANDLES.includes(lower)) {
      return res.status(400).json({ error: 'That handle is reserved' });
    }

    const taken = await User.findOne({ handle: lower, _id: { $ne: req.user._id } });
    if (taken) return res.status(409).json({ error: 'Handle already taken' });

    const oldHandle = req.user.handle;
    if (oldHandle && oldHandle !== lower) {
      if (!req.user.previousHandles.includes(oldHandle)) {
        req.user.previousHandles.push(oldHandle);
      }
      const Strand = require('../models/Strand');
      const Braid  = require('../models/Braid');
      await Strand.updateMany({ publisher: req.user._id }, { publisherHandle: lower });
      await Braid.updateMany({ publisher: req.user._id }, { publisherHandle: lower });
    }

    req.user.handle = lower;
    await req.user.save();
    res.json({ ok: true, handle: lower });
  } catch (e) {
    next(e);
  }
});

// PATCH /api/auth/profile — update display name
router.patch('/profile', auth, async (req, res, next) => {
  try {
    const { displayName } = req.body;
    if (displayName) req.user.displayName = displayName.trim().slice(0, 60);
    await req.user.save();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;

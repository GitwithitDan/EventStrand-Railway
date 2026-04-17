const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const User    = require('../models/User');
const auth    = require('../middleware/auth');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '90d' });
}

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
      // Update profile picture and name silently
      user.googleId   = googleId;
      user.picture    = picture || user.picture;
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
    const reserved = ['admin','api','app','eventstrand','www','support','help','static','assets','s','b','p','spec'];
    if (reserved.includes(handle.toLowerCase())) {
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
    const taken = await User.findOne({ handle: lower, _id: { $ne: req.user._id } });
    if (taken) return res.status(409).json({ error: 'Handle already taken' });

    // Store old handle for redirect
    const oldHandle = req.user.handle;
    if (oldHandle && oldHandle !== lower) {
      if (!req.user.previousHandles.includes(oldHandle)) {
        req.user.previousHandles.push(oldHandle);
      }
      // Update publisherHandle on all strands and braids silently
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

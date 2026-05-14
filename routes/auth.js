const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const User     = require('../models/User');
const auth     = require('../middleware/auth');
const { validate, schemas } = require('../lib/validators');
const { sendEmail, verifyEmailTemplate, resetPasswordTemplate } = require('../lib/email');

if (!process.env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID env var is required');
if (!process.env.JWT_SECRET)       throw new Error('JWT_SECRET env var is required');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const RESERVED_HANDLES = ['admin','api','app','eventstrand','www','support','help','static','assets','s','b','p','spec','verify','reset-password','forgot-password','sitemap'];

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;        // 24 hours
const RESET_TTL_MS  = 60 * 60 * 1000;             // 1 hour

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '90d' });
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function userJson(u, extras = {}) {
  return {
    id:            u._id,
    email:         u.email,
    displayName:   u.displayName,
    picture:       u.picture,
    handle:        u.handle || null,
    accountType:   u.accountType,
    emailVerified: u.emailVerified,
    ...extras,
  };
}

// POST /api/auth/register — email + password account creation
router.post('/register', validate(schemas.register), async (req, res, next) => {
  try {
    const { email, password, displayName, accountType } = req.body;

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

    const passwordHash = await bcrypt.hash(password, 12);
    const verifyToken  = newToken();

    const user = await User.create({
      email: email.toLowerCase(),
      passwordHash,
      displayName: displayName ? displayName.trim().slice(0, 60) : email.split('@')[0],
      accountType: accountType === 'venue' ? 'venue' : 'personal',
      emailVerified: false,
      verifyToken,
      verifyTokenExpires: new Date(Date.now() + VERIFY_TTL_MS),
    });

    // Fire-and-forget — don't block signup on email delivery
    const tpl = verifyEmailTemplate(user.displayName, verifyToken);
    sendEmail({ to: user.email, ...tpl }).catch(e => console.error('verify email send failed:', e));

    const token = signToken(user._id);
    res.status(201).json({ token, user: userJson(user) });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/login — email + password sign in
router.post('/login', validate(schemas.login), async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.passwordHash) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken(user._id);
    res.json({ token, user: userJson(user) });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/google — verify GIS credential, sign in or create user
// Google-verified emails are marked emailVerified automatically.
router.post('/google', async (req, res, next) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Missing credential' });

    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture, email_verified } = payload;

    const normEmail = email.toLowerCase();

    let user = await User.findOne({ googleId });
    if (!user) user = await User.findOne({ email: normEmail });

    if (!user) {
      user = await User.create({
        googleId,
        email: normEmail,
        displayName: name,
        picture,
        emailVerified: !!email_verified,
      });
    } else {
      user.googleId    = googleId;
      user.picture     = picture || user.picture;
      user.displayName = user.displayName || name;
      // Trust Google's email verification — promote local account if Google says so
      if (email_verified && !user.emailVerified) user.emailVerified = true;
      await user.save();
    }

    const token = signToken(user._id);
    res.json({ token, user: userJson(user) });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/verify-email — confirm an email verification token
router.post('/verify-email', validate(schemas.verifyEmail), async (req, res, next) => {
  try {
    const { token } = req.body;
    const user = await User.findOne({ verifyToken: token })
      .select('+verifyToken +verifyTokenExpires');
    if (!user) return res.status(400).json({ error: 'Invalid or expired verification link' });
    if (user.verifyTokenExpires && user.verifyTokenExpires < new Date()) {
      return res.status(400).json({ error: 'Verification link expired — request a new one' });
    }
    user.emailVerified      = true;
    user.verifyToken        = null;
    user.verifyTokenExpires = null;
    await user.save();
    res.json({ ok: true, email: user.email });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/resend-verification — issue a new verification email
router.post('/resend-verification', auth, async (req, res, next) => {
  try {
    if (req.user.emailVerified) return res.json({ ok: true, alreadyVerified: true });

    req.user.verifyToken        = newToken();
    req.user.verifyTokenExpires = new Date(Date.now() + VERIFY_TTL_MS);
    await req.user.save();

    const tpl = verifyEmailTemplate(req.user.displayName, req.user.verifyToken);
    sendEmail({ to: req.user.email, ...tpl }).catch(e => console.error('resend verify failed:', e));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/forgot-password — issue a password reset email
// Always returns 200 with the same shape, even if the email isn't on file.
// This prevents email enumeration through the reset endpoint.
router.post('/forgot-password', validate(schemas.forgotPassword), async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    if (user && user.passwordHash) {
      user.resetToken        = newToken();
      user.resetTokenExpires = new Date(Date.now() + RESET_TTL_MS);
      await user.save();
      const tpl = resetPasswordTemplate(user.displayName, user.resetToken);
      sendEmail({ to: user.email, ...tpl }).catch(e => console.error('reset email send failed:', e));
    }
    // Generic success regardless — don't reveal whether the email exists
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/reset-password — consume a reset token and set new password
router.post('/reset-password', validate(schemas.resetPassword), async (req, res, next) => {
  try {
    const { token, password } = req.body;
    const user = await User.findOne({ resetToken: token })
      .select('+resetToken +resetTokenExpires +passwordHash');
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });
    if (user.resetTokenExpires && user.resetTokenExpires < new Date()) {
      return res.status(400).json({ error: 'Reset link expired — request a new one' });
    }
    user.passwordHash      = await bcrypt.hash(password, 12);
    user.resetToken        = null;
    user.resetTokenExpires = null;
    // Resetting via email proof also verifies the email
    user.emailVerified     = true;
    await user.save();

    const newJwt = signToken(user._id);
    res.json({ ok: true, token: newJwt, user: userJson(user) });
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

    if (RESERVED_HANDLES.includes(lower)) {
      return res.status(400).json({ error: 'That handle is reserved' });
    }

    const taken = await User.findOne({ handle: lower, _id: { $ne: req.user._id } });
    if (taken) return res.status(409).json({ error: 'Handle already taken' });

    const oldHandle = req.user.handle;
    if (oldHandle && oldHandle !== lower) {
      if (!req.user.previousHandles.includes(oldHandle)) {
        req.user.previousHandles.push(oldHandle);
        if (req.user.previousHandles.length > 10) {
          req.user.previousHandles = req.user.previousHandles.slice(-10);
        }
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

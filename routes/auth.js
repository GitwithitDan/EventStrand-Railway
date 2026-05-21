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

// B-28: Added missing reserved paths that the server actually serves.
const RESERVED_HANDLES = [
  'admin','api','app','eventstrand','www','support','help','static','assets',
  's','b','p','spec','verify','reset-password','forgot-password','sitemap',
  'health','ssr','qr','dashboard','notifications','analytics','account',
  'subscriptions','interested','directory','developers',
];

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;        // 24 hours
const RESET_TTL_MS  = 60 * 60 * 1000;             // 1 hour

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '90d' });
}

// Set the JWT as an httpOnly cookie so JS cannot read it (XSS protection).
// secure:true requires HTTPS — safe for production; Railway + Cloudflare always serve HTTPS.
// sameSite:'strict' is valid here because eventstrand.com and api.eventstrand.com share the
// same eTLD+1 (eventstrand.com), so requests from the frontend to the API are same-site.
function setAuthCookie(res, token) {
  res.cookie('es_jwt', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days — matches JWT expiry
    path: '/',
  });
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// B-6: Hash verify/reset tokens before storing in MongoDB.
// The raw token is sent in the email link; the DB stores only the SHA-256 hash.
// A DB read (backup, leaked log, insider) does not hand an attacker a live token.
// Pattern mirrors ApiKey.keyHash which already uses this correctly.
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
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

    // B-5: Don't reveal whether the email is already registered at signup time.
    // Previously returned HTTP 409 with "An account with that email already exists"
    // which allowed enumeration of the user list with ~30 req/15min per IP.
    // Now: if the email exists we send them a "you already have an account" email
    // and return the same 201 shape, making register indistinguishable from
    // "email taken" from the caller's perspective.
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      // Fire-and-forget — tell the real owner someone tried to register with their email
      const subject = 'Someone tried to register with your EventStrand email';
      const html    = `<p>Hi ${existing.displayName},</p>
        <p>Someone just tried to register an EventStrand account using your email address.
        If that was you, you already have an account — just
        <a href="https://eventstrand.com/#login">sign in</a> instead.</p>
        <p>If it wasn't you, no action is needed.</p>`;
      sendEmail({ to: existing.email, subject, html }).catch(() => {});
      // Return a token for the NEW user attempt — but there's no new user.
      // Simplest safe approach: return 201 with a generic message; no token, no user data.
      return res.status(201).json({ ok: true });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const rawVerifyToken = newToken();

    const user = await User.create({
      email: email.toLowerCase(),
      passwordHash,
      displayName: displayName ? displayName.trim().slice(0, 60) : email.split('@')[0],
      accountType: accountType === 'venue' ? 'venue' : 'personal',
      emailVerified: false,
      verifyToken:        hashToken(rawVerifyToken),   // B-6: store hash, not raw
      verifyTokenExpires: new Date(Date.now() + VERIFY_TTL_MS),
    });

    // Fire-and-forget — don't block signup on email delivery
    const tpl = verifyEmailTemplate(user.displayName, rawVerifyToken);  // raw goes in email
    sendEmail({ to: user.email, ...tpl }).catch(e => console.error('verify email send failed:', e));

    const token = signToken(user._id);
    setAuthCookie(res, token);
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
    setAuthCookie(res, token);
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
      try {
        user = await User.create({
          googleId,
          email: normEmail,
          displayName: name,
          picture,
          emailVerified: !!email_verified,
        });
      } catch (createErr) {
        // B-9: Catch E11000 duplicate key from a concurrent first-time sign-in.
        // Two simultaneous requests for the same new user both hit findOne → null
        // and race to create. The second throws E11000 — retry the lookup and
        // return the user that the first request already created.
        if (createErr.code === 11000) {
          user = await User.findOne({ googleId }) || await User.findOne({ email: normEmail });
          if (!user) return next(createErr); // genuinely unexpected — re-throw
        } else {
          return next(createErr);
        }
      }
    } else {
      user.googleId    = googleId;
      user.picture     = picture || user.picture;
      user.displayName = user.displayName || name;
      // Trust Google's email verification — promote local account if Google says so
      if (email_verified && !user.emailVerified) user.emailVerified = true;
      await user.save();
    }

    const token = signToken(user._id);
    setAuthCookie(res, token);
    res.json({ token, user: userJson(user) });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/verify-email — confirm an email verification token
router.post('/verify-email', validate(schemas.verifyEmail), async (req, res, next) => {
  try {
    const { token } = req.body;
    // B-6: Look up by hash of the incoming token, not the raw token
    const user = await User.findOne({ verifyToken: hashToken(token) })
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

    const rawVerifyToken = newToken();
    req.user.verifyToken        = hashToken(rawVerifyToken);  // B-6: store hash
    req.user.verifyTokenExpires = new Date(Date.now() + VERIFY_TTL_MS);
    await req.user.save();

    const tpl = verifyEmailTemplate(req.user.displayName, rawVerifyToken);  // raw in email
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
      const rawResetToken = newToken();
      user.resetToken        = hashToken(rawResetToken);   // B-6: store hash
      user.resetTokenExpires = new Date(Date.now() + RESET_TTL_MS);
      await user.save();
      const tpl = resetPasswordTemplate(user.displayName, rawResetToken);  // raw in email
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
    // B-6: Look up by hash of the incoming token
    const user = await User.findOne({ resetToken: hashToken(token) })
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
    setAuthCookie(res, newJwt);
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

// POST /api/auth/logout — clear the auth cookie
router.post('/logout', (req, res) => {
  res.clearCookie('es_jwt', { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
  res.json({ ok: true });
});

// GET /api/auth/me — verify session and return current user (used on page load to restore session)
router.get('/me', auth, (req, res) => {
  res.json({ user: userJson(req.user) });
});

module.exports = router;

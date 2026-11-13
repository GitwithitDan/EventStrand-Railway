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
const optionalAuth = require('../middleware/optionalAuth');
const { HANDLE_RE, RESERVED_HANDLES, cooldownDays, handleChangeableAt, isHandleAvailable } = require('../lib/handles');

if (!process.env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID env var is required');
if (!process.env.JWT_SECRET)       throw new Error('JWT_SECRET env var is required');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;        // 24 hours
const RESET_TTL_MS  = 60 * 60 * 1000;             // 1 hour

// B-QA7: Per-account login lockout, on top of the IP-level rate limiter in
// server.js. The IP limiter alone gave no visible feedback and doesn't stop
// repeated guesses against one account from a rotating/shared IP.
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_MS      = 15 * 60 * 1000;         // 15 minutes

// `tv` is the user's tokenVersion at signing time. Bumping tokenVersion (password
// reset, sign out everywhere, account linking) invalidates every earlier token.
function signToken(user) {
  return jwt.sign({ userId: user._id, tv: user.tokenVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '90d' });
}

const escHtml = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Every sign-in response carries cookieSession:true. The web app then relies on
// the httpOnly cookie alone and never keeps the token where page scripts can
// read it. `token` stays in the body for non-browser clients.
function sessionJson(token, user, extras = {}) {
  return { ...extras, token, cookieSession: true, user: userJson(user) };
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

// New accounts must confirm their email before they can sign in. This needs
// working email delivery, so it applies only when RESEND_API_KEY is set;
// without it, sign-up signs the user in directly as before.
const verificationRequired = () => !!process.env.RESEND_API_KEY;
// The one reply every sign-up gets, whether or not the address already has an
// account, so the form never reveals who is registered.
const SIGNUP_REPLY = { ok: true, verifyRequired: true };

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
    pictureSource: u.pictureSource || '',
    handle:        u.handle || null,
    handleChangeableAt: handleChangeableAt(u),
    handleCooldownDays: cooldownDays(),
    accountType:   u.accountType,
    emailVerified: u.emailVerified,
    isAdmin:       !!u.isAdmin,
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
      const html    = `<p>Hi ${escHtml(existing.displayName)},</p>
        <p>Someone just tried to register an EventStrand account using your email address.
        If that was you, you already have an account — just
        <a href="https://eventstrand.com/#login">sign in</a> instead.</p>
        <p>If it wasn't you, no action is needed.</p>`;
      sendEmail({ to: existing.email, subject, html }).catch(() => {});
      // Spend the same time hashing as a real sign-up would, so response time
      // does not give the answer away either.
      await bcrypt.hash(password, 12);
      return res.status(201).json(verificationRequired() ? SIGNUP_REPLY : { ok: true });
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

    if (verificationRequired()) return res.status(201).json(SIGNUP_REPLY);

    const token = signToken(user);
    setAuthCookie(res, token);
    res.status(201).json(sessionJson(token, user));
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/login — email + password sign in
router.post('/login', validate(schemas.login), async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() })
      .select('+failedLoginAttempts +lockUntil');
    // Don't reveal whether the email exists — same generic message as a bad password.
    if (!user || !user.passwordHash) return res.status(401).json({ error: 'Invalid email or password' });

    if (user.lockUntil && user.lockUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockUntil - new Date()) / 60000);
      return res.status(423).json({
        error: `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`,
      });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
      if (user.failedLoginAttempts >= MAX_LOGIN_ATTEMPTS) {
        user.lockUntil = new Date(Date.now() + LOGIN_LOCK_MS);
        user.failedLoginAttempts = 0;
        await user.save();
        return res.status(423).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
      }
      await user.save();
      // Same message as an unknown email, so the reply never confirms an account exists.
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Right password, but the email was never confirmed: send a fresh link
    // instead of a session.
    if (!user.emailVerified && verificationRequired()) {
      const rawVerifyToken = newToken();
      user.verifyToken        = hashToken(rawVerifyToken);
      user.verifyTokenExpires = new Date(Date.now() + VERIFY_TTL_MS);
      user.failedLoginAttempts = 0;
      user.lockUntil = null;
      await user.save();
      const tpl = verifyEmailTemplate(user.displayName, rawVerifyToken);
      sendEmail({ to: user.email, ...tpl }).catch(e => console.error('verify email send failed:', e));
      return res.status(403).json({
        error: 'Confirm your email first — we just sent a new link to your inbox.',
        needsVerification: true,
      });
    }

    // Successful login — clear any accumulated failures.
    if (user.failedLoginAttempts || user.lockUntil) {
      user.failedLoginAttempts = 0;
      user.lockUntil = null;
      await user.save();
    }

    const token = signToken(user);
    setAuthCookie(res, token);
    res.json(sessionJson(token, user));
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

    let ticket;
    try {
      ticket = await client.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
    } catch (verifyErr) {
      return res.status(401).json({ error: 'Google sign-in could not be verified' });
    }
    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email) {
      return res.status(401).json({ error: 'Google sign-in could not be verified' });
    }
    const { sub: googleId, email, name, picture, email_verified } = payload;

    const normEmail = email.toLowerCase();

    let user = await User.findOne({ googleId });
    let linkingByEmail = false;
    if (!user) {
      user = await User.findOne({ email: normEmail }).select('+passwordHash');
      linkingByEmail = !!user;
    }
    // Linking to an existing account by email needs Google's proof of ownership.
    if (linkingByEmail && !email_verified) {
      return res.status(401).json({ error: 'Verify this email with Google before signing in' });
    }

    if (!user) {
      try {
        user = await User.create({
          googleId,
          email: normEmail,
          displayName: name,
          picture,
          pictureSource: picture ? 'google' : '',
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
      // An account whose email was never verified may have been created by
      // someone else using this address. The Google owner takes it over: the
      // old password stops working and every earlier session is signed out.
      if (linkingByEmail && !user.emailVerified) {
        user.passwordHash = null;
        user.tokenVersion = (user.tokenVersion || 0) + 1;
      }
      user.googleId    = googleId;
      // Never overwrite a photo the user uploaded themselves.
      if (user.pictureSource !== 'upload' && picture) {
        user.picture       = picture;
        user.pictureSource = 'google';
      }
      user.displayName = user.displayName || name;
      // Trust Google's email verification — promote local account if Google says so
      if (email_verified && !user.emailVerified) user.emailVerified = true;
      await user.save();
    }

    const token = signToken(user);
    setAuthCookie(res, token);
    res.json(sessionJson(token, user));
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
    // A new password signs out every session that existed before it.
    user.tokenVersion      = (user.tokenVersion || 0) + 1;
    await user.save();

    const newJwt = signToken(user);
    setAuthCookie(res, newJwt);
    res.json(sessionJson(newJwt, user, { ok: true }));
  } catch (e) {
    next(e);
  }
});

// GET /api/auth/check-handle?handle=xxx
// Public. If the caller is signed in, their own current/previous handles
// count as available to them.
router.get('/check-handle', optionalAuth, async (req, res, next) => {
  try {
    const { handle } = req.query;
    if (!handle || !HANDLE_RE.test(handle)) {
      return res.status(400).json({ error: 'Invalid handle format' });
    }
    const lower = handle.toLowerCase();
    if (req.user && req.user.handle === lower) return res.json({ available: true, own: true });
    res.json({ available: await isHandleAvailable(lower, req.user?._id) });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/set-handle
// Rules live in lib/handles.js: format, reserved words, uniqueness across
// current + previous handles, change cooldown, permanent redirects.
router.post('/set-handle', auth, async (req, res, next) => {
  try {
    const { handle } = req.body;
    if (!handle || !HANDLE_RE.test(handle)) {
      return res.status(400).json({ error: 'Handles are 3–30 characters: letters, numbers, - and _ only' });
    }
    const lower     = handle.toLowerCase();
    const oldHandle = req.user.handle;

    // No-op: same handle
    if (oldHandle === lower) {
      return res.json({ ok: true, handle: lower, handleChangeableAt: handleChangeableAt(req.user) });
    }

    if (RESERVED_HANDLES.includes(lower)) {
      return res.status(400).json({ error: 'That handle is reserved' });
    }

    // Cooldown applies to changes only — the first handle is always free to set.
    const waitUntil = oldHandle ? handleChangeableAt(req.user) : null;
    if (waitUntil) {
      return res.status(429).json({
        error: `You can change your handle again on ${waitUntil.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`,
        handleChangeableAt: waitUntil,
      });
    }

    if (!(await isHandleAvailable(lower, req.user._id))) {
      return res.status(409).json({ error: 'Handle already taken' });
    }

    if (oldHandle) {
      // Old handle keeps redirecting forever (no cap) and stays reserved.
      if (!req.user.previousHandles.includes(oldHandle)) req.user.previousHandles.push(oldHandle);
      // Taking back one of your own previous handles: it is current again.
      req.user.previousHandles = req.user.previousHandles.filter(h => h !== lower);
      req.user.handleChangedAt = new Date();
    }

    req.user.handle = lower;
    try {
      await req.user.save();
    } catch (saveErr) {
      // Unique index lost a race with a concurrent claim
      if (saveErr.code === 11000) return res.status(409).json({ error: 'Handle already taken' });
      throw saveErr;
    }

    if (oldHandle) {
      const Strand = require('../models/Strand');
      const Braid  = require('../models/Braid');
      await Strand.updateMany({ publisher: req.user._id }, { publisherHandle: lower });
      await Braid.updateMany({ publisher: req.user._id }, { publisherHandle: lower });
    }

    res.json({ ok: true, handle: lower, handleChangeableAt: handleChangeableAt(req.user) });
  } catch (e) {
    next(e);
  }
});

// PATCH /api/auth/profile — update display name
router.patch('/profile', auth, async (req, res, next) => {
  try {
    const { displayName } = req.body;
    if (typeof displayName === 'string') {
      const name = displayName.trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: 'Display name cannot be empty' });
      req.user.displayName = name;
    }
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

// POST /api/auth/logout-all — sign out every device, including this one
router.post('/logout-all', auth, async (req, res, next) => {
  try {
    req.user.tokenVersion = (req.user.tokenVersion || 0) + 1;
    await req.user.save();
    res.clearCookie('es_jwt', { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// GET /api/auth/me — verify session and return current user (used on page load to restore session)
// A browser that still holds an older header token is moved onto the httpOnly
// cookie here, after which the web app discards its copy of the token.
router.get('/me', auth, (req, res) => {
  if (!req.authViaCookie && !req.apiKey) setAuthCookie(res, signToken(req.user));
  res.json({ user: userJson(req.user), cookieSession: true });
});

// DELETE /api/auth/account — permanently delete the account and everything it owns.
// Body: { confirm: "DELETE" }. Accounts with a password must also send it.
router.delete('/account', auth, async (req, res, next) => {
  try {
    if (req.apiKey) return res.status(403).json({ error: 'API keys cannot delete an account' });
    if (req.body?.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });

    const full = await User.findById(req.user._id).select('+passwordHash');
    if (full.passwordHash) {
      const ok = typeof req.body.password === 'string' && await bcrypt.compare(req.body.password, full.passwordHash);
      if (!ok) return res.status(401).json({ error: 'Password is incorrect' });
    }

    const Strand       = require('../models/Strand');
    const Braid        = require('../models/Braid');
    const Workspace    = require('../models/Workspace');
    const ApiKey       = require('../models/ApiKey');
    const Interested   = require('../models/Interested');
    const Notification = require('../models/Notification');
    const userId = req.user._id;

    // Give back the subscriber counts this account contributed.
    const myWorkspaces = await Workspace.find({ user: userId }).select('strands braids').lean();
    const subStrands = [...new Set(myWorkspaces.flatMap(w => (w.strands || []).map(String)))];
    const subBraids  = [...new Set(myWorkspaces.flatMap(w => (w.braids  || []).map(String)))];
    if (subStrands.length) await Strand.updateMany({ _id: { $in: subStrands }, subscriberCount: { $gt: 0 } }, { $inc: { subscriberCount: -1 } });
    if (subBraids.length)  await Braid.updateMany({ _id: { $in: subBraids },  subscriberCount: { $gt: 0 } }, { $inc: { subscriberCount: -1 } });

    // Remove what the account published from everyone else's portals and braids.
    const ownStrands = (await Strand.find({ publisher: userId }).select('_id').lean()).map(s => s._id);
    const ownBraids  = (await Braid.find({ publisher: userId }).select('_id').lean()).map(b => b._id);
    if (ownStrands.length) {
      await Workspace.updateMany({ strands: { $in: ownStrands } }, { $pull: { strands: { $in: ownStrands } } });
      await Braid.updateMany({ strands: { $in: ownStrands } }, { $pull: { strands: { $in: ownStrands } } });
    }
    if (ownBraids.length) await Workspace.updateMany({ braids: { $in: ownBraids } }, { $pull: { braids: { $in: ownBraids } } });

    await Promise.all([
      Strand.deleteMany({ publisher: userId }),
      Braid.deleteMany({ publisher: userId }),
      Workspace.deleteMany({ user: userId }),
      ApiKey.deleteMany({ user: userId }),
      Interested.deleteMany({ user: userId }),
      Notification.deleteMany({ user: userId }),
    ]);
    await User.deleteOne({ _id: userId });

    res.clearCookie('es_jwt', { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;

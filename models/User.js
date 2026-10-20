const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId:        { type: String, unique: true, sparse: true },
  passwordHash:    { type: String, default: null },
  email:           { type: String, required: true, unique: true, lowercase: true },
  displayName:     { type: String, default: '' },
  picture:         { type: String, default: '' },
  // Where `picture` came from: 'upload' (user-chosen, stored in the R2 bucket — see routes/avatar.js),
  // 'google' (Google profile photo, refreshed on Google sign-in), or ''.
  // A Google sign-in never overwrites an uploaded picture.
  pictureSource:   { type: String, enum: ['', 'google', 'upload'], default: '' },
  handle:          { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  accountType:     { type: String, enum: ['personal', 'venue'], default: 'personal' },
  // Moderation access. Deliberately NOT settable through any API route —
  // only ever flipped by hand in the database. That means there is no code
  // path anywhere in the app that can grant admin access.
  isAdmin:         { type: Boolean, default: false },
  // Handle history — every old handle redirects to the current one forever
  // (no cap), so URLs printed on QR codes and signage never break. Old
  // handles are also reserved: no other account can claim them. See
  // lib/handles.js for the full rule set.
  previousHandles: [{ type: String, lowercase: true }],
  // Set when the handle is CHANGED (not on first set). Drives the
  // change cooldown in lib/handles.js.
  handleChangedAt: { type: Date, default: null },

  // ── EMAIL VERIFICATION ────────────────────────────────────
  emailVerified:        { type: Boolean, default: false },
  verifyToken:          { type: String, default: null, select: false },
  verifyTokenExpires:   { type: Date,   default: null, select: false },

  // ── PASSWORD RESET ────────────────────────────────────────
  resetToken:           { type: String, default: null, select: false },
  resetTokenExpires:    { type: Date,   default: null, select: false },

  // ── LOGIN LOCKOUT (B-QA7) ──────────────────────────────────
  // Per-account failed-attempt counter, separate from the IP-level rate
  // limiter in server.js. Reset to 0 on any successful login.
  failedLoginAttempts:  { type: Number, default: 0, select: false },
  lockUntil:            { type: Date,   default: null, select: false },
}, { timestamps: true });

userSchema.index({ previousHandles: 1 });
userSchema.index({ verifyToken: 1 });
userSchema.index({ resetToken: 1 });

module.exports = mongoose.model('User', userSchema);

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId:        { type: String, unique: true, sparse: true },
  passwordHash:    { type: String, default: null },
  email:           { type: String, required: true, unique: true, lowercase: true },
  displayName:     { type: String, default: '' },
  picture:         { type: String, default: '' },
  handle:          { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  accountType:     { type: String, enum: ['personal', 'venue'], default: 'personal' },
  // Handle history — old handles redirect to current
  previousHandles: [{ type: String, lowercase: true }],

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

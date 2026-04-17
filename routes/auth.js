const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId:     { type: String, unique: true, sparse: true },
  passwordHash: { type: String, default: null },
  email:        { type: String, required: true, unique: true, lowercase: true },
  displayName: { type: String, default: '' },
  picture:     { type: String, default: '' },
  handle:      { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  // Handle history — old handles redirect to current
  previousHandles: [{ type: String, lowercase: true }],
}, { timestamps: true });

// handle index is declared via `unique: true` on the field above — no duplicate needed
userSchema.index({ previousHandles: 1 });

module.exports = mongoose.model('User', userSchema);

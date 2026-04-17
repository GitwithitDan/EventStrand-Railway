const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId:    { type: String, unique: true, sparse: true },
  email:       { type: String, required: true, unique: true, lowercase: true },
  displayName: { type: String, default: '' },
  picture:     { type: String, default: '' },
  handle:      { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  // Handle history — old handles redirect to current
  previousHandles: [{ type: String, lowercase: true }],
}, { timestamps: true });

userSchema.index({ handle: 1 });
userSchema.index({ previousHandles: 1 });

module.exports = mongoose.model('User', userSchema);

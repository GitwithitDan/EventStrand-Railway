const mongoose = require('mongoose');

const interestedSchema = new mongoose.Schema({
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  key:       { type: String, required: true },   // "{eventId}_{date}" — unique per user
  eventId:   String,
  date:      String,
  time:      String,
  title:     String,
  venue:     String,
  strand:    String,
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

// One entry per user+key — makes upsert safe
interestedSchema.index({ user: 1, key: 1 }, { unique: true });
// TTL — MongoDB auto-deletes documents once expiresAt passes
interestedSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Interested', interestedSchema);

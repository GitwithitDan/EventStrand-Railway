const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  user:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  message:     { type: String, required: true },
  strandTitle: String,
  strandId:    mongoose.Schema.Types.ObjectId,
  braidId:     mongoose.Schema.Types.ObjectId,
  type:        { type: String, enum: ['strand_updated','strand_added_to_braid','braid_updated'], default: 'strand_updated' },
  read:        { type: Boolean, default: false },
}, { timestamps: true });

notificationSchema.index({ user: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);

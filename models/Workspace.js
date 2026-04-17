const mongoose = require('mongoose');

const workspaceSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:     { type: String, required: true },
  icon:     { type: String, default: '🌅' },
  isActive: { type: Boolean, default: false },
  strands:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'Strand' }],
  braids:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'Braid' }],
  // track last-seen timestamps per strand for unread detection
  lastSeen: { type: Map, of: Date, default: {} },
}, { timestamps: true });

workspaceSchema.index({ user: 1 });

module.exports = mongoose.model('Workspace', workspaceSchema);

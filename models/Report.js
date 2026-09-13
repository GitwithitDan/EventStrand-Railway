const mongoose = require('mongoose');

// Keep in sync with the report modal's option list in app.js.
const REASONS = ['impersonation', 'nonexistent', 'inaccurate', 'spam', 'inappropriate', 'other'];

const reportSchema = new mongoose.Schema({
  strand:     { type: mongoose.Schema.Types.ObjectId, ref: 'Strand', required: true },
  reporter:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reason:     { type: String, enum: REASONS, required: true },
  details:    { type: String, default: '', trim: true, maxlength: 1000 },
  status:     { type: String, enum: ['open', 'resolved'], default: 'open' },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolvedAt: { type: Date, default: null },
}, { timestamps: true });

// One report per (reporter, strand) — resubmitting updates the existing row
// instead of creating a new one, so a single account can't flood the queue
// by reporting the same strand repeatedly.
reportSchema.index({ strand: 1, reporter: 1 }, { unique: true });
// Admin queue is sorted/filtered by status, newest first.
reportSchema.index({ status: 1, createdAt: -1 });

reportSchema.statics.REASONS = REASONS;

module.exports = mongoose.model('Report', reportSchema);

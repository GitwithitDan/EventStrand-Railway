const mongoose = require('mongoose');

const braidSchema = new mongoose.Schema({
  publisher:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  publisherHandle: String,
  title:           { type: String, required: true },
  description:     String,
  visibility:      { type: String, enum: ['public','unlisted','protected'], default: 'public' },
  accessCode:      String,
  published:       { type: Boolean, default: false },
  strands:         [{ type: mongoose.Schema.Types.ObjectId, ref: 'Strand' }],
  subscriberCount: { type: Number, default: 0 },
  viewCount:       { type: Number, default: 0 },
}, { timestamps: true });

braidSchema.index({ publisher: 1 });
braidSchema.index({ publisherHandle: 1 });

module.exports = mongoose.model('Braid', braidSchema);

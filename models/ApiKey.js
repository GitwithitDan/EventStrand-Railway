const mongoose = require('mongoose');
const crypto   = require('crypto');

const VALID_SCOPES = [
  'strand:read',
  'strand:write',
  'events:create',
  'events:update',
  'portal:read',
  'subscriptions:read',
];

const apiKeySchema = new mongoose.Schema({
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  label:     { type: String, required: true, trim: true, maxlength: 64 },
  keyHash:   { type: String, required: true, unique: true },
  keyPrefix: { type: String, required: true }, // first 8 chars shown in UI for identification
  scopes:    { type: [String], enum: VALID_SCOPES, default: ['portal:read', 'strand:read'] },
  lastUsed:  { type: Date, default: null },
  revoked:   { type: Boolean, default: false },
}, { timestamps: true });

// Static: generate a new raw key + its hash
apiKeySchema.statics.generateKey = function () {
  const raw    = 'esk_' + crypto.randomBytes(32).toString('hex'); // esk = eventstrand key
  const hash   = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 12); // "esk_" + 8 chars
  return { raw, hash, prefix };
};

// Static: look up a key by its raw value
apiKeySchema.statics.findByRaw = async function (raw) {
  if (!raw || !raw.startsWith('esk_')) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return this.findOne({ keyHash: hash, revoked: false }).populate('user');
};

module.exports = mongoose.model('ApiKey', apiKeySchema);
module.exports.VALID_SCOPES = VALID_SCOPES;

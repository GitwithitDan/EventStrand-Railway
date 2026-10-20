const express   = require('express');
const rateLimit = require('express-rate-limit');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const router    = express.Router();
const auth      = require('../middleware/auth');

// ── PROFILE PHOTOS → CLOUDFLARE R2 ───────────────────────────
// Images are stored in an R2 bucket and served straight from Cloudflare's
// CDN at R2_PUBLIC_URL (e.g. https://images.eventstrand.com). The API only
// handles uploads/deletes; it never serves image bytes, so photo traffic
// does not touch Railway or MongoDB.
//
// Required env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
// R2_BUCKET, R2_PUBLIC_URL. Optional: R2_ENDPOINT (override, e.g. EU bucket).
// If any are missing, uploads return 503 and nothing else is affected.

const MAX_BYTES = 150 * 1024;
const REQUIRED  = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'];
const configured = REQUIRED.every(k => process.env[k]);
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');

if (!configured) {
  console.warn('[avatar] R2 env vars not set — photo uploads disabled until ' + REQUIRED.join(', ') + ' are set');
}

const s3 = configured ? new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  // R2 does not support the SDK's newer default checksum headers.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
}) : null;

// JPEG / PNG / WebP only. SVG is deliberately not accepted (script risk).
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function magicMatches(mime, buf) {
  if (mime === 'image/jpeg') return buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  if (mime === 'image/png')  return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]));
  if (mime === 'image/webp') return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

// Object key for a photo URL we issued, or null (e.g. a Google photo URL).
function keyFromUrl(url) {
  if (!configured || !url || !url.startsWith(PUBLIC_URL + '/')) return null;
  const key = url.slice(PUBLIC_URL.length + 1).split('?')[0];
  return key.startsWith('avatars/') ? key : null;
}

async function deleteKey(key) {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
  } catch (e) {
    console.error('[avatar] could not delete old object', key, e.message);
  }
}

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: req => req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many photo changes — try again later' },
});

// POST /api/avatar — body: { image: "data:image/jpeg;base64,..." }
router.post('/', auth, uploadLimiter, async (req, res, next) => {
  try {
    if (!configured) return res.status(503).json({ error: 'Photo uploads are not available right now' });

    const m = DATA_URL_RE.exec(req.body?.image || '');
    if (!m) return res.status(400).json({ error: 'Upload a JPEG, PNG, or WebP image' });
    const mime = m[1];
    const buf  = Buffer.from(m[2], 'base64');
    if (buf.length === 0 || buf.length > MAX_BYTES) {
      return res.status(400).json({ error: 'Image is too large — please choose a smaller one' });
    }
    if (!magicMatches(mime, buf)) {
      return res.status(400).json({ error: 'That file is not a valid image' });
    }

    // New key per upload → URL changes → CDN/browser caches never serve a stale photo.
    const key = `avatars/${req.user._id}/${Date.now()}.${EXT[mime]}`;
    await s3.send(new PutObjectCommand({
      Bucket:       process.env.R2_BUCKET,
      Key:          key,
      Body:         buf,
      ContentType:  mime,
      CacheControl: 'public, max-age=31536000, immutable',
    }));

    const oldKey = keyFromUrl(req.user.picture);
    req.user.picture       = `${PUBLIC_URL}/${key}`;
    req.user.pictureSource = 'upload';
    await req.user.save();
    await deleteKey(oldKey);

    res.json({ ok: true, picture: req.user.picture, pictureSource: 'upload' });
  } catch (e) { next(e); }
});

// DELETE /api/avatar — remove uploaded image (falls back to initial / Google photo on next Google sign-in)
router.delete('/', auth, async (req, res, next) => {
  try {
    const oldKey = keyFromUrl(req.user.picture);
    req.user.picture       = '';
    req.user.pictureSource = '';
    await req.user.save();
    await deleteKey(oldKey);
    res.json({ ok: true, picture: '', pictureSource: '' });
  } catch (e) { next(e); }
});

module.exports = router;

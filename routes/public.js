const express = require('express');
const router  = express.Router();
const Strand  = require('../models/Strand');
const Braid   = require('../models/Braid');
const User    = require('../models/User');

// GET /api/public/strand/:handle/:strandId
router.get('/strand/:handle/:strandId', async (req, res, next) => {
  try {
    const { handle, strandId } = req.params;

    // Resolve handle — check current + previous handles for redirect support
    const user = await User.findOne({
      $or: [{ handle }, { previousHandles: handle }]
    });
    if (!user) return res.status(404).json({ error: 'Publisher not found' });

    const strand = await Strand.findOne({
      _id: strandId,
      publisher: user._id,
      published: true,
    }).select('-accessCode');

    if (!strand) return res.status(404).json({ error: 'Strand not found' });

    if (strand.visibility === 'protected') {
      const passcode = req.query.passcode;
      const strandWithCode = await Strand.findById(strandId).select('accessCode');
      if (!passcode || passcode !== strandWithCode.accessCode) {
        return res.status(403).json({ error: 'Passcode required' });
      }
    }

    // Increment view count (async, non-blocking)
    // Rolling 30-day index: days since Unix epoch mod 30 (0–29)
    const today = Math.floor(Date.now() / 86400000) % 30;
    Strand.findByIdAndUpdate(strandId, {
      $inc: { viewCount: 1, [`viewsHistory.${today}`]: 1 },
      lastViewedAt: new Date(),
    }).catch(() => {});

    // Track scan origin if via QR (ref header or ?src param)
    const src = req.query.src || req.get('referer');
    if (src) {
      const origin = src.includes('qr') ? 'QR scan' : new URL(src.startsWith('http') ? src : 'http://x/' + src).hostname || 'direct';
      Strand.findByIdAndUpdate(strandId, {
        $inc: { scanCount: 1 },
      }).catch(() => {});
    }

    res.json({ strand, publisherHandle: user.handle });
  } catch (e) { next(e); }
});

// GET /api/public/braid/:handle/:braidId
router.get('/braid/:handle/:braidId', async (req, res, next) => {
  try {
    const { handle, braidId } = req.params;

    const user = await User.findOne({
      $or: [{ handle }, { previousHandles: handle }]
    });
    if (!user) return res.status(404).json({ error: 'Publisher not found' });

    const braid = await Braid.findOne({
      _id: braidId,
      publisher: user._id,
      published: true,
    }).populate('strands', 'title venue publisherHandle events color subscriberCount');

    if (!braid) return res.status(404).json({ error: 'Braid not found' });

    if (braid.visibility === 'protected') {
      const braidWithCode = await Braid.findById(braidId).select('accessCode');
      if (req.query.passcode !== braidWithCode.accessCode) {
        return res.status(403).json({ error: 'Passcode required' });
      }
    }

    Braid.findByIdAndUpdate(braidId, { $inc: { viewCount: 1 } }).catch(() => {});

    res.json({ braid: { ...braid.toObject(), publisherHandle: user.handle } });
  } catch (e) { next(e); }
});

// GET /api/public/profile/:handle
router.get('/profile/:handle', async (req, res, next) => {
  try {
    const { handle } = req.params;

    const user = await User.findOne({
      $or: [{ handle }, { previousHandles: handle }]
    });
    if (!user) return res.status(404).json({ error: 'Profile not found' });

    // Redirect to canonical handle if using an old one
    if (user.handle !== handle) {
      return res.json({ redirect: user.handle });
    }

    const strands = await Strand.find({
      publisher: user._id,
      published: true,
      visibility: 'public',
    }).select('title venue color subscriberCount events').sort({ subscriberCount: -1 });

    const braids = await Braid.find({
      publisher: user._id,
      published: true,
      visibility: 'public',
    }).select('title description subscriberCount').sort({ subscriberCount: -1 });

    res.json({
      profile: {
        handle:      user.handle,
        displayName: user.displayName,
        picture:     user.picture,
        strands,
        braids,
      },
    });
  } catch (e) { next(e); }
});

// GET /api/public/strands/search?q=xxx
router.get('/strands/search', async (req, res, next) => {
  try {
    const q = req.query.q?.trim();
    if (!q || q.length < 2) return res.json({ strands: [] });

    const strands = await Strand.find({
      published: true,
      visibility: 'public',
      $or: [
        { title: { $regex: q, $options: 'i' } },
        { venue: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } },
      ],
    })
      .select('title venue publisherHandle color subscriberCount')
      .sort({ subscriberCount: -1 })
      .limit(20);

    res.json({ strands });
  } catch (e) { next(e); }
});

module.exports = router;

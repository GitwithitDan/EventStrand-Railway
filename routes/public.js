const express      = require('express');
const router       = express.Router();
const Strand       = require('../models/Strand');
const Braid        = require('../models/Braid');
const User         = require('../models/User');
const Workspace    = require('../models/Workspace');
const optionalAuth = require('../middleware/optionalAuth');
const mongoose     = require('mongoose');
const { DateTime } = require('luxon');
const { checkPasscode } = require('../lib/access');
const { viewUpdate }    = require('../lib/views');
const { getOccurrences, describeSchedule } = require('../lib/occurrences');

// Fields that belong to the publisher only and never leave through a public route.
const PRIVATE_STRAND_FIELDS = '-accessCode -viewsHistory -viewsHistoryDay -scanOrigins -scanCount -lastViewedAt '
  + '-directoryVerificationUrl -directoryLastError -directoryLastAttemptAt';

const isId = v => typeof v === 'string' && mongoose.isValidObjectId(v);
const handleParam = v => String(v || '').toLowerCase();

// Escape user input for safe use in a MongoDB $regex query
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GET /api/public/strand/:handle/:strandId
router.get('/strand/:handle/:strandId', optionalAuth, async (req, res, next) => {
  try {
    const handle = handleParam(req.params.handle);
    const { strandId } = req.params;
    if (!isId(strandId)) return res.status(404).json({ error: 'Strand not found' });

    // Resolve handle — check current + previous handles for redirect support
    const user = await User.findOne({
      $or: [{ handle }, { previousHandles: handle }]
    });
    if (!user) return res.status(404).json({ error: 'Publisher not found' });

    // If using an old handle, tell the client the canonical one
    if (user.handle !== handle) {
      return res.json({ redirect: user.handle });
    }

    const strand = await Strand.findOne({
      _id: strandId,
      publisher: user._id,
      published: true,
    });

    if (!strand) return res.status(404).json({ error: 'Strand not found' });

    const denied = checkPasscode(req, strand);
    if (denied) return res.status(denied.status).json({ error: denied.error, passcodeHeader: true });

    // Count the view (async, non-blocking). The publisher's own visits don't count.
    if (!req.user || String(req.user._id) !== String(user._id)) {
      Strand.updateOne({ _id: strandId }, viewUpdate(strand)).catch(() => {});
    }

    // Track scan origin — only fires when ?src=qr is appended (by QR code URLs)
    const src = req.query.src;
    if (src === 'qr') {
      const label = 'QR scan';
      // Increment existing origin label, or push a new one
      const updated = await Strand.findOneAndUpdate(
        { _id: strandId, 'scanOrigins.label': label },
        { $inc: { scanCount: 1, 'scanOrigins.$.count': 1 } },
      );
      if (!updated) {
        await Strand.findByIdAndUpdate(strandId, {
          $inc: { scanCount: 1 },
          $push: { scanOrigins: { label, count: 1 } },
        });
      }
    }

    // If the request came from a signed-in user, tell the frontend whether
    // they already subscribe to this strand in any workspace, so the public
    // strand page can render "Subscribed" instead of always showing "Subscribe".
    let subscribed = false;
    if (req.user) {
      subscribed = await Workspace.exists({ user: req.user._id, strands: strand._id });
    }

    // What a visitor actually wants: the next dates, and each event's schedule
    // in plain words. Computed here so every client shows the same answer.
    const tz    = strand.timezone || 'UTC';
    const start = DateTime.now().setZone(tz).isValid ? DateTime.now().setZone(tz) : DateTime.now().setZone('UTC');
    const from  = start.toISODate();
    const to    = start.plus({ days: 90 }).toISODate();
    const upcoming = [];
    const schedules = {};
    for (const ev of strand.events || []) {
      schedules[String(ev._id)] = describeSchedule(ev);
      for (const o of getOccurrences(ev, from, to)) {
        upcoming.push({
          eventId:   ev._id,
          title:     ev.title,
          date:      o.date,
          timeStart: o.no_time ? '' : (o.time_start || ''),
          timeEnd:   o.no_time ? '' : (o.time_end || ''),
          noTime:    !!o.no_time,
          note:      o.note || '',
          modified:  !!o.modified,
        });
      }
    }
    upcoming.sort((a, b) => a.date.localeCompare(b.date) || a.timeStart.localeCompare(b.timeStart));

    const out = strand.toObject();
    for (const f of PRIVATE_STRAND_FIELDS.split(' ')) delete out[f.slice(1)];

    res.set('Cache-Control', 'no-store');
    res.json({
      strand: out,
      publisherHandle: user.handle,
      subscribed: !!subscribed,
      upcoming: upcoming.slice(0, 60),
      schedules,
    });
  } catch (e) { next(e); }
});

// GET /api/public/braid/:handle/:braidId
router.get('/braid/:handle/:braidId', async (req, res, next) => {
  try {
    const handle = handleParam(req.params.handle);
    const { braidId } = req.params;
    if (!isId(braidId)) return res.status(404).json({ error: 'Braid not found' });

    const user = await User.findOne({
      $or: [{ handle }, { previousHandles: handle }]
    });
    if (!user) return res.status(404).json({ error: 'Publisher not found' });

    if (user.handle !== handle) {
      return res.json({ redirect: user.handle });
    }

    const braid = await Braid.findOne({
      _id: braidId,
      publisher: user._id,
      published: true,
    }).populate({
      // A braid only ever shows strands that are themselves open to read:
      // published, and not behind their own passcode.
      path:   'strands',
      select: 'title venue publisherHandle events color subscriberCount',
      match:  { published: true, visibility: { $ne: 'protected' } },
    });

    if (!braid) return res.status(404).json({ error: 'Braid not found' });

    const denied = checkPasscode(req, braid);
    if (denied) return res.status(denied.status).json({ error: denied.error, passcodeHeader: true });

    Braid.findByIdAndUpdate(braidId, { $inc: { viewCount: 1 } }).catch(() => {});

    // Track scan origin for braid QR codes
    const src = req.query.src;
    if (src === 'qr') {
      const label = 'QR scan';
      const updated = await Braid.findOneAndUpdate(
        { _id: braidId, 'scanOrigins.label': label },
        { $inc: { scanCount: 1, 'scanOrigins.$.count': 1 } },
      );
      if (!updated) {
        await Braid.findByIdAndUpdate(braidId, {
          $inc: { scanCount: 1 },
          $push: { scanOrigins: { label, count: 1 } },
        });
      }
    }

    const braidOut = braid.toObject();
    delete braidOut.accessCode;
    delete braidOut.scanOrigins;
    delete braidOut.scanCount;
    braidOut.strands = (braidOut.strands || []).filter(Boolean);

    res.set('Cache-Control', 'no-store');
    res.json({ braid: { ...braidOut, publisherHandle: user.handle } });
  } catch (e) { next(e); }
});

// GET /api/public/profile/:handle
router.get('/profile/:handle', async (req, res, next) => {
  try {
    const handle = handleParam(req.params.handle);

    const user = await User.findOne({
      $or: [{ handle }, { previousHandles: handle }]
    });
    if (!user) return res.status(404).json({ error: 'Profile not found' });

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

    res.set('Cache-Control', 'no-store');
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
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    if (!q || q.length < 2) return res.json({ strands: [] });

    const safe = escapeRegex(q);

    const strands = await Strand.find({
      published: true,
      visibility: 'public',
      $or: [
        { title:       { $regex: safe, $options: 'i' } },
        { venue:       { $regex: safe, $options: 'i' } },
        { description: { $regex: safe, $options: 'i' } },
      ],
    })
      .select('title venue publisherHandle color subscriberCount')
      .sort({ subscriberCount: -1 })
      .limit(20);

    res.json({ strands });
  } catch (e) { next(e); }
});

module.exports = router;

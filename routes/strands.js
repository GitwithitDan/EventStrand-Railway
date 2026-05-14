const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const Strand   = require('../models/Strand');
const Workspace = require('../models/Workspace');
const Notification = require('../models/Notification');
const { validate, schemas } = require('../lib/validators');

// Notify all subscribers of a strand update
async function notifySubscribers(strandId, strandTitle, message) {
  try {
    const workspaces = await Workspace.find({ strands: strandId }).select('user').lean();
    const userIds = [...new Set(workspaces.map(w => w.user.toString()))];
    if (!userIds.length) return;
    await Notification.insertMany(userIds.map(userId => ({
      user: userId, message, strandTitle, strandId,
      type: 'strand_updated',
    })));
  } catch (e) {
    console.error('notify subscribers error:', e);
  }
}

// GET /api/strands/mine
router.get('/mine', auth, async (req, res, next) => {
  try {
    const strands = await Strand.find({ publisher: req.user._id })
      .sort({ updatedAt: -1 })
      .select('-accessCode');
    res.json({ strands });
  } catch (e) { next(e); }
});

// GET /api/strands/:id — load a single owned strand (for editing)
router.get('/:id', auth, async (req, res, next) => {
  try {
    const strand = await Strand.findOne({ _id: req.params.id, publisher: req.user._id });
    if (!strand) return res.status(404).json({ error: 'Strand not found' });
    res.json({ strand });
  } catch (e) { next(e); }
});

// POST /api/strands — create new strand
router.post('/', auth, validate(schemas.strandCreate), async (req, res, next) => {
  try {
    const { rcal, meta, events, visibility, accessCode } = req.body;
    if (!meta?.title) return res.status(400).json({ error: 'Title is required' });

    const strand = await Strand.create({
      publisher:       req.user._id,
      publisherHandle: req.user.handle || null,
      title:           meta.title,
      description:     meta.description,
      type:            meta.type,
      venue:           meta.location,
      address:         meta.location,
      timezone:        meta.timezone,
      color:           meta.color,
      website:         meta.website,
      visibility:      visibility || meta.visibility || 'public',
      accessCode:      accessCode || meta.access_code,
      events:          (events || []).map(e => normaliseEvent(e, null)),
      published:       false,
    });
    res.json({ strand });
  } catch (e) { next(e); }
});

// PUT /api/strands/:id — update strand, preserving per-event view counters
router.put('/:id', auth, validate(schemas.strandUpdate), async (req, res, next) => {
  try {
    const strand = await Strand.findOne({ _id: req.params.id, publisher: req.user._id });
    if (!strand) return res.status(404).json({ error: 'Strand not found' });

    const { meta, events, visibility, accessCode } = req.body;
    if (meta) {
      if (meta.title)       strand.title       = meta.title;
      if (meta.description) strand.description = meta.description;
      if (meta.type)        strand.type        = meta.type;
      if (meta.location) {
        strand.venue   = meta.location;
        strand.address = meta.location;   // keep both fields in sync
      }
      if (meta.timezone)    strand.timezone    = meta.timezone;
      if (meta.color)       strand.color       = meta.color;
      if (meta.website)     strand.website     = meta.website;
      if (meta.visibility)  strand.visibility  = meta.visibility;
      if (meta.access_code) strand.accessCode  = meta.access_code;
    }
    if (visibility)              strand.visibility = visibility;
    if (accessCode !== undefined) strand.accessCode = accessCode;

    if (events) {
      // Preserve per-event view counters by matching incoming events to existing
      // ones by their Mongo _id (present on edits) or falling back to title match
      const existingById    = new Map(strand.events.map(e => [e._id.toString(), e]));
      const existingByTitle = new Map(strand.events.map(e => [e.title?.toLowerCase(), e]));

      strand.events = events.map(e => {
        const prev = (e._id && existingById.get(e._id.toString()))
                  || existingByTitle.get(e.title?.toLowerCase());
        return normaliseEvent(e, prev?.views ?? 0);
      });
    }

    await strand.save();

    if (strand.published && strand.subscriberCount > 0) {
      await notifySubscribers(strand._id, strand.title,
        `${strand.title} has been updated`);
    }

    res.json({ strand });
  } catch (e) { next(e); }
});

// POST /api/strands/:id/publish
router.post('/:id/publish', auth, async (req, res, next) => {
  try {
    const strand = await Strand.findOne({ _id: req.params.id, publisher: req.user._id });
    if (!strand) return res.status(404).json({ error: 'Strand not found' });
    if (!req.user.handle) return res.status(400).json({ error: 'Set a handle before publishing' });
    strand.published = true;
    strand.publisherHandle = req.user.handle;
    await strand.save();
    res.json({ strand });
  } catch (e) { next(e); }
});

// DELETE /api/strands/:id — silent removal from all subscriber workspaces
router.delete('/:id', auth, async (req, res, next) => {
  try {
    const strand = await Strand.findOne({ _id: req.params.id, publisher: req.user._id });
    if (!strand) return res.status(404).json({ error: 'Strand not found' });

    await Workspace.updateMany({ strands: strand._id }, { $pull: { strands: strand._id } });
    await strand.deleteOne();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/strands/:id/analytics
router.get('/:id/analytics', auth, async (req, res, next) => {
  try {
    const strand = await Strand.findOne({ _id: req.params.id, publisher: req.user._id });
    if (!strand) return res.status(404).json({ error: 'Not found' });
    res.json({
      title:           strand.title,
      subscriberCount: strand.subscriberCount,
      totalViews:      strand.viewCount,
      viewsThisMonth:  strand.viewsHistory.slice(-30).reduce((a, b) => a + b, 0),
      scanCount:       strand.scanCount,
      viewsLast30:     strand.viewsHistory.slice(-30),
      topScanOrigins:  strand.scanOrigins.slice(0, 5).map(o => ({
        label: o.label,
        count: o.count,
        pct:   strand.scanCount ? Math.round((o.count / strand.scanCount) * 100) : 0,
      })),
      events: strand.events.map(e => ({ title: e.title, views: e.views || 0 }))
        .sort((a, b) => b.views - a.views).slice(0, 8),
    });
  } catch (e) { next(e); }
});

// Normalise incoming event data from .rcal format, preserving existing view count
function normaliseEvent(e, existingViews) {
  return {
    title:          e.title,
    category:       e.category,
    vibes:          e.vibes || [],
    price:          e.price || 'free',
    price_note:     e.price_note,
    ticket_url:     e.ticket_url,
    lead_time_days: e.lead_time_days || 0,
    notes:          e.notes,
    event_type:     e.date ? 'oneoff' : e.date_list?.length ? 'datelist' : 'recurring',
    date:           e.date,
    time_start:     e.time_start,
    time_end:       e.time_end,
    date_list:      e.date_list || [],
    recurrence:     e.recurrence || [],
    exceptions:     e.exceptions || [],
    views:          existingViews ?? e.views ?? 0,
  };
}

module.exports = router;

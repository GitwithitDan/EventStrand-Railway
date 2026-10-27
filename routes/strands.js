const express    = require('express');
const router     = express.Router();
const auth       = require('../middleware/auth');
const Strand     = require('../models/Strand');
const Workspace  = require('../models/Workspace');
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
    const { meta, events, visibility, accessCode } = req.body;
    if (!meta?.title) return res.status(400).json({ error: 'Title is required' });

    const strand = await Strand.create({
      publisher:       req.user._id,
      publisherHandle: req.user.handle || null,
      title:           meta.title,
      description:     meta.description,
      type:            meta.type,
      venue:           locStr(meta.location, 'venue'),
      address:         locStr(meta.location, 'address'),
      timezone:        meta.timezone,
      color:           meta.color,
      website:         meta.website,
      visibility:      visibility || meta.visibility || 'public',
      accessCode:      accessCode || meta.access_code,
      events:          assignSpecIds((events || []).map(e => normaliseEvent(e, null, null))),
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
        strand.venue   = locStr(meta.location, 'venue');
        strand.address = locStr(meta.location, 'address');
      }
      if (meta.timezone)    strand.timezone    = meta.timezone;
      if (meta.color)       strand.color       = meta.color;
      if (meta.website)     strand.website     = meta.website;
      if (meta.visibility)  strand.visibility  = meta.visibility;
      if (meta.access_code) strand.accessCode  = meta.access_code;
    }
    if (visibility)              strand.visibility = visibility;
    if (accessCode !== undefined) strand.accessCode = accessCode;

    // B-10: Track whether events meaningfully changed before overwriting them.
    // Capture the current event _id set so we can diff after the update.
    // "Meaningful change" = an event was added (new _id) or the count changed.
    // Meta-only saves (title, description, color, etc.) must NOT notify subscribers.
    let eventsChanged = false;
    if (events) {
      const prevIds   = new Set(strand.events.map(e => e._id.toString()));
      const prevCount = strand.events.length;

      // B-16: Fix title-dedup silently losing the first of two same-titled events.
      // Build the title fallback Map from the END of the array so the last entry
      // wins on a duplicate, but use _id matching (more reliable) as the primary key.
      const existingById    = new Map(strand.events.map(e => [e._id.toString(), e]));
      // Reverse-iterate so the first occurrence wins the Map slot
      const existingByTitle = new Map(
        [...strand.events].reverse().map(e => [e.title?.toLowerCase(), e])
      );

      strand.events = events.map(e => {
        const prev = (e._id && existingById.get(e._id.toString()))
                  || existingByTitle.get(e.title?.toLowerCase());
        return normaliseEvent(e, prev?.views ?? 0, prev);
      });
      strand.events = assignSpecIds(strand.events);

      // A new event is one that supplied no _id or supplied an _id we don't recognise
      const newCount = strand.events.length;
      eventsChanged  = newCount !== prevCount
                    || events.some(e => !e._id || !prevIds.has(e._id.toString()));
    }

    await strand.save();

    // Only notify when the strand is live and events actually changed.
    // Typo fixes to titles, color/description edits, etc. don't notify.
    if (strand.published && strand.subscriberCount > 0 && eventsChanged) {
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

    // B-QA10/13: A strand used to be publishable with 0 events, and a
    // Protected strand could go live with no passcode set — both silently.
    // Require the minimum a subscriber-facing strand needs before it can go live.
    if (!strand.title || !strand.title.trim()) {
      return res.status(400).json({ error: 'Add a strand title before publishing' });
    }
    if (!strand.events || strand.events.length === 0) {
      return res.status(400).json({ error: 'Add at least one event before publishing' });
    }
    if (strand.visibility === 'protected' && (!strand.accessCode || !strand.accessCode.trim())) {
      return res.status(400).json({ error: 'Set a passcode before publishing a protected strand' });
    }

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
function slugId(t) {
  return String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

// Spec v0.2: every event has a unique, stable id. Keep any supplied/stored
// spec_id; generate one only for events that have none; dedupe collisions.
function assignSpecIds(events) {
  const used = new Set();
  events.forEach(ev => { if (ev.spec_id) used.add(ev.spec_id); });
  const seen = new Set();
  events.forEach((ev, i) => {
    if (ev.spec_id && !seen.has(ev.spec_id)) { seen.add(ev.spec_id); return; }
    const base = slugId(ev.title) || ('event-' + (i + 1));
    let id = base, n = 2;
    while (used.has(id) || seen.has(id)) id = base + '-' + (n++);
    ev.spec_id = id; used.add(id); seen.add(id);
  });
  return events;
}

// meta.location may be a string or the spec object
function locStr(loc, kind) {
  if (!loc) return undefined;
  if (typeof loc === 'string') return loc;
  const o = loc;
  if (kind === 'venue') return o.name || o.address || undefined;
  return [o.address, o.city, o.state, o.country].filter(Boolean).join(', ') || o.name || undefined;
}

function normaliseEvent(e, existingViews, prev) {
  const dates = e.dates || [];
  return {
    spec_id:        e.spec_id || prev?.spec_id,
    description:    e.description,
    location:       e.location,
    timezone:       e.timezone,
    title:          e.title,
    category:       e.category,
    vibes:          e.vibes || [],
    price:          e.price || 'free',
    price_note:     e.price_note,
    ticket_url:     e.ticket_url,
    lead_time_days: e.lead_time_days || 0,
    notes:          e.notes,
    event_type:     e.date ? 'oneoff' : e.recurrence?.length ? 'recurring' : dates.length ? 'datelist' : 'recurring',
    date:           e.date,
    time_start:     e.time_start,
    time_end:       e.time_end,
    all_day:        e.all_day || false,
    dates:          dates,
    recurrence:     e.recurrence || [],
    exceptions:     e.exceptions || [],
    views:          existingViews ?? e.views ?? 0,
  };
}

module.exports = router;

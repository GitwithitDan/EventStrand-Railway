const express   = require('express');
const router    = express.Router();
const auth      = require('../middleware/auth');
const Workspace = require('../models/Workspace');
const { DateTime } = require('luxon');
const { getOccurrences } = require('../lib/occurrences');

// GET /api/dashboard/upcoming?workspaceId=xxx
router.get('/upcoming', auth, async (req, res, next) => {
  try {
    const query = { user: req.user._id };
    if (req.query.workspaceId && req.query.workspaceId !== 'all') {
      if (typeof req.query.workspaceId !== 'string' || !/^[0-9a-f]{24}$/i.test(req.query.workspaceId)) {
        return res.status(400).json({ error: 'Invalid workspaceId' });
      }
      query._id = req.query.workspaceId;
    }

    const workspaces = await Workspace.find(query).populate({
      path: 'strands',
      select: 'title venue address timezone events publisherHandle color',
      match: { published: true },
    });

    const days   = Math.min(Math.max(parseInt(req.query.days, 10) || 60, 1), 365);
    const events = [];
    const seenStrands = new Set();

    for (const ws of workspaces) {
      for (const strand of ws.strands || []) {
        if (!strand || seenStrands.has(strand._id.toString())) continue;
        seenStrands.add(strand._id.toString());

        // ── TIMEZONE-AWARE DATE WINDOW ───────────────────────────
        // Use the strand's timezone for all date math. Falls back to
        // UTC if the strand has no timezone set, which keeps behaviour
        // deterministic regardless of where the server runs.
        let from = DateTime.now().setZone(strand.timezone || 'UTC').startOf('day');
        if (!from.isValid) from = DateTime.now().setZone('UTC').startOf('day');
        const tz = from.zoneName;
        const to = from.plus({ days });

        for (const ev of strand.events || []) {
          // One engine for every consumer — see lib/occurrences.js.
          for (const o of getOccurrences(ev, from.toISODate(), to.toISODate())) {
            events.push({
              eventId:     ev._id,
              title:       ev.title || strand.title,
              date:        o.date,
              time:        o.no_time ? '' : (o.time_start || ''),
              timeEnd:     o.no_time ? '' : (o.time_end || ''),
              noTime:      !!o.no_time,
              note:        o.note || '',
              strandId:    strand._id,
              strandTitle: strand.title,
              venue:       strand.venue || '',
              address:     strand.address || '',
              publisher:   strand.publisherHandle || '',
              color:       strand.color || '#6C8FFF',
              vibes:       ev.vibes || [],
              timezone:    tz,
            });
          }
        }
      }
    }

    events.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    res.json({ events: events.slice(0, 100) });
  } catch (e) { next(e); }
});

module.exports = router;

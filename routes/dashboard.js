const express   = require('express');
const router    = express.Router();
const auth      = require('../middleware/auth');
const Workspace = require('../models/Workspace');
const { DateTime } = require('luxon');

// GET /api/dashboard/upcoming?workspaceId=xxx
router.get('/upcoming', auth, async (req, res, next) => {
  try {
    const query = { user: req.user._id };
    if (req.query.workspaceId && req.query.workspaceId !== 'all') {
      query._id = req.query.workspaceId;
    }

    const workspaces = await Workspace.find(query).populate({
      path: 'strands',
      select: 'title venue address timezone events publisherHandle color',
      match: { published: true },
    });

    const days   = Math.min(parseInt(req.query.days) || 60, 365);
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
        const tz = strand.timezone || 'UTC';
        const from = DateTime.now().setZone(tz).startOf('day');
        const to   = from.plus({ days });

        for (const ev of strand.events || []) {
          const upcoming = getUpcomingDates(ev, from, to, tz);
          for (const { date, timeStart } of upcoming) {
            events.push({
              title:       ev.title || strand.title,
              date:        date,
              time:        timeStart || '',
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

    events.sort((a, b) => a.date > b.date ? 1 : -1);
    res.json({ events: events.slice(0, 100) });
  } catch (e) { next(e); }
});

// ── RECURRENCE ENGINE ─────────────────────────────────────────
// All date math happens in the strand's timezone via Luxon DateTime.
// `from` and `to` are DateTime objects already pinned to that zone.
// One-off and date-list events use plain ISO date strings (YYYY-MM-DD)
// which are timezone-agnostic — they refer to a calendar date in
// whatever zone the publisher set.
function getUpcomingDates(ev, from, to, tz) {
  const results = [];
  const fromIso = from.toISODate();
  const toIso   = to.toISODate();

  if (ev.event_type === 'oneoff' || ev.date) {
    if (ev.date && ev.date >= fromIso && ev.date <= toIso) {
      results.push({ date: ev.date, timeStart: ev.time_start });
    }
    return results;
  }

  if (ev.event_type === 'datelist' && ev.date_list?.length) {
    for (const entry of ev.date_list) {
      if (!entry.date) continue;
      if (entry.date >= fromIso && entry.date <= toIso) {
        results.push({ date: entry.date, timeStart: entry.time_start });
      }
    }
    return results;
  }

  // Recurring — walk through window day by day in the strand's timezone
  const rule = ev.recurrence?.[0];
  if (!rule) return results;

  let d = from;
  let safety = 0;

  while (d <= to && safety++ < 500) {
    // Luxon weekday: 1=Monday … 7=Sunday. Map to our abbreviated form.
    const DOW_ABBR = ['mon','tue','wed','thu','fri','sat','sun'];
    const dayAbbr = DOW_ABBR[d.weekday - 1];
    let match = false;

    if (rule.pattern === 'daily') match = true;
    else if (rule.pattern === 'weekly') match = (rule.days || ['fri']).includes(dayAbbr);
    else if (rule.pattern === 'monthly_week') {
      // "first/second/third/fourth Monday of the month" semantics
      const weekNum = Math.ceil(d.day / 7);
      const lastDayOfMonth = d.endOf('month').day;
      const lastWeek = Math.ceil(lastDayOfMonth / 7);
      const weekMap = { first:1, second:2, third:3, fourth:4, last: lastWeek };
      match = (rule.days || []).includes(dayAbbr) && weekMap[rule.month_week] === weekNum;
    } else if (rule.pattern === 'monthly_date') {
      match = d.day === (rule.month_date || 1);
    } else if (rule.pattern === 'annual') {
      if (rule.month_date) {
        match = d.day === rule.month_date;
      } else if (rule.days?.length) {
        match = rule.days.includes(dayAbbr);
      } else {
        match = true;
      }
    }

    // Season filter (months are inclusive: jan..dec)
    if (match && (rule.season_start || rule.season_end)) {
      const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
      const monthIdx = d.month - 1; // Luxon month is 1-based
      const si = rule.season_start ? MONTHS.indexOf(rule.season_start) : 0;
      const ei = rule.season_end   ? MONTHS.indexOf(rule.season_end)   : 11;
      match = si <= ei
        ? (monthIdx >= si && monthIdx <= ei)
        : (monthIdx >= si || monthIdx <= ei); // wraps year-end (e.g. nov..feb)
    }

    // Exception filter — exception dates compared as ISO strings in the strand's tz
    if (match && ev.exceptions?.length) {
      const dateStr = d.toISODate();
      for (const exc of ev.exceptions) {
        if (exc.type === 'skip' && exc.date === dateStr) { match = false; break; }
        if (exc.type === 'cancelled_range' && exc.date <= dateStr && dateStr <= (exc.date_end || exc.date)) { match = false; break; }
      }
    }

    if (match) {
      results.push({ date: d.toISODate(), timeStart: rule.time_start || '' });
    }

    d = d.plus({ days: 1 });
  }

  return results;
}

module.exports = router;

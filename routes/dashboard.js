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
          for (const { date, timeStart, allDay } of upcoming) {
            events.push({
              title:       ev.title || strand.title,
              date:        date,
              time:        timeStart || '',
              allDay:      !!allDay,
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
      results.push({ date: ev.date, timeStart: ev.all_day ? '' : ev.time_start, allDay: !!ev.all_day });
    }
    return results;
  }

  // Curated dates[] — the sole schedule for a "Date List" event, or extra
  // dates coexisting with recurrence[] on a "Recurring" event (spec dates[]).
  if (ev.dates?.length) {
    for (const entry of ev.dates) {
      if (!entry.date) continue;
      if (entry.date >= fromIso && entry.date <= toIso) {
        results.push({ date: entry.date, timeStart: entry.all_day ? '' : entry.time_start, allDay: !!entry.all_day });
      }
    }
  }

  // Recurring — walk through window day by day in the strand's timezone,
  // checking every recurrence rule. Rules are additive per spec — a date
  // matching ANY rule produces one occurrence for that date.
  const rules = ev.recurrence || [];
  if (!rules.length) return results;

  const DOW_ABBR = ['mon','tue','wed','thu','fri','sat','sun'];
  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

  let d = from;
  let safety = 0;

  while (d <= to && safety++ < 500) {
    const dateStr = d.toISODate();
    const dayAbbr = DOW_ABBR[d.weekday - 1];
    let dayMatch = false;
    let matchedAllDay = false;
    let matchedTimeStart = '';

    for (const rule of rules) {
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
        const monthIdx = d.month - 1; // Luxon month is 1-based
        const si = rule.season_start ? MONTHS.indexOf(rule.season_start) : 0;
        const ei = rule.season_end   ? MONTHS.indexOf(rule.season_end)   : 11;
        match = si <= ei
          ? (monthIdx >= si && monthIdx <= ei)
          : (monthIdx >= si || monthIdx <= ei); // wraps year-end (e.g. nov..feb)
      }

      // Rule-level active window
      if (match && rule.start_date && dateStr < rule.start_date) match = false;
      if (match && rule.end_date   && dateStr > rule.end_date)   match = false;

      if (match) {
        dayMatch = true;
        matchedAllDay = !!rule.all_day;
        matchedTimeStart = rule.all_day ? '' : (rule.time_start || '');
        break; // first matching rule supplies the displayed time for this date
      }
    }

    // Exception filter — event-level, applies regardless of which rule matched
    if (dayMatch && ev.exceptions?.length) {
      for (const exc of ev.exceptions) {
        if (exc.type === 'skip' && exc.date === dateStr) { dayMatch = false; break; }
        if (exc.type === 'cancelled_range' && exc.date <= dateStr && dateStr <= (exc.date_end || exc.date)) { dayMatch = false; break; }
      }
    }

    if (dayMatch && !results.find(x => x.date === dateStr)) {
      results.push({ date: dateStr, timeStart: matchedTimeStart, allDay: matchedAllDay });
    }

    d = d.plus({ days: 1 });
  }

  return results;
}

module.exports = router;

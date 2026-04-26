const express   = require('express');
const router    = express.Router();
const auth      = require('../middleware/auth');
const Workspace = require('../models/Workspace');

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

    const now    = new Date();
    const days   = Math.min(parseInt(req.query.days) || 60, 365);
    const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const events = [];
    const seenStrands = new Set();

    for (const ws of workspaces) {
      for (const strand of ws.strands || []) {
        if (!strand || seenStrands.has(strand._id.toString())) continue;
        seenStrands.add(strand._id.toString());

        for (const ev of strand.events || []) {
          const upcoming = getUpcomingDates(ev, now, cutoff);
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
            });
          }
        }
      }
    }

    // Sort by date, dedup, limit 100
    events.sort((a, b) => a.date > b.date ? 1 : -1);
    res.json({ events: events.slice(0, 100) });
  } catch (e) { next(e); }
});

// Compute upcoming dates for an event within a window
function getUpcomingDates(ev, from, to) {
  const results = [];

  if (ev.event_type === 'oneoff' || ev.date) {
    if (ev.date) {
      const d = new Date(ev.date + 'T00:00:00');
      if (d >= from && d <= to) results.push({ date: ev.date, timeStart: ev.time_start });
    }
    return results;
  }

  if (ev.event_type === 'datelist' && ev.date_list?.length) {
    for (const entry of ev.date_list) {
      if (!entry.date) continue;
      const d = new Date(entry.date + 'T00:00:00');
      if (d >= from && d <= to) results.push({ date: entry.date, timeStart: entry.time_start });
    }
    return results;
  }

  // Recurring — walk through window day by day against first rule
  const rule = ev.recurrence?.[0];
  if (!rule) return results;

  const DAYS = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
  let d = new Date(from);
  let safety = 0;

  while (d <= to && safety++ < 500) {
    const dow = d.getDay(); // 0=sun
    const dayAbbr = ['sun','mon','tue','wed','thu','fri','sat'][dow];
    let match = false;

    if (rule.pattern === 'daily') match = true;
    else if (rule.pattern === 'weekly') match = (rule.days || ['fri']).includes(dayAbbr);
    else if (rule.pattern === 'monthly_week') {
      const weekNum = Math.ceil(d.getDate() / 7);
      const weekMap = { first:1, second:2, third:3, fourth:4, last: Math.ceil(new Date(d.getFullYear(), d.getMonth()+1, 0).getDate()/7) };
      match = (rule.days || []).includes(dayAbbr) && weekMap[rule.month_week] === weekNum;
    } else if (rule.pattern === 'monthly_date') {
      match = d.getDate() === (rule.month_date || 1);
    } else if (rule.pattern === 'annual') {
      // Annual events: match by specific date (month_date) within season, or by day-of-week within season
      if (rule.month_date) {
        match = d.getDate() === rule.month_date;
      } else if (rule.days?.length) {
        match = rule.days.includes(dayAbbr);
      } else {
        match = true; // match every day in the season window (e.g. a holiday period)
      }
    }

    // Season filter
    if (match && (rule.season_start || rule.season_end)) {
      const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
      const m = MONTHS[d.getMonth()];
      const si = rule.season_start ? MONTHS.indexOf(rule.season_start) : 0;
      const ei = rule.season_end   ? MONTHS.indexOf(rule.season_end)   : 11;
      match = si <= ei ? (d.getMonth() >= si && d.getMonth() <= ei) : (d.getMonth() >= si || d.getMonth() <= ei);
    }

    // Exception filter
    if (match && ev.exceptions?.length) {
      const dateStr = d.toISOString().slice(0, 10);
      for (const exc of ev.exceptions) {
        if (exc.type === 'skip' && exc.date === dateStr) { match = false; break; }
        if (exc.type === 'cancelled_range' && exc.date <= dateStr && dateStr <= (exc.date_end || exc.date)) { match = false; break; }
      }
    }

    if (match) {
      results.push({ date: d.toISOString().slice(0, 10), timeStart: rule.time_start || '' });
    }

    d.setDate(d.getDate() + 1);
  }

  return results;
}

module.exports = router;

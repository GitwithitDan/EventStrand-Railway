// ── SCHEDULE NORMALISATION ─────────────────────────────────────
// An .rcal event may combine `date`, `dates` and `recurrence` freely; every
// occurrence from all three is merged. Internally a strand event keeps a
// lone `date` only when it is the sole schedule (event_type "oneoff"). When a
// `date` is combined with other schedule fields it is folded into `dates` so
// nothing is lost and every consumer sees a single, uniform shape.
//
// `no_time` marks an occurrence with no specific time (all-day, untimed, or
// time not applicable). The older name `all_day` is still read, so strands
// stored before the rename keep working; it is never written.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_DAY = /^(\d{2})-(\d{2})$/;
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function hasNoTime(o) {
  return !!(o && (o.no_time || o.all_day));
}

const DAY3 = ['sun','mon','tue','wed','thu','fri','sat'];
const DAY_FULL = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

// Day names are accepted as mon / monday / weekday / weekend in any case and
// stored as three-letter names, in week order, without repeats.
function normaliseDays(days) {
  const out = new Set();
  (Array.isArray(days) ? days : []).forEach(d => {
    if (typeof d !== 'string') return;
    const v = d.trim().toLowerCase();
    if (v === 'weekday' || v === 'weekdays') { ['mon','tue','wed','thu','fri'].forEach(x => out.add(x)); return; }
    if (v === 'weekend' || v === 'weekends') { out.add('sat'); out.add('sun'); return; }
    const i = DAY_FULL.indexOf(v) >= 0 ? DAY_FULL.indexOf(v) : DAY3.indexOf(v);
    if (i >= 0) out.add(DAY3[i]);
  });
  return DAY3.filter(d => out.has(d));
}

// Months are stored as three-letter names ("june" and "Jun" both become "jun").
function normaliseMonth(m) {
  if (typeof m !== 'string') return undefined;
  const v = m.trim().toLowerCase().slice(0, 3);
  return MONTHS.includes(v) ? v : undefined;
}

function normaliseRule(r) {
  const out = { ...r };
  const nt = hasNoTime(r);
  delete out.all_day;
  if (nt) out.no_time = true; else delete out.no_time;
  if (out.days !== undefined) out.days = normaliseDays(out.days);
  ['season_start', 'season_end'].forEach(k => {
    if (out[k] === undefined) return;
    const m = normaliseMonth(out[k]);
    if (m) out[k] = m; else delete out[k];
  });
  if (typeof out.month_week === 'string') out.month_week = out.month_week.trim().toLowerCase();
  ['time_start', 'time_end', 'start_date', 'end_date'].forEach(k => { if (out[k] === '') delete out[k]; });
  return out;
}

// Returns { date, time_start, time_end, no_time, dates, recurrence }.
function normaliseSchedule(e) {
  const evNoTime = hasNoTime(e);
  const recurrence = (e.recurrence || []).map(normaliseRule);

  // dates[] entries may be plain ISO strings or objects. A plain string, or an
  // object with no time information at all, inherits the event-level time.
  const dates = [];
  const seen = new Set();
  const addDate = entry => {
    const key = entry.date + '|' + (entry.no_time ? 'n' : (entry.time_start || '') + '-' + (entry.time_end || ''));
    if (seen.has(key)) return;
    seen.add(key);
    dates.push(entry);
  };
  (e.dates || []).forEach(d => {
    const src = typeof d === 'string' ? { date: d } : d;
    if (!src || typeof src.date !== 'string' || !src.date) return;
    const out = { ...src };
    const nt = hasNoTime(src);
    delete out.all_day;
    if (nt) {
      out.no_time = true;
    } else {
      delete out.no_time;
      if (!out.time_start && !out.time_end) {
        if (evNoTime) out.no_time = true;
        else {
          if (e.time_start) out.time_start = e.time_start;
          if (e.time_end)   out.time_end   = e.time_end;
        }
      }
    }
    addDate(out);
  });

  let date = e.date || undefined;
  let time_start = e.time_start;
  let time_end = e.time_end;
  let no_time = evNoTime;

  if (date && (recurrence.length || dates.length)) {
    if (ISO_DATE.test(date)) {
      // Fold the single date into the curated list.
      const entry = { date };
      if (evNoTime) entry.no_time = true;
      else {
        if (time_start) entry.time_start = time_start;
        if (time_end)   entry.time_end   = time_end;
      }
      addDate(entry);
    } else {
      // MM-DD anchors the day of the year for annual rules.
      const m = MONTH_DAY.exec(date);
      if (m && MONTHS[+m[1] - 1]) {
        recurrence.forEach(r => {
          if (r.pattern === 'annual' && !r.season_start) {
            r.season_start = MONTHS[+m[1] - 1];
            r.season_end = r.season_start;
            if (!r.month_date) r.month_date = +m[2];
          }
        });
      }
    }
    date = undefined;
    time_start = undefined;
    time_end = undefined;
    no_time = false;
  }

  return { date, time_start, time_end, no_time, dates, recurrence };
}

module.exports = { hasNoTime, normaliseSchedule, normaliseDays };

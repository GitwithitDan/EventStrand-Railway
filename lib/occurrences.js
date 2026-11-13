// ── OCCURRENCE ENGINE ──────────────────────────────────────────
// One implementation of the .rcal schedule rules for every server consumer
// (dashboard feed, public strand API, server-rendered strand pages). It
// mirrors the reference reader at rcal.dtdm.us: `date`, `dates` and
// `recurrence` merge, `every` is anchored so it never drifts, seasons may wrap
// the year end, and exceptions are applied last to every kind of occurrence.
//
// All arithmetic is done on calendar dates in UTC, so the result does not
// depend on the server's own time zone. Callers pass the window as ISO dates
// already resolved in the strand's time zone.

const { hasNoTime } = require('./schedule');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MON3 = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
const FULL = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const S3   = ['sun','mon','tue','wed','thu','fri','sat'];
const DAY_LABEL = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTH_LABEL = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
const iso = d => d.toISOString().slice(0, 10);
const dayNum = d => Math.floor(d.getTime() / 86400000);
const mod = (a, n) => ((a % n) + n) % n;
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

function isValidIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = utc(y, m - 1, d);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function isoToDate(s) { const [y, m, d] = s.split('-').map(Number); return utc(y, m - 1, d); }
function isValidTime(t) { return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t); }

// Day names: full names, mon–sun, "weekday" (Mon–Fri), "weekend" (Sat/Sun).
function parseDayList(raw) {
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach(d => {
    if (typeof d !== 'string') return;
    const dl = d.trim().toLowerCase();
    if (dl === 'weekday' || dl === 'weekdays') { out.push(1, 2, 3, 4, 5); return; }
    if (dl === 'weekend' || dl === 'weekends') { out.push(0, 6); return; }
    let i = FULL.indexOf(dl); if (i < 0) i = S3.indexOf(dl);
    if (i >= 0) out.push(i);
  });
  return [...new Set(out)].sort((a, b) => a - b);
}

function expandRule(rule, start, end, ev) {
  const results = [];
  if (!rule || typeof rule !== 'object') return results;
  const every = Math.max(1, parseInt(rule.every, 10) || 1);
  if ((rule.time_start != null && rule.time_start !== '' && !isValidTime(rule.time_start)) ||
      (rule.time_end != null && rule.time_end !== '' && !isValidTime(rule.time_end))) return results;
  const timing = hasNoTime(rule) ? { no_time: true }
    : { time_start: rule.time_start || undefined, time_end: rule.time_end || undefined };

  const hasStart = !!rule.season_start && MON3[String(rule.season_start).toLowerCase()] !== undefined;
  const hasEnd   = !!rule.season_end   && MON3[String(rule.season_end).toLowerCase()]   !== undefined;
  const sm = hasStart ? MON3[String(rule.season_start).toLowerCase()] : 0;
  const sd = hasStart ? (rule.season_start_day || 1) : 1;
  const em = hasEnd ? MON3[String(rule.season_end).toLowerCase()] : 11;
  const ed = hasEnd ? (rule.season_end_day || 31) : 31;
  const sKey = sm * 100 + sd, eKey = em * 100 + ed;
  const inSeason = d => {
    if (!hasStart && !hasEnd) return true;
    const k = d.getUTCMonth() * 100 + d.getUTCDate();
    return sKey <= eKey ? (k >= sKey && k <= eKey) : (k >= sKey || k <= eKey);
  };
  const addOcc = d => {
    if (!inSeason(d)) return;
    const s = iso(d);
    if (isValidIsoDate(rule.start_date) && s < rule.start_date) return;
    if (isValidIsoDate(rule.end_date) && s > rule.end_date) return;
    results.push({ date: s, ...timing });
  };

  // `every` is anchored to start_date when present, otherwise to a fixed
  // epoch Sunday, so "every other week" never shifts with the viewing day.
  const anchor = isValidIsoDate(rule.start_date) ? isoToDate(rule.start_date) : utc(1970, 0, 4);
  const anchorSunday = addDays(anchor, -anchor.getUTCDay());
  const monthIndex = d => d.getUTCFullYear() * 12 + d.getUTCMonth();

  const p = rule.pattern;
  if (p === 'daily') {
    const a = dayNum(anchor);
    for (let cur = start; cur <= end; cur = addDays(cur, 1)) {
      if (mod(dayNum(cur) - a, every) === 0) addOcc(cur);
    }
  } else if (p === 'weekly' || p === 'weekdays') {
    const targetDays = p === 'weekdays' ? [1, 2, 3, 4, 5] : parseDayList(rule.days);
    const aSun = dayNum(anchorSunday);
    for (let cur = addDays(start, -start.getUTCDay()); cur <= end; cur = addDays(cur, 7)) {
      if (mod(Math.round((dayNum(cur) - aSun) / 7), every) !== 0) continue;
      targetDays.forEach(dow => { const d = addDays(cur, dow); if (d >= start && d <= end) addOcc(d); });
    }
  } else if (p === 'monthly_date') {
    const dom = parseInt(rule.month_date, 10);
    if (!(dom >= 1 && dom <= 31)) return results;
    for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); utc(y, m, 1) <= end; m++) {
      const first = utc(y, m, 1);
      if (mod(monthIndex(first) - monthIndex(anchor), every) !== 0) continue;
      const d = utc(y, m, dom);
      // A day missing from this month (e.g. the 31st in April) is skipped.
      if (d.getUTCMonth() === first.getUTCMonth() && d >= start && d <= end) addOcc(d);
    }
  } else if (p === 'monthly_week') {
    const wm = { first: 0, second: 1, third: 2, fourth: 3, last: -1 };
    const key = String(rule.month_week || 'first').toLowerCase();
    const which = wm[key] !== undefined ? wm[key] : 0;
    const targetDays = parseDayList(rule.days);
    for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); utc(y, m, 1) <= end; m++) {
      const first = utc(y, m, 1);
      if (mod(monthIndex(first) - monthIndex(anchor), every) !== 0) continue;
      targetDays.forEach(dow => {
        let d;
        if (which === -1) {
          const last = utc(y, m + 1, 0);
          d = addDays(last, -mod(last.getUTCDay() - dow, 7));
        } else {
          d = addDays(first, mod(dow - first.getUTCDay(), 7) + which * 7);
          if (d.getUTCMonth() !== first.getUTCMonth()) return;
        }
        if (d >= start && d <= end) addOcc(d);
      });
    }
  } else if (p === 'annual') {
    // Day of the year: season_start (+ month_date or season_start_day), or an
    // MM-DD / ISO date on the event. A rule with neither falls on 1 January.
    let am, ad;
    if (hasStart) { am = sm; ad = parseInt(rule.month_date, 10) || sd; }
    else {
      const m = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(String((ev && ev.date) || ''));
      if (m) { am = +m[1] - 1; ad = +m[2]; } else { am = 0; ad = parseInt(rule.month_date, 10) || 1; }
    }
    for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) {
      const d = utc(y, am, ad);
      if (d.getUTCMonth() === am && d >= start && d <= end) addOcc(d);
    }
  }
  return results;
}

// Every occurrence of one event between fromIso and toIso (inclusive), sorted.
// Skipped and cancelled occurrences are dropped; a "modified" exception
// changes the time and carries its note.
function getOccurrences(ev, fromIso, toIso) {
  if (!ev || !isValidIsoDate(fromIso) || !isValidIsoDate(toIso) || fromIso > toIso) return [];
  const start = isoToDate(fromIso), end = isoToDate(toIso);
  const evTiming = hasNoTime(ev) ? { no_time: true }
    : { time_start: ev.time_start || undefined, time_end: ev.time_end || undefined };
  const results = [];

  if (ev.date && isValidIsoDate(ev.date)) results.push({ date: ev.date, ...evTiming });
  (Array.isArray(ev.dates) ? ev.dates : []).forEach(d => {
    if (typeof d === 'string') { if (isValidIsoDate(d)) results.push({ date: d, ...evTiming }); return; }
    if (!d || typeof d !== 'object' || !isValidIsoDate(d.date)) return;
    const o = { date: d.date };
    if (hasNoTime(d)) o.no_time = true;
    else if (hasNoTime(ev) && !isValidTime(d.time_start) && !isValidTime(d.time_end)) o.no_time = true;
    else {
      o.time_start = isValidTime(d.time_start) ? d.time_start : (ev.time_start || undefined);
      o.time_end   = isValidTime(d.time_end)   ? d.time_end   : (ev.time_end || undefined);
    }
    if (d.note) o.note = d.note;
    results.push(o);
  });
  (Array.isArray(ev.recurrence) ? ev.recurrence : []).forEach(rule => {
    expandRule(rule, start, end, ev).forEach(o => results.push(o));
  });

  const seen = new Set();
  const unique = results.filter(o => {
    if (o.date < fromIso || o.date > toIso) return false;
    const k = o.date + '|' + (o.no_time ? 'n' : (o.time_start || '') + '-' + (o.time_end || ''));
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  const exMap = {};
  (Array.isArray(ev.exceptions) ? ev.exceptions : []).forEach(ex => {
    if (!ex || !isValidIsoDate(ex.date)) return;
    if (ex.type === 'skip' || ex.type === 'modified') exMap[ex.date] = ex;
    else if (ex.type === 'cancelled_range') {
      const endStr = isValidIsoDate(ex.date_end) ? ex.date_end : ex.date;
      let guard = 0;
      for (let cur = isoToDate(ex.date); iso(cur) <= endStr && guard++ < 3660; cur = addDays(cur, 1)) exMap[iso(cur)] = ex;
    }
  });

  const out = [];
  unique.forEach(o => {
    const ex = exMap[o.date];
    if (!ex) { out.push(o); return; }
    if (ex.type === 'skip' || ex.type === 'cancelled_range') return;
    const m = { ...o, modified: true, note: ex.note || o.note };
    if (isValidTime(ex.time_start) || isValidTime(ex.time_end)) {
      delete m.no_time;
      if (isValidTime(ex.time_start)) m.time_start = ex.time_start;
      if (isValidTime(ex.time_end))   m.time_end   = ex.time_end;
    }
    out.push(m);
  });
  out.sort((a, b) => a.date.localeCompare(b.date) || String(a.time_start || '').localeCompare(String(b.time_start || '')));
  return out;
}

// ── Plain-language schedule text ("Every other Fri · 21:00") ───
function dayText(days) {
  const idx = parseDayList(days);
  if (idx.join() === '1,2,3,4,5') return 'weekdays';
  if (idx.join() === '0,6') return 'weekends';
  return idx.map(i => DAY_LABEL[i]).join(', ');
}
function timeText(o) {
  if (hasNoTime(o) || !o.time_start) return '';
  return o.time_start + (o.time_end ? '–' + o.time_end : '');
}
function seasonText(r) {
  const s = MON3[String(r.season_start || '').toLowerCase()], e = MON3[String(r.season_end || '').toLowerCase()];
  if (s === undefined && e === undefined) return '';
  const part = (m, day) => MONTH_LABEL[m] + (day ? ' ' + day : '');
  if (s !== undefined && e !== undefined) {
    if (s === e && !r.season_start_day && !r.season_end_day) return MONTH_LABEL[s];
    return part(s, r.season_start_day) + '–' + part(e, r.season_end_day);
  }
  return s !== undefined ? 'from ' + part(s, r.season_start_day) : 'until ' + part(e, r.season_end_day);
}
function describeRule(r) {
  if (!r || typeof r !== 'object') return '';
  const every = Math.max(1, parseInt(r.every, 10) || 1);
  const nth = n => n === 2 ? 'other' : n + (n === 3 ? 'rd' : 'th');
  const days = dayText(r.days);
  let base = '';
  switch (r.pattern) {
    case 'daily':        base = every > 1 ? `Every ${nth(every)} day` : 'Daily'; break;
    case 'weekdays':     base = every > 1 ? `Every ${nth(every)} week on weekdays` : 'Every weekday'; break;
    case 'weekly': {
      const one = days === 'weekdays' ? 'weekday' : days === 'weekends' ? 'weekend' : days;
      base = every > 1 ? `Every ${nth(every)} week${days ? ' on ' + days : ''}` : (one ? `Every ${one}` : 'Weekly'); break;
    }
    case 'monthly_week': {
      const w = String(r.month_week || 'first').toLowerCase();
      base = `${w.charAt(0).toUpperCase() + w.slice(1)} ${days || 'week'} of ${every > 1 ? `every ${nth(every)} month` : 'the month'}`; break;
    }
    case 'monthly_date': base = `Day ${r.month_date || 1} of ${every > 1 ? `every ${nth(every)} month` : 'each month'}`; break;
    case 'annual': {
      const s = MON3[String(r.season_start || '').toLowerCase()];
      const spans = s !== undefined && r.season_end && String(r.season_end).toLowerCase() !== String(r.season_start).toLowerCase();
      if (spans) return ['Yearly', seasonText(r), timeText(r)].filter(Boolean).join(' · ');
      const day = parseInt(r.month_date, 10) || r.season_start_day;
      return [s !== undefined ? `Yearly on ${MONTH_LABEL[s]}${day ? ' ' + day : ''}` : 'Yearly', timeText(r)].filter(Boolean).join(' · ');
    }
    default: return '';
  }
  return [base, seasonText(r), timeText(r)].filter(Boolean).join(' · ');
}
function describeSchedule(ev) {
  if (!ev) return '';
  const parts = [];
  if (ev.date) parts.push([ev.date, timeText(ev)].filter(Boolean).join(' · '));
  (ev.recurrence || []).forEach(r => { const t = describeRule(r); if (t) parts.push(t); });
  const n = (ev.dates || []).length;
  if (n) parts.push(parts.length ? `+${n} listed date${n === 1 ? '' : 's'}` : `${n} listed date${n === 1 ? '' : 's'}`);
  return parts.join(' + ');
}

module.exports = { getOccurrences, describeSchedule, describeRule, parseDayList, isValidIsoDate };

// ── ROLLING 30-DAY VIEW COUNTS ─────────────────────────────────
// viewsHistory holds 30 slots indexed by (day number mod 30) and
// viewsHistoryDay is the last day a view was recorded. Slots for days that
// passed with no views are cleared when the next view arrives, so a slot never
// keeps a count from 30 or more days ago.
const dayNumber = () => Math.floor(Date.now() / 86400000);

// The update that records one view on a strand loaded with
// viewsHistory + viewsHistoryDay.
function viewUpdate(strand) {
  const day = dayNumber();
  const slot = day % 30;
  const last = strand.viewsHistoryDay;
  const $set = { lastViewedAt: new Date(), viewsHistoryDay: day };
  const $inc = { viewCount: 1 };
  if (last === day) {
    $inc[`viewsHistory.${slot}`] = 1;
  } else if (typeof last !== 'number' || day - last >= 30 || day < last) {
    const fresh = new Array(30).fill(0);
    fresh[slot] = 1;
    $set.viewsHistory = fresh;
  } else {
    for (let d = last + 1; d < day; d++) $set[`viewsHistory.${d % 30}`] = 0;
    $set[`viewsHistory.${slot}`] = 1;
  }
  return { $set, $inc };
}

// The last 30 days, oldest first, ending today.
function last30(strand) {
  const hist = Array.isArray(strand.viewsHistory) ? strand.viewsHistory : [];
  const last = strand.viewsHistoryDay;
  if (typeof last !== 'number') return new Array(30).fill(0);
  const today = dayNumber();
  const out = [];
  for (let d = today - 29; d <= today; d++) {
    out.push(d > last || d <= last - 30 ? 0 : (hist[((d % 30) + 30) % 30] || 0));
  }
  return out;
}

module.exports = { viewUpdate, last30 };

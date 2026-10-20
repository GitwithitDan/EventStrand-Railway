// ── OPS ALERTS ───────────────────────────────────────────────
// Emails ALERT_EMAIL (via the existing Resend wrapper) when the database
// goes down or comes back. Throttled so a burst of failing requests sends
// one email, not hundreds. If ALERT_EMAIL is unset, alerts only log.

const { sendEmail } = require('./email');

const THROTTLE_MS = 15 * 60 * 1000;
const lastSent = new Map();

async function alertOps(key, subject, detail) {
  console.error(`[ALERT] ${subject} — ${detail}`);
  const to = process.env.ALERT_EMAIL;
  if (!to) return;
  const now = Date.now();
  if (now - (lastSent.get(key) || 0) < THROTTLE_MS) return;
  lastSent.set(key, now);
  const safe = String(detail).replace(/[<>&]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' })[c]);
  await sendEmail({
    to,
    subject: `[EventStrand] ${subject}`,
    html: `<p><strong>${subject}</strong></p><p>${safe}</p><p style="color:#888">${new Date().toISOString()}</p>`,
  }).catch(() => {});
}

module.exports = { alertOps };

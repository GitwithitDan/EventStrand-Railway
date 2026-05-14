// ── EMAIL DELIVERY (RESEND) ──────────────────────────────────
// Wraps the Resend HTTP API. Falls back gracefully if RESEND_API_KEY
// is not set: logs the message and returns success, so local dev
// works without provisioning an email service. Production deploys
// with the env var set will actually deliver.

const FROM_DEFAULT = 'EventStrand <noreply@eventstrand.com>';

async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.EMAIL_FROM || FROM_DEFAULT;

  if (!apiKey) {
    console.log(`[email:dev] To: ${to}\n  Subject: ${subject}\n  ${text || html.replace(/<[^>]+>/g, '')}`);
    return { ok: true, dev: true };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[email:resend] ${res.status} ${body}`);
      return { ok: false, status: res.status };
    }
    const data = await res.json();
    return { ok: true, id: data.id };
  } catch (e) {
    console.error('[email:resend] error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── EMAIL TEMPLATES ───────────────────────────────────────────
const FRONTEND = process.env.FRONTEND_URL || 'https://eventstrand.com';

// Shared minimal styling — keeps emails readable in every client
function shell(title, bodyHtml) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f4f5fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#222;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
    <div style="text-align:center;margin-bottom:32px;">
      <span style="font-family:'Georgia',serif;font-size:22px;font-weight:600;color:#222;letter-spacing:-0.3px;">EventStrand</span>
    </div>
    <div style="background:#fff;border-radius:14px;padding:32px 28px;box-shadow:0 2px 12px rgba(0,0,0,0.04);">
      ${bodyHtml}
    </div>
    <div style="text-align:center;margin-top:24px;color:#888;font-size:12px;">
      You're receiving this because someone signed up at eventstrand.com with your email.
      If that wasn't you, you can ignore this message.
    </div>
  </div>
</body></html>`;
}

function verifyEmailTemplate(displayName, token) {
  const link = `${FRONTEND}/#/verify?token=${encodeURIComponent(token)}`;
  const greeting = displayName ? `Hey ${displayName.split(' ')[0]},` : 'Welcome!';
  return {
    subject: 'Verify your EventStrand email',
    html: shell('Verify your email', `
      <h1 style="font-family:'Georgia',serif;font-size:22px;font-weight:600;margin:0 0 16px;">${greeting}</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 24px;">Tap the button below to confirm your email address. The link is good for 24 hours.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${link}" style="display:inline-block;background:#6C8FFF;color:#fff;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:600;font-size:14px;">Verify email</a>
      </div>
      <p style="font-size:13px;color:#666;margin:0 0 8px;">Or paste this into your browser:</p>
      <p style="font-size:12px;color:#888;word-break:break-all;margin:0;">${link}</p>
    `),
    text: `${greeting}\n\nVerify your email by opening: ${link}\n\nThe link expires in 24 hours.`,
  };
}

function resetPasswordTemplate(displayName, token) {
  const link = `${FRONTEND}/#/reset-password?token=${encodeURIComponent(token)}`;
  const greeting = displayName ? `Hey ${displayName.split(' ')[0]},` : 'Hi,';
  return {
    subject: 'Reset your EventStrand password',
    html: shell('Reset password', `
      <h1 style="font-family:'Georgia',serif;font-size:22px;font-weight:600;margin:0 0 16px;">${greeting}</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 24px;">Someone (hopefully you) asked to reset your password. The link below is good for 1 hour.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${link}" style="display:inline-block;background:#6C8FFF;color:#fff;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:600;font-size:14px;">Reset password</a>
      </div>
      <p style="font-size:13px;color:#666;margin:0 0 8px;">Or paste this into your browser:</p>
      <p style="font-size:12px;color:#888;word-break:break-all;margin:0 0 16px;">${link}</p>
      <p style="font-size:13px;color:#666;margin:0;">If you didn't request this, no action needed — your password stays the same.</p>
    `),
    text: `${greeting}\n\nReset your password: ${link}\n\nThe link expires in 1 hour. If you didn't request this, ignore this email.`,
  };
}

module.exports = { sendEmail, verifyEmailTemplate, resetPasswordTemplate };

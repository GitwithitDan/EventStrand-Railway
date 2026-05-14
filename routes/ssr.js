// ── SERVER-SIDE RENDERED PUBLIC PAGES ─────────────────────────
// Renders /s/:handle/:strandId, /b/:handle/:braidId, /p/:handle as
// fully indexable HTML. Crawlers see prerendered content with rich
// meta tags + JSON-LD; real users get the same HTML, then app.js
// loads and the SPA's hash router hydrates the same view on top.
//
// Wired up via Cloudflare Page Rule that proxies eventstrand.com/s/*
// (and /b/*, /p/*) to api.eventstrand.com/ssr/* under the hood,
// preserving the user-facing URL.

const express = require('express');
const router  = express.Router();
const Strand  = require('../models/Strand');
const Braid   = require('../models/Braid');
const User    = require('../models/User');

const FRONTEND = process.env.FRONTEND_URL || 'https://eventstrand.com';

// HTML escape — for everything we drop into the page
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

// Trim a description to the right length for meta + open graph
function metaDescription(text, max = 160) {
  if (!text) return 'Never miss what\'s on at the places you love. A living event schedule on EventStrand.';
  const stripped = String(text).replace(/\s+/g, ' ').trim();
  if (stripped.length <= max) return stripped;
  return stripped.slice(0, max - 1).replace(/[,;:.\s]+\S*$/, '') + '…';
}

// Format a recurrence rule into human-readable text
function describeRule(rule) {
  if (!rule || !rule.pattern) return '';
  const days = (rule.days || []).map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ');
  if (rule.pattern === 'daily')         return 'Daily';
  if (rule.pattern === 'weekly')        return days ? `Weekly on ${days}` : 'Weekly';
  if (rule.pattern === 'monthly_week')  return `${(rule.month_week||'first').replace(/^./, c => c.toUpperCase())} ${days || 'day'} of the month`;
  if (rule.pattern === 'monthly_date')  return `Monthly on the ${rule.month_date || 1}${nth(rule.month_date || 1)}`;
  if (rule.pattern === 'annual')        return rule.month_date ? `Annually on the ${rule.month_date}${nth(rule.month_date)}` : 'Annually';
  return '';
}
function nth(n) { return ['th','st','nd','rd'][n%100>10 && n%100<14 ? 0 : Math.min(n%10, 4) === 4 ? 0 : n%10]; }

// Page shell — used by every SSR response
function shell({ canonical, title, description, ogImage, jsonLd, bodyHtml }) {
  const safeTitle = esc(title);
  const safeDesc  = esc(description);
  const safeUrl   = esc(canonical);
  const safeImage = esc(ogImage || `${FRONTEND}/icon-512.png`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDesc}">
  <link rel="canonical" href="${safeUrl}">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png">
  <link rel="manifest" href="/manifest.json">

  <meta property="og:type"        content="website">
  <meta property="og:url"         content="${safeUrl}">
  <meta property="og:title"       content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  <meta property="og:image"       content="${safeImage}">
  <meta property="og:site_name"   content="EventStrand">

  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <meta name="twitter:image"       content="${safeImage}">

  ${jsonLd ? `<script type="application/ld+json">${jsonLd.replace(/</g,'\\u003c')}</script>` : ''}

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,300;1,9..144,400&family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

  <style>
    body { margin: 0; font-family: 'Outfit', sans-serif; background: #04061a; color: #ECF0FF; }
    .ssr-content { max-width: 760px; margin: 0 auto; padding: 56px 24px; }
    .ssr-content a { color: #6C8FFF; }
    .ssr-content h1 { font-family: 'Fraunces', serif; font-weight: 600; font-size: 36px; line-height: 1.15; margin: 0 0 12px; }
    .ssr-content h2 { font-family: 'Fraunces', serif; font-weight: 600; font-size: 22px; margin: 32px 0 12px; }
    .ssr-content .meta { color: #8290C0; font-size: 15px; margin-bottom: 24px; }
    .ssr-content .desc { color: #C5CCEA; font-size: 16px; line-height: 1.65; margin-bottom: 28px; }
    .ssr-content .event { padding: 16px 0; border-top: 1px solid rgba(100,120,255,0.18); }
    .ssr-content .event-title { font-weight: 600; font-size: 16px; margin-bottom: 4px; }
    .ssr-content .event-meta { color: #8290C0; font-size: 13px; }
    .ssr-content .strand-link { display: inline-block; padding: 6px 12px; background: rgba(108,143,255,0.14); border-radius: 8px; color: #6C8FFF; text-decoration: none; font-size: 14px; margin: 4px 6px 4px 0; }
    .ssr-content .footer { margin-top: 48px; color: #8290C0; font-size: 13px; }
    .ssr-content .footer a { font-weight: 600; }
  </style>
</head>
<body>
  <main class="ssr-content" id="ssr-content">
    ${bodyHtml}
  </main>

  <!-- ── SPA HYDRATION ─────────────────────────────────────────
       app.js's hash router falls back to window.location.pathname
       when there's no hash. It reads /s/, /b/, /p/ paths directly
       and renders the same view on top — replacing this static
       prerender with the live interactive view. -->
  <script src="/app.js" defer></script>
</body>
</html>`;
}

// ── /ssr/strand/:handle/:strandId ─────────────────────────────
router.get('/strand/:handle/:strandId', async (req, res, next) => {
  try {
    const { handle, strandId } = req.params;
    const user = await User.findOne({
      $or: [{ handle }, { previousHandles: handle }]
    });
    if (!user) return res.status(404).send(notFoundPage('Publisher not found'));

    if (user.handle !== handle) {
      return res.redirect(301, `${FRONTEND}/s/${user.handle}/${strandId}`);
    }

    const strand = await Strand.findOne({
      _id: strandId, publisher: user._id, published: true,
    }).select('-accessCode').lean();

    if (!strand) return res.status(404).send(notFoundPage('Strand not found'));

    // Protected strands shouldn't reveal content server-side without the passcode
    if (strand.visibility === 'protected') {
      return res.send(passcodeGatePage({
        canonical: `${FRONTEND}/s/${handle}/${strandId}`,
        title: `${strand.title} — passcode required`,
      }));
    }

    const canonical = `${FRONTEND}/s/${handle}/${strandId}`;
    const title     = `${strand.title} · @${handle} · EventStrand`;
    const desc      = metaDescription(strand.description || `${strand.title} — a living event schedule${strand.venue ? ' at ' + strand.venue : ''}.`);
    const ogImage   = `${FRONTEND}/icon-512.png`;

    const events = (strand.events || []).slice(0, 30);
    const eventsHtml = events.length ? events.map(ev => {
      const recur = describeRule(ev.recurrence?.[0]);
      const when  = ev.date ? esc(ev.date) : recur;
      return `
        <div class="event">
          <div class="event-title">${esc(ev.title || strand.title)}</div>
          <div class="event-meta">${esc(when || '')}${ev.time_start ? ` · ${esc(ev.time_start)}` : ''}${ev.price && ev.price !== 'free' ? ` · ${esc(ev.price)}` : ''}</div>
          ${ev.notes ? `<div style="margin-top:6px;color:#C5CCEA;font-size:14px;">${esc(ev.notes)}</div>` : ''}
        </div>`;
    }).join('') : '<p style="color:#8290C0;">No events scheduled yet.</p>';

    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type':    'EventSeries',
      name:        strand.title,
      description: strand.description || undefined,
      url:         canonical,
      location:    strand.venue ? { '@type':'Place', name: strand.venue, address: strand.address || undefined } : undefined,
      organizer:   { '@type':'Organization', name: handle, url: `${FRONTEND}/p/${handle}` },
    });

    const bodyHtml = `
      <h1>${esc(strand.title)}</h1>
      <div class="meta">
        ${strand.venue ? esc(strand.venue) + ' · ' : ''}
        Published by <a href="/p/${esc(handle)}">@${esc(handle)}</a>
        ${strand.subscriberCount ? ` · ${strand.subscriberCount} subscriber${strand.subscriberCount === 1 ? '' : 's'}` : ''}
      </div>
      ${strand.description ? `<p class="desc">${esc(strand.description)}</p>` : ''}
      <h2>Upcoming events</h2>
      ${eventsHtml}
      <div class="footer">
        Get this strand in your inbox — <a href="${FRONTEND}/#/s/${esc(handle)}/${esc(strandId)}">subscribe on EventStrand</a>.
      </div>`;

    res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
    res.send(shell({ canonical, title, description: desc, ogImage, jsonLd, bodyHtml }));
  } catch (e) { next(e); }
});

// ── /ssr/braid/:handle/:braidId ───────────────────────────────
router.get('/braid/:handle/:braidId', async (req, res, next) => {
  try {
    const { handle, braidId } = req.params;
    const user = await User.findOne({
      $or: [{ handle }, { previousHandles: handle }]
    });
    if (!user) return res.status(404).send(notFoundPage('Publisher not found'));

    if (user.handle !== handle) {
      return res.redirect(301, `${FRONTEND}/b/${user.handle}/${braidId}`);
    }

    const braid = await Braid.findOne({
      _id: braidId, publisher: user._id, published: true,
    }).populate('strands', 'title venue subscriberCount color').lean();

    if (!braid) return res.status(404).send(notFoundPage('Braid not found'));

    if (braid.visibility === 'protected') {
      return res.send(passcodeGatePage({
        canonical: `${FRONTEND}/b/${handle}/${braidId}`,
        title: `${braid.title} — passcode required`,
      }));
    }

    const canonical = `${FRONTEND}/b/${handle}/${braidId}`;
    const title     = `${braid.title} · @${handle} · EventStrand`;
    const desc      = metaDescription(braid.description || `${braid.title} — a curated bundle of strands by @${handle}.`);

    const strands = braid.strands || [];
    const strandsHtml = strands.length ? strands.map(s => `
      <div class="event">
        <div class="event-title">${esc(s.title)}</div>
        <div class="event-meta">${s.venue ? esc(s.venue) : ''}${s.subscriberCount ? ` · ${s.subscriberCount} subscriber${s.subscriberCount === 1 ? '' : 's'}` : ''}</div>
      </div>`).join('') : '<p style="color:#8290C0;">No strands in this braid yet.</p>';

    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type':    'CollectionPage',
      name:        braid.title,
      description: braid.description || undefined,
      url:         canonical,
      author:      { '@type':'Organization', name: handle, url: `${FRONTEND}/p/${handle}` },
    });

    const bodyHtml = `
      <h1>${esc(braid.title)}</h1>
      <div class="meta">
        Curated by <a href="/p/${esc(handle)}">@${esc(handle)}</a>
        · ${strands.length} strand${strands.length === 1 ? '' : 's'}
      </div>
      ${braid.description ? `<p class="desc">${esc(braid.description)}</p>` : ''}
      <h2>Strands in this braid</h2>
      ${strandsHtml}
      <div class="footer">
        Subscribe once and stay current as new strands are added — <a href="${FRONTEND}/#/b/${esc(handle)}/${esc(braidId)}">open on EventStrand</a>.
      </div>`;

    res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
    res.send(shell({ canonical, title, description: desc, jsonLd, bodyHtml }));
  } catch (e) { next(e); }
});

// ── /ssr/profile/:handle ──────────────────────────────────────
router.get('/profile/:handle', async (req, res, next) => {
  try {
    const { handle } = req.params;
    const user = await User.findOne({
      $or: [{ handle }, { previousHandles: handle }]
    });
    if (!user) return res.status(404).send(notFoundPage('Profile not found'));

    if (user.handle !== handle) {
      return res.redirect(301, `${FRONTEND}/p/${user.handle}`);
    }

    const strands = await Strand.find({
      publisher: user._id, published: true, visibility: 'public',
    }).select('title venue color subscriberCount').sort({ subscriberCount: -1 }).lean();

    const braids = await Braid.find({
      publisher: user._id, published: true, visibility: 'public',
    }).select('title description subscriberCount').sort({ subscriberCount: -1 }).lean();

    const canonical = `${FRONTEND}/p/${handle}`;
    const title     = `@${handle} · EventStrand`;
    const desc      = metaDescription(`${user.displayName || handle} — strands and braids on EventStrand. ${strands.length} strand${strands.length === 1 ? '' : 's'}.`);

    const strandsHtml = strands.length ? strands.map(s => `
      <a class="strand-link" href="/s/${esc(handle)}/${esc(s._id)}">${esc(s.title)}</a>`).join('') : '<p style="color:#8290C0;">No public strands yet.</p>';

    const braidsHtml = braids.length ? braids.map(b => `
      <a class="strand-link" href="/b/${esc(handle)}/${esc(b._id)}">${esc(b.title)}</a>`).join('') : '';

    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type':    'ProfilePage',
      name:        user.displayName || handle,
      url:         canonical,
      mainEntity:  { '@type':'Organization', name: user.displayName || handle, alternateName: handle, url: canonical },
    });

    const bodyHtml = `
      <h1>${esc(user.displayName || `@${handle}`)}</h1>
      <div class="meta">@${esc(handle)} · ${strands.length} strand${strands.length === 1 ? '' : 's'}${braids.length ? ` · ${braids.length} braid${braids.length === 1 ? '' : 's'}` : ''}</div>
      <h2>Strands</h2>
      <div>${strandsHtml}</div>
      ${braids.length ? `<h2>Braids</h2><div>${braidsHtml}</div>` : ''}
      <div class="footer">
        Subscribe to any of these on <a href="${FRONTEND}/#/p/${esc(handle)}">EventStrand</a>.
      </div>`;

    res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
    res.send(shell({ canonical, title, description: desc, jsonLd, bodyHtml }));
  } catch (e) { next(e); }
});

function notFoundPage(message) {
  return shell({
    canonical: FRONTEND,
    title: 'Not found · EventStrand',
    description: message,
    bodyHtml: `<h1>404</h1><p class="desc">${esc(message)}.</p><div class="footer"><a href="${FRONTEND}/">Back to EventStrand</a></div>`,
  });
}

function passcodeGatePage({ canonical, title }) {
  return shell({
    canonical,
    title,
    description: 'This strand requires a passcode to view.',
    bodyHtml: `<h1>Passcode required</h1><p class="desc">This strand is protected. Open it on <a href="${esc(canonical)}#">EventStrand</a> and enter the passcode to view.</p>`,
  });
}

module.exports = router;

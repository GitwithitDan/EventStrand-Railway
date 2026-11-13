// ── SERVER-SIDE RENDERED PUBLIC PAGES ─────────────────────────
// Renders /s/:handle/:strandId, /b/:handle/:braidId, /p/:handle as
// fully indexable HTML. Crawlers see prerendered content with rich
// meta tags + JSON-LD; real users get the same HTML, with a link into the
// app to subscribe.
//
// Wired up via Cloudflare Page Rule that proxies eventstrand.com/s/*
// (and /b/*, /p/*) to api.eventstrand.com/ssr/* under the hood,
// preserving the user-facing URL.

const express = require('express');
const router  = express.Router();
const Strand  = require('../models/Strand');
const Braid   = require('../models/Braid');
const User    = require('../models/User');
const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const { getOccurrences, describeSchedule } = require('../lib/occurrences');

const isId = v => mongoose.isValidObjectId(v);
const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// "2026-11-20" -> "Fri, Nov 20"
function prettyDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[dt.getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
}

const FRONTEND = process.env.FRONTEND_URL || 'https://eventstrand.com';

// ── LAST-GOOD-PAGE FALLBACK ──────────────────────────────────
// Remembers the most recent successful (200) HTML for each public page in
// memory. If the database is unreachable when a page is requested, the
// remembered copy is served instead of an error, so published strand/QR
// links keep working through a database outage. The cache is per-process:
// it is empty after a restart/redeploy and fills as pages are visited.
const LAST_GOOD_MAX = 500;
const lastGood = new Map();

router.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const key = req.originalUrl.split('?')[0];
  const origSend = res.send.bind(res);
  res.send = (body) => {
    if (res.statusCode === 200 && typeof body === 'string') {
      lastGood.delete(key);
      lastGood.set(key, body);
      if (lastGood.size > LAST_GOOD_MAX) lastGood.delete(lastGood.keys().next().value);
    }
    return origSend(body);
  };
  next();
});

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

// Page shell — used by every SSR response
function shell({ canonical, title, description, ogImage, jsonLd, bodyHtml, noindex }) {
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
  ${noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
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
    body { margin: 0; padding-top: 64px; font-family: 'Outfit', sans-serif; background: #04061a; color: #ECF0FF; }
    .ssr-nav { position: fixed; top: 0; left: 0; right: 0; z-index: 250; display: flex; align-items: center; justify-content: space-between; padding: 0 40px; height: 64px; box-sizing: border-box; background: rgba(4,6,26,0.90); backdrop-filter: blur(20px); border-bottom: 1px solid rgba(100,120,255,0.18); }
    .ssr-nav-logo { display: flex; align-items: center; gap: 10px; text-decoration: none; color: #ECF0FF; font-family: 'Fraunces', serif; font-size: 20px; font-weight: 600; }
    .ssr-nav-logo img { width: 32px; height: 32px; border-radius: 8px; object-fit: cover; }
    .ssr-nav-links { display: flex; align-items: center; gap: 8px; }
    .ssr-nav-links a { color: #8290C0; text-decoration: none; font-size: 14px; font-weight: 500; padding: 6px 14px; border-radius: 8px; }
    .ssr-nav-links a:hover { color: #ECF0FF; background: rgba(108,143,255,0.14); }
    .ssr-nav-links a.ssr-nav-btn { color: #8290C0; border: 1px solid rgba(100,120,255,0.32); font-weight: 600; margin-left: 8px; }
    .ssr-nav-links a.ssr-nav-btn:hover { color: #ECF0FF; border-color: #6C8FFF; }
    .ssr-nav-links a.ssr-nav-cta { color: #fff; background: #6C8FFF; font-weight: 600; }
    @media (max-width: 900px) { .ssr-nav { padding: 0 20px; } .ssr-nav-links a:not(.ssr-nav-cta):not(.ssr-nav-btn) { display: none; } }
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
    .site-footer { max-width: 760px; margin: 0 auto; padding: 0 24px 40px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; border-top: 1px solid rgba(100,120,255,0.18); padding-top: 20px; }
    .site-footer, .site-footer a { color: #7882B8; font-size: 12px; text-decoration: none; }
    .site-footer .site-footer-links { display: flex; gap: 20px; }
  </style>
</head>
<body>
  <nav class="ssr-nav">
    <a class="ssr-nav-logo" href="${FRONTEND}/"><img src="${FRONTEND}/icon-192.png" alt="EventStrand"><span>EventStrand</span></a>
    <div class="ssr-nav-links">
      <a href="${FRONTEND}/">Home</a>
      <a href="${FRONTEND}/#concept">About</a>
      <a href="${FRONTEND}/#how">How It Works</a>
      <a href="${FRONTEND}/#builder">Builder</a>
      <a href="${FRONTEND}/#library">Library</a>
      <a href="${FRONTEND}/#venue-guides">Venue Guides</a>
      <a href="${FRONTEND}/#directory">Directory</a>
      <a href="${FRONTEND}/#developer">Developers</a>
      <a class="ssr-nav-btn" href="${FRONTEND}/spec">.rcal Spec</a>
      <a class="ssr-nav-cta" href="${FRONTEND}/#/dashboard">Open App</a>
    </div>
  </nav>
  <main class="ssr-content" id="ssr-content">
    ${bodyHtml}
  </main>

  <footer class="site-footer">
    <div>© 2026 EventStrand</div>
    <div class="site-footer-links">
      <a href="${FRONTEND}/privacy-policy.html">Privacy Policy</a>
      <a href="${FRONTEND}/terms-of-service.html">Terms of Service</a>
    </div>
  </footer>

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
    const handle = String(req.params.handle || '').toLowerCase();
    const { strandId } = req.params;
    if (!isId(strandId)) return res.status(404).send(notFoundPage('Strand not found'));
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
    // Nothing about it — not even its name — is shown or indexed.
    if (strand.visibility === 'protected') {
      res.set('Cache-Control', 'no-store');
      return res.send(passcodeGatePage({
        canonical: `${FRONTEND}/s/${handle}/${strandId}`,
        openUrl:   `${FRONTEND}/#/s/${handle}/${strandId}`,
        what:      'strand',
      }));
    }
    // Unlisted strands open for anyone with the link but stay out of search engines.
    const noindex = strand.visibility !== 'public';

    const canonical = `${FRONTEND}/s/${handle}/${strandId}`;
    const title     = `${strand.title} · @${handle} · EventStrand`;
    const desc      = metaDescription(strand.description || `${strand.title} — a living event schedule${strand.venue ? ' at ' + strand.venue : ''}.`);
    const ogImage   = `${FRONTEND}/icon-512.png`;

    // Real upcoming dates for the next 90 days, in the strand's own time zone.
    let now = DateTime.now().setZone(strand.timezone || 'UTC');
    if (!now.isValid) now = DateTime.now().setZone('UTC');
    const from = now.toISODate(), to = now.plus({ days: 90 }).toISODate();
    const occurrences = [];
    for (const ev of strand.events || []) {
      for (const o of getOccurrences(ev, from, to)) occurrences.push({ ...o, title: ev.title || strand.title });
    }
    occurrences.sort((a, b) => a.date.localeCompare(b.date) || String(a.time_start || '').localeCompare(String(b.time_start || '')));
    const upcomingHtml = occurrences.length ? occurrences.slice(0, 30).map(o => `
        <div class="event">
          <div class="event-title">${esc(o.title)}</div>
          <div class="event-meta">${esc(prettyDate(o.date))}${!o.no_time && o.time_start ? ` · ${esc(o.time_start)}${o.time_end ? '–' + esc(o.time_end) : ''}` : ''}${o.note ? ` · ${esc(o.note)}` : ''}</div>
        </div>`).join('') : '<p style="color:#8290C0;">Nothing scheduled in the next 90 days.</p>';

    const events = (strand.events || []).slice(0, 60);
    const eventsHtml = events.length ? events.map(ev => `
        <div class="event">
          <div class="event-title">${esc(ev.title || strand.title)}</div>
          <div class="event-meta">${esc(describeSchedule(ev))}${ev.price && ev.price !== 'free' ? ` · ${esc(ev.price)}` : ''}</div>
          ${ev.notes ? `<div style="margin-top:6px;color:#C5CCEA;font-size:14px;">${esc(ev.notes)}</div>` : ''}
        </div>`).join('') : '<p style="color:#8290C0;">No events scheduled yet.</p>';

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
      <h2>Coming up</h2>
      ${upcomingHtml}
      <h2>Schedule</h2>
      ${eventsHtml}
      <div class="footer">
        Keep this schedule in your own portal — <a href="${FRONTEND}/#/s/${esc(handle)}/${esc(strandId)}">subscribe on EventStrand</a>.
      </div>`;

    res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=60, stale-if-error=86400');
    res.send(shell({ canonical, title, description: desc, ogImage, jsonLd, bodyHtml, noindex }));
  } catch (e) { next(e); }
});

// ── /ssr/braid/:handle/:braidId ───────────────────────────────
router.get('/braid/:handle/:braidId', async (req, res, next) => {
  try {
    const handle = String(req.params.handle || '').toLowerCase();
    const { braidId } = req.params;
    if (!isId(braidId)) return res.status(404).send(notFoundPage('Braid not found'));
    const user = await User.findOne({
      $or: [{ handle }, { previousHandles: handle }]
    });
    if (!user) return res.status(404).send(notFoundPage('Publisher not found'));

    if (user.handle !== handle) {
      return res.redirect(301, `${FRONTEND}/b/${user.handle}/${braidId}`);
    }

    const braid = await Braid.findOne({
      _id: braidId, publisher: user._id, published: true,
    }).populate({
      path: 'strands', select: 'title venue subscriberCount color',
      match: { published: true, visibility: { $ne: 'protected' } },
    }).lean();

    if (!braid) return res.status(404).send(notFoundPage('Braid not found'));

    if (braid.visibility === 'protected') {
      res.set('Cache-Control', 'no-store');
      return res.send(passcodeGatePage({
        canonical: `${FRONTEND}/b/${handle}/${braidId}`,
        openUrl:   `${FRONTEND}/#/b/${handle}/${braidId}`,
        what:      'braid',
      }));
    }
    const noindex = braid.visibility !== 'public';

    const canonical = `${FRONTEND}/b/${handle}/${braidId}`;
    const title     = `${braid.title} · @${handle} · EventStrand`;
    const desc      = metaDescription(braid.description || `${braid.title} — a curated bundle of strands by @${handle}.`);

    const strands = (braid.strands || []).filter(Boolean);
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

    res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=60, stale-if-error=86400');
    res.send(shell({ canonical, title, description: desc, jsonLd, bodyHtml, noindex }));
  } catch (e) { next(e); }
});

// ── /ssr/profile/:handle ──────────────────────────────────────
router.get('/profile/:handle', async (req, res, next) => {
  try {
    const handle = String(req.params.handle || '').toLowerCase();
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

    res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=60, stale-if-error=86400');
    res.send(shell({ canonical, title, description: desc, jsonLd, bodyHtml }));
  } catch (e) { next(e); }
});

function notFoundPage(message) {
  return shell({
    canonical: FRONTEND,
    noindex: true,
    title: 'Not found · EventStrand',
    description: message,
    bodyHtml: `<h1>404</h1><p class="desc">${esc(message)}.</p><div class="footer"><a href="${FRONTEND}/">Back to EventStrand</a></div>`,
  });
}

function passcodeGatePage({ canonical, openUrl, what }) {
  return shell({
    canonical,
    noindex: true,
    title: 'Passcode required · EventStrand',
    description: `This ${what} requires a passcode to view.`,
    bodyHtml: `<h1>Passcode required</h1><p class="desc">This ${what} is protected. <a href="${esc(openUrl)}">Open it on EventStrand</a> and enter the passcode to view.</p>`,
  });
}

// Router-level error handler: serve the last good copy if we have one,
// otherwise a friendly page — never a raw JSON/DB error.
router.use((err, req, res, next) => {
  console.error('[ssr]', err.stack || err);
  if (res.headersSent) return next(err);
  const key = req.originalUrl.split('?')[0];
  const cached = lastGood.get(key);
  res.set('Cache-Control', 'no-store');
  if (cached) {
    res.set('X-Served-Stale', '1');
    return res.status(200).type('html').send(cached);
  }
  res.status(503).type('html').send(shell({
    canonical: FRONTEND,
    title: 'Temporarily unavailable · EventStrand',
    description: 'EventStrand is having trouble right now.',
    bodyHtml: `<h1>Temporarily unavailable</h1><p class="desc">EventStrand is having trouble right now. Please try again in a few minutes.</p><div class="footer"><a href="${FRONTEND}/">Back to EventStrand</a></div>`,
  }));
});

module.exports = router;

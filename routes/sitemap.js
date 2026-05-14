// ── DYNAMIC SITEMAP ──────────────────────────────────────────
// Generated from current published+public strands, braids, and
// profiles. Cached for 1 hour at the CDN level. Excludes anything
// that's unlisted, protected, or unpublished.
//
// Wired up via Cloudflare so eventstrand.com/sitemap.xml is proxied
// to api.eventstrand.com/sitemap.xml.

const express = require('express');
const router  = express.Router();
const Strand  = require('../models/Strand');
const Braid   = require('../models/Braid');
const User    = require('../models/User');

const FRONTEND = process.env.FRONTEND_URL || 'https://eventstrand.com';

function urlEntry({ loc, lastmod, changefreq = 'weekly', priority = '0.7' }) {
  return `  <url>
    <loc>${escXml(loc)}</loc>${lastmod ? `\n    <lastmod>${escXml(lastmod)}</lastmod>` : ''}
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

function escXml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'
  })[c]);
}

router.get('/sitemap.xml', async (req, res, next) => {
  try {
    // Static pages
    const staticUrls = [
      { loc: `${FRONTEND}/`,                  changefreq: 'daily',   priority: '1.0' },
      { loc: `${FRONTEND}/spec/`,             changefreq: 'monthly', priority: '0.6' },
      { loc: `${FRONTEND}/developers/`,       changefreq: 'monthly', priority: '0.6' },
      { loc: `${FRONTEND}/privacy-policy.html`, changefreq: 'yearly',  priority: '0.3' },
      { loc: `${FRONTEND}/terms-of-service.html`, changefreq: 'yearly',  priority: '0.3' },
      { loc: `${FRONTEND}/cookie-policy.html`, changefreq: 'yearly',  priority: '0.3' },
    ];

    // Public profiles (any user with a handle)
    const users = await User.find({ handle: { $exists: true, $ne: null } })
      .select('handle updatedAt').lean();

    // Published public strands
    const strands = await Strand.find({
      published: true, visibility: 'public',
    }).select('publisherHandle updatedAt').lean();

    // Published public braids
    const braids = await Braid.find({
      published: true, visibility: 'public',
    }).select('publisherHandle updatedAt').lean();

    const entries = [
      ...staticUrls.map(u => urlEntry(u)),
      ...users.map(u => urlEntry({
        loc: `${FRONTEND}/p/${u.handle}`,
        lastmod: u.updatedAt?.toISOString().slice(0, 10),
        changefreq: 'weekly',
        priority: '0.7',
      })),
      ...strands.filter(s => s.publisherHandle).map(s => urlEntry({
        loc: `${FRONTEND}/s/${s.publisherHandle}/${s._id}`,
        lastmod: s.updatedAt?.toISOString().slice(0, 10),
        changefreq: 'weekly',
        priority: '0.8',
      })),
      ...braids.filter(b => b.publisherHandle).map(b => urlEntry({
        loc: `${FRONTEND}/b/${b.publisherHandle}/${b._id}`,
        lastmod: b.updatedAt?.toISOString().slice(0, 10),
        changefreq: 'weekly',
        priority: '0.7',
      })),
    ];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>
`;
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    res.send(xml);
  } catch (e) { next(e); }
});

router.get('/robots.txt', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(`User-agent: *
Allow: /

Sitemap: ${FRONTEND}/sitemap.xml
`);
});

module.exports = router;

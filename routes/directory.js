const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const Strand   = require('../models/Strand');

// ── VERIFICATION ENGINE ──────────────────────────────────────────────────────
//
// Three-layer pipeline. Each layer is attempted in order; the first that
// confirms the strand URL on the page marks the strand as verified and returns.
// If all three fail the strand is flagged for manual review (never auto-rejected).
//
// Layer 1 — Static HTML fetch
//   Simple HTTP GET of the verification URL, search raw HTML for the strand URL.
//   Catches most cases: venues that embed a plain text link.
//
// Layer 2 — Headless browser render (Puppeteer)
//   Full JS-rendered DOM. Catches React/Vue/Squarespace/Wix sites where the
//   link is injected by JavaScript after page load.
//
// Layer 3 — QR image decode
//   Puppeteer page screenshot + all <img> src values → fetch each → decode
//   with jimp + jsqr. Catches venues that embed the QR image without a text link.
//
// ─────────────────────────────────────────────────────────────────────────────

function buildStrandUrl(strand) {
  const handle = strand.publisherHandle;
  const id     = strand._id.toString();
  return `https://eventstrand.com/s/${handle}/${id}`;
}

// Layer 1: plain HTTP fetch → search raw HTML
async function layer1StaticFetch(verificationUrl, strandUrl) {
  try {
    const res = await fetch(verificationUrl, {
      headers: { 'User-Agent': 'EventStrand-Verifier/1.0 (+https://eventstrand.com)' },
      signal:  AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    if (!res.ok) return false;
    const html = await res.text();
    return html.includes(strandUrl);
  } catch (e) {
    console.warn('[verify L1] static fetch failed:', e.message);
    return false;
  }
}

// Layer 2: headless Puppeteer render → search rendered DOM
async function layer2Puppeteer(verificationUrl, strandUrl) {
  let browser;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    });
    const page = await browser.newPage();
    await page.setUserAgent('EventStrand-Verifier/1.0 (+https://eventstrand.com)');
    await page.goto(verificationUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    const bodyText = await page.evaluate(() => document.documentElement.innerHTML);
    return bodyText.includes(strandUrl);
  } catch (e) {
    console.warn('[verify L2] puppeteer failed:', e.message);
    return false;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Layer 3: QR decode from page images
async function layer3QrDecode(verificationUrl, strandUrl) {
  let browser;
  try {
    const puppeteer = require('puppeteer');
    const Jimp      = require('jimp');
    const jsQR      = require('jsqr');

    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    });
    const page = await browser.newPage();
    await page.setUserAgent('EventStrand-Verifier/1.0 (+https://eventstrand.com)');
    await page.goto(verificationUrl, { waitUntil: 'networkidle2', timeout: 20000 });

    // Collect all image URLs visible on the page
    const imgSrcs = await page.evaluate(() => {
      return Array.from(document.images)
        .map(img => img.src)
        .filter(src => src && src.startsWith('http'));
    });

    // Also grab a full-page screenshot — catches inline QR codes rendered as canvas
    const screenshot = await page.screenshot({ fullPage: true });
    await browser.close().catch(() => {});
    browser = null;

    // Helper: decode QR from a buffer
    async function decodeBuffer(buffer) {
      try {
        const image = await Jimp.read(buffer);
        const { data, width, height } = image.bitmap;
        const result = jsQR(new Uint8ClampedArray(data), width, height);
        return result?.data || null;
      } catch (e) {
        return null;
      }
    }

    // Check screenshot first
    const screenshotResult = await decodeBuffer(screenshot);
    if (screenshotResult && screenshotResult.includes(strandUrl)) return true;

    // Check individual images (cap at 15 to keep runtime reasonable)
    for (const src of imgSrcs.slice(0, 15)) {
      try {
        const imgRes = await fetch(src, {
          signal: AbortSignal.timeout(5000),
          headers: { 'User-Agent': 'EventStrand-Verifier/1.0' },
        });
        if (!imgRes.ok) continue;
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const qrData = await decodeBuffer(buf);
        if (qrData && qrData.includes(strandUrl)) return true;
      } catch (e) {
        // skip this image, try next
      }
    }

    return false;
  } catch (e) {
    console.warn('[verify L3] qr decode failed:', e.message);
    return false;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Main async verification job — fire-and-forget from routes
async function runVerification(strandId) {
  let strand;
  try {
    strand = await Strand.findById(strandId);
    if (!strand || !strand.directoryVerificationUrl) return;

    strand.directoryLastAttemptAt = new Date();
    strand.directoryLastError     = null;
    await strand.save();

    const strandUrl = buildStrandUrl(strand);
    const url       = strand.directoryVerificationUrl;

    console.log(`[verify] starting for strand ${strandId}, url: ${url}`);

    // Layer 1
    console.log('[verify] Layer 1: static fetch');
    if (await layer1StaticFetch(url, strandUrl)) {
      console.log('[verify] L1 ✓ verified');
      strand.directoryStatus    = 'verified';
      strand.directoryVerifiedAt = new Date();
      await strand.save();
      return;
    }

    // Layer 2
    console.log('[verify] Layer 2: puppeteer render');
    if (await layer2Puppeteer(url, strandUrl)) {
      console.log('[verify] L2 ✓ verified');
      strand.directoryStatus    = 'verified';
      strand.directoryVerifiedAt = new Date();
      await strand.save();
      return;
    }

    // Layer 3
    console.log('[verify] Layer 3: QR decode');
    if (await layer3QrDecode(url, strandUrl)) {
      console.log('[verify] L3 ✓ verified');
      strand.directoryStatus    = 'verified';
      strand.directoryVerifiedAt = new Date();
      await strand.save();
      return;
    }

    // All layers failed — flag for manual review, never auto-reject
    console.log(`[verify] all layers failed for ${strandId} — flagged for review`);
    strand.directoryStatus    = 'flagged';
    strand.directoryLastError = `Strand URL not found on ${url} via static fetch, rendered DOM, or QR image decode. Flagged for manual review.`;
    await strand.save();

  } catch (e) {
    console.error('[verify] unexpected error:', e.message);
    if (strand) {
      strand.directoryStatus    = 'flagged';
      strand.directoryLastError = e.message;
      await strand.save().catch(() => {});
    }
  }
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

// POST /api/directory/:id/submit — opt-in and trigger verification
router.post('/:id/submit', auth, async (req, res, next) => {
  try {
    const strand = await Strand.findOne({ _id: req.params.id, publisher: req.user._id });
    if (!strand) return res.status(404).json({ error: 'Strand not found' });
    if (!strand.published) return res.status(400).json({ error: 'Publish your strand before submitting to the directory' });

    const { verificationUrl } = req.body;
    if (!verificationUrl || typeof verificationUrl !== 'string') {
      return res.status(400).json({ error: 'verificationUrl is required' });
    }

    let url;
    try { url = new URL(verificationUrl.trim()); }
    catch (e) { return res.status(400).json({ error: 'verificationUrl must be a valid URL (include https://)' }); }
    if (!['http:', 'https:'].includes(url.protocol)) {
      return res.status(400).json({ error: 'verificationUrl must be http or https' });
    }

    strand.directoryOptIn            = true;
    strand.directoryVerificationUrl  = url.href;
    strand.directoryStatus           = 'pending';
    strand.directoryLastError        = null;
    await strand.save();

    // Fire verification async — respond immediately so venue isn't waiting
    setImmediate(() => runVerification(strand._id.toString()));

    res.json({ ok: true, status: 'pending', message: 'Verification started — check back in a minute.' });
  } catch (e) { next(e); }
});

// POST /api/directory/:id/reverify — re-run verification for an existing submission
router.post('/:id/reverify', auth, async (req, res, next) => {
  try {
    const strand = await Strand.findOne({ _id: req.params.id, publisher: req.user._id });
    if (!strand) return res.status(404).json({ error: 'Strand not found' });
    if (!strand.directoryOptIn || !strand.directoryVerificationUrl) {
      return res.status(400).json({ error: 'No directory submission found — submit first' });
    }
    if (strand.directoryStatus === 'pending') {
      return res.status(400).json({ error: 'Verification already running' });
    }

    // Enforce a cooldown: at least 60 seconds between re-verify attempts
    if (strand.directoryLastAttemptAt) {
      const elapsed = Date.now() - strand.directoryLastAttemptAt.getTime();
      if (elapsed < 60 * 1000) {
        const wait = Math.ceil((60 * 1000 - elapsed) / 1000);
        return res.status(429).json({ error: `Please wait ${wait}s before re-verifying` });
      }
    }

    strand.directoryStatus    = 'pending';
    strand.directoryLastError = null;
    await strand.save();

    setImmediate(() => runVerification(strand._id.toString()));

    res.json({ ok: true, status: 'pending', message: 'Re-verification started.' });
  } catch (e) { next(e); }
});

// GET /api/directory/:id/status — poll verification status
router.get('/:id/status', auth, async (req, res, next) => {
  try {
    const strand = await Strand.findOne({ _id: req.params.id, publisher: req.user._id })
      .select('directoryOptIn directoryStatus directoryVerificationUrl directoryVerifiedAt directoryLastAttemptAt directoryLastError');
    if (!strand) return res.status(404).json({ error: 'Strand not found' });
    res.json({
      optIn:            strand.directoryOptIn,
      status:           strand.directoryStatus,
      verificationUrl:  strand.directoryVerificationUrl,
      verifiedAt:       strand.directoryVerifiedAt,
      lastAttemptAt:    strand.directoryLastAttemptAt,
      lastError:        strand.directoryLastError,
    });
  } catch (e) { next(e); }
});

// DELETE /api/directory/:id/withdraw — opt out of directory
router.delete('/:id/withdraw', auth, async (req, res, next) => {
  try {
    const strand = await Strand.findOne({ _id: req.params.id, publisher: req.user._id });
    if (!strand) return res.status(404).json({ error: 'Strand not found' });
    strand.directoryOptIn            = false;
    strand.directoryStatus           = 'none';
    strand.directoryVerificationUrl  = undefined;
    strand.directoryVerifiedAt       = undefined;
    strand.directoryLastError        = undefined;
    await strand.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/directory/public/directory — public listing of verified strands
// No auth required. Filterable by type and city. Paginated (24 per page).
router.get('/public/directory', async (req, res, next) => {
  try {
    const { type, city, page = 1 } = req.query;
    const limit = 24;
    const skip  = (parseInt(page) - 1) * limit;

    const filter = {
      directoryStatus: 'verified',
      published:       true,
      visibility:      'public',
    };
    if (type) filter.type = type;
    if (city) filter.city = new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const [strands, total] = await Promise.all([
      Strand.find(filter)
        .select('title type venue city description color publisherHandle')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Strand.countDocuments(filter),
    ]);

    res.json({
      strands,
      total,
      page:  parseInt(page),
      pages: Math.ceil(total / limit),
    });
  } catch (e) { next(e); }
});

module.exports = router;

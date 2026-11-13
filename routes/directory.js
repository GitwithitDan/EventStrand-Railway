const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const Strand   = require('../models/Strand');
const dns      = require('dns').promises;
const net      = require('net');

// ── SSRF PROTECTION ──────────────────────────────────────────────────────────
// Reject any URL whose resolved IP falls in a private/loopback/link-local range.
// Applied before every outbound fetch and before every Puppeteer goto().

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT 100.64.0.0/10
  /^192\.0\.0\./,
  /^198\.1[89]\./,
  /^(22[4-9]|2[3-5]\d)\./,                     // multicast and reserved
  /^::$/,
  /^ff[0-9a-f]{2}:/i,
];

function isPrivateIp(ip) {
  let addr = String(ip).replace(/^\[|\]$/g, '');
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is judged by the IPv4 address inside it.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) addr = mapped[1];
  else if (/^::ffff:/i.test(addr)) return true;
  return PRIVATE_RANGES.some(r => r.test(addr));
}

async function assertPublicHostname(hostname) {
  // Reject well-known local names without a DNS lookup
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error(`Hostname "${hostname}" is not allowed`);
  }
  hostname = String(hostname).replace(/^\[|\]$/g, '');
  // For numeric IPs validate directly
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`IP address "${hostname}" is not allowed`);
    return;
  }
  // DNS resolve and check every returned address
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw new Error(`Could not resolve hostname "${hostname}"`);
  }
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error(`Hostname "${hostname}" resolves to a private address`);
  }
}

// Fetches a public http(s) URL. Redirects are followed by hand, at most five,
// and every hop is checked again, so a public address cannot bounce the
// request to a private one.
async function safeFetch(url, options = {}) {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http and https URLs are allowed');
    await assertPublicHostname(parsed.hostname);
    const res = await fetch(current, { ...options, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

// Reads at most `limit` bytes of a response body as text.
async function readCapped(res, limit = 2 * 1024 * 1024) {
  if (!res.body || !res.body.getReader) return (await res.text()).slice(0, limit);
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value)); size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

async function safePuppeteerGoto(page, url, options = {}) {
  const parsed = new URL(url);
  await assertPublicHostname(parsed.hostname);
  // Also intercept any redirects or sub-requests from the page itself
  await page.setRequestInterception(true);
  page.on('request', async req => {
    try {
      const reqUrl = new URL(req.url());
      await assertPublicHostname(reqUrl.hostname);
      req.continue();
    } catch (_) {
      req.abort();
    }
  });
  return page.goto(url, options);
}

// ── VERIFICATION ENGINE ──────────────────────────────────────────────────────

function buildStrandUrl(strand) {
  const handle = strand.publisherHandle;
  const id     = strand._id.toString();
  return `https://eventstrand.com/s/${handle}/${id}`;
}

async function layer1StaticFetch(verificationUrl, strandUrl) {
  try {
    const res = await safeFetch(verificationUrl, {
      headers: { 'User-Agent': 'EventStrand-Verifier/1.0 (+https://eventstrand.com)' },
      signal:  AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    const html = await readCapped(res);
    return html.includes(strandUrl);
  } catch (e) {
    console.warn('[verify L1] static fetch failed:', e.message);
    return false;
  }
}

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
    await safePuppeteerGoto(page, verificationUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    const bodyText = await page.evaluate(() => document.documentElement.innerHTML);
    return bodyText.includes(strandUrl);
  } catch (e) {
    console.warn('[verify L2] puppeteer failed:', e.message);
    return false;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

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
    await safePuppeteerGoto(page, verificationUrl, { waitUntil: 'networkidle2', timeout: 20000 });

    const imgSrcs = await page.evaluate(() => {
      return Array.from(document.images)
        .map(img => img.src)
        .filter(src => src && src.startsWith('http'));
    });

    const screenshot = await page.screenshot({ fullPage: true });
    await browser.close().catch(() => {});
    browser = null;

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

    const screenshotResult = await decodeBuffer(screenshot);
    if (screenshotResult && screenshotResult.includes(strandUrl)) return true;

    for (const src of imgSrcs.slice(0, 15)) {
      try {
        const imgRes = await safeFetch(src, {
          signal: AbortSignal.timeout(5000),
          headers: { 'User-Agent': 'EventStrand-Verifier/1.0' },
        });
        if (!imgRes.ok) continue;
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const qrData = await decodeBuffer(buf);
        if (qrData && qrData.includes(strandUrl)) return true;
      } catch (e) {
        // skip this image
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

    console.log('[verify] Layer 1: static fetch');
    if (await layer1StaticFetch(url, strandUrl)) {
      console.log('[verify] L1 ✓ verified');
      strand.directoryStatus    = 'verified';
      strand.directoryVerifiedAt = new Date();
      await strand.save();
      return;
    }

    console.log('[verify] Layer 2: puppeteer render');
    if (await layer2Puppeteer(url, strandUrl)) {
      console.log('[verify] L2 ✓ verified');
      strand.directoryStatus    = 'verified';
      strand.directoryVerifiedAt = new Date();
      await strand.save();
      return;
    }

    console.log('[verify] Layer 3: QR decode');
    if (await layer3QrDecode(url, strandUrl)) {
      console.log('[verify] L3 ✓ verified');
      strand.directoryStatus    = 'verified';
      strand.directoryVerifiedAt = new Date();
      await strand.save();
      return;
    }

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

    // Apply the same 60-second cooldown as reverify — prevents rapid re-submissions
    if (strand.directoryLastAttemptAt) {
      const elapsed = Date.now() - strand.directoryLastAttemptAt.getTime();
      if (elapsed < 60 * 1000) {
        const wait = Math.ceil((60 * 1000 - elapsed) / 1000);
        return res.status(429).json({ error: `Please wait ${wait}s before re-submitting` });
      }
    }

    strand.directoryOptIn            = true;
    strand.directoryVerificationUrl  = url.href;
    strand.directoryStatus           = 'pending';
    strand.directoryLastError        = null;
    await strand.save();

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
router.get('/public/directory', async (req, res, next) => {
  try {
    const type = typeof req.query.type === 'string' ? req.query.type.slice(0, 60) : '';
    const city = typeof req.query.city === 'string' ? req.query.city.trim().slice(0, 80) : '';
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 1000);
    const limit = 24;
    const skip  = (page - 1) * limit;

    const filter = {
      directoryStatus: 'verified',
      published:       true,
      visibility:      'public',
    };
    if (type) filter.type = type;
    if (city) {
      // Strands saved before the city was stored separately still match on their address.
      const re = new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ city: re }, { address: re }];
    }

    const [strands, total] = await Promise.all([
      Strand.find(filter)
        .select('title type venue city address description color publisherHandle')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Strand.countDocuments(filter),
    ]);

    // Public endpoint — allow Cloudflare to cache for 60s
    res.set('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.json({
      strands,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (e) { next(e); }
});

module.exports = router;

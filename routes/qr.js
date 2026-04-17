const express = require('express');
const router  = express.Router();
const QRCode  = require('qrcode');

// GET /api/qr?url=https://...
// Returns QR code as PNG image
router.get('/', async (req, res, next) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url parameter required' });

    // Validate it's an eventstrand URL
    const allowed = ['eventstrand.com', 'localhost', '127.0.0.1'];
    let parsed;
    try { parsed = new URL(url); } catch(e) { return res.status(400).json({ error: 'Invalid URL' }); }
    if (!allowed.some(h => parsed.hostname.includes(h))) {
      return res.status(400).json({ error: 'URL not allowed' });
    }

    const png = await QRCode.toBuffer(url, {
      type:           'png',
      width:          400,
      margin:         2,
      color: {
        dark:  '#04061a',
        light: '#ffffff',
      },
      errorCorrectionLevel: 'M',
    });

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(png);
  } catch (e) { next(e); }
});

module.exports = router;

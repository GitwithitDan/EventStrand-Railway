require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// ── SECURITY HEADERS ──────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow QR image embeds
  contentSecurityPolicy: false, // managed by Cloudflare
}));

// ── TRUST PROXY (required for correct IP detection behind Cloudflare + Railway) ──
app.set('trust proxy', 1);

// ── CORS ─────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL || 'https://eventstrand.com',
  'https://www.eventstrand.com',
  'http://localhost:3000',
  'http://localhost:8080',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));

// ── RATE LIMITING ─────────────────────────────────────────────
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }));
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

// ── NO-CACHE HEADERS (prevents Cloudflare caching API responses) ─────────
// QR endpoint is excluded — it intentionally sets its own long cache header
app.use('/api', (req, res, next) => {
  if (!req.path.startsWith('/qr')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

// ── ROUTES ────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/strands',   require('./routes/strands'));
app.use('/api/braids',    require('./routes/braids'));
app.use('/api/user',      require('./routes/user'));
app.use('/api/user',      require('./routes/interested'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/public',    require('./routes/public'));
app.use('/api/qr',        require('./routes/qr'));

// ── HEALTH ────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── ERROR HANDLER ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// ── DATABASE + START ──────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('MongoDB connected');
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`EventStrand API running on port ${PORT}`));
  })
  .catch(err => { console.error('MongoDB connection error:', err); process.exit(1); });

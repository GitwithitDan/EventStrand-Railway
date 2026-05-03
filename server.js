require('dotenv').config();

// ── BOOT-TIME ENV VALIDATION ─────────────────────────────────
// Fail fast rather than starting with broken config.
// GOOGLE_CLIENT_ID and JWT_SECRET are validated inside routes/auth.js
// so they throw on first require(). MONGODB_URI must be checked here.
['MONGODB_URI', 'JWT_SECRET', 'GOOGLE_CLIENT_ID'].forEach(key => {
  if (!process.env[key]) {
    console.error(`FATAL: ${key} environment variable is not set`);
    process.exit(1);
  }
});

const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// ── SECURITY HEADERS ──────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow QR image embeds
  contentSecurityPolicy: false, // managed by Cloudflare
}));

// ── TRUST PROXY ──────────────────────────────────────────────
// Railway sits behind Cloudflare. Using `true` trusts the full chain
// and lets req.ip resolve to the real client IP from CF-Connecting-IP.
app.set('trust proxy', true);

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
  // credentials:true is not needed — auth uses Bearer tokens in headers,
  // not cookies. Keeping it false reduces CORS attack surface.
  credentials: false,
}));

app.use(express.json({ limit: '2mb' }));

// ── RATE LIMITING ─────────────────────────────────────────────
// keyGenerator reads the real client IP via CF-Connecting-IP header,
// which Cloudflare sets and Railway forwards.
function cfIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip;
}

app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: cfIp,
  standardHeaders: true,
  legacyHeaders: false,
}));
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  keyGenerator: cfIp,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── CACHE HEADERS ─────────────────────────────────────────────
// Default: no caching for all API routes. Individual routes that
// serve stable public data (directory, public strand/braid/profile, QR)
// set their own cache headers to override this.
app.use('/api', (req, res, next) => {
  if (!req.path.startsWith('/qr') && !req.path.startsWith('/directory/public') && !req.path.startsWith('/public/')) {
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
app.use('/api/apikeys',   require('./routes/apikeys'));
app.use('/api/directory', require('./routes/directory'));

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
    const server = app.listen(PORT, () => console.log(`EventStrand API running on port ${PORT}`));

    // ── GRACEFUL SHUTDOWN ─────────────────────────────────────
    // Allows Railway re-deploys to finish in-flight requests cleanly
    // instead of hard-killing connections and causing 502s.
    function gracefulShutdown(signal) {
      console.log(`${signal} received — shutting down gracefully`);
      server.close(() => {
        mongoose.connection.close(false).then(() => {
          console.log('MongoDB connection closed. Process exiting.');
          process.exit(0);
        });
      });
      // Force exit if graceful shutdown takes more than 10s
      setTimeout(() => { console.error('Forced exit after timeout'); process.exit(1); }, 10000);
    }
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  })
  .catch(err => { console.error('MongoDB connection error:', err); process.exit(1); });

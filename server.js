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
// CSP rationale:
//  - 'unsafe-inline' on script-src is required because index.html
//    contains 230+ inline event handlers (onclick=, onchange=,
//    oninput=) generated dynamically via template literals. A future
//    refactor to addEventListener delegation can remove this.
//  - 'unsafe-inline' on style-src covers 400+ inline style="..."
//    attributes throughout the SPA.
//  - object-src 'none' blocks <object>/<embed>/<applet> entirely.
//  - frame-ancestors 'self' blocks clickjacking via iframes.
//  - base-uri 'self' prevents <base> tag injection from rerouting
//    relative URLs to attacker-controlled origins.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow QR image embeds
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src':     ["'self'"],
      'script-src':      ["'self'", "'unsafe-inline'", 'https://accounts.google.com', 'https://cdn.mxpnl.com', 'https://*.mxpnl.com'],
      'script-src-attr': ["'unsafe-inline'"],
      'style-src':       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src':        ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src':         ["'self'", 'data:', 'https:', 'blob:'],
      'connect-src':     ["'self'", 'https://api.eventstrand.com', 'https://accounts.google.com', 'https://*.mxpnl.com', 'https://api-js.mixpanel.com'],
      'frame-src':       ['https://accounts.google.com'],
      'frame-ancestors': ["'self'"],
      'object-src':      ["'none'"],
      'base-uri':        ["'self'"],
      'form-action':     ["'self'"],
    },
  },
}));

// ── TRUST PROXY ──────────────────────────────────────────────
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
  credentials: false,
}));

app.use(express.json({ limit: '2mb' }));

// ── RATE LIMITING ─────────────────────────────────────────────
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
// SSR pages get a separate, lighter limit — these are public, cacheable, and
// hit by both crawlers and direct users.
app.use(['/ssr', '/sitemap.xml', '/robots.txt'], rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: cfIp,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── CACHE HEADERS ─────────────────────────────────────────────
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

// ── SSR + SITEMAP ─────────────────────────────────────────────
// These are mounted at the root so Cloudflare Page Rules can proxy
// /s/*, /b/*, /p/*, /sitemap.xml, /robots.txt to the backend without
// path rewriting. The SSR routes match /s/:handle/:strandId etc.
app.use('/',    require('./routes/sitemap'));
app.use('/ssr', require('./routes/ssr'));
// Direct path mounts so Cloudflare can simply forward without a rewrite
app.use('/s',   (req, res, next) => {
  // Forward to /ssr/strand internally
  req.url = `/strand${req.url}`;
  return require('./routes/ssr')(req, res, next);
});
app.use('/b',   (req, res, next) => {
  req.url = `/braid${req.url}`;
  return require('./routes/ssr')(req, res, next);
});
app.use('/p',   (req, res, next) => {
  req.url = `/profile${req.url}`;
  return require('./routes/ssr')(req, res, next);
});

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

    function gracefulShutdown(signal) {
      console.log(`${signal} received — shutting down gracefully`);
      server.close(() => {
        mongoose.connection.close(false).then(() => {
          console.log('MongoDB connection closed. Process exiting.');
          process.exit(0);
        });
      });
      setTimeout(() => { console.error('Forced exit after timeout'); process.exit(1); }, 10000);
    }
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  })
  .catch(err => { console.error('MongoDB connection error:', err); process.exit(1); });

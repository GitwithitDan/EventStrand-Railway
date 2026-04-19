const express    = require('express');
const router     = express.Router();
const auth       = require('../middleware/auth');
const Interested = require('../models/Interested');

// GET /api/user/interested — fetch all entries for the current user
router.get('/interested', auth, async (req, res, next) => {
  try {
    const items = await Interested.find({ user: req.user._id })
      .sort({ expiresAt: 1 })
      .lean();
    res.json({
      items: items.map(i => ({
        key:       i.key,
        eventId:   i.eventId,
        date:      i.date,
        time:      i.time,
        title:     i.title,
        venue:     i.venue,
        strand:    i.strand,
        expiresAt: i.expiresAt.getTime(),
      })),
    });
  } catch (e) { next(e); }
});

// POST /api/user/interested — add or update an entry (upsert by key)
router.post('/interested', auth, async (req, res, next) => {
  try {
    const { key, eventId, date, time, title, venue, strand, expiresAt } = req.body;
    if (!key || !expiresAt) return res.status(400).json({ error: 'key and expiresAt required' });

    await Interested.findOneAndUpdate(
      { user: req.user._id, key },
      { user: req.user._id, key, eventId, date, time, title, venue, strand,
        expiresAt: new Date(expiresAt) },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/user/interested/clear-expired — delete all past-expiry entries
// Must be defined BEFORE /:key to prevent route shadowing
router.post('/interested/clear-expired', auth, async (req, res, next) => {
  try {
    const result = await Interested.deleteMany({
      user:      req.user._id,
      expiresAt: { $lte: new Date() },
    });
    res.json({ ok: true, deleted: result.deletedCount });
  } catch (e) { next(e); }
});

// DELETE /api/user/interested/:key — remove one entry
router.delete('/interested/:key', auth, async (req, res, next) => {
  try {
    await Interested.deleteOne({ user: req.user._id, key: req.params.key });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;

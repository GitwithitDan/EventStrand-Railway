const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const Strand  = require('../models/Strand');
const Report  = require('../models/Report');

// POST /api/strands/:id/report
// One report per (reporter, strand) — resubmitting updates the existing
// report (reason/details) rather than creating a duplicate row.
router.post('/:id/report', auth, async (req, res, next) => {
  try {
    const { reason, details } = req.body;
    if (!Report.REASONS.includes(reason)) {
      return res.status(400).json({ error: 'Invalid reason' });
    }

    const strand = await Strand.findById(req.params.id);
    if (!strand) return res.status(404).json({ error: 'Strand not found' });

    if (strand.publisher.equals(req.user._id)) {
      return res.status(400).json({ error: "You can't report your own strand" });
    }

    await Report.findOneAndUpdate(
      { strand: strand._id, reporter: req.user._id },
      {
        strand:     strand._id,
        reporter:   req.user._id,
        reason,
        details:    (details || '').toString().trim().slice(0, 1000),
        status:     'open',
        resolvedBy: null,
        resolvedAt: null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;

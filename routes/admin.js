const express       = require('express');
const router        = express.Router();
const auth          = require('../middleware/auth');
const requireAdmin  = require('../middleware/requireAdmin');
const Report        = require('../models/Report');
const Strand        = require('../models/Strand');
const Workspace     = require('../models/Workspace');
const User          = require('../models/User');

// Every route below requires a valid session AND isAdmin.
router.use(auth, requireAdmin);

// GET /api/admin/reports — open reports, newest first, with enough
// strand/publisher context to act on each one without leaving the page.
router.get('/reports', async (req, res, next) => {
  try {
    const reports = await Report.find({ status: 'open' })
      .sort({ createdAt: -1 })
      .populate('strand', 'title publisherHandle published')
      .populate('reporter', 'handle')
      .lean();

    const strandIds = reports.map(r => r.strand?._id).filter(Boolean);
    const strands = await Strand.find({ _id: { $in: strandIds } }).select('publisher').lean();
    const publisherByStrand = Object.fromEntries(strands.map(s => [s._id.toString(), s.publisher]));

    const publisherIds = [...new Set(Object.values(publisherByStrand).map(String))];
    const publishers = await User.find({ _id: { $in: publisherIds } }).select('email handle').lean();
    const publisherById = Object.fromEntries(publishers.map(u => [u._id.toString(), u]));

    res.json({
      reports: reports.map(r => {
        const pubId      = r.strand ? publisherByStrand[r.strand._id.toString()] : null;
        const publisher  = pubId ? publisherById[pubId.toString()] : null;
        return {
          id:              r._id,
          reason:          r.reason,
          details:         r.details,
          createdAt:       r.createdAt,
          reporterHandle:  r.reporter?.handle || null,
          strand: r.strand ? {
            id:        r.strand._id,
            title:     r.strand.title,
            handle:    r.strand.publisherHandle,
            published: r.strand.published,
          } : null,
          publisherEmail:  publisher?.email  || null,
          publisherHandle: publisher?.handle || null,
        };
      }),
    });
  } catch (e) { next(e); }
});

// POST /api/admin/reports/:id/dismiss — mark resolved, drop from the queue.
// Does not touch the strand itself.
router.post('/reports/:id/dismiss', async (req, res, next) => {
  try {
    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    report.status     = 'resolved';
    report.resolvedBy = req.user._id;
    report.resolvedAt = new Date();
    await report.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/admin/strands/:id/unpublish — reversible; strand stops
// resolving publicly but the document (and its reports) stays intact.
router.post('/strands/:id/unpublish', async (req, res, next) => {
  try {
    const strand = await Strand.findById(req.params.id);
    if (!strand) return res.status(404).json({ error: 'Strand not found' });
    strand.published = false;
    await strand.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/admin/strands/:id — permanent. Mirrors the cleanup the
// owner-facing DELETE /api/strands/:id already does (routes/strands.js):
// pull the strand out of every subscriber workspace. Also clears any
// reports pointed at it, since there's nothing left to review.
router.delete('/strands/:id', async (req, res, next) => {
  try {
    const strand = await Strand.findById(req.params.id);
    if (!strand) return res.status(404).json({ error: 'Strand not found' });

    await Workspace.updateMany({ strands: strand._id }, { $pull: { strands: strand._id } });
    await Report.deleteMany({ strand: strand._id });
    await strand.deleteOne();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;

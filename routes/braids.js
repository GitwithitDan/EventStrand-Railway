const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const Braid    = require('../models/Braid');
const Strand   = require('../models/Strand');
const Workspace = require('../models/Workspace');
const Notification = require('../models/Notification');
const { validate, schemas } = require('../lib/validators');

// GET /api/braids/mine
router.get('/mine', auth, async (req, res, next) => {
  try {
    const braids = await Braid.find({ publisher: req.user._id })
      .populate('strands', 'title venue subscriberCount color')
      .sort({ updatedAt: -1 });
    res.json({ braids });
  } catch (e) { next(e); }
});

// POST /api/braids — create braid
router.post('/', auth, validate(schemas.braidCreate), async (req, res, next) => {
  try {
    const { title, description, strandIds, visibility, accessCode } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });

    const braid = await Braid.create({
      publisher:       req.user._id,
      publisherHandle: req.user.handle,
      title, description,
      strands:    strandIds || [],
      visibility: visibility || 'public',
      accessCode: visibility === 'protected' ? accessCode : undefined,
      published:  true,
    });
    res.json({ braid });
  } catch (e) { next(e); }
});

// PUT /api/braids/:id — update braid
// If new strands added, notify existing subscribers silently
router.put('/:id', auth, validate(schemas.braidUpdate), async (req, res, next) => {
  try {
    const braid = await Braid.findOne({ _id: req.params.id, publisher: req.user._id });
    if (!braid) return res.status(404).json({ error: 'Braid not found' });

    const { title, description, strandIds, visibility, accessCode } = req.body;
    const prevStrandIds = braid.strands.map(s => s.toString());
    const newStrandIds  = strandIds || prevStrandIds;
    const added = newStrandIds.filter(id => !prevStrandIds.includes(id));

    if (title)       braid.title       = title;
    if (description) braid.description = description;
    if (visibility)  braid.visibility  = visibility;
    if (accessCode !== undefined) braid.accessCode = accessCode;
    braid.strands = newStrandIds;
    await braid.save();

    // Silently notify subscribers if new strands were added
    if (added.length && braid.subscriberCount > 0) {
      const workspaces = await Workspace.find({ braids: braid._id }).select('user strands');
      for (const ws of workspaces) {
        // Auto-add new strands to subscriber workspaces
        const toAdd = added.filter(id => !ws.strands.map(s => s.toString()).includes(id));
        if (toAdd.length) {
          ws.strands.push(...toAdd);
          await ws.save();

          // Increment subscriber count for each newly-added strand,
          // but only if this user didn't already have it in another workspace
          for (const sid of toAdd) {
            const alreadyElsewhere = await Workspace.exists({
              user:    ws.user,
              _id:     { $ne: ws._id },
              strands: sid,
            });
            if (!alreadyElsewhere) {
              await Strand.findByIdAndUpdate(sid, { $inc: { subscriberCount: 1 } });
            }
          }
        }
      }
      const userIds = [...new Set(workspaces.map(w => w.user.toString()))];
      await Notification.insertMany(userIds.map(userId => ({
        user: userId,
        message: `${braid.title} has new strands`,
        strandTitle: braid.title,
        braidId: braid._id,
        type: 'braid_updated',
      })));
    }

    res.json({ braid });
  } catch (e) { next(e); }
});

// DELETE /api/braids/:id — remove from subscriber workspaces silently
router.delete('/:id', auth, async (req, res, next) => {
  try {
    const braid = await Braid.findOne({ _id: req.params.id, publisher: req.user._id });
    if (!braid) return res.status(404).json({ error: 'Braid not found' });
    await Workspace.updateMany({ braids: braid._id }, { $pull: { braids: braid._id } });
    await braid.deleteOne();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/braids/:id/analytics
router.get('/:id/analytics', auth, async (req, res, next) => {
  try {
    const braid = await Braid.findOne({ _id: req.params.id, publisher: req.user._id })
      .populate('strands', 'title subscriberCount');
    if (!braid) return res.status(404).json({ error: 'Not found' });
    res.json({
      title:           braid.title,
      subscriberCount: braid.subscriberCount,
      totalViews:      braid.viewCount,
      scanCount:       braid.scanCount || 0,
      strandCount:     braid.strands.length,
      topScanOrigins:  (braid.scanOrigins || []).slice(0, 5).map(o => ({
        label: o.label,
        count: o.count,
        pct:   braid.scanCount ? Math.round((o.count / braid.scanCount) * 100) : 0,
      })),
      strands: braid.strands.map(s => ({ title: s.title, subscribers: s.subscriberCount || 0 })),
    });
  } catch (e) { next(e); }
});

module.exports = router;

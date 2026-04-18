const express      = require('express');
const router       = express.Router();
const auth         = require('../middleware/auth');
const Workspace    = require('../models/Workspace');
const Strand       = require('../models/Strand');
const Braid        = require('../models/Braid');
const Notification = require('../models/Notification');

// ─────────────────────────────────────────────────────────────
// WORKSPACES
// ─────────────────────────────────────────────────────────────

// GET /api/user/workspaces
router.get('/workspaces', auth, async (req, res, next) => {
  try {
    const workspaces = await Workspace.find({ user: req.user._id }).sort({ createdAt: 1 });
    res.json({
      workspaces: workspaces.map(ws => ({
        _id:        ws._id,
        name:       ws.name,
        icon:       ws.icon,
        isActive:   ws.isActive,
        strandCount: ws.strands.length,
        braidCount:  ws.braids.length,
      })),
    });
  } catch (e) { next(e); }
});

// POST /api/user/workspaces — create workspace
router.post('/workspaces', auth, async (req, res, next) => {
  try {
    const { name, icon } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

    const count = await Workspace.countDocuments({ user: req.user._id });
    if (count >= 10) return res.status(400).json({ error: 'Maximum 10 workspaces' });

    const workspace = await Workspace.create({
      user:     req.user._id,
      name:     name.trim().slice(0, 50),
      icon:     icon || '🌅',
      isActive: count === 0, // first workspace is auto-active
    });

    res.status(201).json({
      workspace: {
        _id:         workspace._id,
        name:        workspace.name,
        icon:        workspace.icon,
        isActive:    workspace.isActive,
        strandCount: 0,
        braidCount:  0,
      },
    });
  } catch (e) { next(e); }
});

// POST /api/user/workspaces/:id/activate
router.post('/workspaces/:id/activate', auth, async (req, res, next) => {
  try {
    const workspace = await Workspace.findOne({ _id: req.params.id, user: req.user._id });
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    await Workspace.updateMany({ user: req.user._id }, { isActive: false });
    workspace.isActive = true;
    await workspace.save();

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/user/workspaces/:id
router.delete('/workspaces/:id', auth, async (req, res, next) => {
  try {
    const count = await Workspace.countDocuments({ user: req.user._id });
    if (count <= 1) return res.status(400).json({ error: 'You must keep at least one workspace' });

    const workspace = await Workspace.findOne({ _id: req.params.id, user: req.user._id });
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    // If deleted workspace was active, activate the next one
    if (workspace.isActive) {
      const next = await Workspace.findOne({ user: req.user._id, _id: { $ne: workspace._id } });
      if (next) { next.isActive = true; await next.save(); }
    }

    await workspace.deleteOne();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────
// SUBSCRIPTIONS
// ─────────────────────────────────────────────────────────────

// GET /api/user/subscriptions?workspaceId=xxx
router.get('/subscriptions', auth, async (req, res, next) => {
  try {
    const query = { user: req.user._id };
    if (req.query.workspaceId && req.query.workspaceId !== 'all') {
      query._id = req.query.workspaceId;
    }

    const workspaces = await Workspace.find(query);

    // Collect unique strand and braid IDs across all matching workspaces
    const strandIdSet = new Set();
    const braidIdSet  = new Set();
    for (const ws of workspaces) {
      ws.strands.forEach(id => strandIdSet.add(id.toString()));
      ws.braids.forEach(id  => braidIdSet.add(id.toString()));
    }

    // Get unread notification targets so we can mark items
    const unreadNotifs = await Notification.find({
      user: req.user._id,
      read: false,
    }).select('strandId braidId').lean();

    const unreadStrandIds = new Set(unreadNotifs.map(n => n.strandId?.toString()).filter(Boolean));
    const unreadBraidIds  = new Set(unreadNotifs.map(n => n.braidId?.toString()).filter(Boolean));

    // Fetch strands
    const strands = await Strand.find({
      _id:       { $in: [...strandIdSet] },
      published: true,
    }).select('title venue publisherHandle color subscriberCount').lean();

    // Fetch braids and include strandCount from populated strands array
    const braids = await Braid.find({
      _id:       { $in: [...braidIdSet] },
      published: true,
    }).select('title strands subscriberCount').lean();

    res.json({
      strands: strands.map(s => ({
        ...s,
        unread: unreadStrandIds.has(s._id.toString()),
      })),
      braids: braids.map(b => ({
        _id:         b._id,
        title:       b.title,
        subscriberCount: b.subscriberCount,
        strandCount: b.strands?.length || 0,
        unread:      unreadBraidIds.has(b._id.toString()),
      })),
    });
  } catch (e) { next(e); }
});

// POST /api/user/strands — subscribe to a strand
router.post('/strands', auth, async (req, res, next) => {
  try {
    const { strandId, workspaceId } = req.body;
    if (!strandId) return res.status(400).json({ error: 'strandId required' });

    // Verify strand exists and is published
    const strand = await Strand.findOne({ _id: strandId, published: true });
    if (!strand) return res.status(404).json({ error: 'Strand not found' });

    // Resolve target workspace — use supplied ID, active workspace, or first workspace
    let workspace;
    if (workspaceId) {
      workspace = await Workspace.findOne({ _id: workspaceId, user: req.user._id });
    }
    if (!workspace) {
      workspace = await Workspace.findOne({ user: req.user._id, isActive: true })
        || await Workspace.findOne({ user: req.user._id });
    }
    if (!workspace) return res.status(400).json({ error: 'No workspace found — create one first' });

    // Idempotent — skip if already subscribed
    const alreadyIn = workspace.strands.some(id => id.toString() === strandId);
    if (alreadyIn) return res.json({ ok: true, already: true });

    workspace.strands.push(strandId);
    await workspace.save();

    // Increment subscriber count on the strand
    await Strand.findByIdAndUpdate(strandId, { $inc: { subscriberCount: 1 } });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/user/strands/:strandId — unsubscribe from a strand
router.delete('/strands/:strandId', auth, async (req, res, next) => {
  try {
    const { strandId } = req.params;

    // Remove from every workspace the user owns
    const result = await Workspace.updateMany(
      { user: req.user._id, strands: strandId },
      { $pull: { strands: strandId } },
    );

    if (result.modifiedCount > 0) {
      await Strand.findByIdAndUpdate(strandId, { $inc: { subscriberCount: -1 } });
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/user/braids — subscribe to a braid (adds braid + all its strands)
router.post('/braids', auth, async (req, res, next) => {
  try {
    const { braidId, workspaceId } = req.body;
    if (!braidId) return res.status(400).json({ error: 'braidId required' });

    const braid = await Braid.findOne({ _id: braidId, published: true });
    if (!braid) return res.status(404).json({ error: 'Braid not found' });

    // Resolve workspace
    let workspace;
    if (workspaceId) {
      workspace = await Workspace.findOne({ _id: workspaceId, user: req.user._id });
    }
    if (!workspace) {
      workspace = await Workspace.findOne({ user: req.user._id, isActive: true })
        || await Workspace.findOne({ user: req.user._id });
    }
    if (!workspace) return res.status(400).json({ error: 'No workspace found — create one first' });

    // Add braid if not already subscribed
    const braidAlreadyIn = workspace.braids.some(id => id.toString() === braidId);
    if (!braidAlreadyIn) {
      workspace.braids.push(braidId);
      await Braid.findByIdAndUpdate(braidId, { $inc: { subscriberCount: 1 } });
    }

    // Also add all the braid's strands that aren't already in the workspace
    const existingStrandIds = new Set(workspace.strands.map(id => id.toString()));
    const strandsToAdd = braid.strands
      .map(id => id.toString())
      .filter(id => !existingStrandIds.has(id));

    if (strandsToAdd.length) {
      workspace.strands.push(...strandsToAdd);
      await Strand.updateMany(
        { _id: { $in: strandsToAdd } },
        { $inc: { subscriberCount: 1 } },
      );
    }

    await workspace.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/user/braids/:braidId — unsubscribe from a braid
router.delete('/braids/:braidId', auth, async (req, res, next) => {
  try {
    const { braidId } = req.params;

    const result = await Workspace.updateMany(
      { user: req.user._id, braids: braidId },
      { $pull: { braids: braidId } },
    );

    if (result.modifiedCount > 0) {
      await Braid.findByIdAndUpdate(braidId, { $inc: { subscriberCount: -1 } });
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────

// GET /api/user/notifications
router.get('/notifications', auth, async (req, res, next) => {
  try {
    const notifications = await Notification.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ notifications });
  } catch (e) { next(e); }
});

// POST /api/user/notifications/:id/read
router.post('/notifications/:id/read', auth, async (req, res, next) => {
  try {
    await Notification.updateOne(
      { _id: req.params.id, user: req.user._id },
      { read: true },
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/user/notifications/read-all
router.post('/notifications/read-all', auth, async (req, res, next) => {
  try {
    await Notification.updateMany({ user: req.user._id, read: false }, { read: true });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;

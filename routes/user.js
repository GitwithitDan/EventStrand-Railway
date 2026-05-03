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
        _id:         ws._id,
        name:        ws.name,
        icon:        ws.icon,
        isActive:    ws.isActive,
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
      isActive: count === 0,
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

// PATCH /api/user/workspaces/:id — rename or change icon
router.patch('/workspaces/:id', auth, async (req, res, next) => {
  try {
    const workspace = await Workspace.findOne({ _id: req.params.id, user: req.user._id });
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    const { name, icon } = req.body;
    if (name !== undefined) workspace.name = name.trim().slice(0, 50);
    if (icon !== undefined) workspace.icon = icon;
    await workspace.save();

    res.json({
      workspace: {
        _id:         workspace._id,
        name:        workspace.name,
        icon:        workspace.icon,
        isActive:    workspace.isActive,
        strandCount: workspace.strands.length,
        braidCount:  workspace.braids.length,
      },
    });
  } catch (e) { next(e); }
});

// DELETE /api/user/workspaces/:id
router.delete('/workspaces/:id', auth, async (req, res, next) => {
  try {
    const count = await Workspace.countDocuments({ user: req.user._id });
    if (count <= 1) return res.status(400).json({ error: 'You must keep at least one workspace' });

    const workspace = await Workspace.findOne({ _id: req.params.id, user: req.user._id });
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    if (workspace.isActive) {
      const replacement = await Workspace.findOne({ user: req.user._id, _id: { $ne: workspace._id } });
      if (replacement) { replacement.isActive = true; await replacement.save(); }
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

    const strandIdSet = new Set();
    const braidIdSet  = new Set();
    for (const ws of workspaces) {
      ws.strands.forEach(id => strandIdSet.add(id.toString()));
      ws.braids.forEach(id  => braidIdSet.add(id.toString()));
    }

    const unreadNotifs = await Notification.find({
      user: req.user._id,
      read: false,
    }).select('strandId braidId').lean();

    const unreadStrandIds = new Set(unreadNotifs.map(n => n.strandId?.toString()).filter(Boolean));
    const unreadBraidIds  = new Set(unreadNotifs.map(n => n.braidId?.toString()).filter(Boolean));

    const strands = await Strand.find({
      _id:       { $in: [...strandIdSet] },
      published: true,
    }).select('title venue publisherHandle color subscriberCount').lean();

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
        _id:             b._id,
        title:           b.title,
        subscriberCount: b.subscriberCount,
        strandCount:     b.strands?.length || 0,
        unread:          unreadBraidIds.has(b._id.toString()),
      })),
    });
  } catch (e) { next(e); }
});

// POST /api/user/strands — subscribe to a strand
router.post('/strands', auth, async (req, res, next) => {
  try {
    const { strandId, workspaceId } = req.body;
    if (!strandId) return res.status(400).json({ error: 'strandId required' });

    const strand = await Strand.findOne({ _id: strandId, published: true });
    if (!strand) return res.status(404).json({ error: 'Strand not found' });

    // Resolve target workspace
    let workspace;
    if (workspaceId) {
      workspace = await Workspace.findOne({ _id: workspaceId, user: req.user._id });
    }
    if (!workspace) {
      workspace = await Workspace.findOne({ user: req.user._id, isActive: true })
        || await Workspace.findOne({ user: req.user._id });
    }
    if (!workspace) return res.status(400).json({ error: 'No workspace found — create one first' });

    // Check if already in this specific workspace — skip silently if so
    const alreadyInWorkspace = workspace.strands.some(id => id.toString() === strandId);
    if (alreadyInWorkspace) return res.json({ ok: true, already: true });

    // Check if the user already has this strand in ANY other workspace —
    // if so, add to this workspace but don't double-count the subscriber
    const alreadyForUser = await Workspace.exists({
      user:    req.user._id,
      strands: strandId,
    });

    workspace.strands.push(strandId);
    await workspace.save();

    if (!alreadyForUser) {
      await Strand.findByIdAndUpdate(strandId, { $inc: { subscriberCount: 1 } });
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/user/strands/:strandId — unsubscribe from a strand
router.delete('/strands/:strandId', auth, async (req, res, next) => {
  try {
    const { strandId } = req.params;

    // Remove from every workspace the user owns
    await Workspace.updateMany(
      { user: req.user._id, strands: strandId },
      { $pull: { strands: strandId } },
    );

    // Only decrement if it's no longer in any of their workspaces
    const stillSubscribed = await Workspace.exists({
      user:    req.user._id,
      strands: strandId,
    });
    if (!stillSubscribed) {
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

    // Add braid if not already in this workspace
    const braidAlreadyInWorkspace = workspace.braids.some(id => id.toString() === braidId);
    if (!braidAlreadyInWorkspace) {
      // Only increment subscriber count if user doesn't already have it in another workspace
      const braidAlreadyForUser = await Workspace.exists({
        user:   req.user._id,
        braids: braidId,
      });
      workspace.braids.push(braidId);
      if (!braidAlreadyForUser) {
        await Braid.findByIdAndUpdate(braidId, { $inc: { subscriberCount: 1 } });
      }
    }

    // Fan out: add the braid's strands that aren't already in this workspace
    const existingStrandIds = new Set(workspace.strands.map(id => id.toString()));
    const strandsToAdd = braid.strands
      .map(id => id.toString())
      .filter(id => !existingStrandIds.has(id));

    if (strandsToAdd.length) {
      workspace.strands.push(...strandsToAdd);

      // For each strand being added, only increment count if not already
      // subscribed via another workspace
      for (const sid of strandsToAdd) {
        const alreadyForUser = await Workspace.exists({ user: req.user._id, strands: sid });
        if (!alreadyForUser) {
          await Strand.findByIdAndUpdate(sid, { $inc: { subscriberCount: 1 } });
        }
      }
    }

    await workspace.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/user/braids/:braidId — unsubscribe from a braid
router.delete('/braids/:braidId', auth, async (req, res, next) => {
  try {
    const { braidId } = req.params;

    await Workspace.updateMany(
      { user: req.user._id, braids: braidId },
      { $pull: { braids: braidId } },
    );

    // Only decrement if no longer in any workspace
    const stillSubscribed = await Workspace.exists({
      user:   req.user._id,
      braids: braidId,
    });
    if (!stillSubscribed) {
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

const express      = require('express');
const router       = express.Router();
const auth         = require('../middleware/auth');
const Workspace    = require('../models/Workspace');
const Strand       = require('../models/Strand');
const Braid        = require('../models/Braid');
const Notification = require('../models/Notification');

// ── SUBSCRIPTIONS ─────────────────────────────────────────────

// GET /api/user/subscriptions?workspaceId=xxx
// Returns all subscribed strands + braids for a workspace (or all)
router.get('/subscriptions', auth, async (req, res, next) => {
  try {
    const query = { user: req.user._id };
    if (req.query.workspaceId && req.query.workspaceId !== 'all') {
      query._id = req.query.workspaceId;
    }

    const workspaces = await Workspace.find(query)
      .populate({
        path: 'strands',
        select: 'title venue publisherHandle color subscriberCount events published',
        match: { published: true },
      })
      .populate({
        path: 'braids',
        select: 'title description publisherHandle subscriberCount published',
        match: { published: true },
      });

    // Merge strands/braids across workspaces, dedup by id
    const seenStrands = new Set();
    const seenBraids  = new Set();
    const strands = [];
    const braids  = [];

    for (const ws of workspaces) {
      for (const s of ws.strands || []) {
        if (!s || seenStrands.has(s._id.toString())) continue;
        seenStrands.add(s._id.toString());
        strands.push(s);
      }
      for (const b of ws.braids || []) {
        if (!b || seenBraids.has(b._id.toString())) continue;
        seenBraids.add(b._id.toString());
        braids.push(b);
      }
    }

    res.json({ strands, braids });
  } catch (e) { next(e); }
});

// POST /api/user/strands — subscribe to a strand
// Body: { strandId, workspaceId? }
router.post('/strands', auth, async (req, res, next) => {
  try {
    const { strandId, workspaceId } = req.body;
    if (!strandId) return res.status(400).json({ error: 'strandId required' });

    const strand = await Strand.findOne({ _id: strandId, published: true });
    if (!strand) return res.status(404).json({ error: 'Strand not found or not published' });

    // Find or create target workspace
    let ws;
    if (workspaceId) {
      ws = await Workspace.findOne({ _id: workspaceId, user: req.user._id });
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    } else {
      ws = await Workspace.findOne({ user: req.user._id, isActive: true })
        || await Workspace.findOne({ user: req.user._id });
      if (!ws) {
        ws = await Workspace.create({ user: req.user._id, name: 'My Strands', icon: '🌅', isActive: true });
      }
    }

    // Add strand if not already there
    const alreadyIn = ws.strands.some(id => id.toString() === strandId);
    if (!alreadyIn) {
      ws.strands.push(strandId);
      await ws.save();
      // Increment subscriber count (async)
      Strand.findByIdAndUpdate(strandId, { $inc: { subscriberCount: 1 } }).catch(() => {});
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/user/strands/:strandId — unsubscribe from a strand (removes from all workspaces)
router.delete('/strands/:strandId', auth, async (req, res, next) => {
  try {
    const { strandId } = req.params;
    const result = await Workspace.updateMany(
      { user: req.user._id, strands: strandId },
      { $pull: { strands: strandId } }
    );
    if (result.modifiedCount > 0) {
      Strand.findByIdAndUpdate(strandId, { $inc: { subscriberCount: -1 } }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/user/braids — subscribe to a braid
// Body: { braidId, workspaceId? }
router.post('/braids', auth, async (req, res, next) => {
  try {
    const { braidId, workspaceId } = req.body;
    if (!braidId) return res.status(400).json({ error: 'braidId required' });

    const braid = await Braid.findOne({ _id: braidId, published: true }).populate('strands', '_id');
    if (!braid) return res.status(404).json({ error: 'Braid not found or not published' });

    let ws;
    if (workspaceId) {
      ws = await Workspace.findOne({ _id: workspaceId, user: req.user._id });
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    } else {
      ws = await Workspace.findOne({ user: req.user._id, isActive: true })
        || await Workspace.findOne({ user: req.user._id });
      if (!ws) {
        ws = await Workspace.create({ user: req.user._id, name: 'My Strands', icon: '🌅', isActive: true });
      }
    }

    const alreadyIn = ws.braids.some(id => id.toString() === braidId);
    if (!alreadyIn) {
      ws.braids.push(braidId);
      // Also add each constituent strand (deduped)
      for (const s of braid.strands || []) {
        const sid = s._id ? s._id.toString() : s.toString();
        if (!ws.strands.some(id => id.toString() === sid)) {
          ws.strands.push(sid);
        }
      }
      await ws.save();
      Braid.findByIdAndUpdate(braidId, { $inc: { subscriberCount: 1 } }).catch(() => {});
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/user/braids/:braidId — unsubscribe from a braid
router.delete('/braids/:braidId', auth, async (req, res, next) => {
  try {
    const { braidId } = req.params;
    const result = await Workspace.updateMany(
      { user: req.user._id, braids: braidId },
      { $pull: { braids: braidId } }
    );
    if (result.modifiedCount > 0) {
      Braid.findByIdAndUpdate(braidId, { $inc: { subscriberCount: -1 } }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── WORKSPACES ────────────────────────────────────────────────

// GET /api/user/workspaces
router.get('/workspaces', auth, async (req, res, next) => {
  try {
    const workspaces = await Workspace.find({ user: req.user._id })
      .populate('strands', 'title venue color publisherHandle')
      .populate('braids', 'title description')
      .sort({ isActive: -1, createdAt: 1 });

    // If no workspaces, create a default one
    if (!workspaces.length) {
      const ws = await Workspace.create({
        user: req.user._id,
        name: 'My Strands',
        icon: '🌅',
        isActive: true,
      });
      return res.json({ workspaces: [ws] });
    }

    res.json({ workspaces });
  } catch (e) { next(e); }
});

// POST /api/user/workspaces — create a new workspace
router.post('/workspaces', auth, async (req, res, next) => {
  try {
    const { name, icon } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

    const count = await Workspace.countDocuments({ user: req.user._id });
    if (count >= 10) return res.status(400).json({ error: 'Maximum 10 workspaces allowed' });

    const ws = await Workspace.create({
      user: req.user._id,
      name: name.trim().slice(0, 40),
      icon: icon || '🌅',
      isActive: false,
    });

    res.json({ workspace: ws });
  } catch (e) { next(e); }
});

// POST /api/user/workspaces/:id/activate — set as active workspace
router.post('/workspaces/:id/activate', auth, async (req, res, next) => {
  try {
    const ws = await Workspace.findOne({ _id: req.params.id, user: req.user._id });
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });

    // Deactivate all others, activate this one
    await Workspace.updateMany({ user: req.user._id }, { isActive: false });
    ws.isActive = true;
    await ws.save();

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/user/workspaces/:id — delete workspace
router.delete('/workspaces/:id', auth, async (req, res, next) => {
  try {
    const ws = await Workspace.findOne({ _id: req.params.id, user: req.user._id });
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });

    // Prevent deleting the last workspace
    const count = await Workspace.countDocuments({ user: req.user._id });
    if (count <= 1) return res.status(400).json({ error: 'Cannot delete your only workspace' });

    await ws.deleteOne();

    // If it was active, activate another
    if (ws.isActive) {
      const next = await Workspace.findOne({ user: req.user._id });
      if (next) { next.isActive = true; await next.save(); }
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── NOTIFICATIONS ─────────────────────────────────────────────

// GET /api/user/notifications
router.get('/notifications', auth, async (req, res, next) => {
  try {
    const notifications = await Notification.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50);
    const unreadCount = notifications.filter(n => !n.read).length;
    res.json({ notifications, unreadCount });
  } catch (e) { next(e); }
});

// POST /api/user/notifications/:id/read
router.post('/notifications/:id/read', auth, async (req, res, next) => {
  try {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { read: true }
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

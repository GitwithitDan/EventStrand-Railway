const express = require('express');
const router  = express.Router();
const Strand  = require('../models/Strand');

// GET /api/library/strands
// Public — no auth required.
// Returns EventStrand-curated strands (publisherHandle === 'library').
// Optional ?category= filter matches libraryCategory field.
router.get('/strands', async (req, res, next) => {
  try {
    const { category } = req.query;
    const query = {
      publisherHandle: 'library',
      published: true,
      visibility: 'public',
    };
    if (category && category !== 'all') query.libraryCategory = category;

    const strands = await Strand.find(query)
      .select('_id title description color events subscriberCount libraryCategory venue')
      .sort({ libraryCategory: 1, subscriberCount: -1 });

    res.json({ strands });
  } catch (e) { next(e); }
});

module.exports = router;

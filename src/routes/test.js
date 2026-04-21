const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// POST /api/test/send-like
// Body : { liker_firebase_uid, liked_firebase_uid }
// Simule un like venant de liker vers liked, émet l'event Socket new_like
router.post('/send-like', async (req, res) => {
  try {
    const { liker_firebase_uid, liked_firebase_uid } = req.body;

    const { rows } = await pool.query(
      `SELECT id, firebase_uid, name FROM users WHERE firebase_uid IN ($1, $2)`,
      [liker_firebase_uid, liked_firebase_uid]
    );
    const liker = rows.find(u => u.firebase_uid === liker_firebase_uid);
    const liked = rows.find(u => u.firebase_uid === liked_firebase_uid);
    if (!liker || !liked) {
      return res.status(404).json({ error: 'users not found' });
    }

    const ins = await pool.query(
      `INSERT INTO likes (liker_id, liked_id, created_at)
       VALUES ($1, $2, NOW())
       RETURNING id`,
      [liker.id, liked.id]
    );
    const likeId = ins.rows[0].id;

    const reciprocal = await pool.query(
      `SELECT 1 FROM likes WHERE liker_id = $1 AND liked_id = $2`,
      [liked.id, liker.id]
    );

    const io = req.app.get('io');
    if (io) {
      if (reciprocal.rowCount === 0) {
        io.to(`user:${liked.id}`).emit('new_like', {
          liker_id:   liker.id,
          liker_name: liker.name,
        });
      } else {
        const u1 = liker.id < liked.id ? liker.id : liked.id;
        const u2 = liker.id < liked.id ? liked.id : liker.id;
        const matchIns = await pool.query(
          `INSERT INTO matches (user1_id, user2_id, is_active, created_at)
           VALUES ($1, $2, TRUE, NOW())
           RETURNING id`,
          [u1, u2]
        );
        const matchId = matchIns.rows[0].id;
        io.to(`user:${liker.id}`).emit('new_match', {
          match_id: matchId, other_id: liked.id, other_name: liked.name,
        });
        io.to(`user:${liked.id}`).emit('new_match', {
          match_id: matchId, other_id: liker.id, other_name: liker.name,
        });
      }
    }

    res.status(201).json({ like_id: likeId, reciprocal: reciprocal.rowCount > 0 });
  } catch (err) {
    console.error('[TEST] send-like error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

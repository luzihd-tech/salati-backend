const express = require('express');
const { supabase } = require('../db/database');
const { adminMiddleware } = require('../middleware/auth');

const router = express.Router();

router.get('/stats', adminMiddleware, async (req, res) => {
  try {
    const [{ count: placesCount }, { count: usersCount }, { count: ratingsCount }] = await Promise.all([
      supabase.from('places').select('*', { count: 'exact', head: true }),
      supabase.from('users').select('*', { count: 'exact', head: true }),
      supabase.from('ratings').select('*', { count: 'exact', head: true })
    ]);
    res.json({ places: placesCount, users: usersCount, likes: ratingsCount });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/users', adminMiddleware, async (req, res) => {
  try {
    const { data: users } = await supabase.from('users').select('id, name, email, role, is_subscribed, created_at').order('created_at', { ascending: false });
    res.json({ users });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.put('/places/:id/verify', adminMiddleware, async (req, res) => {
  try {
    const { data: place } = await supabase.from('places').update({ verified: true }).eq('id', req.params.id).select().single();
    res.json(place);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

module.exports = router;

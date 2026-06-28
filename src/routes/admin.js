const express = require('express');
const { supabase } = require('../db/database');
const { adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// Toutes les routes admin sont protégées
router.use(adminMiddleware);

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  try {
    const { data: places, error: placesError } = await supabase.from('places').select('*');
    if (placesError) throw placesError;

    const { data: users, error: usersError } = await supabase.from('users').select('id, role');
    if (usersError) throw usersError;

    const { count: ratingsCount, error: ratingsError } = await supabase
      .from('ratings')
      .select('*', { count: 'exact', head: true });
    if (ratingsError) throw ratingsError;

    const recentPlaces = [...places]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5);

    res.json({
      totalPlaces: places.length,
      totalUsers: users.filter(u => u.role !== 'admin').length,
      totalRatings: ratingsCount || 0,
      verifiedPlaces: places.filter(p => p.verified).length,
      byType: {
        mosque: places.filter(p => p.type === 'mosque').length,
        shop: places.filter(p => p.type === 'shop').length,
        restaurant: places.filter(p => p.type === 'restaurant').length,
        other: places.filter(p => p.type === 'other').length,
      },
      recentPlaces
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/admin/users - Liste des utilisateurs
router.get('/users', async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, name, email, role, favorites, is_subscribed, created_at');

    if (error) throw error;
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/admin/users/:id - Supprimer un utilisateur
router.delete('/users/:id', async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('role').eq('id', req.params.id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (user.role === 'admin') return res.status(403).json({ error: 'Impossible de supprimer l\'admin' });

    const { error } = await supabase.from('users').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/admin/places/:id/verify - Vérifier/dévérifier un lieu
router.put('/places/:id/verify', async (req, res) => {
  try {
    const { data: place } = await supabase.from('places').select('verified').eq('id', req.params.id).maybeSingle();
    if (!place) return res.status(404).json({ error: 'Lieu introuvable' });

    const { data: updated, error } = await supabase
      .from('places')
      .update({ verified: !place.verified })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ verified: updated.verified });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;

const express = require('express');
const { supabase } = require('../db/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

function distKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// GET /api/places
router.get('/', async (req, res) => {
  try {
    let { type, ablution, genre, lat, lng, radius, city, q, page=1, limit=200 } = req.query;
    let query = supabase.from('places').select('*');
    if (type && type !== 'all') query = query.eq('type', type);
    if (ablution === 'true') query = query.eq('ablution', true);
    if (city) query = query.ilike('city', `%${city}%`);
    if (q) query = query.or(`name.ilike.%${q}%,address.ilike.%${q}%,description.ilike.%${q}%`);

    const { data, error } = await query;
    if (error) throw error;

    let places = data || [];
    if (lat && lng) {
      const uLat = parseFloat(lat), uLng = parseFloat(lng), maxR = parseFloat(radius)||50;
      places = places.map(p=>({...p, dist: distKm(uLat, uLng, p.lat, p.lng)}))
        .filter(p=>p.dist<=maxR).sort((a,b)=>a.dist-b.dist);
    }
    res.json({ places, total: places.length });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// GET /api/places/:id
router.get('/:id', async (req, res) => {
  try {
    const { data: place } = await supabase.from('places').select('*').eq('id', req.params.id).maybeSingle();
    if (!place) return res.status(404).json({ error: 'Lieu introuvable' });
    res.json(place);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// POST /api/places (admin)
router.post('/', adminMiddleware, async (req, res) => {
  try {
    const { name, type, address, city, lat, lng, ablution, wc, genre, description, emoji, openingHours, mawaqitId } = req.body;
    if (!name || !type || !address || !lat || !lng) return res.status(400).json({ error: 'Champs obligatoires manquants' });

    const { data: place, error } = await supabase.from('places').insert({
      name, type, address, city: city||'', lat: parseFloat(lat), lng: parseFloat(lng),
      ablution: ablution==='true'||ablution===true, wc: wc==='true'||wc===true,
      genre: genre||'mixte', description: description||'',
      emoji: emoji||(type==='mosque'?'🕌':type==='shop'?'🏪':type==='restaurant'?'🍽️':'📍'),
      rating: 0, rating_count: 0, verified: true,
      mawaqit_id: mawaqitId||null, opening_hours: openingHours||'',
      created_by: req.user.id
    }).select().single();
    if (error) throw error;
    res.status(201).json(place);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// PUT /api/places/:id (admin)
router.put('/:id', adminMiddleware, async (req, res) => {
  try {
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    if (updates.ablution !== undefined) updates.ablution = updates.ablution==='true'||updates.ablution===true;
    if (updates.wc !== undefined) updates.wc = updates.wc==='true'||updates.wc===true;
    if (updates.lat) updates.lat = parseFloat(updates.lat);
    if (updates.lng) updates.lng = parseFloat(updates.lng);
    if (updates.openingHours !== undefined) { updates.opening_hours = updates.openingHours; delete updates.openingHours; }

    const { data: place, error } = await supabase.from('places').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(place);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// DELETE /api/places/:id (admin)
router.delete('/:id', adminMiddleware, async (req, res) => {
  try {
    const { error } = await supabase.from('places').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// POST /api/places/:id/like — Pouce bleu (toggle)
router.post('/:id/like', authMiddleware, async (req, res) => {
  try {
    const placeId = req.params.id;

    const { data: place } = await supabase.from('places').select('id').eq('id', placeId).maybeSingle();
    if (!place) return res.status(404).json({ error: 'Lieu introuvable' });

    const { data: existing } = await supabase.from('ratings')
      .select('id').eq('place_id', placeId).eq('user_id', req.user.id).maybeSingle();

    let liked;
    if (existing) {
      await supabase.from('ratings').delete().eq('id', existing.id);
      liked = false;
    } else {
      await supabase.from('ratings').insert({ place_id: placeId, user_id: req.user.id, rating: 1 });
      liked = true;
    }

    const { count } = await supabase.from('ratings').select('*', { count: 'exact', head: true }).eq('place_id', placeId);
    const { data: updated } = await supabase.from('places').update({ rating_count: count }).eq('id', placeId).select().single();

    res.json({ liked, likeCount: updated.rating_count });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// POST /api/places/:id/favorite
router.post('/:id/favorite', authMiddleware, async (req, res) => {
  try {
    const placeId = req.params.id;
    const { data: user } = await supabase.from('users').select('favorites').eq('id', req.user.id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const favs = user.favorites || [];
    const isFav = favs.includes(placeId);
    const newFavs = isFav ? favs.filter(id=>id!==placeId) : [...favs, placeId];

    await supabase.from('users').update({ favorites: newFavs }).eq('id', req.user.id);
    res.json({ favorited: !isFav, favorites: newFavs });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

module.exports = router;

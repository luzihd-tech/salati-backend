const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { supabase } = require('../db/database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// Config upload photos (stockage local du serveur — voir README pour migration vers Supabase Storage)
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `place_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Seules les images sont acceptées'));
  }
});

function distKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// GET /api/places - Liste avec filtres & géoloc
router.get('/', async (req, res) => {
  try {
    let { type, ablution, genre, lat, lng, radius, city, q, page = 1, limit = 50 } = req.query;

    let query = supabase.from('places').select('*');

    if (type && type !== 'all') query = query.eq('type', type);
    if (ablution === 'true') query = query.eq('ablution', true);
    if (genre && genre !== 'all') query = query.or(`genre.eq.${genre},genre.eq.mixte`);
    if (city) query = query.ilike('city', `%${city}%`);
    if (q) query = query.or(`name.ilike.%${q}%,address.ilike.%${q}%,description.ilike.%${q}%`);

    const { data, error } = await query;
    if (error) throw error;

    let places = data || [];

    if (lat && lng) {
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);
      const maxRadius = parseFloat(radius) || 20;
      places = places
        .map(p => ({ ...p, dist: distKm(userLat, userLng, p.lat, p.lng) }))
        .filter(p => p.dist <= maxRadius)
        .sort((a, b) => a.dist - b.dist);
    }

    const total = places.length;
    const start = (parseInt(page) - 1) * parseInt(limit);
    const paginated = places.slice(start, start + parseInt(limit));

    res.json({ places: paginated, total, page: parseInt(page) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/places/:id - Détail d'un lieu
router.get('/:id', async (req, res) => {
  try {
    const { data: place, error } = await supabase
      .from('places')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) throw error;
    if (!place) return res.status(404).json({ error: 'Lieu introuvable' });
    res.json(place);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/places - Créer un lieu (admin uniquement)
router.post('/', adminMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { name, type, address, city, lat, lng, ablution, wc, genre, description, emoji, openingHours, mawaqitId } = req.body;

    if (!name || !type || !address || !lat || !lng) {
      return res.status(400).json({ error: 'Champs obligatoires : name, type, address, lat, lng' });
    }

    const newPlace = {
      name,
      type,
      address,
      city: city || '',
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      ablution: ablution === 'true' || ablution === true,
      wc: wc === 'true' || wc === true,
      genre: genre || 'mixte',
      description: description || '',
      photo: req.file ? `/uploads/${req.file.filename}` : null,
      emoji: emoji || (type === 'mosque' ? '🕌' : type === 'shop' ? '🏪' : type === 'restaurant' ? '🍽️' : '📍'),
      rating: 0,
      rating_count: 0,
      verified: true,
      mawaqit_id: mawaqitId || null,
      opening_hours: openingHours || '',
      created_by: req.user.id
    };

    const { data: place, error } = await supabase
      .from('places')
      .insert(newPlace)
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(place);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/places/:id - Modifier un lieu (admin uniquement)
router.put('/:id', adminMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.ablution !== undefined) updates.ablution = updates.ablution === 'true' || updates.ablution === true;
    if (updates.wc !== undefined) updates.wc = updates.wc === 'true' || updates.wc === true;
    if (updates.lat) updates.lat = parseFloat(updates.lat);
    if (updates.lng) updates.lng = parseFloat(updates.lng);
    if (updates.openingHours !== undefined) { updates.opening_hours = updates.openingHours; delete updates.openingHours; }
    if (updates.mawaqitId !== undefined) { updates.mawaqit_id = updates.mawaqitId; delete updates.mawaqitId; }
    if (req.file) updates.photo = `/uploads/${req.file.filename}`;
    updates.updated_at = new Date().toISOString();

    const { data: place, error } = await supabase
      .from('places')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    if (!place) return res.status(404).json({ error: 'Lieu introuvable' });
    res.json(place);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/places/:id - Supprimer un lieu (admin uniquement)
router.delete('/:id', adminMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('places')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/places/:id/rate - Noter un lieu (utilisateur connecté)
router.post('/:id/rate', authMiddleware, async (req, res) => {
  try {
    const { rating } = req.body;
    const placeId = req.params.id;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Note entre 1 et 5 requise' });
    }

    const { data: place } = await supabase.from('places').select('id').eq('id', placeId).maybeSingle();
    if (!place) return res.status(404).json({ error: 'Lieu introuvable' });

    // Upsert : crée ou met à jour la note de cet utilisateur pour ce lieu
    const { error: upsertError } = await supabase
      .from('ratings')
      .upsert({ place_id: placeId, user_id: req.user.id, rating: parseInt(rating) }, { onConflict: 'place_id,user_id' });

    if (upsertError) throw upsertError;

    // Recalcule la moyenne
    const { data: allRatings, error: ratingsError } = await supabase
      .from('ratings')
      .select('rating')
      .eq('place_id', placeId);

    if (ratingsError) throw ratingsError;

    const avg = Math.round((allRatings.reduce((s, r) => s + r.rating, 0) / allRatings.length) * 10) / 10;

    const { data: updated, error: updateError } = await supabase
      .from('places')
      .update({ rating: avg, rating_count: allRatings.length })
      .eq('id', placeId)
      .select()
      .single();

    if (updateError) throw updateError;
    res.json({ rating: updated.rating, ratingCount: updated.rating_count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/places/:id/favorite - Ajouter/retirer des favoris
router.post('/:id/favorite', authMiddleware, async (req, res) => {
  try {
    const placeId = req.params.id;

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('favorites')
      .eq('id', req.user.id)
      .maybeSingle();

    if (userError) throw userError;
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const favs = user.favorites || [];
    const isFav = favs.includes(placeId);
    const newFavs = isFav ? favs.filter(id => id !== placeId) : [...favs, placeId];

    const { error: updateError } = await supabase
      .from('users')
      .update({ favorites: newFavs })
      .eq('id', req.user.id);

    if (updateError) throw updateError;
    res.json({ favorited: !isFav, favorites: newFavs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;

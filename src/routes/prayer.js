const express = require('express');
const fetch = require('node-fetch');
const { authMiddleware } = require('../middleware/auth');
const { supabase } = require('../db/database');

const router = express.Router();

// GET /api/prayer/times?lat=&lng=&date= - Horaires via aladhan.com
router.get('/times', async (req, res) => {
  try {
    const { lat = 48.8566, lng = 2.3522, date } = req.query;
    const today = date || (() => {
      const d = new Date();
      return `${d.getDate()}-${d.getMonth()+1}-${d.getFullYear()}`;
    })();

    // Méthode 12 = Union des Organisations Islamiques de France (UOIF)
    const url = `https://api.aladhan.com/v1/timings/${today}?latitude=${lat}&longitude=${lng}&method=12&school=1`;
    const resp = await fetch(url, { timeout: 5000 });
    const data = await resp.json();

    if (data.code !== 200) throw new Error('API aladhan indisponible');

    const t = data.data.timings;
    const prayers = {
      Fajr: t.Fajr,
      Chourouk: t.Sunrise,
      Dhohr: t.Dhuhr,
      Asr: t.Asr,
      Maghrib: t.Maghrib,
      Icha: t.Isha
    };

    const hijri = data.data.date.hijri;

    res.json({
      prayers,
      date: data.data.date.gregorian.date,
      hijriDate: `${hijri.day} ${hijri.month.fr || hijri.month.en} ${hijri.year}`,
      location: { lat: parseFloat(lat), lng: parseFloat(lng) }
    });
  } catch (err) {
    // Fallback horaires approximatifs si API down
    res.json({
      prayers: { Fajr: '05:30', Chourouk: '07:00', Dhohr: '13:00', Asr: '16:30', Maghrib: '20:00', Icha: '21:30' },
      date: new Date().toLocaleDateString('fr-FR'),
      fallback: true,
      error: 'Horaires approximatifs (API indisponible)'
    });
  }
});

// GET /api/prayer/mawaqit/:mosqueId - Horaires depuis Mawaqit
router.get('/mawaqit/:mosqueId', async (req, res) => {
  try {
    const { mosqueId } = req.params;
    const url = `https://mawaqit.net/api/2.0/mosque/${mosqueId}/prayer-times`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      timeout: 5000
    });
    if (!resp.ok) throw new Error('Mosquée Mawaqit introuvable');
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: 'Impossible de récupérer les horaires Mawaqit', detail: err.message });
  }
});

// GET /api/prayer/mawaqit-search?q=&lat=&lng= - Chercher une mosquée sur Mawaqit
router.get('/mawaqit-search', async (req, res) => {
  try {
    const { q, lat, lng } = req.query;
    let url = 'https://mawaqit.net/api/2.0/mosque/search?';
    if (q) url += `word=${encodeURIComponent(q)}&`;
    if (lat && lng) url += `lat=${lat}&lng=${lng}&`;

    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      timeout: 5000
    });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la recherche Mawaqit' });
  }
});

// POST /api/prayer/favorite-mosque - Définir mosquée favorite (avec horaires Mawaqit)
router.post('/favorite-mosque', authMiddleware, async (req, res) => {
  try {
    const { mawaqitId, mosqueName } = req.body;

    const { data: updated, error } = await supabase
      .from('users')
      .update({ favorite_mosque_id: mawaqitId, favorite_mosque_name: mosqueName })
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, favoriteMosque: { mawaqitId: updated.favorite_mosque_id, mosqueName: updated.favorite_mosque_name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;

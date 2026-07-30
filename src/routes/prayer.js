const express = require('express');
const fetch = require('node-fetch');

const router = express.Router();

router.get('/times', async (req, res) => {
  try {
    const { lat = 48.8566, lng = 2.3522 } = req.query;
    const d = new Date();
    const date = `${d.getDate()}-${d.getMonth()+1}-${d.getFullYear()}`;
    const r = await fetch(`https://api.aladhan.com/v1/timings/${date}?latitude=${lat}&longitude=${lng}&method=12`);
    const data = await r.json();
    if (data.code !== 200) throw new Error('API error');
    const t = data.data.timings;
    res.json({ prayers: { Fajr:t.Fajr, Chourouk:t.Sunrise, Dhohr:t.Dhuhr, Asr:t.Asr, Maghrib:t.Maghrib, Icha:t.Isha } });
  } catch (err) {
    res.status(500).json({ error: 'Horaires indisponibles' });
  }
});

module.exports = router;

const express = require('express');
const https = require('https');
const http = require('http');

const router = express.Router();

// Helper : fetch HTTP/HTTPS en Node sans dépendance externe
function nodeFetch(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'PrayerSpot/1.0' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, status: res.statusCode, json: () => JSON.parse(data) }); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function parseMawaqitTimes(data) {
  const times = data.times || data.calendar?.[0] || null;
  if (!times || !times.length) return null;
  const today = new Date().getDate() - 1;
  const todayTimes = Array.isArray(times[0]) ? times[today] : times;
  if (!todayTimes || todayTimes.length < 5) return null;
  return {
    Fajr:     todayTimes[0],
    Chourouk: todayTimes[1],
    Dhohr:    todayTimes[2],
    Asr:      todayTimes[3],
    Maghrib:  todayTimes[4],
    Icha:     todayTimes[5] || todayTimes[4]
  };
}

// GET /api/prayer-times?mawaqit_id=xxx   — horaires par ID mosquée Mawaqit
// GET /api/prayer-times?lat=xx&lng=xx    — horaires par géoloc (mosquée la plus proche)
router.get('/', async (req, res) => {
  const { mawaqit_id, lat, lng } = req.query;

  // 1. Par mawaqit_id
  if (mawaqit_id) {
    try {
      const r = await nodeFetch(`https://mawaqit.net/api/2.0/mosque/${mawaqit_id}/prayer-times`);
      if (r.ok) {
        const times = parseMawaqitTimes(r.json());
        if (times) return res.json({ source: 'mawaqit_id', times });
      }
    } catch(e) { console.error('Mawaqit ID error:', e.message); }
  }

  // 2. Par géoloc Mawaqit
  if (lat && lng) {
    try {
      const r = await nodeFetch(`https://mawaqit.net/api/2.0/mosque/nearests?lat=${lat}&lon=${lng}&language=fr`);
      if (r.ok) {
        const mosques = r.json();
        if (mosques && mosques.length && mosques[0].uuid) {
          const r2 = await nodeFetch(`https://mawaqit.net/api/2.0/mosque/${mosques[0].uuid}/prayer-times`);
          if (r2.ok) {
            const times = parseMawaqitTimes(r2.json());
            if (times) return res.json({ source: 'mawaqit_geo', times });
          }
        }
      }
    } catch(e) { console.error('Mawaqit geo error:', e.message); }

    // 3. Fallback Aladhan
    try {
      const d = new Date();
      const date = `${d.getDate()}-${d.getMonth()+1}-${d.getFullYear()}`;
      const r = await nodeFetch(`https://api.aladhan.com/v1/timings/${date}?latitude=${lat}&longitude=${lng}&method=3`);
      if (r.ok) {
        const data = r.json();
        if (data.code === 200) {
          const t = data.data.timings;
          return res.json({ source: 'aladhan', times: {
            Fajr: t.Fajr, Chourouk: t.Sunrise, Dhohr: t.Dhuhr,
            Asr: t.Asr, Maghrib: t.Maghrib, Icha: t.Isha
          }});
        }
      }
    } catch(e) { console.error('Aladhan error:', e.message); }
  }

  res.status(503).json({ error: 'Horaires indisponibles' });
});

module.exports = router;

const express = require('express');
const https = require('https');
const http = require('http');

const router = express.Router();

// Helper : fetch HTTP/HTTPS en Node sans dépendance externe
function nodeFetch(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'Accept': 'application/json, text/plain, */*', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Accept-Language': 'fr-FR,fr;q=0.9', 'Referer': 'https://mawaqit.net/' }
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

// Date du jour demandée par l'app (JJ-MM-AAAA, heure du téléphone),
// sinon la date à Paris — le serveur est en heure UTC et se tromperait de jour après minuit
function requestedDate(q) {
  if (typeof q === 'string' && /^\d{1,2}-\d{1,2}-\d{4}$/.test(q)) {
    const [d, m, y] = q.split('-').map(Number);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) return { d, m, y };
  }
  const parts = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(new Date());
  const get = t => +parts.find(p => p.type === t).value;
  return { d: get('day'), m: get('month'), y: get('year') };
}

function parseMawaqitTimes(data, day) {
  const times = data.times || data.calendar?.[0] || null;
  if (!times || !times.length) return null;
  const todayTimes = Array.isArray(times[0]) ? times[day - 1] : times;
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

// Petit cache (6 h) : même zone (~1 km) + même jour = mêmes horaires
const cache = new Map();
const CACHE_MS = 6 * 3600 * 1000;
function cacheGet(k) { const e = cache.get(k); if (e && Date.now() - e.t < CACHE_MS) return e.v; cache.delete(k); return null; }
function cacheSet(k, v) { if (cache.size > 2000) cache.clear(); cache.set(k, { t: Date.now(), v }); }

// GET /api/prayer-times?lat=xx&lng=xx[&date=JJ-MM-AAAA][&mawaqit_id=xxx]
// - mawaqit_id : horaires de la mosquée sur Mawaqit si leur service répond (accès privé, souvent refusé)
// - sinon : calcul Aladhan, méthode 2 (ISNA, 15°), selon la position
router.get('/', async (req, res) => {
  const { mawaqit_id, lat, lng } = req.query;
  const date = requestedDate(req.query.date);

  // 1. Mosquée liée à Mawaqit
  if (mawaqit_id && /^[\w-]{1,80}$/.test(String(mawaqit_id))) {
    try {
      const r = await nodeFetch(`https://mawaqit.net/api/2.0/mosque/${encodeURIComponent(mawaqit_id)}/prayer-times`, 4000);
      if (r.ok) {
        const times = parseMawaqitTimes(r.json(), date.d);
        if (times) return res.json({ source: 'mawaqit_id', times });
      }
    } catch(e) { console.error('Mawaqit ID error:', e.message); }
    // pas de réponse → on continue avec le calcul ci-dessous (jamais d'horaires vides)
  }

  // 2. Calcul selon la position (méthode 15°)
  const la = parseFloat(lat), ln = parseFloat(lng);
  if (Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180) {
    const key = `${la.toFixed(2)},${ln.toFixed(2)},${date.d}-${date.m}-${date.y}`;
    const hit = cacheGet(key);
    if (hit) return res.json(hit);
    try {
      const r = await nodeFetch(`https://api.aladhan.com/v1/timings/${date.d}-${date.m}-${date.y}?latitude=${la}&longitude=${ln}&method=2`);
      if (r.ok) {
        const data = r.json();
        if (data.code === 200) {
          const t = data.data.timings;
          const out = { source: 'aladhan', method: 'ISNA 15°', times: {
            Fajr: t.Fajr, Chourouk: t.Sunrise, Dhohr: t.Dhuhr,
            Asr: t.Asr, Maghrib: t.Maghrib, Icha: t.Isha
          }};
          cacheSet(key, out);
          return res.json(out);
        }
      }
    } catch(e) { console.error('Aladhan error:', e.message); }
  }

  res.status(503).json({ error: 'Horaires indisponibles' });
});

module.exports = router;

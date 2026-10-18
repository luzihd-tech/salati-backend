// ============================================================
// AJOUT AUTOMATIQUE DE LIEUX
// Au démarrage du serveur, lit data/lieux-a-ajouter.json et ajoute les lieux
// qui ne sont pas encore dans la base. Les coordonnées GPS sont trouvées à
// partir de l'adresse (Base Adresse Nationale, service public de l'IGN).
// Un lieu déjà présent (même nom dans la même ville, ou même type à moins
// de 30 m) n'est jamais ajouté deux fois : on peut relancer sans risque.
// ============================================================
const fs = require('fs');
const path = require('path');
const { supabase } = require('./db/database');

const FILE = path.join(__dirname, '..', 'data', 'lieux-a-ajouter.json');
const TYPES = ['mosque', 'shop', 'restaurant', 'other'];
const GENRES = ['mixte', 'hommes', 'femmes'];
const EMOJI = { mosque: '🕌', shop: '🏪', restaurant: '🍽️', other: '📍' };
const GEOCODERS = [
  'https://data.geopf.fr/geocodage/search?index=address&limit=1&q=',
  'https://api-adresse.data.gouv.fr/search/?limit=1&q='
];

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const bool = v => v === true || v === 'true' || v === 'oui' || v === 1;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function distM(a, b) {
  const R = 6371000, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function geocode(address, city) {
  const q = encodeURIComponent([address, city].filter(Boolean).join(' '));
  for (const base of GEOCODERS) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(base + q, { signal: ctl.signal, headers: { 'User-Agent': 'PrayerSpot/1.0 (prayerspot.fr)' } });
      clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      const f = j && j.features && j.features[0];
      if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) return { error: 'adresse introuvable' };
      const p = f.properties || {};
      if (typeof p.score === 'number' && p.score < 0.5) return { error: `adresse imprécise (trouvé : ${p.label || '?'})` };
      return { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], city: p.city, label: p.label };
    } catch (e) { /* on essaie le service suivant */ }
  }
  return { error: 'service d\'adresses injoignable' };
}

function readList() {
  if (!fs.existsSync(FILE)) return [];
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('le fichier doit contenir une liste [ … ]');
  return raw;
}

async function runPlacesImport() {
  let list;
  try { list = readList(); } catch (e) { console.error('Import lieux : fichier illisible —', e.message); return { error: e.message }; }
  if (!list.length) { console.log('Import lieux : rien à ajouter'); return { added: 0 }; }

  const { data: existing, error } = await supabase.from('places').select('id, name, city, type, lat, lng');
  if (error) { console.error('Import lieux : lecture de la base impossible —', error.message); return { error: error.message }; }
  const known = (existing || []).map(p => ({ ...p, key: norm(p.name) + '|' + norm(p.city) }));

  const res = { added: [], already: [], failed: [] };
  for (const item of list) {
    const name = String(item.name || '').trim();
    const type = TYPES.includes(item.type) ? item.type : null;
    const address = String(item.address || '').trim();
    const label = name || '(sans nom)';
    if (!name || !type || !address) { res.failed.push(`${label} — nom, type ou adresse manquant`); continue; }

    let { lat, lng } = item, city = String(item.city || '').trim();
    // Déjà dans la base sous le même nom et la même ville → inutile de chercher l'adresse
    if (city && known.some(p => p.key === norm(name) + '|' + norm(city))) { res.already.push(label); continue; }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      const g = await geocode(address, city);
      await sleep(150);
      if (g.error) { res.failed.push(`${label} — ${g.error} (${address})`); continue; }
      lat = g.lat; lng = g.lng; if (!city && g.city) city = g.city;
    }

    const key = norm(name) + '|' + norm(city);
    const dup = known.find(p => p.key === key || (p.type === type && typeof p.lat === 'number' && distM(p, { lat, lng }) < 30));
    if (dup) { res.already.push(label); continue; }

    const row = {
      name, type, address, city, lat, lng,
      ablution: bool(item.ablution), wc: bool(item.wc),
      genre: GENRES.includes(item.genre) ? item.genre : 'mixte',
      description: String(item.description || ''),
      emoji: EMOJI[type], rating: 0, rating_count: 0, verified: true,
      mawaqit_id: item.mawaqit_id || null, opening_hours: String(item.opening_hours || '')
    };
    const { data: inserted, error: insErr } = await supabase.from('places').insert(row).select('id').single();
    if (insErr) { res.failed.push(`${label} — refus de la base (${insErr.message})`); continue; }
    known.push({ id: inserted && inserted.id, name, city, type, lat, lng, key });
    res.added.push(`${label} (${city})`);
  }

  console.log(`Import lieux : ${res.added.length} ajouté(s), ${res.already.length} déjà présent(s), ${res.failed.length} problème(s)`);
  res.added.forEach(l => console.log('  + ajouté : ' + l));
  res.already.forEach(l => console.log('  = déjà présent : ' + l));
  res.failed.forEach(l => console.log('  ! problème : ' + l));
  return { added: res.added.length, already: res.already.length, failed: res.failed.length };
}

module.exports = { runPlacesImport, geocode, norm };

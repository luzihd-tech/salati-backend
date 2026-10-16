const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase } = require('../db/database');
const { signToken, authMiddleware, authReady } = require('../middleware/auth');

const router = express.Router();

// ── Protection contre les essais de mots de passe en boucle ───────────────
// 10 échecs sur un même email (ou 50 depuis une même connexion) → bloqué 15 minutes
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_EMAIL = 10;
const MAX_FAILS_IP = 50;
const fails = new Map(); // clé → { count, first }

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress || 'inconnu';
}
function blockedFor(key, max) {
  const e = fails.get(key);
  if (!e) return 0;
  const left = WINDOW_MS - (Date.now() - e.first);
  if (left <= 0) { fails.delete(key); return 0; }
  return e.count >= max ? left : 0;
}
function addFail(key) {
  const now = Date.now();
  let e = fails.get(key);
  if (!e || now - e.first > WINDOW_MS) { e = { count: 0, first: now }; fails.set(key, e); }
  e.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of fails) if (now - e.first > WINDOW_MS) fails.delete(k);
}, 10 * 60 * 1000).unref();

const tooMany = (res, ms) => res.status(429).json({
  error: `Trop de tentatives. Réessaie dans ${Math.max(1, Math.ceil(ms / 60000))} min.`
});

// ── Contrôles des champs ──────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const isStr = v => typeof v === 'string';

function checkName(name) {
  if (!isStr(name)) return 'Nom invalide';
  const n = name.trim();
  if (!n) return 'Tous les champs sont requis';
  if (n.length > 50) return 'Nom trop long (50 caractères max)';
  if (/[<>]/.test(n) || /[\u0000-\u001f\u007f]/.test(n)) return 'Le nom contient des caractères non autorisés';
  return null;
}
function checkEmail(email) {
  if (!isStr(email)) return 'Email invalide';
  const e = email.trim();
  if (!e) return 'Tous les champs sont requis';
  if (e.length > 254 || !EMAIL_RE.test(e)) return 'Adresse email invalide';
  return null;
}
function checkPassword(pw, label) {
  if (!isStr(pw) || !pw) return 'Tous les champs sont requis';
  if (pw.length < 6) return `${label} trop court (6 min)`;
  if (pw.length > 128) return `${label} trop long (128 max)`;
  return null;
}

router.post('/register', async (req, res) => {
  try {
    if (!authReady()) return res.status(503).json({ error: 'Inscription momentanément indisponible' });
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'Tous les champs sont requis' });
    const bad = checkName(name) || checkEmail(email) || checkPassword(password, 'Mot de passe');
    if (bad) return res.status(400).json({ error: bad });
    const cleanName = name.trim(), cleanEmail = email.trim();

    const { data: existing } = await supabase.from('users').select('id').eq('email', cleanEmail).maybeSingle();
    if (existing) return res.status(409).json({ error: 'Cet email est déjà utilisé' });

    const hashed = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase.from('users').insert({ name: cleanName, email: cleanEmail, password: hashed, role: 'user' }).select().single();
    if (error) throw error;

    const token = signToken(user);
    const { password: _, ...safeUser } = user;
    res.status(201).json({ token, user: safeUser });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/login', async (req, res) => {
  try {
    if (!authReady()) return res.status(503).json({ error: 'Connexion momentanément indisponible' });
    const { email, password } = req.body || {};
    if (!isStr(email) || !isStr(password) || !email.trim() || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
    const cleanEmail = email.trim();

    const kEmail = 'e:' + cleanEmail.toLowerCase(), kIp = 'i:' + clientIp(req);
    const wait = Math.max(blockedFor(kEmail, MAX_FAILS_EMAIL), blockedFor(kIp, MAX_FAILS_IP));
    if (wait) return tooMany(res, wait);

    const { data: user } = await supabase.from('users').select('*').eq('email', cleanEmail).maybeSingle();
    const valid = user && password.length <= 128 ? await bcrypt.compare(password, user.password) : false;
    if (!valid) {
      addFail(kEmail); addFail(kIp);
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    fails.delete(kEmail);

    const token = signToken(user);
    const { password: _, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const { password: _, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!isStr(currentPassword) || !isStr(newPassword) || !currentPassword || !newPassword) return res.status(400).json({ error: 'Tous les champs sont requis' });
    const bad = checkPassword(newPassword, 'Nouveau mot de passe');
    if (bad) return res.status(400).json({ error: bad });

    const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const valid = currentPassword.length <= 128 && await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await supabase.from('users').update({ password: hashed }).eq('id', req.user.id);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

module.exports = router;

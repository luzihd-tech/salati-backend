const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { sendUserMail, mailProvider, makeLimiter, esc } = require('../mailer');
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
    const cleanName = name.trim(), cleanEmail = email.trim().toLowerCase();

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
    const cleanEmail = email.trim().toLowerCase();

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

// ── Mot de passe oublié ───────────────────────────────────────────────────
// 1) POST /forgot-password { email } → e-mail avec un lien valable 1 h, utilisable une fois.
//    Réponse identique que le compte existe ou non (on ne révèle pas qui a un compte).
// 2) POST /reset-password { token, password } → nouveau mot de passe, connexion directe.
// Seule l'empreinte (SHA-256) du lien est enregistrée en base.
const APP_URL = () => (process.env.APP_URL || 'https://prayerspot.fr').replace(/\/+$/, '');
const RESET_TTL_MS = 60 * 60 * 1000;
const resetIpLimit = makeLimiter(10, 300);          // 10 demandes / heure par connexion, 300 / jour au total
const resetByEmail = new Map();                       // 3 demandes / heure par adresse
function emailAllowed(email) {
  const now = Date.now(), list = (resetByEmail.get(email) || []).filter(t => now - t < 3600 * 1000);
  if (list.length >= 3) { resetByEmail.set(email, list); return false; }
  list.push(now); resetByEmail.set(email, list); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of resetByEmail) if (!v.some(t => now - t < 3600 * 1000)) resetByEmail.delete(k); }, 15 * 60 * 1000).unref();
const sha256 = t => crypto.createHash('sha256').update(String(t)).digest('hex');

function resetMail(name, link) {
  const n = esc(String(name || '').trim() || 'à toi');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f1e6;font-family:Arial,Helvetica,sans-serif;color:#1b2820">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1e6;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fdfaf4;border:1px solid #e6e0d3;border-radius:18px">
<tr><td style="background:#2a4234;border-radius:18px 18px 0 0;padding:22px 26px;color:#f7f2e8;font-family:Georgia,'Times New Roman',serif;font-size:21px;font-weight:bold">Prayer Spot</td></tr>
<tr><td style="padding:26px 26px 8px;font-size:15px;line-height:1.6">
<p style="margin:0 0 14px">Salam ${n},</p>
<p style="margin:0 0 20px">Tu as demandé à choisir un nouveau mot de passe pour ton compte Prayer Spot. Appuie sur le bouton ci-dessous :</p>
<p style="margin:0 0 22px;text-align:center"><a href="${link}" style="display:inline-block;background:#2a4234;color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 24px;border-radius:12px">Choisir un nouveau mot de passe</a></p>
<p style="margin:0 0 12px;font-size:13px;color:#47524a">Ce lien est valable <b>1 heure</b> et ne fonctionne qu'une seule fois.</p>
<p style="margin:0 0 18px;font-size:13px;color:#47524a">Si tu n'es pas à l'origine de cette demande, ignore simplement cet e-mail : ton mot de passe reste inchangé.</p>
</td></tr>
<tr><td style="padding:0 26px 22px;font-size:11.5px;color:#8a8c82;line-height:1.5">Le bouton ne marche pas ? Copie ce lien dans ton navigateur :<br><span style="word-break:break-all;color:#405c4d">${link}</span></td></tr>
</table></td></tr></table></body></html>`;
  const text = `Salam ${String(name || '').trim()},\n\nTu as demandé à choisir un nouveau mot de passe pour ton compte Prayer Spot.\nOuvre ce lien (valable 1 heure, utilisable une seule fois) :\n${link}\n\nSi tu n'es pas à l'origine de cette demande, ignore cet e-mail : ton mot de passe reste inchangé.\n\nPrayer Spot`;
  return { html, text };
}

async function sendResetLink(email) {
  const { data: user } = await supabase.from('users').select('id, name, email').eq('email', email).maybeSingle();
  // ménage : liens expirés depuis plus d'un jour
  await supabase.from('password_resets').delete().lt('expires_at', new Date(Date.now() - 86400000).toISOString());
  if (!user) return;
  const token = crypto.randomBytes(32).toString('base64url');
  await supabase.from('password_resets').delete().eq('user_id', user.id).is('used_at', null); // un seul lien actif
  const { error } = await supabase.from('password_resets').insert({
    user_id: user.id, token_hash: sha256(token), expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString()
  });
  if (error) throw error;
  const { html, text } = resetMail(user.name, `${APP_URL()}/#reset=${token}`);
  const sent = await sendUserMail({ to: user.email, subject: 'Ton lien pour choisir un nouveau mot de passe', html, text, label: 'Mot de passe oublié' });
  console.log(sent ? 'Mot de passe oublié : lien envoyé' : 'Mot de passe oublié : envoi impossible');
}

router.post('/forgot-password', async (req, res) => {
  try {
    if (!authReady()) return res.status(503).json({ error: 'Service momentanément indisponible' });
    const { email } = req.body || {};
    if (checkEmail(email)) return res.status(400).json({ error: 'Adresse email invalide' });
    if (!mailProvider()) return res.status(503).json({ error: "L'envoi d'e-mails est momentanément indisponible" });
    const clean = email.trim().toLowerCase();
    if (!resetIpLimit(clientIp(req)) || !emailAllowed(clean)) return res.status(429).json({ error: 'Trop de demandes. Réessaie dans une heure.' });
    // Réponse immédiate et identique dans tous les cas ; l'envoi se fait ensuite
    res.json({ success: true });
    sendResetLink(clean).catch(e => console.error('Mot de passe oublié :', e.message || e));
  } catch (err) { console.error(err); if (!res.headersSent) res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/reset-password', async (req, res) => {
  try {
    if (!authReady()) return res.status(503).json({ error: 'Service momentanément indisponible' });
    const { token, password } = req.body || {};
    if (!isStr(token) || token.length < 20 || token.length > 200) return res.status(400).json({ error: "Ce lien n'est pas valide.", code: 'invalid' });
    const bad = checkPassword(password, 'Mot de passe');
    if (bad) return res.status(400).json({ error: bad });
    const kIp = 'r:' + clientIp(req);
    const wait = blockedFor(kIp, 20);
    if (wait) return tooMany(res, wait);

    const { data: row } = await supabase.from('password_resets').select('id, user_id, expires_at, used_at').eq('token_hash', sha256(token)).maybeSingle();
    if (!row) { addFail(kIp); return res.status(400).json({ error: "Ce lien n'est pas valide.", code: 'invalid' }); }
    if (row.used_at) return res.status(400).json({ error: 'Ce lien a déjà été utilisé.', code: 'used' });
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'Ce lien a expiré.', code: 'expired' });

    // On « consomme » le lien avant tout : impossible de l'utiliser deux fois
    const { data: claimed } = await supabase.from('password_resets').update({ used_at: new Date().toISOString() }).eq('id', row.id).is('used_at', null).select('id');
    if (!claimed || !claimed.length) return res.status(400).json({ error: 'Ce lien a déjà été utilisé.', code: 'used' });

    const hashed = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase.from('users').update({ password: hashed }).eq('id', row.user_id).select().single();
    if (error || !user) throw error || new Error('Utilisateur introuvable');
    await supabase.from('password_resets').delete().eq('user_id', row.user_id).neq('id', row.id);
    fails.delete('e:' + String(user.email).toLowerCase()); // la connexion n'est plus bloquée

    const jwt = signToken(user);
    const { password: _, ...safeUser } = user;
    res.json({ token: jwt, user: safeUser });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

module.exports = router;


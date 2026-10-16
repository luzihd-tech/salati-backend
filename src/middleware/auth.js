const jwt = require('jsonwebtoken');
const { supabase } = require('../db/database');

// La clé secrète vient UNIQUEMENT de Render (variable JWT_SECRET).
// Pas de valeur par défaut : si elle manque, les connexions sont refusées
// (la carte et les lieux continuent de fonctionner).
const RAW_SECRET = process.env.JWT_SECRET || '';
const OLD_DEFAULT = 'salati_secret_key';
const JWT_SECRET = (RAW_SECRET && RAW_SECRET !== OLD_DEFAULT) ? RAW_SECRET : null;

// Journal de démarrage : dit seulement si la clé est présente et sa longueur, jamais sa valeur
if (!JWT_SECRET) {
  console.error('JWT_SECRET: ⚠️ manquant (ou ancienne valeur par défaut) — connexions désactivées');
} else if (JWT_SECRET.length < 32) {
  console.warn(`JWT_SECRET: ⚠️ configuré mais court (${JWT_SECRET.length} caractères) — 32 minimum conseillés`);
} else {
  console.log(`JWT_SECRET: ✅ configuré (${JWT_SECRET.length} caractères)`);
}

const SERVICE_DOWN = { error: 'Connexion momentanément indisponible' };

function authMiddleware(req, res, next) {
  if (!JWT_SECRET) return res.status(503).json(SERVICE_DOWN);
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Token manquant' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch { res.status(401).json({ error: 'Token invalide' }); }
}

// Admin : on ne se fie pas au rôle écrit dans la connexion,
// on le vérifie dans la base à chaque action admin.
function adminMiddleware(req, res, next) {
  authMiddleware(req, res, async () => {
    try {
      const { data: user } = await supabase.from('users').select('id, role').eq('id', req.user.id).maybeSingle();
      if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Accès admin requis' });
      req.user.role = 'admin';
      next();
    } catch (err) {
      console.error('Vérification admin impossible:', err.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });
}

function signToken(user) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET manquant');
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET, { expiresIn: '30d', algorithm: 'HS256' }
  );
}

module.exports = { authMiddleware, adminMiddleware, signToken, authReady: () => !!JWT_SECRET };

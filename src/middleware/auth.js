const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'salati_secret_key';

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Token manquant' });
  try {
    req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Token invalide' }); }
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès admin requis' });
    next();
  });
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET, { expiresIn: '30d' }
  );
}

module.exports = { authMiddleware, adminMiddleware, signToken };

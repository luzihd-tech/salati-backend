const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase } = require('../db/database');
const { signToken, authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Tous les champs sont requis' });
    if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 min)' });

    const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (existing) return res.status(409).json({ error: 'Cet email est déjà utilisé' });

    const hashed = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase.from('users').insert({ name, email, password: hashed, role: 'user' }).select().single();
    if (error) throw error;

    const token = signToken(user);
    const { password: _, ...safeUser } = user;
    res.status(201).json({ token, user: safeUser });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

    const { data: user } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
    if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

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
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Tous les champs sont requis' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Nouveau mot de passe trop court' });

    const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await supabase.from('users').update({ password: hashed }).eq('id', req.user.id);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

module.exports = router;

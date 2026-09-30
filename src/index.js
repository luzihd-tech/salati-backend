require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// ⚠️ Le webhook Stripe a besoin du raw body AVANT express.json()
// Il faut l'enregistrer en premier
const stripeRoutes = require('./routes/stripe');
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  // Garde le raw body pour la vérification de signature
  req.rawBody = req.body;
  next();
});

// Middlewares globaux
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: 'Salati API', version: '1.0.0', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/places', require('./routes/places'));
app.use('/api/prayer', require('./routes/prayer'));
app.use('/api/prayer-times', require('./routes/prayer-times'));
app.use('/api/stripe', stripeRoutes);
app.use('/api/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));

app.listen(PORT, () => {
  console.log(`🕌 Salati API démarrée sur http://localhost:${PORT}`);
  console.log(`Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅ configuré' : '⚠️ STRIPE_SECRET_KEY manquant'}`);
});

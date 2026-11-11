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
app.use('/api/suggestions', require('./routes/suggestions'));
app.use('/api/reports', require('./routes/reports'));

app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));

app.listen(PORT, () => {
  console.log(`🕌 Salati API démarrée sur http://localhost:${PORT}`);
  console.log(`Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅ configuré' : '⚠️ STRIPE_SECRET_KEY manquant'}`);
  console.log(`Suggestions : ${process.env.GMAIL_APP_PASSWORD ? '✅ envoi par Gmail configuré' : process.env.RESEND_API_KEY ? '✅ envoi par Resend configuré' : '⚠️ GMAIL_APP_PASSWORD manquant — le formulaire proposera l\'envoi par e-mail'}`);
  // Ajout automatique des lieux listés dans data/lieux-a-ajouter.json (doublons ignorés)
  // Ajout automatique des lieux ; si le service d'adresses ne répond pas, nouvel essai toutes les 15 min (4 fois max)
  const importPlaces = (tries = 0) => require('./import-places').runPlacesImport()
    .then(r => { if (r && r.unreachable && tries < 4) { console.log('Import lieux : nouvel essai dans 15 min'); setTimeout(() => importPlaces(tries + 1), 15 * 60 * 1000).unref(); } })
    .catch(e => console.error('Import lieux :', e.message));
  setTimeout(() => importPlaces(), 3000);
});

const express = require('express');
const { supabase } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const STRIPE_PRICE_ID = 'price_1TyhDl0UyBARfvAyr3eijteK';

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY manquant');
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

function getFrontendUrl() {
  return process.env.FRONTEND_URL && process.env.FRONTEND_URL !== '*'
    ? process.env.FRONTEND_URL
    : 'https://salati.netlify.app';
}

// POST /api/stripe/create-checkout
router.post('/create-checkout', authMiddleware, async (req, res) => {
  try {
    const stripe = getStripe();
    const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (user.is_subscribed) return res.status(400).json({ error: 'Déjà abonné' });

    // Crée ou récupère le customer Stripe
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email, name: user.name,
        metadata: { salati_user_id: user.id }
      });
      customerId = customer.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', user.id);
    }

    const FRONTEND = getFrontendUrl();
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${FRONTEND}?subscription=success`,
      cancel_url: `${FRONTEND}?subscription=cancelled`,
      locale: 'fr',
      metadata: { salati_user_id: user.id }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/webhook — Événements Stripe (raw body requis)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = getStripe();
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook invalid:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const isActive = sub.status === 'active' || sub.status === 'trialing';
        await supabase.from('users').update({
          is_subscribed: isActive,
          stripe_subscription_id: sub.id,
          subscription_status: sub.status
        }).eq('stripe_customer_id', sub.customer);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase.from('users').update({
          is_subscribed: false,
          stripe_subscription_id: null,
          subscription_status: 'cancelled'
        }).eq('stripe_customer_id', sub.customer);
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object;
        await supabase.from('users').update({
          is_subscribed: false,
          subscription_status: 'payment_failed'
        }).eq('stripe_customer_id', inv.customer);
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// POST /api/stripe/cancel
router.post('/cancel', authMiddleware, async (req, res) => {
  try {
    const stripe = getStripe();
    const { data: user } = await supabase.from('users').select('stripe_subscription_id').eq('id', req.user.id).maybeSingle();
    if (!user?.stripe_subscription_id) return res.status(400).json({ error: 'Aucun abonnement actif' });

    await stripe.subscriptions.update(user.stripe_subscription_id, { cancel_at_period_end: true });
    await supabase.from('users').update({ subscription_status: 'cancelling' }).eq('id', req.user.id);
    res.json({ success: true, message: 'Abonnement annulé à la fin de la période en cours' });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// GET /api/stripe/status
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users')
      .select('is_subscribed, subscription_status')
      .eq('id', req.user.id).maybeSingle();
    res.json({ isSubscribed: user?.is_subscribed || false, status: user?.subscription_status || null });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;

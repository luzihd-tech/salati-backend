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

// POST /api/stripe/create-subscription-intent
router.post('/create-subscription-intent', authMiddleware, async (req, res) => {
  try {
    const stripe = getStripe();
    const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (user.is_subscribed) return res.status(400).json({ error: 'Déjà abonné' });

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email, name: user.name,
        metadata: { salati_user_id: user.id }
      });
      customerId = customer.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', user.id);
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      metadata: { salati_user_id: user.id, price_id: STRIPE_PRICE_ID }
    });

    res.json({ client_secret: setupIntent.client_secret, customer_id: customerId });
  } catch (err) {
    console.error('Stripe intent error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/confirm-subscription
// Appelée après la saisie de la carte dans l'app (SetupIntent confirmé côté navigateur)
router.post('/confirm-subscription', authMiddleware, async (req, res) => {
  try {
    const stripe = getStripe();
    const { payment_method_id } = req.body || {};
    if (!payment_method_id) return res.status(400).json({ error: 'Moyen de paiement manquant' });
    const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).maybeSingle();
    if (!user?.stripe_customer_id) return res.status(400).json({ error: 'Customer introuvable' });

    // La carte est déjà rattachée au client par le SetupIntent : on ignore l'erreur « déjà rattachée »
    try {
      await stripe.paymentMethods.attach(payment_method_id, { customer: user.stripe_customer_id });
    } catch (e) {
      if (!/already been attached|already attached/i.test(e.message || '')) throw e;
    }
    await stripe.customers.update(user.stripe_customer_id, {
      invoice_settings: { default_payment_method: payment_method_id }
    });

    // Anti-doublon : abonnement déjà actif → on s'arrête ; essai précédent resté « incomplet » → annulé
    const existing = await stripe.subscriptions.list({ customer: user.stripe_customer_id, status: 'all', limit: 10 });
    const alreadyActive = existing.data.find(s => s.status === 'active' || s.status === 'trialing');
    if (alreadyActive) {
      await supabase.from('users').update({
        is_subscribed: true, stripe_subscription_id: alreadyActive.id, subscription_status: alreadyActive.status
      }).eq('id', user.id);
      return res.json({ success: true, status: alreadyActive.status });
    }
    for (const s of existing.data.filter(s => s.status === 'incomplete')) {
      try { await stripe.subscriptions.cancel(s.id); } catch (e) { /* déjà expiré */ }
    }

    const subscription = await stripe.subscriptions.create({
      customer: user.stripe_customer_id,
      items: [{ price: STRIPE_PRICE_ID }],
      default_payment_method: payment_method_id,
      expand: ['latest_invoice.payment_intent']
    });

    const isActive = subscription.status === 'active' || subscription.status === 'trialing';
    await supabase.from('users').update({
      is_subscribed: isActive,
      stripe_subscription_id: subscription.id,
      subscription_status: subscription.status
    }).eq('id', user.id);

    if (isActive) return res.json({ success: true, status: subscription.status });

    // La banque redemande une validation (3D Secure) pour le premier prélèvement
    const pi = subscription.latest_invoice && subscription.latest_invoice.payment_intent;
    if (pi && pi.status === 'requires_action') {
      return res.json({ success: false, requires_action: true, client_secret: pi.client_secret, status: subscription.status });
    }
    const reason = (pi && pi.last_payment_error && pi.last_payment_error.message) || "Le paiement n'a pas abouti";
    return res.json({ success: false, status: subscription.status, error: reason, code: pi && pi.last_payment_error && (pi.last_payment_error.decline_code || pi.last_payment_error.code) });
  } catch (err) {
    console.error('Confirm subscription error:', err);
    if (err.type === 'StripeCardError') return res.status(402).json({ error: err.message, code: err.decline_code || err.code });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/sync-subscription
// Après une validation bancaire : relit l'abonnement chez Stripe et met le compte à jour
router.post('/sync-subscription', authMiddleware, async (req, res) => {
  try {
    const stripe = getStripe();
    const { data: user } = await supabase.from('users').select('id, stripe_customer_id').eq('id', req.user.id).maybeSingle();
    if (!user?.stripe_customer_id) return res.status(400).json({ error: 'Customer introuvable' });
    const subs = await stripe.subscriptions.list({ customer: user.stripe_customer_id, status: 'all', limit: 5 });
    const sub = subs.data.find(s => s.status === 'active' || s.status === 'trialing') || subs.data[0];
    if (!sub) return res.json({ active: false, status: null });
    const isActive = sub.status === 'active' || sub.status === 'trialing';
    await supabase.from('users').update({
      is_subscribed: isActive, stripe_subscription_id: sub.id, subscription_status: sub.status
    }).eq('id', user.id);
    res.json({ active: isActive, status: sub.status });
  } catch (err) {
    console.error('Sync subscription error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/webhook
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

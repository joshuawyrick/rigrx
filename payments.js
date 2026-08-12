// ============ Payments (Stripe) ============
// Without STRIPE_SECRET_KEY, purchases run in SIMULATION MODE: they succeed instantly
// and are marked 'simulated' — the full app flow works before you connect Stripe.
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  try { stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); }
  catch (e) { console.error('Stripe init failed, running in simulation mode:', e.message); }
}

const SIMULATED = () => !stripe;

// Charge a provider's saved card for a lead. Returns { ok, paymentId }.
async function chargeLead(provider, amountCents, description) {
  if (!stripe) return { ok: true, paymentId: 'simulated' };
  try {
    // Real mode: charge the customer's default payment method off-session.
    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: provider.stripe_customer || undefined,
      description,
      confirm: true,
      off_session: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' }
    });
    return { ok: intent.status === 'succeeded', paymentId: intent.id };
  } catch (e) {
    console.error('Stripe charge failed:', e.message);
    return { ok: false, error: e.message };
  }
}

async function refund(paymentId) {
  if (!stripe || paymentId === 'simulated') return { ok: true };
  try {
    await stripe.refunds.create({ payment_intent: paymentId });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { chargeLead, refund, SIMULATED };

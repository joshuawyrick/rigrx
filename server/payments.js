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
    if (!provider.stripe_customer || !provider.stripe_pm)
      return { ok: false, error: 'No card on file — add one in Settings' };
    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: provider.stripe_customer,
      payment_method: provider.stripe_pm,
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

/* ---- card collection ----
   The provider adds a card once, in Settings. We create a Stripe Customer for the
   company, collect the card through Stripe Elements on the client (the card number
   never touches the RIGRX server), and store the payment-method id. chargeLead then
   charges that stored card off-session at buy time. */
async function cardSetup(provider, name, email) {
  if (!stripe) return null;
  let customerId = provider.stripe_customer;
  if (!customerId) {
    const c = await stripe.customers.create({
      name: name || provider.name || 'RIGRX service company',
      email: email || provider.email || undefined,
      metadata: { rigrx_provider: String(provider.user_id) }
    });
    customerId = c.id;
  }
  const si = await stripe.setupIntents.create({
    customer: customerId,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' }
  });
  return { customerId, clientSecret: si.client_secret };
}

// After the client confirms the SetupIntent, look the card up server-side (never
// trust the browser for what got saved) and make it the charging default.
async function saveCard(customerId, paymentMethodId) {
  if (!stripe) return null;
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  if (!pm || pm.customer !== customerId) return null;
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId }
  });
  return { last4: pm.card?.last4 || '', brand: pm.card?.brand || '' };
}

module.exports = { chargeLead, refund, SIMULATED, cardSetup, saveCard };

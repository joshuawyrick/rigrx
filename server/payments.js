// ============ Payments (Stripe) ============
// Simulation is available only when explicitly enabled in a non-production runtime.
const { simulationEnabled, paymentsConfigured } = require('./config');

let stripe = null;
if (paymentsConfigured()) {
  try {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  } catch (error) {
    if (!simulationEnabled()) throw error;
    console.error('Stripe init failed; explicit development simulation remains active:', error.message);
  }
}

const SIMULATED = () => !stripe && simulationEnabled();

function unavailable() {
  return { ok: false, error: 'Payments are not configured' };
}

function isIndeterminate(error) {
  return error?.code === 'idempotency_key_in_use'
    || ['StripeAPIError', 'StripeConnectionError', 'StripeRateLimitError', 'StripeIdempotencyError'].includes(error?.type)
    || Number(error?.statusCode) >= 500;
}

function classifyRefund(result) {
  if (result.status === 'succeeded')
    return { ok: true, complete: true, refundId: result.id, status: result.status };
  if (['failed', 'canceled'].includes(result.status)) {
    return {
      ok: false,
      indeterminate: false,
      refundId: result.id,
      status: result.status,
      error: result.failure_reason || `Refund ${result.status}`
    };
  }
  return {
    ok: false,
    indeterminate: true,
    refundId: result.id,
    status: result.status || 'pending',
    error: `Refund is ${result.status || 'pending'}`
  };
}

async function createLeadPayment(provider, amountCents, description, { idempotencyKey } = {}) {
  if (!stripe) {
    if (!SIMULATED()) return unavailable();
    return { ok: true, paymentId: 'simulated', status: 'requires_confirmation' };
  }
  try {
    if (!provider.stripe_customer || !provider.stripe_pm)
      return { ok: false, error: 'No card on file — add one in Settings' };
    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: provider.stripe_customer,
      description,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: {
        rigrx_provider: String(provider.user_id),
        rigrx_purchase_key: String(idempotencyKey || '')
      }
    }, idempotencyKey ? { idempotencyKey } : undefined);
    return { ok: true, paymentId: intent.id, status: intent.status };
  } catch (error) {
    console.error('Stripe payment creation failed:', error.message);
    return { ok: false, error: error.message, indeterminate: isIndeterminate(error) };
  }
}

async function confirmLeadPayment(paymentId, provider, { idempotencyKey } = {}) {
  if (paymentId === 'simulated') {
    return SIMULATED() ? { ok: true, paymentId, status: 'succeeded' } : unavailable();
  }
  if (!stripe) return unavailable();
  try {
    let intent = await stripe.paymentIntents.retrieve(paymentId);
    if (intent.status === 'succeeded')
      return { ok: true, paymentId: intent.id, status: intent.status };
    if (!['requires_confirmation', 'requires_payment_method'].includes(intent.status)) {
      return {
        ok: false,
        paymentId: intent.id,
        status: intent.status,
        indeterminate: intent.status === 'processing',
        error: `Payment requires attention (${intent.status})`
      };
    }
    intent = await stripe.paymentIntents.confirm(paymentId, {
      payment_method: provider.stripe_pm,
      off_session: true
    }, idempotencyKey ? { idempotencyKey } : undefined);
    return {
      ok: intent.status === 'succeeded',
      paymentId: intent.id,
      status: intent.status,
      indeterminate: intent.status === 'processing',
      error: intent.status === 'succeeded' ? undefined : `Payment did not complete (${intent.status})`
    };
  } catch (error) {
    console.error('Stripe payment confirmation failed:', error.message);
    return { ok: false, paymentId, error: error.message, indeterminate: isIndeterminate(error) };
  }
}

async function cancelPayment(paymentId, { idempotencyKey } = {}) {
  if (paymentId === 'simulated') return { ok: true, status: 'canceled' };
  if (!stripe) return unavailable();
  try {
    const intent = await stripe.paymentIntents.retrieve(paymentId);
    if (intent.status === 'canceled') return { ok: true, status: intent.status };
    if (intent.status === 'succeeded')
      return { ok: false, status: intent.status, alreadySucceeded: true, error: 'Payment already succeeded and must be refunded' };
    await stripe.paymentIntents.cancel(paymentId, {}, idempotencyKey ? { idempotencyKey } : undefined);
    return { ok: true, status: 'canceled' };
  } catch (error) {
    return { ok: false, error: error.message, indeterminate: isIndeterminate(error) };
  }
}

async function refund(paymentId, { idempotencyKey, refundId } = {}) {
  // Historical development purchases may be refunded after production is enabled.
  // There was never an external charge, so this is always a safe local no-op.
  if (paymentId === 'simulated')
    return { ok: true, complete: true, refundId: 'simulated', status: 'succeeded' };
  if (!stripe) return unavailable();
  try {
    const result = refundId
      ? await stripe.refunds.retrieve(refundId)
      : await stripe.refunds.create(
          { payment_intent: paymentId },
          idempotencyKey ? { idempotencyKey } : undefined
        );
    return classifyRefund(result);
  } catch (error) {
    if (!refundId && (error?.code === 'charge_already_refunded'
        || /already (?:been )?refunded/i.test(error?.message || ''))) {
      try {
        const existing = await stripe.refunds.list({ payment_intent: paymentId, limit: 10 });
        const found = existing.data.find(item =>
          ['succeeded', 'pending', 'requires_action'].includes(item.status));
        if (found) return classifyRefund(found);
      } catch (lookupError) {
        console.error('Stripe refund lookup failed:', lookupError.message);
      }
    }
    return { ok: false, error: error.message, indeterminate: isIndeterminate(error) };
  }
}

/* ---- card collection ---- */
async function cardSetup(provider, name, email) {
  if (!stripe) return null;
  let customerId = provider.stripe_customer;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: name || provider.name || 'RIGRX service company',
      email: email || provider.email || undefined,
      metadata: { rigrx_provider: String(provider.user_id) }
    });
    customerId = customer.id;
  }
  const intent = await stripe.setupIntents.create({
    customer: customerId,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' }
  });
  return { customerId, clientSecret: intent.client_secret };
}

async function saveCard(customerId, paymentMethodId) {
  if (!stripe) return null;
  const method = await stripe.paymentMethods.retrieve(paymentMethodId);
  if (!method || method.customer !== customerId) return null;
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId }
  });
  return { last4: method.card?.last4 || '', brand: method.card?.brand || '' };
}

module.exports = {
  createLeadPayment,
  confirmLeadPayment,
  cancelPayment,
  refund,
  SIMULATED,
  cardSetup,
  saveCard,
  _classifyRefund: classifyRefund,
  _isIndeterminate: isIndeterminate
};
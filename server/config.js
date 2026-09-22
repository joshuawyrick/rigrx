const PRODUCTION = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT === '1';

function flag(value) {
  return /^(1|true|yes)$/i.test(String(value || ''));
}

function simulationEnabled(env = process.env) {
  const production = env.NODE_ENV === 'production' || env.REPLIT_DEPLOYMENT === '1';
  return !production && flag(env.RIGRX_ALLOW_SIMULATION);
}

function twilioConfigured(env = process.env) {
  return ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'].every(key => !!env[key]);
}

function sms8Configured(env = process.env) {
  return !!env.SMS8_API_KEY;
}

// True when ANY real SMS provider is set up (Twilio or SMS8).
function smsConfigured(env = process.env) {
  return twilioConfigured(env) || sms8Configured(env);
}

function paymentsConfigured(env = process.env) {
  return ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'].every(key => !!env[key]);
}

function validateRuntimeConfig(env = process.env) {
  const production = env.NODE_ENV === 'production' || env.REPLIT_DEPLOYMENT === '1';
  const simulation = simulationEnabled(env);
  const missing = [];

  for (const key of ['DATABASE_URL', 'SESSION_SECRET', 'ADMIN_PHONE']) {
    if (!env[key]) missing.push(key);
  }

  const smsKeys = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'];
  const paymentKeys = ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'];
  const missingSms = smsKeys.filter(key => !env[key]);
  const missingPayments = paymentKeys.filter(key => !env[key]);
  // Either provider satisfies the SMS requirement: full Twilio credentials, or an SMS8 key.
  const smsReady = missingSms.length === 0 || sms8Configured(env);

  if (!simulation || production) {
    if (!smsReady) missing.push(...missingSms, 'or SMS8_API_KEY');
    missing.push(...missingPayments);
  }

  if (production && flag(env.RIGRX_ALLOW_SIMULATION)) {
    throw new Error('RIGRX_ALLOW_SIMULATION cannot be enabled in production.');
  }
  if (missing.length) {
    const hint = production
      ? 'Production will not start with simulated authentication or payments.'
      : 'For local development only, set RIGRX_ALLOW_SIMULATION=true explicitly.';
    throw new Error(`Missing required configuration: ${[...new Set(missing)].join(', ')}. ${hint}`);
  }
  if (env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters.');
  }

  return { production, simulation, smsSimulated: !smsReady, paymentsSimulated: missingPayments.length > 0 };
}

module.exports = {
  PRODUCTION,
  simulationEnabled,
  smsConfigured,
  twilioConfigured,
  sms8Configured,
  paymentsConfigured,
  validateRuntimeConfig
};
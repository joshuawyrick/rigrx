const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { Pool } = require('pg');

require('dotenv').config();
process.env.RIGRX_ALLOW_SIMULATION = 'true';

let db;
let marketplace;
let dispatch;
let auth;
let notify;
let routes;
let schemaName;
let apiServer;
let apiBase;
let phoneSequence = 1000;

test.before(async () => {
  schemaName = `rigrx_test_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await admin.query(`CREATE SCHEMA "${schemaName}"`);
  await admin.end();
  process.env.PGOPTIONS = `-c search_path=${schemaName}`;

  db = require('../server/db');
  await db.migrate();
  // Exercise an upgrade from the legacy credit ledger, where CREATE TABLE IF
  // NOT EXISTS cannot add the newer idempotency column by itself.
  await db.q('DROP INDEX uq_credit_log_event');
  await db.q('ALTER TABLE credit_log DROP COLUMN event_key');
  await db.migrate();
  assert.equal((await db.q(`
    SELECT COUNT(*)::int AS n FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='credit_log' AND column_name='event_key'`))[0].n, 1);
  marketplace = require('../server/marketplace');
  dispatch = require('../server/dispatch');
  auth = require('../server/auth');
  notify = require('../server/notify');

  const express = require('express');
  const cookieParser = require('cookie-parser');
  const api = express();
  api.use(express.json());
  api.use(cookieParser());
  api.use(auth.attachUser);
  routes = require('../server/routes');
  api.use('/api', routes);
  api.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status || 500).json({ error: error.message || 'Server error' });
  });
  apiServer = http.createServer(api);
  await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${apiServer.address().port}`;
});

test.after(async () => {
  if (apiServer) await new Promise(resolve => apiServer.close(resolve));
  if (db) await db.pool.end();
  if (schemaName) {
    const admin = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      options: '-c search_path=public'
    });
    await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin.end();
  }
});

function nextPhone() {
  return `+1661555${String(phoneSequence++).padStart(4, '0')}`;
}

async function createUser(role = 'driver', values = {}) {
  const row = (await db.q(`
    INSERT INTO users (phone, role, name, company_id, member_role, archived_at)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [nextPhone(), role, values.name || role, values.company_id || null,
     values.member_role || '', values.archived_at || null]))[0];
  return row;
}

async function createProvider({ credits = 0, approved = true } = {}) {
  const owner = await createUser('provider', { member_role: 'owner' });
  await db.q('UPDATE users SET company_id=id WHERE id=$1', [owner.id]);
  await db.q(`
    INSERT INTO providers
      (user_id, name, approved, lead_credits, stripe_customer, stripe_pm, primary_trade, duty_classes)
    VALUES ($1,$2,$3,$4,$5,$6,'mobile_mechanic','["heavy","medium","light"]')`,
    [owner.id, `Provider ${owner.id}`, approved, credits, `cus_${owner.id}`, `pm_${owner.id}`]);
  return owner;
}

async function createRequest(driverId) {
  return (await db.q(`
    INSERT INTO requests
      (driver_id, service_key, service_label, lat, lng, area_label, status, duty_class)
    VALUES ($1,'mechanic','Mobile Mechanic',35,-119,'Test area','open','heavy') RETURNING *`,
    [driverId]))[0];
}

function fakePayments({ failFirstConfirmation = false } = {}) {
  const createdKeys = [];
  const confirmedKeys = [];
  const refundKeys = [];
  const refundRequests = [];
  let shouldFail = failFirstConfirmation;
  return {
    createdKeys,
    confirmedKeys,
    refundKeys,
    refundRequests,
    SIMULATED: () => false,
    async createLeadPayment(provider, amount, description, { idempotencyKey }) {
      createdKeys.push(idempotencyKey);
      return { ok: true, paymentId: `pi_${idempotencyKey}`, status: 'requires_confirmation' };
    },
    async confirmLeadPayment(paymentId, provider, { idempotencyKey }) {
      confirmedKeys.push(idempotencyKey);
      if (shouldFail) {
        shouldFail = false;
        return { ok: false, paymentId, error: 'declined' };
      }
      return { ok: true, paymentId, status: 'succeeded' };
    },
    async cancelPayment() {
      return { ok: true };
    },
    async refund(paymentId, { idempotencyKey, refundId }) {
      refundKeys.push(idempotencyKey);
      refundRequests.push({ paymentId, idempotencyKey, refundId });
      return {
        ok: true,
        complete: true,
        refundId: refundId || `re_${idempotencyKey}`,
        status: 'succeeded'
      };
    }
  };
}

test('production configuration cannot enable simulation or omit SMS/payment credentials', () => {
  const { validateRuntimeConfig } = require('../server/config');
  const base = {
    DATABASE_URL: 'postgres://example',
    SESSION_SECRET: 'x'.repeat(32),
    ADMIN_PHONE: '+16615550100'
  };
  assert.throws(
    () => validateRuntimeConfig({ ...base, NODE_ENV: 'production', RIGRX_ALLOW_SIMULATION: 'true' }),
    /cannot be enabled in production/
  );
  assert.throws(
    () => validateRuntimeConfig({ ...base, NODE_ENV: 'production' }),
    /TWILIO_ACCOUNT_SID.*STRIPE_SECRET_KEY/
  );
  assert.equal(validateRuntimeConfig({ ...base, RIGRX_ALLOW_SIMULATION: 'true' }).simulation, true);
});

test('protected account types cannot be rewritten as company members', () => {
  const { memberConflict } = require('../server/account-policy');
  assert.match(memberConflict({ role: 'admin' }, 7), /protected administrator/);
  assert.match(memberConflict({ role: 'driver' }, 7), /different account type/);
  assert.match(memberConflict({ role: 'provider', company_id: 8, member_role: 'tech' }, 7), /another company/);
  assert.match(memberConflict({ role: 'provider', company_id: 7, member_role: 'owner' }, 7), /owner/);
  assert.equal(memberConflict({ role: 'provider', company_id: 7, member_role: 'dispatcher' }, 7), null);
});

test('the Stripe adapter finalizes only succeeded refund objects', () => {
  const { _classifyRefund, _isIndeterminate } = require('../server/payments');
  assert.deepEqual(_classifyRefund({ id: 're_ok', status: 'succeeded' }), {
    ok: true, complete: true, refundId: 're_ok', status: 'succeeded'
  });
  assert.deepEqual(_classifyRefund({ id: 're_wait', status: 'pending' }), {
    ok: false, indeterminate: true, refundId: 're_wait', status: 'pending', error: 'Refund is pending'
  });
  assert.deepEqual(_classifyRefund({ id: 're_bad', status: 'failed', failure_reason: 'lost_or_stolen_card' }), {
    ok: false,
    indeterminate: false,
    refundId: 're_bad',
    status: 'failed',
    error: 'lost_or_stolen_card'
  });
  assert.equal(_isIndeterminate({
    type: 'StripeIdempotencyError',
    code: 'idempotency_key_in_use'
  }), true);
});

test('five concurrent buyers produce exactly four unique purchases and no lost credits', async () => {
  const driver = await createUser();
  const request = await createRequest(driver.id);
  const providers = await Promise.all(Array.from({ length: 5 }, () => createProvider({ credits: 1 })));

  const outcomes = await Promise.allSettled(providers.map(provider =>
    marketplace.purchaseLead({ requestId: request.id, providerId: provider.id })
  ));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 4);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);

  const purchases = await db.q(`
    SELECT provider_id, slot FROM purchases
    WHERE request_id=$1 AND status='succeeded' ORDER BY slot`, [request.id]);
  assert.deepEqual(purchases.map(row => row.slot), [1, 2, 3, 4]);
  assert.equal(new Set(purchases.map(row => row.provider_id)).size, 4);
  const credits = await db.q(`
    SELECT lead_credits FROM providers WHERE user_id=ANY($1::int[])`,
    [providers.map(provider => provider.id)]);
  assert.equal(credits.reduce((sum, row) => sum + row.lead_credits, 0), 1);
});

test('repeated purchase requests replay one purchase and spend one credit', async () => {
  const driver = await createUser();
  const provider = await createProvider({ credits: 1 });
  const request = await createRequest(driver.id);
  const first = await marketplace.purchaseLead({ requestId: request.id, providerId: provider.id });
  const retry = await marketplace.purchaseLead({ requestId: request.id, providerId: provider.id });

  assert.equal(first.justCompleted, true);
  assert.equal(retry.replayed, true);
  assert.equal((await db.q('SELECT COUNT(*)::int n FROM purchases WHERE request_id=$1', [request.id]))[0].n, 1);
  assert.equal((await db.q('SELECT lead_credits FROM providers WHERE user_id=$1', [provider.id]))[0].lead_credits, 0);
  assert.equal((await db.q(`
    SELECT COUNT(*)::int n FROM credit_log WHERE event_key=$1`,
    [`purchase:${first.purchase.id}:spend`]))[0].n, 1);
});

test('a declined card can retry safely with a new attempt key', async () => {
  const driver = await createUser();
  const provider = await createProvider();
  const request = await createRequest(driver.id);
  const payments = fakePayments({ failFirstConfirmation: true });

  await assert.rejects(
    marketplace.purchaseLead({ requestId: request.id, providerId: provider.id, paymentsApi: payments }),
    error => error.status === 402
  );
  const result = await marketplace.purchaseLead({
    requestId: request.id,
    providerId: provider.id,
    paymentsApi: payments
  });
  assert.equal(result.purchase.status, 'succeeded');
  assert.equal(result.purchase.payment_attempts, 2);
  assert.equal(new Set(payments.createdKeys).size, 2);
  assert.notEqual(payments.createdKeys[0], payments.createdKeys[1]);
  assert.equal((await db.q('SELECT COUNT(*)::int n FROM purchases WHERE request_id=$1', [request.id]))[0].n, 1);
});

test('an indeterminate confirmation resumes the same payment without a second charge attempt', async () => {
  const driver = await createUser();
  const provider = await createProvider();
  const request = await createRequest(driver.id);
  const payments = fakePayments();
  const originalConfirm = payments.confirmLeadPayment;
  let first = true;
  payments.confirmLeadPayment = async (...args) => {
    if (first) {
      first = false;
      payments.confirmedKeys.push(args[2].idempotencyKey);
      return { ok: false, indeterminate: true, error: 'Connection closed after confirmation' };
    }
    return originalConfirm(...args);
  };

  await assert.rejects(
    marketplace.purchaseLead({ requestId: request.id, providerId: provider.id, paymentsApi: payments }),
    error => error.status === 503
  );
  const pending = (await db.q('SELECT * FROM purchases WHERE request_id=$1', [request.id]))[0];
  assert.equal(pending.status, 'pending');
  const resumed = await marketplace.purchaseLead({
    requestId: request.id,
    providerId: provider.id,
    paymentsApi: payments
  });
  assert.equal(resumed.purchase.status, 'succeeded');
  assert.equal(resumed.purchase.payment_attempts, 1);
  assert.equal(payments.createdKeys.length, 1);
  assert.equal(new Set(payments.confirmedKeys).size, 1);
});

test('a delayed old payment worker cannot overwrite or charge a newer attempt', async () => {
  const driver = await createUser();
  const provider = await createProvider();
  const request = await createRequest(driver.id);
  let releaseOldCreate;
  let releaseNewCreate;
  let announceOldCreate;
  let announceNewCreate;
  const oldCreateStarted = new Promise(resolve => { announceOldCreate = resolve; });
  const newCreateStarted = new Promise(resolve => { announceNewCreate = resolve; });
  const oldCreateGate = new Promise(resolve => { releaseOldCreate = resolve; });
  const newCreateGate = new Promise(resolve => { releaseNewCreate = resolve; });
  const createKeys = [];
  const confirms = [];
  const successfulPayments = [];
  const canceled = [];
  let oldConfirmations = 0;

  const payments = {
    SIMULATED: () => false,
    async createLeadPayment(providerRow, amount, description, { idempotencyKey }) {
      createKeys.push(idempotencyKey);
      if (idempotencyKey.endsWith('attempt-2')) {
        announceNewCreate();
        await newCreateGate;
        return { ok: true, paymentId: 'pi_attempt_2' };
      }
      if (createKeys.filter(key => key === idempotencyKey).length === 1) {
        announceOldCreate();
        await oldCreateGate;
      }
      return { ok: true, paymentId: 'pi_attempt_1' };
    },
    async confirmLeadPayment(paymentId, providerRow, { idempotencyKey }) {
      confirms.push({ paymentId, idempotencyKey });
      if (paymentId === 'pi_attempt_1') {
        oldConfirmations += 1;
        if (oldConfirmations === 1) return { ok: false, paymentId, error: 'declined' };
      }
      successfulPayments.push(paymentId);
      return { ok: true, paymentId, status: 'succeeded' };
    },
    async cancelPayment(paymentId) {
      canceled.push(paymentId);
      return { ok: true, status: 'canceled' };
    },
    async refund() {
      throw new Error('not used');
    }
  };

  const delayedOld = marketplace.purchaseLead({
    requestId: request.id,
    providerId: provider.id,
    paymentsApi: payments
  });
  await oldCreateStarted;

  await assert.rejects(
    marketplace.purchaseLead({ requestId: request.id, providerId: provider.id, paymentsApi: payments }),
    error => error.status === 402
  );

  const newer = marketplace.purchaseLead({
    requestId: request.id,
    providerId: provider.id,
    paymentsApi: payments
  });
  await newCreateStarted;
  releaseOldCreate();
  await assert.rejects(delayedOld, error => error.status === 409);
  releaseNewCreate();
  const completed = await newer;

  assert.equal(completed.purchase.status, 'succeeded');
  assert.equal(completed.purchase.payment_attempts, 2);
  assert.equal(completed.purchase.stripe_payment, 'pi_attempt_2');
  assert.deepEqual(successfulPayments, ['pi_attempt_2']);
  assert.equal(confirms.filter(call => call.paymentId === 'pi_attempt_1').length, 1);
  assert.deepEqual(canceled, ['pi_attempt_1']);
  assert.deepEqual(createKeys.map(key => key.match(/attempt-\d+$/)[0]),
    ['attempt-1', 'attempt-1', 'attempt-2']);
});

test('a delayed same-attempt creation error cannot invalidate a bound charge', async () => {
  const driver = await createUser();
  const provider = await createProvider();
  const request = await createRequest(driver.id);
  let announceDelayedCreate;
  let releaseDelayedError;
  const delayedCreateStarted = new Promise(resolve => { announceDelayedCreate = resolve; });
  const delayedErrorGate = new Promise(resolve => { releaseDelayedError = resolve; });
  let createCalls = 0;
  let confirmCalls = 0;
  const charged = [];

  const payments = {
    SIMULATED: () => false,
    async createLeadPayment() {
      createCalls += 1;
      if (createCalls === 1) {
        announceDelayedCreate();
        await delayedErrorGate;
        return { ok: false, error: 'Keys for idempotent requests can only be used with the same parameters' };
      }
      return { ok: true, paymentId: 'pi_same_attempt' };
    },
    async confirmLeadPayment(paymentId) {
      confirmCalls += 1;
      if (confirmCalls === 1) {
        charged.push(paymentId);
        return { ok: false, indeterminate: true, paymentId, error: 'Connection lost after confirmation' };
      }
      return { ok: true, paymentId, status: 'succeeded' };
    },
    async cancelPayment() {
      return { ok: true, status: 'canceled' };
    },
    async refund() {
      throw new Error('not used');
    }
  };

  const delayedError = marketplace.purchaseLead({
    requestId: request.id,
    providerId: provider.id,
    paymentsApi: payments
  });
  await delayedCreateStarted;
  await assert.rejects(
    marketplace.purchaseLead({ requestId: request.id, providerId: provider.id, paymentsApi: payments }),
    error => error.status === 503
  );
  releaseDelayedError();
  await assert.rejects(delayedError, error => error.status === 503);

  const pending = (await db.q('SELECT * FROM purchases WHERE request_id=$1', [request.id]))[0];
  assert.equal(pending.status, 'pending');
  assert.equal(pending.stripe_payment, 'pi_same_attempt');
  assert.equal(pending.payment_attempts, 1);

  const resumed = await marketplace.purchaseLead({
    requestId: request.id,
    providerId: provider.id,
    paymentsApi: payments
  });
  assert.equal(resumed.purchase.status, 'succeeded');
  assert.equal(resumed.purchase.stripe_payment, 'pi_same_attempt');
  assert.equal(resumed.purchase.payment_attempts, 1);
  assert.equal(createCalls, 2);
  assert.deepEqual(charged, ['pi_same_attempt']);
});

test('drivers can select only an active provider with a successful purchase', async () => {
  const driver = await createUser();
  const provider = await createProvider();
  const request = await createRequest(driver.id);

  await assert.rejects(
    marketplace.selectProvider({ requestId: request.id, driverId: driver.id, providerId: provider.id }),
    error => error.status === 403
  );
  await marketplace.purchaseLead({
    requestId: request.id,
    providerId: provider.id,
    paymentsApi: fakePayments()
  });
  const selected = await marketplace.selectProvider({
    requestId: request.id,
    driverId: driver.id,
    providerId: provider.id
  });
  assert.equal(selected.status, 'selected');
  assert.equal(selected.selected_provider, provider.id);
});

test('concurrent credit refunds restore one credit and one ledger event', async () => {
  const driver = await createUser();
  const provider = await createProvider({ credits: 1 });
  const request = await createRequest(driver.id);
  const bought = await marketplace.purchaseLead({ requestId: request.id, providerId: provider.id });

  const refunds = await Promise.all([
    marketplace.refundPurchase({ purchaseId: bought.purchase.id }),
    marketplace.refundPurchase({ purchaseId: bought.purchase.id })
  ]);
  assert.equal(refunds.filter(result => result.replayed).length, 1);
  assert.equal((await db.q('SELECT lead_credits FROM providers WHERE user_id=$1', [provider.id]))[0].lead_credits, 1);
  assert.equal((await db.q(`
    SELECT COUNT(*)::int n FROM credit_log WHERE event_key=$1`,
    [`purchase:${bought.purchase.id}:refund`]))[0].n, 1);
});

test('card refunds use one deterministic provider idempotency key', async () => {
  const driver = await createUser();
  const provider = await createProvider();
  const request = await createRequest(driver.id);
  const payments = fakePayments();
  const bought = await marketplace.purchaseLead({
    requestId: request.id,
    providerId: provider.id,
    paymentsApi: payments
  });

  await Promise.all([
    marketplace.refundPurchase({ purchaseId: bought.purchase.id, paymentsApi: payments }),
    marketplace.refundPurchase({ purchaseId: bought.purchase.id, paymentsApi: payments })
  ]);
  assert.equal(new Set(payments.refundKeys).size, 1);
  assert.equal((await db.q('SELECT refunded FROM purchases WHERE id=$1', [bought.purchase.id]))[0].refunded, true);
});

test('an indeterminate refund stays pending and reconciliation completes it', async () => {
  const driver = await createUser();
  const provider = await createProvider();
  const request = await createRequest(driver.id);
  const payments = fakePayments();
  const bought = await marketplace.purchaseLead({
    requestId: request.id,
    providerId: provider.id,
    paymentsApi: payments
  });
  const originalRefund = payments.refund;
  let first = true;
  payments.refund = async (...args) => {
    if (first) {
      first = false;
      payments.refundKeys.push(args[1].idempotencyKey);
      payments.refundRequests.push({ paymentId: args[0], ...args[1] });
      return {
        ok: false,
        indeterminate: true,
        refundId: 're_pending',
        status: 'pending',
        error: 'Refund is pending'
      };
    }
    return originalRefund(...args);
  };

  await assert.rejects(
    marketplace.refundPurchase({ purchaseId: bought.purchase.id, paymentsApi: payments }),
    error => error.status === 503
  );
  assert.equal((await db.q('SELECT refund_status FROM purchases WHERE id=$1', [bought.purchase.id]))[0].refund_status, 'pending');
  const report = await marketplace.reconcilePayments({ paymentsApi: payments });
  assert.deepEqual(report.refunds, [bought.purchase.id]);
  assert.equal(new Set(payments.refundKeys).size, 1);
  assert.equal(payments.refundRequests[1].refundId, 're_pending');
  assert.equal((await db.q('SELECT refunded FROM purchases WHERE id=$1', [bought.purchase.id]))[0].refunded, true);
});

test('a selected winning purchase cannot be refunded out from under the job', async () => {
  const driver = await createUser();
  const provider = await createProvider({ credits: 1 });
  const request = await createRequest(driver.id);
  const bought = await marketplace.purchaseLead({ requestId: request.id, providerId: provider.id });
  await marketplace.selectProvider({ requestId: request.id, driverId: driver.id, providerId: provider.id });
  await assert.rejects(
    marketplace.refundPurchase({ purchaseId: bought.purchase.id }),
    error => error.status === 409 && /assigned to the job/.test(error.message)
  );
  assert.equal((await db.q('SELECT refunded FROM purchases WHERE id=$1', [bought.purchase.id]))[0].refunded, false);
});

test('reconciliation reverses a charge that succeeded after its lead closed', async () => {
  const driver = await createUser();
  const provider = await createProvider();
  const request = await createRequest(driver.id);
  const purchase = (await db.q(`
    INSERT INTO purchases
      (request_id, provider_id, slot, amount_cents, premium, stripe_payment, paid_with,
       list_price_cents, status, payment_attempts, idempotency_key)
    VALUES ($1,$2,1,3000,FALSE,'pi_late_success','card',3000,'pending',1,$3) RETURNING *`,
    [request.id, provider.id, `late-success-${request.id}`]))[0];
  await db.q('UPDATE requests SET status=$1 WHERE id=$2', ['canceled', request.id]);
  const payments = fakePayments();
  payments.cancelPayment = async () => ({
    ok: false,
    status: 'succeeded',
    alreadySucceeded: true,
    error: 'Payment already succeeded'
  });

  const report = await marketplace.reconcilePayments({ paymentsApi: payments });
  assert.equal(report.errors.length, 1);
  assert.equal(payments.refundKeys[0], `rigrx-refund-purchase-${purchase.id}`);
  const repaired = (await db.q(`
    SELECT status, refunded, refund_status FROM purchases WHERE id=$1`, [purchase.id]))[0];
  assert.deepEqual(repaired, { status: 'failed', refunded: true, refund_status: 'succeeded' });
});

test('closed-lead refund recovery keeps one key and resumes by Stripe refund ID', async () => {
  const driver = await createUser();
  const provider = await createProvider();
  const request = await createRequest(driver.id);
  const purchase = (await db.q(`
    INSERT INTO purchases
      (request_id, provider_id, slot, amount_cents, premium, stripe_payment, paid_with,
       list_price_cents, status, payment_attempts, idempotency_key)
    VALUES ($1,$2,1,3000,FALSE,'pi_late_pending_refund','card',3000,'pending',1,$3) RETURNING *`,
    [request.id, provider.id, `late-pending-refund-${request.id}`]))[0];
  await db.q('UPDATE requests SET status=$1 WHERE id=$2', ['canceled', request.id]);
  const payments = fakePayments();
  payments.cancelPayment = async () => ({
    ok: false,
    status: 'succeeded',
    alreadySucceeded: true,
    error: 'Payment already succeeded'
  });
  const originalRefund = payments.refund;
  let first = true;
  payments.refund = async (...args) => {
    if (first) {
      first = false;
      payments.refundKeys.push(args[1].idempotencyKey);
      payments.refundRequests.push({ paymentId: args[0], ...args[1] });
      return {
        ok: false,
        indeterminate: true,
        refundId: 're_late_pending',
        status: 'pending',
        error: 'Refund is pending'
      };
    }
    return originalRefund(...args);
  };

  const firstPass = await marketplace.reconcilePayments({ paymentsApi: payments });
  assert.equal(firstPass.errors.length, 1);
  assert.deepEqual(firstPass.refunds, [purchase.id]);
  const repaired = (await db.q(`
    SELECT status, refunded, refund_status, refund_idempotency_key, stripe_refund
    FROM purchases WHERE id=$1`, [purchase.id]))[0];
  assert.deepEqual(repaired, {
    status: 'succeeded',
    refunded: true,
    refund_status: 'succeeded',
    refund_idempotency_key: `rigrx-refund-purchase-${purchase.id}`,
    stripe_refund: 're_late_pending'
  });
  assert.equal(new Set(payments.refundKeys).size, 1);
  assert.equal(payments.refundRequests[1].refundId, 're_late_pending');
});

test('archiving a company owner invalidates member sessions', async () => {
  const owner = await createProvider();
  const member = await createUser('provider', { company_id: owner.id, member_role: 'dispatcher' });
  const token = await auth.createSession(member.id);

  const before = { cookies: { rigrx_session: token } };
  await new Promise(resolve => auth.attachUser(before, {}, resolve));
  assert.equal(before.user.id, member.id);

  await db.q('UPDATE users SET archived_at=NOW() WHERE id=$1', [owner.id]);
  const after = { cookies: { rigrx_session: token } };
  await new Promise(resolve => auth.attachUser(after, {}, resolve));
  assert.equal(after.user, null);
});

test('ending a session closes its registered WebSocket immediately', async () => {
  class FakeSocket extends EventEmitter {
    close(code) {
      this.closeCode = code;
      this.emit('close');
    }
    send() {}
  }
  const user = await createUser();
  const token = await auth.createSession(user.id);
  const socket = new FakeSocket();
  notify.wsRegister(user.id, socket, token);
  await auth.endSession(token);
  assert.equal(socket.closeCode, 4001);
});

test('archiving a user closes all of their registered WebSockets', async () => {
  class FakeSocket extends EventEmitter {
    close(code) {
      this.closeCode = code;
      this.emit('close');
    }
    send() {}
  }
  const user = await createUser();
  const socket = new FakeSocket();
  notify.wsRegister(user.id, socket, 'archive-test-token');
  notify.wsRevokeUser(user.id);
  assert.equal(socket.closeCode, 4001);
});

test('private upload routes enforce authentication and ownership', async t => {
  const owner = await createUser();
  const stranger = await createUser();
  const ownerToken = await auth.createSession(owner.id);
  const strangerToken = await auth.createSession(stranger.id);
  const filename = `${crypto.randomBytes(8).toString('hex')}.pdf`;
  const diskPath = path.join(__dirname, '..', 'uploads', filename);
  await fs.mkdir(path.dirname(diskPath), { recursive: true });
  await fs.writeFile(diskPath, 'private verification document');
  t.after(() => fs.unlink(diskPath).catch(() => {}));
  await db.q(`
    INSERT INTO uploads (file_name, original_name, mime_type, owner_id)
    VALUES ($1,'verification.pdf','application/pdf',$2)`,
    [filename, owner.id]);

  assert.equal((await fetch(`${apiBase}/api/uploads/${filename}`)).status, 401);
  assert.equal((await fetch(`${apiBase}/api/uploads/${filename}`, {
    headers: { Cookie: `rigrx_session=${strangerToken}` }
  })).status, 403);
  const allowed = await fetch(`${apiBase}/api/uploads/${filename}`, {
    headers: { Cookie: `rigrx_session=${ownerToken}` }
  });
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), 'private verification document');
});

test('provider self-service payloads omit internal and payment identifiers', async () => {
  const provider = await createProvider();
  await db.q(`
    UPDATE providers SET admin_notes='internal only', stripe_customer='cus_secret',
      stripe_pm='pm_secret' WHERE user_id=$1`, [provider.id]);
  const token = await auth.createSession(provider.id);
  const response = await fetch(`${apiBase}/api/me`, {
    headers: { Cookie: `rigrx_session=${token}` }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider.admin_notes, undefined);
  assert.equal(body.provider.stripe_customer, undefined);
  assert.equal(body.provider.stripe_pm, undefined);
  assert.equal(body.provider.has_payment_method, true);
});

test('team member API rejects takeover of an existing driver account', async () => {
  const owner = await createProvider();
  const driver = await createUser();
  const token = await auth.createSession(owner.id);
  const response = await fetch(`${apiBase}/api/provider/members`, {
    method: 'POST',
    headers: {
      Cookie: `rigrx_session=${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ phone: driver.phone, name: 'Not allowed', member_role: 'tech' })
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /different account type/);
  assert.equal((await db.q('SELECT role FROM users WHERE id=$1', [driver.id]))[0].role, 'driver');
});

test('archiving a company through the API revokes member sessions and sockets', async () => {
  class FakeSocket extends EventEmitter {
    close(code) {
      this.closeCode = code;
      this.emit('close');
    }
    send() {}
  }
  const admin = await createUser('admin');
  const owner = await createProvider();
  const member = await createUser('provider', { company_id: owner.id, member_role: 'dispatcher' });
  const adminToken = await auth.createSession(admin.id);
  const memberToken = await auth.createSession(member.id);
  const socket = new FakeSocket();
  notify.wsRegister(member.id, socket, memberToken);

  const response = await fetch(`${apiBase}/api/admin/users/${owner.id}/archive`, {
    method: 'POST',
    headers: {
      Cookie: `rigrx_session=${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ reason: 'Test archive' })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).archived_accounts, 2);
  const archived = await db.q(`
    SELECT id, archived_at IS NOT NULL AS archived, archived_by_company
    FROM users WHERE id=ANY($1::int[]) ORDER BY id`, [[owner.id, member.id]]);
  assert.equal(archived.every(row => row.archived), true);
  assert.equal(archived.find(row => row.id === member.id).archived_by_company, true);
  assert.equal((await db.q('SELECT COUNT(*)::int n FROM sessions WHERE token=$1', [memberToken]))[0].n, 0);
  assert.equal(socket.closeCode, 4001);
});

test('migration repairs duplicate legacy responder slots before adding the unique index', async () => {
  const driver = await createUser();
  const request = await createRequest(driver.id);
  const providers = await Promise.all([createProvider(), createProvider()]);
  await db.q('DROP INDEX uq_purchases_active_slot');
  await db.q(`
    INSERT INTO purchases
      (request_id, provider_id, slot, amount_cents, premium, paid_with, status)
    VALUES ($1,$2,1,2000,FALSE,'card','succeeded'),
           ($1,$3,1,2000,FALSE,'card','succeeded')`,
    [request.id, providers[0].id, providers[1].id]);
  await db.migrate();
  const slots = await db.q(`
    SELECT slot FROM purchases WHERE request_id=$1 ORDER BY slot`, [request.id]);
  assert.deepEqual(slots.map(row => row.slot), [1, 2]);
});

async function createDispatchFixture() {
  const driver = await createUser('driver', { name: 'Stranded driver' });
  const owner = await createProvider();
  const tech1 = await createUser('provider', {
    name: 'Tech One',
    company_id: owner.id,
    member_role: 'tech'
  });
  const tech2 = await createUser('provider', {
    name: 'Tech Two',
    company_id: owner.id,
    member_role: 'tech'
  });
  await db.q('UPDATE users SET assignable=TRUE WHERE id=ANY($1::int[])', [[tech1.id, tech2.id]]);
  const request = await createRequest(driver.id);
  await db.q(`
    UPDATE requests SET status='selected', selected_provider=$1, selected_at=NOW(),
      job_state='unassigned', job_activity_at=NOW()
    WHERE id=$2`, [owner.id, request.id]);
  return { driver, owner, tech1, tech2, request };
}

test('dispatch lifecycle rejects skipped steps and fences stale technician actions', async () => {
  const f = await createDispatchFixture();
  const first = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `test_assign_first_${f.request.id}`
  });
  assert.equal(first.request.job_state, 'assigned');
  const v1 = first.request.assignment_version;
  assert.equal((await db.one(`
    SELECT COUNT(*)::int n FROM notifications_log
    WHERE request_id=$1 AND event_type='job_assigned'
      AND dedupe_key=$2 AND status='pending'`,
    [f.request.id, `request:${f.request.id}:assigned:v${v1}:tech:${f.tech1.id}`])).n, 1);

  await assert.rejects(
    dispatch.techAction({
      requestId: f.request.id,
      techId: f.tech1.id,
      assignmentVersion: v1,
      action: 'enroute',
      etaMinutes: 20
    }),
    error => error.status === 409 && /while it is assigned/.test(error.message)
  );
  await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech1.id,
    assignmentVersion: v1,
    action: 'accept'
  });

  const reassigned = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech2.id,
    expectedAssignmentVersion: v1,
    commandKey: `test_reassign_second_${f.request.id}`
  });
  assert.equal(reassigned.request.job_state, 'assigned');
  assert.equal(reassigned.request.assignment_version, v1 + 1);
  await assert.rejects(
    dispatch.techAction({
      requestId: f.request.id,
      techId: f.tech1.id,
      assignmentVersion: v1,
      action: 'decline'
    }),
    error => error.status === 409 && /no longer assigned/.test(error.message)
  );

  const v2 = reassigned.request.assignment_version;
  await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech2.id,
    assignmentVersion: v2,
    action: 'accept'
  });
  await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech2.id,
    assignmentVersion: v2,
    action: 'enroute',
    etaMinutes: 25
  });
  await assert.rejects(
    dispatch.techAction({
      requestId: f.request.id,
      techId: f.tech2.id,
      assignmentVersion: v2,
      action: 'complete'
    }),
    error => error.status === 409 && /while it is enroute/.test(error.message)
  );
  await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech2.id,
    assignmentVersion: v2,
    action: 'arrived'
  });
  const completed = await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech2.id,
    assignmentVersion: v2,
    action: 'complete'
  });
  assert.equal(completed.request.status, 'completed');
  assert.equal(completed.request.job_state, 'completed');
  assert.equal((await db.one('SELECT jobs_won FROM providers WHERE user_id=$1', [f.owner.id])).jobs_won, 1);
  const replay = await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech2.id,
    assignmentVersion: v2,
    action: 'complete'
  });
  assert.equal(replay.replayed, true);
  assert.equal((await db.one('SELECT jobs_won FROM providers WHERE user_id=$1', [f.owner.id])).jobs_won, 1);
});

test('decline and timeout visibly return an assignment to dispatch', async () => {
  const declined = await createDispatchFixture();
  const assigned = await dispatch.assignJob({
    requestId: declined.request.id,
    companyId: declined.owner.id,
    actorId: declined.owner.id,
    techId: declined.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `test_assign_decline_${declined.request.id}`
  });
  const result = await dispatch.techAction({
    requestId: declined.request.id,
    techId: declined.tech1.id,
    assignmentVersion: assigned.request.assignment_version,
    action: 'decline',
    reason: 'Truck unavailable'
  });
  assert.equal(result.request.job_state, 'unassigned');
  assert.equal(result.request.assigned_tech, null);
  assert.equal(result.request.assign_bounced, true);
  assert.equal(result.request.assignment_bounces, 1);
  assert.equal(result.request.assignment_version, assigned.request.assignment_version + 1);

  const timed = await createDispatchFixture();
  const timedAssignment = await dispatch.assignJob({
    requestId: timed.request.id,
    companyId: timed.owner.id,
    actorId: timed.owner.id,
    techId: timed.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `test_assign_timeout_${timed.request.id}`
  });
  await db.q(`UPDATE requests SET assigned_at=NOW()-INTERVAL '6 minutes' WHERE id=$1`,
    [timed.request.id]);
  const swept = await dispatch.bounceUnacceptedJobs();
  assert.equal(swept.some(row => row.id === timed.request.id), true);
  const after = await db.one('SELECT * FROM requests WHERE id=$1', [timed.request.id]);
  assert.equal(after.job_state, 'unassigned');
  assert.equal(after.assigned_tech, null);
  assert.equal(after.assignment_version, timedAssignment.request.assignment_version + 1);
});

test('driver cannot complete a selected job before arrival', async () => {
  const f = await createDispatchFixture();
  await assert.rejects(
    dispatch.completeByDriver({ requestId: f.request.id, driverId: f.driver.id }),
    error => error.status === 409 && /must arrive/.test(error.message)
  );
});

test('request API rejects stale GPS and requires a landmark for manual location', async () => {
  const driver = await createUser('driver');
  const token = await auth.createSession(driver.id);
  const base = {
    service_key: 'mechanic',
    lat: 35,
    lng: -119,
    location_source: 'device',
    location_captured_at: new Date(Date.now() - 20 * 60 * 1000).toISOString()
  };
  const stale = await fetch(`${apiBase}/api/requests`, {
    method: 'POST',
    headers: { Cookie: `rigrx_session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(base)
  });
  assert.equal(stale.status, 400);
  assert.match((await stale.json()).error, /stale/);

  const noLandmark = await fetch(`${apiBase}/api/requests`, {
    method: 'POST',
    headers: { Cookie: `rigrx_session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, location_source: 'manual', location_captured_at: new Date().toISOString() })
  });
  assert.equal(noLandmark.status, 400);
  assert.match((await noLandmark.json()).error, /landmark/);

  const manual = await fetch(`${apiBase}/api/requests`, {
    method: 'POST',
    headers: { Cookie: `rigrx_session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...base,
      location_source: 'manual',
      location_captured_at: new Date().toISOString(),
      landmark: 'I-5 northbound mile marker 253'
    })
  });
  assert.equal(manual.status, 200);
  assert.equal((await manual.json()).request.location_source, 'manual');
});

test('failed notifications stay observable and retry with the same durable record', async () => {
  const f = await createDispatchFixture();
  notify._setTwilioClient({
    messages: { create: async () => { throw new Error('carrier unavailable'); } }
  });
  process.env.TWILIO_FROM_NUMBER = '+16615550000';
  const key = `test:notification-retry:${f.request.id}`;
  const first = await notify.sms(f.driver.id, f.driver.phone, 'Dispatch update', {
    requestId: f.request.id,
    eventType: 'test_dispatch_update',
    dedupeKey: key
  });
  assert.equal(first.status, 'pending');
  let row = await db.one('SELECT * FROM notifications_log WHERE dedupe_key=$1', [key]);
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /carrier unavailable/);
  assert.equal((await db.one(`
    SELECT COUNT(*)::int n FROM dispatch_exceptions
    WHERE request_id=$1 AND type='notification_failure' AND status='open'`,
    [f.request.id])).n, 1);

  notify._setTwilioClient({
    messages: { create: async () => ({ sid: 'SM_RETRIED' }) }
  });
  await db.q(`UPDATE notifications_log SET available_at=NOW() WHERE id=$1`, [row.id]);
  const retried = await notify.processNotificationOutbox({ onlyId: row.id, limit: 1 });
  assert.equal(retried[0].status, 'sent');
  row = await db.one('SELECT * FROM notifications_log WHERE id=$1', [row.id]);
  assert.equal(row.status, 'sent');
  assert.equal(row.attempts, 2);
  assert.equal(row.provider_message_id, 'SM_RETRIED');
  notify._setTwilioClient(null);
  delete process.env.TWILIO_FROM_NUMBER;
});

test('provider selection atomically queues the win notice for owner and dispatchers', async () => {
  const driver = await createUser('driver');
  const owner = await createProvider();
  const dispatcher = await createUser('provider', {
    name: 'Night dispatcher',
    company_id: owner.id,
    member_role: 'dispatcher'
  });
  const request = await createRequest(driver.id);
  await db.q(`
    INSERT INTO purchases
      (request_id,provider_id,slot,amount_cents,premium,paid_with,status,refund_status)
    VALUES ($1,$2,1,2500,FALSE,'card','succeeded','none')`,
    [request.id, owner.id]);
  const selected = await marketplace.selectProvider({
    requestId: request.id,
    driverId: driver.id,
    providerId: owner.id
  });
  assert.equal(selected.status, 'selected');
  assert.deepEqual(selected.winnerRecipients.sort((a, b) => a - b),
    [owner.id, dispatcher.id].sort((a, b) => a - b));
  const queued = await db.q(`
    SELECT user_id, status FROM notifications_log
    WHERE request_id=$1 AND event_type='provider_selected'
    ORDER BY user_id`, [request.id]);
  assert.deepEqual(queued.map(row => row.user_id), [owner.id, dispatcher.id].sort((a, b) => a - b));
  assert.equal(queued.every(row => row.status === 'pending'), true);
});

test('no-response and stalled exception alarms can rearm after new activity', async () => {
  const driver = await createUser('driver');
  const open = await createRequest(driver.id);
  await db.q(`
    UPDATE requests SET notified_count=2, last_notified_at=NOW()-INTERVAL '11 minutes',
      silent_alerted=FALSE WHERE id=$1`, [open.id]);
  await routes.sweepMarketplace();
  assert.equal((await db.one(`
    SELECT COUNT(*)::int n FROM dispatch_exceptions
    WHERE request_id=$1 AND type='no_response' AND status='open'`, [open.id])).n, 1);
  await dispatch.resolveException(open.id, 'no_response', 'Test acknowledgement of activity');
  await db.q(`
    UPDATE requests SET last_notified_at=NOW()-INTERVAL '11 minutes',
      silent_alerted=FALSE WHERE id=$1`, [open.id]);
  await routes.sweepMarketplace();
  assert.equal((await db.one(`
    SELECT COUNT(*)::int n FROM dispatch_exceptions
    WHERE request_id=$1 AND type='no_response' AND status='open'`, [open.id])).n, 1);
  assert.equal((await db.one(`
    SELECT COUNT(*)::int n FROM notifications_log
    WHERE request_id=$1 AND event_type='request_silent_alarm'`, [open.id])).n, 2);

  const selected = await createDispatchFixture();
  await db.q(`
    UPDATE requests SET selected_at=NOW()-INTERVAL '16 minutes',
      job_activity_at=NOW()-INTERVAL '16 minutes', stall_alerted=FALSE
    WHERE id=$1`, [selected.request.id]);
  await routes.sweepMarketplace();
  assert.equal((await db.one(`
    SELECT COUNT(*)::int n FROM dispatch_exceptions
    WHERE request_id=$1 AND type='stalled' AND status='open'`, [selected.request.id])).n, 1);
  const assignment = await dispatch.assignJob({
    requestId: selected.request.id,
    companyId: selected.owner.id,
    actorId: selected.owner.id,
    techId: selected.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `test_assign_rearm_${selected.request.id}`
  });
  assert.equal(assignment.request.stall_alerted, false);
  assert.equal((await db.one(`
    SELECT COUNT(*)::int n FROM dispatch_exceptions
    WHERE request_id=$1 AND type='stalled' AND status='open'`, [selected.request.id])).n, 1);
});

test('delayed dispatcher commands cannot overwrite a newer assignment', async () => {
  const f = await createDispatchFixture();
  const firstKey = `delayed_assign_first_${f.request.id}`;
  const first = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: firstKey
  });
  const second = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech2.id,
    expectedAssignmentVersion: first.request.assignment_version,
    commandKey: `delayed_assign_second_${f.request.id}`
  });

  await assert.rejects(
    dispatch.assignJob({
      requestId: f.request.id,
      companyId: f.owner.id,
      actorId: f.owner.id,
      techId: f.tech1.id,
      expectedAssignmentVersion: 0,
      commandKey: `delayed_assign_old_new_key_${f.request.id}`
    }),
    error => error.status === 409 && /changed/.test(error.message)
  );
  const replay = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: firstKey
  });
  assert.equal(replay.commandReplayed, true);
  assert.equal(replay.request.assigned_tech, f.tech2.id);

  await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech2.id,
    assignmentVersion: second.request.assignment_version,
    action: 'accept'
  });
  const duplicateSameTech = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech2.id,
    expectedAssignmentVersion: second.request.assignment_version,
    commandKey: `assign_same_after_accept_${f.request.id}`
  });
  assert.equal(duplicateSameTech.replayed, true);
  assert.equal(duplicateSameTech.request.job_state, 'accepted');
});

test('technician removal atomically fences concurrent technician actions', async () => {
  const f = await createDispatchFixture();
  const assigned = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `race_assign_before_remove_${f.request.id}`
  });
  const [removal, action] = await Promise.allSettled([
    dispatch.unassignTechnician({
      techId: f.tech1.id,
      actorId: f.owner.id,
      userChanges: {
        memberRole: 'tech',
        assignable: false,
        memberLocationId: null,
        archive: true,
        archiveReason: 'Removed in race test'
      }
    }),
    dispatch.techAction({
      requestId: f.request.id,
      techId: f.tech1.id,
      assignmentVersion: assigned.request.assignment_version,
      action: 'accept'
    })
  ]);
  assert.equal(removal.status, 'fulfilled');
  assert.equal(['fulfilled', 'rejected'].includes(action.status), true);
  const request = await db.one('SELECT * FROM requests WHERE id=$1', [f.request.id]);
  const tech = await db.one('SELECT * FROM users WHERE id=$1', [f.tech1.id]);
  assert.equal(request.job_state, 'unassigned');
  assert.equal(request.assigned_tech, null);
  assert.equal(tech.assignable, false);
  assert.ok(tech.archived_at);
});

test('migration returns legacy non-technician assignments to dispatch', async () => {
  const f = await createDispatchFixture();
  await db.q(`
    UPDATE requests SET assigned_tech=$1, assigned_at=NOW(), accepted_at=NOW(),
      enroute_at=NOW(), job_state='enroute'
    WHERE id=$2`, [f.owner.id, f.request.id]);
  await db.migrate();
  const request = await db.one('SELECT * FROM requests WHERE id=$1', [f.request.id]);
  assert.equal(request.job_state, 'unassigned');
  assert.equal(request.assigned_tech, null);
  assert.equal((await db.one(`
    SELECT COUNT(*)::int n FROM job_events
    WHERE request_id=$1 AND event_type='legacy_assignment_recovered'`, [f.request.id])).n, 1);
  assert.equal((await db.one(`
    SELECT COUNT(*)::int n FROM dispatch_exceptions
    WHERE request_id=$1 AND type='assignment_bounced' AND status='open'`, [f.request.id])).n, 1);
});

test('migration preserves legacy on-scene work for safe driver completion', async () => {
  const f = await createDispatchFixture();
  await db.q(`
    UPDATE requests SET assigned_tech=$1, assigned_at=NOW(), accepted_at=NOW(),
      enroute_at=NOW(), arrived_at=NOW(), job_state='arrived'
    WHERE id=$2`, [f.owner.id, f.request.id]);
  await db.migrate();
  let request = await db.one('SELECT * FROM requests WHERE id=$1', [f.request.id]);
  assert.equal(request.job_state, 'arrived');
  assert.equal(request.assigned_tech, f.owner.id);
  assert.ok(request.arrived_at);
  assert.equal((await db.one(`
    SELECT COUNT(*)::int n FROM job_events
    WHERE request_id=$1 AND event_type='legacy_assignment_recovered'`, [f.request.id])).n, 0);

  const driverToken = await auth.createSession(f.driver.id);
  for (const action of ['cancel', 'reopen']) {
    const blocked = await fetch(`${apiBase}/api/requests/${f.request.id}/${action}`, {
      method: 'POST',
      headers: { Cookie: `rigrx_session=${driverToken}` }
    });
    assert.equal(blocked.status, 409);
  }
  const completed = await fetch(`${apiBase}/api/requests/${f.request.id}/complete`, {
    method: 'POST',
    headers: { Cookie: `rigrx_session=${driverToken}` }
  });
  assert.equal(completed.status, 200);
  request = await db.one('SELECT * FROM requests WHERE id=$1', [f.request.id]);
  assert.equal(request.status, 'completed');
  assert.equal(request.job_state, 'completed');
});

test('decline, timeout, and removal each invalidate prepared assignment commands', async () => {
  const declined = await createDispatchFixture();
  const dAssigned = await dispatch.assignJob({
    requestId: declined.request.id,
    companyId: declined.owner.id,
    actorId: declined.owner.id,
    techId: declined.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `revocation_decline_assign_${declined.request.id}`
  });
  await dispatch.techAction({
    requestId: declined.request.id,
    techId: declined.tech1.id,
    assignmentVersion: dAssigned.request.assignment_version,
    action: 'decline'
  });
  await assert.rejects(dispatch.assignJob({
    requestId: declined.request.id,
    companyId: declined.owner.id,
    actorId: declined.owner.id,
    techId: declined.tech1.id,
    expectedAssignmentVersion: dAssigned.request.assignment_version,
    commandKey: `prepared_before_decline_${declined.request.id}`
  }), error => error.status === 409);

  const timed = await createDispatchFixture();
  const tAssigned = await dispatch.assignJob({
    requestId: timed.request.id,
    companyId: timed.owner.id,
    actorId: timed.owner.id,
    techId: timed.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `revocation_timeout_assign_${timed.request.id}`
  });
  await db.q(`UPDATE requests SET assigned_at=NOW()-INTERVAL '6 minutes' WHERE id=$1`,
    [timed.request.id]);
  await dispatch.bounceUnacceptedJobs();
  await assert.rejects(dispatch.assignJob({
    requestId: timed.request.id,
    companyId: timed.owner.id,
    actorId: timed.owner.id,
    techId: timed.tech1.id,
    expectedAssignmentVersion: tAssigned.request.assignment_version,
    commandKey: `prepared_before_timeout_${timed.request.id}`
  }), error => error.status === 409);

  const removed = await createDispatchFixture();
  const rAssigned = await dispatch.assignJob({
    requestId: removed.request.id,
    companyId: removed.owner.id,
    actorId: removed.owner.id,
    techId: removed.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `revocation_removal_assign_${removed.request.id}`
  });
  await dispatch.unassignTechnician({
    techId: removed.tech1.id,
    actorId: removed.owner.id,
    userChanges: {
      memberRole: 'tech',
      assignable: false,
      memberLocationId: null
    }
  });
  await db.q('UPDATE users SET assignable=TRUE WHERE id=$1', [removed.tech1.id]);
  await assert.rejects(dispatch.assignJob({
    requestId: removed.request.id,
    companyId: removed.owner.id,
    actorId: removed.owner.id,
    techId: removed.tech1.id,
    expectedAssignmentVersion: rAssigned.request.assignment_version,
    commandKey: `prepared_before_removal_${removed.request.id}`
  }), error => error.status === 409);
});

test('member update HTTP path recovers an enroute job before changing technician role', async () => {
  const f = await createDispatchFixture();
  const assigned = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `http_member_assign_${f.request.id}`
  });
  await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech1.id,
    assignmentVersion: assigned.request.assignment_version,
    action: 'accept'
  });
  await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech1.id,
    assignmentVersion: assigned.request.assignment_version,
    action: 'enroute',
    etaMinutes: 20
  });
  const token = await auth.createSession(f.owner.id);
  const response = await fetch(`${apiBase}/api/provider/members`, {
    method: 'POST',
    headers: { Cookie: `rigrx_session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone: f.tech1.phone,
      name: f.tech1.name,
      member_role: 'dispatcher',
      assignable: false,
      lang: 'en'
    })
  });
  assert.equal(response.status, 200);
  const request = await db.one('SELECT * FROM requests WHERE id=$1', [f.request.id]);
  const member = await db.one('SELECT * FROM users WHERE id=$1', [f.tech1.id]);
  assert.equal(request.job_state, 'unassigned');
  assert.equal(request.assigned_tech, null);
  assert.equal(member.member_role, 'dispatcher');
  assert.equal(member.assignable, false);
});

test('admin archive HTTP path recovers a technician assignment', async () => {
  const f = await createDispatchFixture();
  const assigned = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `http_archive_assign_${f.request.id}`
  });
  await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech1.id,
    assignmentVersion: assigned.request.assignment_version,
    action: 'accept'
  });
  const admin = await createUser('admin');
  const token = await auth.createSession(admin.id);
  const response = await fetch(`${apiBase}/api/admin/users/${f.tech1.id}/archive`, {
    method: 'POST',
    headers: { Cookie: `rigrx_session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'Unavailable' })
  });
  assert.equal(response.status, 200);
  const request = await db.one('SELECT * FROM requests WHERE id=$1', [f.request.id]);
  const member = await db.one('SELECT * FROM users WHERE id=$1', [f.tech1.id]);
  assert.equal(request.job_state, 'unassigned');
  assert.equal(request.assigned_tech, null);
  assert.ok(member.archived_at);
});

test('company archive serializes concurrent membership creation and assignment', async () => {
  const f = await createDispatchFixture();
  const admin = await createUser('admin');
  const adminToken = await auth.createSession(admin.id);
  const ownerToken = await auth.createSession(f.owner.id);

  const archivePromise = fetch(`${apiBase}/api/admin/users/${f.owner.id}/archive`, {
    method: 'POST',
    headers: { Cookie: `rigrx_session=${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'Company closed' })
  });
  const invitePromise = fetch(`${apiBase}/api/provider/members`, {
    method: 'POST',
    headers: { Cookie: `rigrx_session=${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone: '+16615559999',
      name: 'Concurrent technician',
      member_role: 'tech',
      assignable: true,
      lang: 'en'
    })
  });
  const assignPromise = dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `company_archive_race_${f.request.id}`
  });

  const [archive, invite, assignment] = await Promise.allSettled([
    archivePromise,
    invitePromise,
    assignPromise
  ]);
  assert.equal(archive.status, 'fulfilled');
  assert.equal(archive.value.status, 200);
  assert.equal(['fulfilled', 'rejected'].includes(invite.status), true);
  assert.equal(['fulfilled', 'rejected'].includes(assignment.status), true);
  const request = await db.one('SELECT * FROM requests WHERE id=$1', [f.request.id]);
  const activeMembers = await db.one(`
    SELECT COUNT(*)::int n FROM users
    WHERE company_id=$1 AND archived_at IS NULL`, [f.owner.id]);
  assert.equal(activeMembers.n, 0);
  assert.equal(request.assigned_tech, null);
  assert.notEqual(request.job_state, 'assigned');
});

test('wider retry keeps an alerted out-of-radius lead visible in the live feed', async () => {
  const driver = await createUser('driver');
  const provider = await createProvider();
  await db.q(`
    UPDATE providers SET services='{"mechanic":["Mobile Mechanic"]}'::jsonb
    WHERE user_id=$1`, [provider.id]);
  await db.q(`
    INSERT INTO provider_locations (user_id,label,lat,lng,radius_mi)
    VALUES ($1,'Far yard',35,-117.5,5)`, [provider.id]);
  const request = await createRequest(driver.id);
  await db.q(`
    UPDATE requests SET last_notified_at=NOW()-INTERVAL '5 minutes'
    WHERE id=$1`, [request.id]);
  const driverToken = await auth.createSession(driver.id);
  const providerToken = await auth.createSession(provider.id);

  const retry = await fetch(`${apiBase}/api/requests/${request.id}/retry`, {
    method: 'POST',
    headers: { Cookie: `rigrx_session=${driverToken}` }
  });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).notified, 1);
  const eligibility = await db.one(`
    SELECT * FROM lead_eligibility WHERE request_id=$1 AND provider_id=$2`,
    [request.id, provider.id]);
  assert.ok(Number(eligibility.distance_mi) > 5);

  const response = await fetch(`${apiBase}/api/leads`, {
    headers: { Cookie: `rigrx_session=${providerToken}` }
  });
  assert.equal(response.status, 200);
  const feed = await response.json();
  assert.equal(feed.leads.some(lead => lead.id === request.id), true);
});

test('on-scene technician removal is rejected, including an arrival race', async () => {
  const f = await createDispatchFixture();
  const assigned = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `arrived_remove_assign_${f.request.id}`
  });
  const version = assigned.request.assignment_version;
  await dispatch.techAction({
    requestId: f.request.id, techId: f.tech1.id,
    assignmentVersion: version, action: 'accept'
  });
  await dispatch.techAction({
    requestId: f.request.id, techId: f.tech1.id,
    assignmentVersion: version, action: 'enroute', etaMinutes: 20
  });

  const [arrival, removal] = await Promise.allSettled([
    dispatch.techAction({
      requestId: f.request.id, techId: f.tech1.id,
      assignmentVersion: version, action: 'arrived'
    }),
    dispatch.unassignTechnician({
      techId: f.tech1.id,
      actorId: f.owner.id,
      companyId: f.owner.id,
      userChanges: {
        name: f.tech1.name, lang: f.tech1.lang, memberRole: 'tech',
        assignable: false, memberLocationId: null
      }
    })
  ]);
  const request = await db.one('SELECT * FROM requests WHERE id=$1', [f.request.id]);
  const technician = await db.one('SELECT * FROM users WHERE id=$1', [f.tech1.id]);
  if (request.job_state === 'arrived') {
    assert.equal(arrival.status, 'fulfilled');
    assert.equal(removal.status, 'rejected');
    assert.equal(removal.reason.status, 409);
    assert.equal(technician.assignable, true);
    await assert.rejects(
      dispatch.unassignTechnician({
        techId: f.tech1.id,
        actorId: f.owner.id,
        companyId: f.owner.id,
        userChanges: {
          name: f.tech1.name, lang: f.tech1.lang, memberRole: 'tech',
          assignable: false, memberLocationId: null
        }
      }),
      error => error.status === 409 && /on scene/i.test(error.message)
    );
  } else {
    assert.equal(request.job_state, 'unassigned');
    assert.equal(removal.status, 'fulfilled');
    assert.equal(arrival.status, 'rejected');
    assert.equal(technician.assignable, false);
  }
});

test('repeat late, selection, and reopen events each keep a distinct notification identity', async () => {
  const f = await createDispatchFixture();
  const assigned = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `repeat_notice_assign_${f.request.id}`
  });
  const version = assigned.request.assignment_version;
  await dispatch.techAction({
    requestId: f.request.id, techId: f.tech1.id,
    assignmentVersion: version, action: 'accept'
  });
  await dispatch.techAction({
    requestId: f.request.id, techId: f.tech1.id,
    assignmentVersion: version, action: 'enroute', etaMinutes: 20
  });
  await dispatch.techAction({
    requestId: f.request.id, techId: f.tech1.id,
    assignmentVersion: version, action: 'late', etaMinutes: 15,
    actionKey: `late_notice_one_${f.request.id}`
  });
  await dispatch.techAction({
    requestId: f.request.id, techId: f.tech1.id,
    assignmentVersion: version, action: 'late', etaMinutes: 15,
    actionKey: `late_notice_two_${f.request.id}`
  });
  const lateReplay = await dispatch.techAction({
    requestId: f.request.id, techId: f.tech1.id,
    assignmentVersion: version, action: 'late', etaMinutes: 15,
    actionKey: `late_notice_two_${f.request.id}`
  });
  assert.equal(lateReplay.replayed, true);
  const lateNotices = await db.q(`
    SELECT dedupe_key FROM notifications_log
    WHERE request_id=$1 AND event_type='job_late' ORDER BY id`, [f.request.id]);
  assert.equal(lateNotices.length, 2);
  assert.notEqual(lateNotices[0].dedupe_key, lateNotices[1].dedupe_key);

  const driver = await createUser('driver');
  const owner = await createProvider();
  const request = await createRequest(driver.id);
  await db.q(`
    INSERT INTO purchases
      (request_id,provider_id,slot,amount_cents,premium,paid_with,status,refund_status)
    VALUES ($1,$2,1,2500,FALSE,'card','succeeded','none')`,
    [request.id, owner.id]);
  const driverToken = await auth.createSession(driver.id);
  for (let cycle = 0; cycle < 2; cycle++) {
    await marketplace.selectProvider({
      requestId: request.id, driverId: driver.id, providerId: owner.id
    });
    const reopened = await fetch(`${apiBase}/api/requests/${request.id}/reopen`, {
      method: 'POST',
      headers: { Cookie: `rigrx_session=${driverToken}` }
    });
    assert.equal(reopened.status, 200);
  }
  const lifecycleNotices = await db.q(`
    SELECT event_type, COUNT(*)::int n, COUNT(DISTINCT dedupe_key)::int identities
    FROM notifications_log
    WHERE request_id=$1 AND event_type IN ('provider_selected','job_reopened')
    GROUP BY event_type ORDER BY event_type`, [request.id]);
  assert.deepEqual(lifecycleNotices, [
    { event_type: 'job_reopened', n: 2, identities: 2 },
    { event_type: 'provider_selected', n: 2, identities: 2 }
  ]);
});

test('an expired notification worker cannot overwrite a newer successful claim', async () => {
  const user = await createUser('driver');
  const request = await createRequest(user.id);
  const notification = await notify.enqueueSms(
    user.id, user.phone, 'Fenced delivery', {
      requestId: request.id,
      eventType: 'claim_fence_test',
      dedupeKey: `claim_fence_${request.id}`
    });
  const previousFrom = process.env.TWILIO_FROM_NUMBER;
  process.env.TWILIO_FROM_NUMBER = '+16615550000';
  let rejectOld;
  let announceOld;
  const oldStarted = new Promise(resolve => { announceOld = resolve; });
  notify._setTwilioClient({
    messages: {
      create: async () => {
        announceOld();
        return await new Promise((resolve, reject) => { rejectOld = reject; });
      }
    }
  });

  try {
    const oldWorker = notify.processNotificationOutbox({
      onlyId: notification.id, limit: 1
    });
    await oldStarted;
    const oldClaim = await db.one(
      'SELECT claim_token, attempts FROM notifications_log WHERE id=$1',
      [notification.id]);
    assert.ok(oldClaim.claim_token);
    assert.equal(oldClaim.attempts, 1);
    await db.q(`
      UPDATE notifications_log SET locked_at=NOW()-INTERVAL '10 minutes'
      WHERE id=$1`, [notification.id]);

    notify._setTwilioClient({
      messages: { create: async () => ({ sid: 'SM_NEWER_CLAIM' }) }
    });
    const newer = await notify.processNotificationOutbox({
      onlyId: notification.id, limit: 1
    });
    assert.equal(newer[0].status, 'sent');
    rejectOld(new Error('old worker failed after its lease expired'));
    const stale = await oldWorker;
    assert.equal(stale[0].status, 'superseded');

    const final = await db.one(
      'SELECT * FROM notifications_log WHERE id=$1', [notification.id]);
    assert.equal(final.status, 'sent');
    assert.equal(final.attempts, 2);
    assert.equal(final.provider_message_id, 'SM_NEWER_CLAIM');
    assert.equal(final.last_error, '');
    assert.equal(final.claim_token, null);
    const failures = await db.one(`
      SELECT COUNT(*)::int n FROM dispatch_exceptions
      WHERE request_id=$1 AND type='notification_failure'
        AND status IN ('open','acknowledged')`, [request.id]);
    assert.equal(failures.n, 0);
  } finally {
    notify._setTwilioClient(null);
    if (previousFrom === undefined) delete process.env.TWILIO_FROM_NUMBER;
    else process.env.TWILIO_FROM_NUMBER = previousFrom;
  }
});

test('delayed enroute delivery cannot resolve a newer assignment recovery exception', async () => {
  const f = await createDispatchFixture();
  const assigned = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `delayed_enroute_assign_${f.request.id}`
  });
  const version = assigned.request.assignment_version;
  await dispatch.techAction({
    requestId: f.request.id, techId: f.tech1.id,
    assignmentVersion: version, action: 'accept'
  });
  const techToken = await auth.createSession(f.tech1.id);
  const previousFrom = process.env.TWILIO_FROM_NUMBER;
  process.env.TWILIO_FROM_NUMBER = '+16615550000';
  let finishDelivery;
  let announceDelivery;
  const deliveryStarted = new Promise(resolve => { announceDelivery = resolve; });
  notify._setTwilioClient({
    messages: {
      create: async () => {
        announceDelivery();
        return await new Promise(resolve => { finishDelivery = resolve; });
      }
    }
  });

  try {
    const enrouteResponse = fetch(`${apiBase}/api/jobs/${f.request.id}/enroute`, {
      method: 'POST',
      headers: {
        Cookie: `rigrx_session=${techToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ assignment_version: version, eta_minutes: 20 })
    });
    await deliveryStarted;
    const recovered = await dispatch.unassignTechnician({
      techId: f.tech1.id,
      actorId: f.owner.id,
      companyId: f.owner.id,
      userChanges: {
        name: f.tech1.name, lang: f.tech1.lang, memberRole: 'tech',
        assignable: false, memberLocationId: null
      }
    });
    assert.equal(recovered.length, 1);
    finishDelivery({ sid: 'SM_DELAYED_ENROUTE' });
    const response = await enrouteResponse;
    assert.equal(response.status, 200);

    const request = await db.one('SELECT * FROM requests WHERE id=$1', [f.request.id]);
    assert.equal(request.job_state, 'unassigned');
    const exception = await db.one(`
      SELECT * FROM dispatch_exceptions
      WHERE request_id=$1 AND type='assignment_bounced'
        AND status IN ('open','acknowledged')`, [f.request.id]);
    assert.ok(exception);
    assert.match(JSON.stringify(exception.detail), /technician_unavailable/);
  } finally {
    notify._setTwilioClient(null);
    if (previousFrom === undefined) delete process.env.TWILIO_FROM_NUMBER;
    else process.env.TWILIO_FROM_NUMBER = previousFrom;
  }
});

test('driver archival blocks active road work and atomically cancels pre-arrival work', async () => {
  const admin = await createUser('admin');
  const adminToken = await auth.createSession(admin.id);
  const arrived = await createDispatchFixture();
  const arrivedAssignment = await dispatch.assignJob({
    requestId: arrived.request.id,
    companyId: arrived.owner.id,
    actorId: arrived.owner.id,
    techId: arrived.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `driver_archive_arrived_${arrived.request.id}`
  });
  const arrivedVersion = arrivedAssignment.request.assignment_version;
  await dispatch.techAction({
    requestId: arrived.request.id, techId: arrived.tech1.id,
    assignmentVersion: arrivedVersion, action: 'accept'
  });
  await dispatch.techAction({
    requestId: arrived.request.id, techId: arrived.tech1.id,
    assignmentVersion: arrivedVersion, action: 'enroute', etaMinutes: 15
  });
  await dispatch.techAction({
    requestId: arrived.request.id, techId: arrived.tech1.id,
    assignmentVersion: arrivedVersion, action: 'arrived'
  });
  const blocked = await fetch(`${apiBase}/api/admin/users/${arrived.driver.id}/archive`, {
    method: 'POST',
    headers: {
      Cookie: `rigrx_session=${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ reason: 'Admin review' })
  });
  assert.equal(blocked.status, 409);
  const arrivedRequest = await db.one(
    'SELECT * FROM requests WHERE id=$1', [arrived.request.id]);
  const arrivedDriver = await db.one(
    'SELECT * FROM users WHERE id=$1', [arrived.driver.id]);
  assert.equal(arrivedRequest.status, 'selected');
  assert.equal(arrivedRequest.job_state, 'arrived');
  assert.equal(arrivedRequest.assigned_tech, arrived.tech1.id);
  assert.equal(arrivedDriver.archived_at, null);

  const pending = await createDispatchFixture();
  const pendingAssignment = await dispatch.assignJob({
    requestId: pending.request.id,
    companyId: pending.owner.id,
    actorId: pending.owner.id,
    techId: pending.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `driver_archive_pending_${pending.request.id}`
  });
  const archived = await fetch(`${apiBase}/api/admin/users/${pending.driver.id}/archive`, {
    method: 'POST',
    headers: {
      Cookie: `rigrx_session=${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ reason: 'Duplicate account' })
  });
  assert.equal(archived.status, 200);
  const cancelled = await db.one(
    'SELECT * FROM requests WHERE id=$1', [pending.request.id]);
  const archivedDriver = await db.one(
    'SELECT * FROM users WHERE id=$1', [pending.driver.id]);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.job_state, 'none');
  assert.equal(cancelled.assigned_tech, null);
  assert.equal(cancelled.assignment_version,
    pendingAssignment.request.assignment_version + 1);
  assert.ok(archivedDriver.archived_at);
});

test('request fan-out commits every recipient intent before delivery begins', async () => {
  const driver = await createUser('driver');
  const provider = await createProvider();
  await createUser('provider', {
    name: 'Backup dispatcher',
    company_id: provider.id,
    member_role: 'dispatcher'
  });
  await db.q(`
    UPDATE providers SET services='{"mechanic":["Mobile Mechanic"]}'::jsonb
    WHERE user_id=$1`, [provider.id]);
  await db.q(`
    INSERT INTO provider_locations (user_id,label,lat,lng,radius_mi)
    VALUES ($1,'Main yard',35,-119,50)`, [provider.id]);
  const driverToken = await auth.createSession(driver.id);
  const previousFrom = process.env.TWILIO_FROM_NUMBER;
  process.env.TWILIO_FROM_NUMBER = '+16615550000';
  let releaseDelivery;
  let announceDelivery;
  const deliveryStarted = new Promise(resolve => { announceDelivery = resolve; });
  const deliveryGate = new Promise(resolve => { releaseDelivery = resolve; });
  notify._setTwilioClient({
    messages: {
      create: async () => {
        announceDelivery();
        await deliveryGate;
        return { sid: 'SM_FANOUT' };
      }
    }
  });

  try {
    const responsePromise = fetch(`${apiBase}/api/requests`, {
      method: 'POST',
      headers: {
        Cookie: `rigrx_session=${driverToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        service_key: 'mechanic',
        lat: 35,
        lng: -119,
        location_source: 'device',
        location_captured_at: new Date().toISOString()
      })
    });
    await deliveryStarted;
    const intents = await db.one(`
      SELECT COUNT(*)::int n
      FROM notifications_log n
      JOIN requests r ON r.id=n.request_id
      WHERE r.driver_id=$1 AND n.event_type='new_lead'`, [driver.id]);
    assert.equal(intents.n, 2);
    releaseDelivery();
    const response = await responsePromise;
    assert.equal(response.status, 200);
  } finally {
    notify._setTwilioClient(null);
    if (previousFrom === undefined) delete process.env.TWILIO_FROM_NUMBER;
    else process.env.TWILIO_FROM_NUMBER = previousFrom;
  }
});

test('successful purchase replay restores a missing responder notification intent', async () => {
  const driver = await createUser('driver');
  const provider = await createProvider({ credits: 1 });
  const request = await createRequest(driver.id);
  const first = await marketplace.purchaseLead({
    requestId: request.id,
    providerId: provider.id
  });
  assert.equal(first.justCompleted, true);
  let intents = await db.q(`
    SELECT * FROM notifications_log
    WHERE request_id=$1 AND event_type='responder_unlocked'`, [request.id]);
  assert.equal(intents.length, 1);
  await db.q('DELETE FROM notifications_log WHERE id=$1', [intents[0].id]);

  const replay = await marketplace.purchaseLead({
    requestId: request.id,
    providerId: provider.id
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.notificationIds.length, 1);
  intents = await db.q(`
    SELECT * FROM notifications_log
    WHERE request_id=$1 AND event_type='responder_unlocked'`, [request.id]);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].dedupe_key, `purchase:${first.purchase.id}:driver-responder`);
});

test('admin exception actions reject a stale occurrence after renewed rescue', async () => {
  const f = await createDispatchFixture();
  await dispatch.openException(f.request.id, 'stalled', { generation: 1 });
  const original = await db.one(`
    SELECT * FROM dispatch_exceptions
    WHERE request_id=$1 AND type='stalled' AND status='open'`, [f.request.id]);
  const admin = await createUser('admin');
  const adminToken = await auth.createSession(admin.id);
  await dispatch.openException(f.request.id, 'stalled', { generation: 2 });

  const stale = await fetch(
    `${apiBase}/api/admin/exceptions/${original.id}/resolve`, {
      method: 'POST',
      headers: {
        Cookie: `rigrx_session=${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        occurrence: original.occurrence,
        resolution: 'Old queue view'
      })
    });
  assert.equal(stale.status, 409);
  const renewed = await db.one(
    'SELECT * FROM dispatch_exceptions WHERE id=$1', [original.id]);
  assert.equal(renewed.status, 'open');
  assert.equal(renewed.occurrence, original.occurrence + 1);

  const current = await fetch(
    `${apiBase}/api/admin/exceptions/${original.id}/resolve`, {
      method: 'POST',
      headers: {
        Cookie: `rigrx_session=${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        occurrence: renewed.occurrence,
        resolution: 'Current occurrence handled'
      })
    });
  assert.equal(current.status, 200);
});

test('selected lead navigation includes manual-location provenance', async () => {
  const driver = await createUser('driver');
  const provider = await createProvider();
  const request = await createRequest(driver.id);
  await db.q(`
    UPDATE requests SET location_source='manual',
      landmark='I-5 northbound mile marker 253',
      selected_provider=$1, selected_at=NOW(), status='selected',
      job_state='unassigned'
    WHERE id=$2`, [provider.id, request.id]);
  await db.q(`
    INSERT INTO purchases
      (request_id,provider_id,slot,amount_cents,premium,paid_with,status,refund_status)
    VALUES ($1,$2,1,2500,FALSE,'card','succeeded','none')`,
    [request.id, provider.id]);
  const providerToken = await auth.createSession(provider.id);
  const response = await fetch(`${apiBase}/api/leads/${request.id}`, {
    headers: { Cookie: `rigrx_session=${providerToken}` }
  });
  assert.equal(response.status, 200);
  const lead = await response.json();
  assert.equal(lead.full.won, true);
  assert.equal(lead.full.location_source, 'manual');
  assert.equal(lead.full.landmark, 'I-5 northbound mile marker 253');
});

test('driver archival fences concurrent request creation', async () => {
  const driver = await createUser('driver');
  const admin = await createUser('admin');
  const driverToken = await auth.createSession(driver.id);
  const adminToken = await auth.createSession(admin.id);
  const [creation, archival] = await Promise.all([
    fetch(`${apiBase}/api/requests`, {
      method: 'POST',
      headers: {
        Cookie: `rigrx_session=${driverToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        service_key: 'mechanic',
        lat: 35,
        lng: -119,
        location_source: 'device',
        location_captured_at: new Date().toISOString()
      })
    }),
    fetch(`${apiBase}/api/admin/users/${driver.id}/archive`, {
      method: 'POST',
      headers: {
        Cookie: `rigrx_session=${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ reason: 'Concurrent archival test' })
    })
  ]);
  assert.equal(archival.status, 200);
  assert.equal([200, 401, 409].includes(creation.status), true);
  const active = await db.one(`
    SELECT COUNT(*)::int n FROM requests
    WHERE driver_id=$1 AND status IN ('open','selected')`, [driver.id]);
  assert.equal(active.n, 0);
  const archivedDriver = await db.one(
    'SELECT * FROM users WHERE id=$1', [driver.id]);
  assert.ok(archivedDriver.archived_at);
});

test('assignment revocation supersedes a delayed enroute notification', async () => {
  const f = await createDispatchFixture();
  const assigned = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `stale_enroute_assign_${f.request.id}`
  });
  await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech1.id,
    assignmentVersion: assigned.request.assignment_version,
    action: 'accept'
  });
  const enroute = await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech1.id,
    assignmentVersion: assigned.request.assignment_version,
    action: 'enroute',
    etaMinutes: 20
  });
  assert.equal(enroute.notificationIds.length, 1);

  const recovery = await dispatch.unassignTechnician({
    techId: f.tech1.id,
    actorId: f.owner.id,
    companyId: f.owner.id
  });
  const oldNotice = await db.one(
    'SELECT * FROM notifications_log WHERE id=$1', [enroute.notificationIds[0]]);
  assert.equal(oldNotice.status, 'superseded');
  assert.equal(recovery[0].job_state, 'unassigned');

  const previousFrom = process.env.TWILIO_FROM_NUMBER;
  process.env.TWILIO_FROM_NUMBER = '+16615550000';
  const bodies = [];
  notify._setTwilioClient({
    messages: {
      create: async message => {
        bodies.push(message.body);
        return { sid: `SM_${bodies.length}` };
      }
    }
  });
  try {
    await notify.processNotificationIds(recovery[0].notificationIds);
    await notify.processNotificationIds(enroute.notificationIds);
    assert.equal(bodies.some(body => /on the way/i.test(body)), false);
    assert.equal(bodies.some(body => /back with dispatch/i.test(body)), true);
  } finally {
    notify._setTwilioClient(null);
    if (previousFrom === undefined) delete process.env.TWILIO_FROM_NUMBER;
    else process.env.TWILIO_FROM_NUMBER = previousFrom;
  }
});

test('driver and technician completion serialize without duplicate completion effects', async () => {
  const f = await createDispatchFixture();
  const assigned = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `concurrent_complete_assign_${f.request.id}`
  });
  const version = assigned.request.assignment_version;
  await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech1.id,
    assignmentVersion: version,
    action: 'accept'
  });
  await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech1.id,
    assignmentVersion: version,
    action: 'enroute',
    etaMinutes: 10
  });
  await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech1.id,
    assignmentVersion: version,
    action: 'arrived'
  });

  const results = await Promise.allSettled([
    dispatch.techAction({
      requestId: f.request.id,
      techId: f.tech1.id,
      assignmentVersion: version,
      action: 'complete'
    }),
    dispatch.completeByDriver({
      requestId: f.request.id,
      driverId: f.driver.id
    })
  ]);
  assert.equal(results.every(result => result.status === 'fulfilled'), true);
  const request = await db.one('SELECT * FROM requests WHERE id=$1', [f.request.id]);
  const provider = await db.one(
    'SELECT * FROM providers WHERE user_id=$1', [f.owner.id]);
  const effects = await db.one(`
    SELECT COUNT(*) FILTER (
      WHERE event_type IN ('complete','driver_completed')
    )::int completion_events
    FROM job_events WHERE request_id=$1`, [f.request.id]);
  assert.equal(request.status, 'completed');
  assert.equal(request.job_state, 'completed');
  assert.equal(provider.jobs_won, 1);
  assert.equal(effects.completion_events, 1);
});

test('an old unassignment notice cannot contradict an A to B to A reassignment', async () => {
  const f = await createDispatchFixture();
  const firstA = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `aba_first_a_${f.request.id}_command`
  });
  const assignedB = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech2.id,
    expectedAssignmentVersion: firstA.request.assignment_version,
    commandKey: `aba_assign_b_${f.request.id}_command`
  });
  const oldRevocation = await db.one(`
    SELECT * FROM notifications_log
    WHERE request_id=$1 AND user_id=$2 AND event_type='job_unassigned'
    ORDER BY id DESC LIMIT 1`, [f.request.id, f.tech1.id]);
  const latestA = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: assignedB.request.assignment_version,
    commandKey: `aba_second_a_${f.request.id}_command`
  });
  const latestAssignment = await db.one(`
    SELECT * FROM notifications_log
    WHERE request_id=$1 AND user_id=$2 AND event_type='job_assigned'
      AND payload->>'assignment_version'=$3
    ORDER BY id DESC LIMIT 1`,
    [f.request.id, f.tech1.id, String(latestA.request.assignment_version)]);

  const previousFrom = process.env.TWILIO_FROM_NUMBER;
  process.env.TWILIO_FROM_NUMBER = '+16615550000';
  const bodies = [];
  notify._setTwilioClient({
    messages: {
      create: async message => {
        bodies.push(message.body);
        return { sid: `SM_ABA_${bodies.length}` };
      }
    }
  });
  try {
    await notify.processNotificationIds([latestAssignment.id]);
    await dispatch.techAction({
      requestId: f.request.id,
      techId: f.tech1.id,
      assignmentVersion: latestA.request.assignment_version,
      action: 'accept'
    });
    await dispatch.techAction({
      requestId: f.request.id,
      techId: f.tech1.id,
      assignmentVersion: latestA.request.assignment_version,
      action: 'enroute',
      etaMinutes: 15
    });
    await notify.processNotificationIds([oldRevocation.id]);
    assert.equal(bodies.some(body => /no longer in your queue/i.test(body)), false);
    const stale = await db.one(
      'SELECT * FROM notifications_log WHERE id=$1', [oldRevocation.id]);
    assert.equal(stale.status, 'superseded');
  } finally {
    notify._setTwilioClient(null);
    if (previousFrom === undefined) delete process.env.TWILIO_FROM_NUMBER;
    else process.env.TWILIO_FROM_NUMBER = previousFrom;
  }
});

test('notification failure recording cannot deadlock a request transition', async () => {
  const f = await createDispatchFixture();
  const assigned = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `failure_lock_assign_${f.request.id}`
  });
  await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech1.id,
    assignmentVersion: assigned.request.assignment_version,
    action: 'accept'
  });
  const enroute = await dispatch.techAction({
    requestId: f.request.id,
    techId: f.tech1.id,
    assignmentVersion: assigned.request.assignment_version,
    action: 'enroute',
    etaMinutes: 20
  });
  const notificationId = enroute.notificationIds[0];
  const previousFrom = process.env.TWILIO_FROM_NUMBER;
  process.env.TWILIO_FROM_NUMBER = '+16615550000';
  let announceAttempt;
  const attempted = new Promise(resolve => { announceAttempt = resolve; });
  let releaseFailure;
  const failureGate = new Promise(resolve => { releaseFailure = resolve; });
  notify._setTwilioClient({
    messages: {
      create: async () => {
        announceAttempt();
        await failureGate;
        throw new Error('simulated provider failure');
      }
    }
  });
  const client = await db.pool.connect();
  let inTransaction = false;
  try {
    const delivery = notify.processNotificationIds([notificationId]);
    await attempted;
    await client.query('BEGIN');
    inTransaction = true;
    await client.query(
      'SELECT id FROM requests WHERE id=$1 FOR UPDATE', [f.request.id]);
    releaseFailure();
    await new Promise(resolve => setTimeout(resolve, 30));
    await Promise.race([
      client.query(`
        UPDATE notifications_log
        SET status='superseded', locked_at=NULL, claim_token=NULL
        WHERE id=$1`, [notificationId]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('outbox lock inversion detected')), 500))
    ]);
    await client.query('COMMIT');
    inTransaction = false;
    const result = await delivery;
    assert.equal(result[0].status, 'superseded');
  } finally {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    client.release();
    notify._setTwilioClient(null);
    if (previousFrom === undefined) delete process.env.TWILIO_FROM_NUMBER;
    else process.env.TWILIO_FROM_NUMBER = previousFrom;
  }
});

test('timeout exception foreign keys cannot deadlock a technician transition', async () => {
  const f = await createDispatchFixture();
  const assigned = await dispatch.assignJob({
    requestId: f.request.id,
    companyId: f.owner.id,
    actorId: f.owner.id,
    techId: f.tech1.id,
    expectedAssignmentVersion: 0,
    commandKey: `fk_timeout_lock_${f.request.id}_command`
  });
  const techClient = await db.pool.connect();
  const sweepClient = await db.pool.connect();
  let techTx = false;
  let sweepTx = false;
  try {
    await techClient.query('BEGIN');
    techTx = true;
    await techClient.query(
      'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [f.tech1.id]);
    await sweepClient.query('BEGIN');
    sweepTx = true;
    await sweepClient.query(
      'SELECT id FROM requests WHERE id=$1 FOR UPDATE', [f.request.id]);
    const waitingForRequest = techClient.query(
      'SELECT id FROM requests WHERE id=$1 FOR UPDATE', [f.request.id]);
    await new Promise(resolve => setTimeout(resolve, 30));
    await Promise.race([
      sweepClient.query(`
        INSERT INTO dispatch_exceptions
          (request_id,type,provider_id,tech_id,status,detail)
        VALUES ($1,'assignment_bounced',$2,$3,'open','{}')`,
        [f.request.id, f.owner.id, f.tech1.id]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('technician FK lock inversion detected')), 500))
    ]);
    await sweepClient.query('COMMIT');
    sweepTx = false;
    await waitingForRequest;
    const current = await db.one(
      'SELECT * FROM requests WHERE id=$1', [f.request.id]);
    assert.equal(current.assignment_version, assigned.request.assignment_version);
  } finally {
    if (sweepTx) await sweepClient.query('ROLLBACK').catch(() => {});
    if (techTx) await techClient.query('ROLLBACK').catch(() => {});
    sweepClient.release();
    techClient.release();
  }
});

test('driver actor foreign keys cannot deadlock archival against a driver action', async () => {
  const f = await createDispatchFixture();
  const archiveClient = await db.pool.connect();
  const actionClient = await db.pool.connect();
  let archiveTx = false;
  let actionTx = false;
  try {
    await archiveClient.query('BEGIN');
    archiveTx = true;
    await archiveClient.query(
      'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [f.driver.id]);
    await actionClient.query('BEGIN');
    actionTx = true;
    await actionClient.query(
      'SELECT id FROM requests WHERE id=$1 FOR UPDATE', [f.request.id]);
    const waitingForRequest = archiveClient.query(
      'SELECT id FROM requests WHERE id=$1 FOR UPDATE', [f.request.id]);
    await new Promise(resolve => setTimeout(resolve, 30));
    await Promise.race([
      actionClient.query(`
        INSERT INTO job_events
          (request_id,event_type,from_state,to_state,actor_id,assignment_version)
        VALUES ($1,'driver_lock_probe','unassigned','unassigned',$2,0)`,
        [f.request.id, f.driver.id]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('driver FK lock inversion detected')), 500))
    ]);
    await actionClient.query('COMMIT');
    actionTx = false;
    await waitingForRequest;
    const eventRow = await db.one(`
      SELECT * FROM job_events
      WHERE request_id=$1 AND event_type='driver_lock_probe'`, [f.request.id]);
    assert.equal(eventRow.actor_id, f.driver.id);
  } finally {
    if (actionTx) await actionClient.query('ROLLBACK').catch(() => {});
    if (archiveTx) await archiveClient.query('ROLLBACK').catch(() => {});
    actionClient.release();
    archiveClient.release();
  }
});

test('request widening waits on the driver barrier before locking the request', async () => {
  const driver = await createUser('driver');
  const request = await createRequest(driver.id);
  await db.q(`
    UPDATE requests SET licensed_only=TRUE WHERE id=$1`, [request.id]);
  const token = await auth.createSession(driver.id);
  const blocker = await db.pool.connect();
  const probe = await db.pool.connect();
  let blockerTx = false;
  let probeTx = false;
  try {
    await blocker.query('BEGIN');
    blockerTx = true;
    await blocker.query(
      'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [driver.id]);
    const widening = fetch(`${apiBase}/api/requests/${request.id}/open-to-all`, {
      method: 'POST',
      headers: {
        Cookie: `rigrx_session=${token}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    for (let i = 0; i < 100; i++) {
      const waiting = await db.one(`
        SELECT COUNT(*)::int n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query NOT ILIKE '%pg_stat_activity%'`);
      if (waiting.n > 0) break;
      if (i === 99) throw new Error('widening did not reach the driver barrier');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await probe.query('BEGIN');
    probeTx = true;
    await probe.query(
      'SELECT id FROM requests WHERE id=$1 FOR UPDATE NOWAIT', [request.id]);
    await probe.query('ROLLBACK');
    probeTx = false;
    await blocker.query('COMMIT');
    blockerTx = false;
    const response = await widening;
    assert.equal(response.status, 200);
  } finally {
    if (probeTx) await probe.query('ROLLBACK').catch(() => {});
    if (blockerTx) await blocker.query('ROLLBACK').catch(() => {});
    probe.release();
    blocker.release();
  }
});

test('purchase replay waits on the company barrier before locking the request', async () => {
  const driver = await createUser('driver');
  const provider = await createProvider({ credits: 1 });
  const request = await createRequest(driver.id);
  const first = await marketplace.purchaseLead({
    requestId: request.id,
    providerId: provider.id
  });
  assert.equal(first.justCompleted, true);
  const blocker = await db.pool.connect();
  const probe = await db.pool.connect();
  let blockerTx = false;
  let probeTx = false;
  try {
    await blocker.query('BEGIN');
    blockerTx = true;
    await blocker.query(
      'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [provider.id]);
    const replayPromise = marketplace.purchaseLead({
      requestId: request.id,
      providerId: provider.id
    });
    for (let i = 0; i < 100; i++) {
      const waiting = await db.one(`
        SELECT COUNT(*)::int n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query NOT ILIKE '%pg_stat_activity%'`);
      if (waiting.n > 0) break;
      if (i === 99) throw new Error('purchase replay did not reach the company barrier');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await probe.query('BEGIN');
    probeTx = true;
    await probe.query(
      'SELECT id FROM requests WHERE id=$1 FOR UPDATE NOWAIT', [request.id]);
    await probe.query('ROLLBACK');
    probeTx = false;
    await blocker.query('COMMIT');
    blockerTx = false;
    const replay = await replayPromise;
    assert.equal(replay.replayed, true);
  } finally {
    if (probeTx) await probe.query('ROLLBACK').catch(() => {});
    if (blockerTx) await blocker.query('ROLLBACK').catch(() => {});
    probe.release();
    blocker.release();
  }
});

test('fresh and legacy provider registration persists owner membership for dispatch', async () => {
  const legacyPhone = nextPhone();
  const legacy = (await db.q(`
    INSERT INTO users (phone,role,member_role,company_id)
    VALUES ($1,'provider','',NULL) RETURNING *`, [legacyPhone]))[0];
  await db.q('INSERT INTO providers (user_id) VALUES ($1)', [legacy.id]);
  const normalized = await auth.findOrCreateUser(legacyPhone, 'provider');
  assert.equal(normalized.member_role, 'owner');
  assert.equal(normalized.company_id, normalized.id);

  const owner = await auth.findOrCreateUser(nextPhone(), 'provider');
  assert.equal(owner.member_role, 'owner');
  assert.equal(owner.company_id, owner.id);
  await db.q(`
    UPDATE providers SET name=$1, approved=TRUE
    WHERE user_id=$2`, [`Fresh Company ${owner.id}`, owner.id]);
  const ownerToken = await auth.createSession(owner.id);
  const memberResponse = await fetch(`${apiBase}/api/provider/members`, {
    method: 'POST',
    headers: {
      Cookie: `rigrx_session=${ownerToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      phone: nextPhone(),
      name: 'Fresh technician',
      member_role: 'tech',
      assignable: true
    })
  });
  assert.equal(memberResponse.status, 200);
  const member = (await memberResponse.json()).member;

  const driver = await createUser('driver');
  const request = await createRequest(driver.id);
  await db.q(`
    UPDATE requests SET status='selected', selected_provider=$1,
      selected_at=NOW(), job_state='unassigned'
    WHERE id=$2`, [owner.id, request.id]);
  const assignment = await fetch(`${apiBase}/api/jobs/${request.id}/assign`, {
    method: 'POST',
    headers: {
      Cookie: `rigrx_session=${ownerToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      tech_id: member.id,
      assignment_version: 0,
      command_key: `fresh_owner_assign_${request.id}`
    })
  });
  assert.equal(assignment.status, 200);

  const admin = await createUser('admin');
  const adminToken = await auth.createSession(admin.id);
  const archived = await fetch(`${apiBase}/api/admin/users/${owner.id}/archive`, {
    method: 'POST',
    headers: {
      Cookie: `rigrx_session=${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ reason: 'Registration lifecycle regression' })
  });
  assert.equal(archived.status, 200);
  const finalOwner = await db.one('SELECT * FROM users WHERE id=$1', [owner.id]);
  const finalMember = await db.one('SELECT * FROM users WHERE id=$1', [member.id]);
  const finalRequest = await db.one('SELECT * FROM requests WHERE id=$1', [request.id]);
  assert.ok(finalOwner.archived_at);
  assert.ok(finalMember.archived_at);
  assert.equal(finalRequest.job_state, 'unassigned');
  assert.equal(finalRequest.assigned_tech, null);
});
const { q, withTransaction } = require('./db');
const defaultPayments = require('./payments');
const { enqueueSms, supersedeNotificationsTx } = require('./notify');

const ACTIVE_PURCHASE = `refunded=FALSE AND status='succeeded'`;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function refundIdentity(purchase) {
  return purchase.refund_idempotency_key || `rigrx-refund-purchase-${purchase.id}`;
}

async function first(client, text, params = []) {
  return (await client.query(text, params)).rows[0] || null;
}

function assertEligible(provider, request) {
  if (!provider || provider.owner_archived_at)
    throw fail(403, 'This company account is not active');
  if (!provider.approved)
    throw fail(403, 'Your account is pending RIGRX approval');
  if (request.licensed_only && !provider.license_verified)
    throw fail(403, 'This driver requested licensed companies only');
  const trades = Array.isArray(request.trade_filter) ? request.trade_filter : [];
  if (trades.length && !trades.includes(provider.primary_trade))
    throw fail(403, 'This driver asked for a different kind of company');
  const classes = Array.isArray(provider.duty_classes) ? provider.duty_classes : ['heavy', 'medium', 'light'];
  if (!classes.includes(request.duty_class || 'heavy'))
    throw fail(403, 'You have not marked that you service this size of truck');
}

async function ensureResponderIntent(client, purchase, provider, request) {
  const driver = await first(client,
    'SELECT id, phone, lang FROM users WHERE id=$1', [request.driver_id]);
  const notificationIds = [];
  if (driver) {
    const en = `RIGRX: ${provider.name} unlocked your ${request.service_label} request and can now contact you. Open the app to chat.`;
    const es = `RIGRX: ${provider.name} respondió a su solicitud de ${request.service_label} y ya puede contactarlo. Abra la app para chatear.`;
    const notification = await enqueueSms(driver.id, driver.phone,
      driver.lang === 'es' ? es : en, {
        client,
        requestId: request.id,
        eventType: 'responder_unlocked',
        dedupeKey: `purchase:${purchase.id}:driver-responder`,
        payload: { provider_id: provider.user_id, purchase_id: purchase.id }
      });
    if (notification) notificationIds.push(notification.id);
  }
  await client.query(`
    UPDATE dispatch_exceptions SET status='resolved', resolved_at=NOW(),
      updated_at=NOW(), resolution='A provider responded and purchased the request'
    WHERE request_id=$1 AND type=ANY($2::text[])
      AND status IN ('open','acknowledged')`,
    [request.id, ['zero_match', 'no_response']]);
  return {
    notificationIds,
    responder: driver ? {
      driverId: driver.id,
      providerId: provider.user_id,
      name: provider.name,
      slot: purchase.slot,
      requestId: request.id
    } : null
  };
}

async function reservePurchase(requestId, providerId, paymentsApi) {
  return withTransaction(async client => {
    const owner = await first(client, `
      SELECT id, archived_at FROM users
      WHERE id=$1 FOR NO KEY UPDATE`, [providerId]);
    const request = await first(client, `
      SELECT r.*, pr.standard_cents, pr.premium_cents
      FROM requests r JOIN pricing pr ON pr.service_key=r.service_key
      WHERE r.id=$1 FOR UPDATE OF r`, [requestId]);
    if (!request) throw fail(404, 'Lead not found');

    const provider = await first(client, `
      SELECT p.* FROM providers p
      WHERE p.user_id=$1 FOR UPDATE`, [providerId]);
    if (provider) provider.owner_archived_at = owner?.archived_at || null;
    assertEligible(provider, request);

    let purchase = await first(client,
      'SELECT * FROM purchases WHERE request_id=$1 AND provider_id=$2 FOR UPDATE',
      [requestId, providerId]);
    if (purchase?.status === 'succeeded' && !purchase.refunded) {
      const intent = await ensureResponderIntent(client, purchase, provider, request);
      return {
        purchase, provider, request, replayed: true, justCompleted: false, ...intent
      };
    }
    if (purchase?.refunded)
      throw fail(409, 'This lead purchase was refunded and cannot be purchased again');
    if (request.status !== 'open')
      throw fail(409, 'Lead is no longer open');
    if (purchase?.status === 'pending') {
      return { purchase, provider, request, replayed: false, justCompleted: false };
    }

    const occupied = (await client.query(`
      SELECT slot FROM purchases
      WHERE request_id=$1 AND refunded=FALSE AND status IN ('pending','succeeded')
      ORDER BY slot`, [requestId])).rows.map(row => row.slot);
    const slot = [1, 2, 3, 4].find(candidate => !occupied.includes(candidate));
    if (!slot) throw fail(409, 'Lead sold out (4 responders max)');
    const premium = slot === 4;
    const listPrice = premium ? request.premium_cents : request.standard_cents;

    if (provider.lead_credits > 0) {
      const idempotencyKey = purchase ? `rigrx-credit-purchase-${purchase.id}` : null;
      if (purchase) {
        purchase = await first(client, `
          UPDATE purchases SET slot=$1, amount_cents=0, premium=$2, stripe_payment='credit',
            paid_with='credit', list_price_cents=$3, status='succeeded', payment_error='',
            updated_at=NOW(), idempotency_key=$4
          WHERE id=$5 RETURNING *`,
          [slot, premium, listPrice, idempotencyKey, purchase.id]);
      } else {
        purchase = await first(client, `
          INSERT INTO purchases
            (request_id, provider_id, slot, amount_cents, premium, stripe_payment,
             paid_with, list_price_cents, status)
          VALUES ($1,$2,$3,0,$4,'credit','credit',$5,'succeeded') RETURNING *`,
          [requestId, providerId, slot, premium, listPrice]);
        await client.query('UPDATE purchases SET idempotency_key=$1 WHERE id=$2',
          [`rigrx-credit-purchase-${purchase.id}`, purchase.id]);
      }
      const spent = await first(client, `
        UPDATE providers SET lead_credits=lead_credits-1
        WHERE user_id=$1 AND lead_credits>0 RETURNING lead_credits`, [providerId]);
      if (!spent) throw fail(409, 'Lead credit was already used; try again');
      await client.query(`
        INSERT INTO credit_log (provider_id, delta, reason, event_key)
        VALUES ($1,-1,$2,$3) ON CONFLICT DO NOTHING`,
        [providerId, `Spent on lead #${requestId}`, `purchase:${purchase.id}:spend`]);
      purchase.idempotency_key = `rigrx-credit-purchase-${purchase.id}`;
      const intent = await ensureResponderIntent(client, purchase, provider, request);
      return {
        purchase,
        provider: { ...provider, lead_credits: spent.lead_credits },
        request,
        replayed: false,
        justCompleted: true,
        creditsLeft: spent.lead_credits,
        ...intent
      };
    }

    if (!paymentsApi.SIMULATED() && !provider.stripe_pm)
      throw fail(402, 'No card on file. Add one in Settings → Billing to keep buying leads.');

    const attempts = (purchase?.payment_attempts || 0) + 1;
    if (purchase) {
      purchase = await first(client, `
        UPDATE purchases SET slot=$1, amount_cents=$2, premium=$3, stripe_payment='',
          paid_with='card', list_price_cents=$2, status='pending', payment_attempts=$4,
          payment_error='', updated_at=NOW(), idempotency_key=$5
        WHERE id=$6 RETURNING *`,
        [slot, listPrice, premium, attempts, `rigrx-lead-${purchase.id}-attempt-${attempts}`, purchase.id]);
    } else {
      purchase = await first(client, `
        INSERT INTO purchases
          (request_id, provider_id, slot, amount_cents, premium, stripe_payment,
           paid_with, list_price_cents, status, payment_attempts)
        VALUES ($1,$2,$3,$4,$5,'','card',$4,'pending',1) RETURNING *`,
        [requestId, providerId, slot, listPrice, premium]);
      purchase = await first(client, `
        UPDATE purchases SET idempotency_key=$1 WHERE id=$2 RETURNING *`,
        [`rigrx-lead-${purchase.id}-attempt-1`, purchase.id]);
    }
    return { purchase, provider, request, replayed: false, justCompleted: false };
  });
}

async function markPaymentFailed(purchaseId, attemptKey, message) {
  return (await q(`
    UPDATE purchases SET status='failed', payment_error=$1, updated_at=NOW()
    WHERE id=$2 AND status='pending' AND idempotency_key=$3 AND stripe_payment=''
    RETURNING *`,
    [String(message || 'Payment failed').slice(0, 500), purchaseId, attemptKey]))[0] || null;
}

async function processCardPurchase(reservation, paymentsApi) {
  let { purchase, provider, request } = reservation;
  if (purchase.status === 'succeeded') return reservation;
  const attemptKey = purchase.idempotency_key;

  if (!purchase.stripe_payment) {
    let created;
    try {
      created = await paymentsApi.createLeadPayment(
        provider,
        purchase.list_price_cents,
        `RIGRX lead #${request.id} — ${request.service_label}${purchase.premium ? ' (premium slot)' : ''}`,
        { idempotencyKey: purchase.idempotency_key }
      );
    } catch (error) {
      created = { ok: false, error: error.message, indeterminate: true };
    }
    if (!created.ok) {
      if (created.indeterminate) {
        const current = await q(`
          UPDATE purchases SET payment_error=$1, updated_at=NOW()
          WHERE id=$2 AND status='pending' AND idempotency_key=$3 RETURNING id`,
          [String(created.error || 'Payment status unavailable').slice(0, 500), purchase.id, attemptKey]);
        if (!current.length) {
          const state = (await q('SELECT * FROM purchases WHERE id=$1', [purchase.id]))[0];
          if (state?.idempotency_key === attemptKey && state.status === 'succeeded')
            return { ...reservation, purchase: state, replayed: true, justCompleted: false };
          throw fail(409, 'This payment attempt was superseded by a newer retry.');
        }
        throw fail(503, 'Payment status is still being checked. This purchase will resume safely.');
      }
      const failed = await markPaymentFailed(purchase.id, attemptKey, created.error);
      if (!failed) {
        const state = (await q('SELECT * FROM purchases WHERE id=$1', [purchase.id]))[0];
        if (state?.idempotency_key === attemptKey && state.status === 'succeeded')
          return { ...reservation, purchase: state, replayed: true, justCompleted: false };
        if (state?.idempotency_key === attemptKey && state.status === 'pending' && state.stripe_payment)
          throw fail(503, 'Payment status is still being checked. This purchase will resume safely.');
        if (state?.idempotency_key === attemptKey && state.status === 'failed')
          throw fail(402, 'Your card could not be charged — update it in Settings → Billing and try again.');
        throw fail(409, 'This payment attempt was superseded by a newer retry.');
      }
      throw fail(402, 'Your card could not be charged — update it in Settings → Billing and try again.');
    }
    const bound = (await q(`
      UPDATE purchases SET stripe_payment=$1, updated_at=NOW()
      WHERE id=$2 AND status='pending' AND idempotency_key=$3
        AND (stripe_payment='' OR stripe_payment=$1)
      RETURNING *`, [created.paymentId, purchase.id, attemptKey]))[0];
    if (!bound) {
      try {
        await paymentsApi.cancelPayment(created.paymentId, {
          idempotencyKey: `${attemptKey}:cancel-stale`
        });
      } catch (_) {}
      throw fail(409, 'This payment attempt was superseded by a newer retry.');
    }
    purchase = bound;
  }

  const finalized = await withTransaction(async client => {
    const lockedOwner = await first(client, `
      SELECT id, archived_at FROM users
      WHERE id=$1 FOR NO KEY UPDATE`, [purchase.provider_id]);
    const lockedRequest = await first(client, 'SELECT * FROM requests WHERE id=$1 FOR UPDATE', [request.id]);
    const lockedPurchase = await first(client, 'SELECT * FROM purchases WHERE id=$1 FOR UPDATE', [purchase.id]);
    if (lockedPurchase.idempotency_key !== attemptKey)
      return { stale: true };
    if (lockedPurchase.status === 'succeeded') {
      const intent = await ensureResponderIntent(
        client, lockedPurchase, provider, lockedRequest);
      return {
        purchase: lockedPurchase, justCompleted: false, replayed: true, ...intent
      };
    }
    if (lockedPurchase.status !== 'pending')
      throw fail(409, lockedPurchase.payment_error || 'This purchase is not available to retry');
    const lockedProvider = await first(client, `
      SELECT p.* FROM providers p
      WHERE p.user_id=$1 FOR UPDATE`, [purchase.provider_id]);
    if (lockedProvider)
      lockedProvider.owner_archived_at = lockedOwner?.archived_at || null;
    let stopReason = null;
    if (!lockedRequest || lockedRequest.status !== 'open') {
      stopReason = 'Lead closed before payment completed';
    } else {
      try { assertEligible(lockedProvider, lockedRequest); }
      catch (error) { stopReason = error.message; }
    }
    if (stopReason) {
      const canceled = await paymentsApi.cancelPayment(lockedPurchase.stripe_payment, {
        idempotencyKey: `${lockedPurchase.idempotency_key}:cancel`
      });
      if (canceled.ok) {
        await client.query(`
          UPDATE purchases SET status='failed', payment_error=$1, updated_at=NOW() WHERE id=$2`,
          [stopReason, lockedPurchase.id]);
      } else if (canceled.alreadySucceeded || canceled.status === 'succeeded') {
        const refundKey = refundIdentity(lockedPurchase);
        let reversed;
        try {
          reversed = await paymentsApi.refund(lockedPurchase.stripe_payment, {
            idempotencyKey: refundKey,
            refundId: lockedPurchase.stripe_refund || undefined
          });
        } catch (error) {
          reversed = { ok: false, indeterminate: true, error: error.message };
        }
        if (reversed.ok) {
          await client.query(`
            UPDATE purchases SET status='failed', refunded=TRUE, refund_status='succeeded',
              refunded_at=NOW(), payment_error=$1, refund_idempotency_key=$2,
              stripe_refund=COALESCE($3,stripe_refund), updated_at=NOW() WHERE id=$4`,
            [stopReason, refundKey, reversed.refundId || null, lockedPurchase.id]);
        } else {
          await client.query(`
            UPDATE purchases SET status='succeeded', refund_status=$1,
              refund_idempotency_key=$2, stripe_refund=COALESCE($3,stripe_refund),
              payment_error=$4, updated_at=NOW() WHERE id=$5`,
            [reversed.indeterminate ? 'pending' : 'failed', refundKey,
             reversed.refundId || null, String(reversed.error || stopReason).slice(0, 500),
             lockedPurchase.id]);
        }
      } else {
        await client.query(`
          UPDATE purchases SET payment_error=$1, updated_at=NOW() WHERE id=$2`,
          [String(canceled.error || stopReason).slice(0, 500), lockedPurchase.id]);
      }
      return { error: fail(409, stopReason) };
    }

    let confirmed;
    try {
      confirmed = await paymentsApi.confirmLeadPayment(lockedPurchase.stripe_payment, lockedProvider, {
        idempotencyKey: `${lockedPurchase.idempotency_key}:confirm`
      });
    } catch (error) {
      confirmed = { ok: false, error: error.message, indeterminate: true };
    }
    if (!confirmed.ok) {
      if (confirmed.indeterminate) {
        await client.query(`
          UPDATE purchases SET payment_error=$1, updated_at=NOW() WHERE id=$2`,
          [String(confirmed.error || 'Payment status unavailable').slice(0, 500), lockedPurchase.id]);
        return { error: fail(503, 'Payment status is still being checked. This purchase will resume safely.') };
      }
      await client.query(`
        UPDATE purchases SET status='failed', payment_error=$1, updated_at=NOW() WHERE id=$2`,
        [String(confirmed.error || 'Payment failed').slice(0, 500), lockedPurchase.id]);
      return { error: fail(402, 'Your card was declined — update it in Settings → Billing and try again.') };
    }
    const completed = await first(client, `
      UPDATE purchases SET status='succeeded', stripe_payment=$1, payment_error='', updated_at=NOW()
      WHERE id=$2 AND status='pending' RETURNING *`, [confirmed.paymentId, lockedPurchase.id]);
    const finalPurchase = completed || lockedPurchase;
    const intent = completed
      ? await ensureResponderIntent(client, finalPurchase, lockedProvider, lockedRequest)
      : { notificationIds: [], responder: null };
    return {
      purchase: finalPurchase,
      justCompleted: !!completed,
      replayed: !completed,
      ...intent
    };
  });
  if (finalized.stale) {
    try {
      await paymentsApi.cancelPayment(purchase.stripe_payment, {
        idempotencyKey: `${attemptKey}:cancel-stale`
      });
    } catch (_) {}
    throw fail(409, 'This payment attempt was superseded by a newer retry.');
  }
  if (finalized.error) throw finalized.error;
  return { ...reservation, ...finalized, purchase: finalized.purchase };
}

async function purchaseLead({ requestId, providerId, paymentsApi = defaultPayments }) {
  const reservation = await reservePurchase(Number(requestId), Number(providerId), paymentsApi);
  if (reservation.purchase.status === 'succeeded') return reservation;
  return processCardPurchase(reservation, paymentsApi);
}

async function selectProvider({ requestId, driverId, providerId }) {
  return withTransaction(async client => {
    const request = await first(client, 'SELECT * FROM requests WHERE id=$1 FOR UPDATE', [requestId]);
    if (!request || request.driver_id !== Number(driverId))
      throw fail(404, 'Request not found');
    if (request.status !== 'open')
      throw fail(409, 'Request not open');
    const eligible = await first(client, `
      SELECT pu.id
      FROM purchases pu
      JOIN providers p ON p.user_id=pu.provider_id
      JOIN users owner ON owner.id=p.user_id
      WHERE pu.request_id=$1 AND pu.provider_id=$2
        AND pu.refunded=FALSE AND pu.status='succeeded'
        AND pu.refund_status <> 'pending'
        AND p.approved=TRUE AND owner.archived_at IS NULL`,
      [requestId, providerId]);
    if (!eligible)
      throw fail(403, 'Choose a service company that purchased this active request');
    await supersedeNotificationsTx(client, request.id, [
      'new_lead',
      'provider_selected',
      'job_assigned',
      'job_enroute',
      'job_late',
      'job_arrived'
    ]);
    const selected = await first(client, `
      UPDATE requests SET status='selected', selected_provider=$1, selected_at=NOW(),
        job_state='unassigned', job_activity_at=NOW(), stall_alerted=FALSE,
        selection_generation=selection_generation+1
      WHERE id=$2 AND status='open' RETURNING *`, [providerId, requestId]);
    await client.query(`
      INSERT INTO job_events
        (request_id, event_type, from_state, to_state, actor_id, assignment_version)
      VALUES ($1,'provider_selected','open','unassigned',$2,$3)`,
      [requestId, driverId, selected.assignment_version]);
    let recipients = (await client.query(`
      SELECT id, phone FROM users
      WHERE company_id=$1 AND archived_at IS NULL
        AND member_role IN ('owner','dispatcher')
      ORDER BY id`, [providerId])).rows;
    if (!recipients.length)
      recipients = (await client.query(`
        SELECT id, phone FROM users WHERE id=$1 AND archived_at IS NULL`, [providerId])).rows;
    const notificationIds = [];
    for (const recipient of recipients) {
      const notification = await enqueueSms(recipient.id, recipient.phone,
        `RIGRX: You got the job! Request #${selected.id} (${selected.service_label}). The driver chose your company.`, {
          client,
          requestId: selected.id,
          eventType: 'provider_selected',
          dedupeKey: `request:${selected.id}:selected:g${selected.selection_generation}:recipient:${recipient.id}`,
          payload: {
            provider_id: providerId,
            selection_generation: selected.selection_generation
          }
        });
      if (notification) notificationIds.push(notification.id);
    }
    selected.notificationIds = notificationIds;
    selected.winnerRecipients = recipients.map(recipient => recipient.id);
    return selected;
  });
}

async function refundPurchase({ purchaseId, paymentsApi = defaultPayments }) {
  const prepared = await withTransaction(async client => {
    const purchase = await first(client, `
      SELECT pu.*, r.status AS request_status, r.selected_provider
      FROM purchases pu JOIN requests r ON r.id=pu.request_id
      WHERE pu.id=$1 FOR UPDATE OF pu, r`, [purchaseId]);
    if (!purchase) throw fail(404, 'Purchase not found');
    if (purchase.refunded) return { purchase, replayed: true };
    if (purchase.status !== 'succeeded')
      throw fail(409, 'Only completed purchases can be refunded');
    if (purchase.selected_provider === purchase.provider_id
        && ['selected', 'completed'].includes(purchase.request_status))
      throw fail(409, 'This company is assigned to the job. Cancel or reassign the job before refunding its lead.');

    if (purchase.paid_with === 'credit') {
      await client.query('UPDATE providers SET lead_credits=lead_credits+1 WHERE user_id=$1', [purchase.provider_id]);
      await client.query(`
        INSERT INTO credit_log (provider_id, delta, reason, by_admin, event_key)
        VALUES ($1,1,$2,TRUE,$3) ON CONFLICT DO NOTHING`,
        [purchase.provider_id, `Refund of lead #${purchase.request_id}`, `purchase:${purchase.id}:refund`]);
      const refunded = await first(client, `
        UPDATE purchases SET refunded=TRUE, refund_status='succeeded', refunded_at=NOW(), updated_at=NOW()
        WHERE id=$1 RETURNING *`, [purchase.id]);
      return { purchase: refunded, replayed: false, complete: true };
    }

    const pending = await first(client, `
      UPDATE purchases SET refund_status='pending', refund_idempotency_key=$1,
        payment_error='', updated_at=NOW()
      WHERE id=$2 RETURNING *`, [refundIdentity(purchase), purchase.id]);
    return { purchase: pending, replayed: purchase.refund_status === 'pending', complete: false };
  });

  if (prepared.complete || prepared.purchase.refunded) return prepared;
  let result;
  try {
    result = await paymentsApi.refund(prepared.purchase.stripe_payment, {
      idempotencyKey: refundIdentity(prepared.purchase),
      refundId: prepared.purchase.stripe_refund || undefined
    });
  } catch (error) {
    result = { ok: false, error: error.message, indeterminate: true };
  }
  if (!result.ok) {
    await q(`
      UPDATE purchases SET refund_status=$1, stripe_refund=COALESCE($2,stripe_refund),
        payment_error=$3, updated_at=NOW()
      WHERE id=$4 AND refunded=FALSE`,
      [result.indeterminate ? 'pending' : 'failed', result.refundId || null,
       String(result.error || 'Refund failed').slice(0, 500), prepared.purchase.id]);
    throw fail(result.indeterminate ? 503 : 400,
      result.indeterminate ? 'Refund status is still being checked and will resume safely.' : (result.error || 'Refund failed'));
  }
  const updated = (await q(`
    UPDATE purchases SET refunded=TRUE, refund_status='succeeded', refunded_at=NOW(),
      stripe_refund=COALESCE($1,stripe_refund), payment_error='', updated_at=NOW()
    WHERE id=$2 AND refunded=FALSE RETURNING *`,
    [result.refundId || null, prepared.purchase.id]))[0];
  return { purchase: updated || { ...prepared.purchase, refunded: true }, replayed: !updated };
}

async function reconcilePayments({ paymentsApi = defaultPayments } = {}) {
  const report = { purchases: [], refunds: [], errors: [] };
  const pending = await q(`SELECT id, request_id, provider_id FROM purchases WHERE status='pending' ORDER BY id LIMIT 25`);
  for (const row of pending) {
    try {
      const provider = (await q(`
        SELECT p.*, u.archived_at AS owner_archived_at
        FROM providers p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1`, [row.provider_id]))[0];
      const request = (await q(`
        SELECT r.*, pr.standard_cents, pr.premium_cents
        FROM requests r JOIN pricing pr ON pr.service_key=r.service_key WHERE r.id=$1`, [row.request_id]))[0];
      const purchase = (await q('SELECT * FROM purchases WHERE id=$1', [row.id]))[0];
      if (!provider || !request || !purchase) continue;
      const result = await processCardPurchase({ purchase, provider, request, replayed: true }, paymentsApi);
      if (result.justCompleted) report.purchases.push(result.purchase.id);
    } catch (error) {
      report.errors.push({ purchase_id: row.id, error: error.message });
    }
  }
  const refunds = await q(`
    SELECT id FROM purchases WHERE refund_status='pending' AND refunded=FALSE ORDER BY id LIMIT 25`);
  for (const row of refunds) {
    try {
      await refundPurchase({ purchaseId: row.id, paymentsApi });
      report.refunds.push(row.id);
    } catch (error) {
      report.errors.push({ refund_purchase_id: row.id, error: error.message });
    }
  }
  return report;
}

module.exports = {
  ACTIVE_PURCHASE,
  purchaseLead,
  selectProvider,
  refundPurchase,
  reconcilePayments
};
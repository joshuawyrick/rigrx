// ============ Durable notifications: SMS outbox + in-app WebSocket push ============
const crypto = require('crypto');
const { q, one, withTransaction } = require('./db');
const { simulationEnabled, smsConfigured } = require('./config');

let twilioClient = null;
if (smsConfigured()) {
  try { twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN); }
  catch (e) {
    if (!simulationEnabled()) throw e;
    console.error('Twilio init failed; explicit development simulation remains active:', e.message);
  }
}

const MAX_ATTEMPTS = 5;
const RETRY_MINUTES = [1, 2, 5, 15, 30];

function generatedKey(eventType) {
  return `${eventType || 'sms'}:${crypto.randomUUID()}`;
}

async function enqueueSms(userId, phone, body, options = {}) {
  const eventType = String(options.eventType || 'general').slice(0, 80);
  const dedupeKey = options.dedupeKey || generatedKey(eventType);
  const text = `
    INSERT INTO notifications_log
      (user_id, channel, body, simulated, phone, event_type, request_id, payload,
       dedupe_key, status, available_at, updated_at)
    VALUES ($1,'sms',$2,$3,$4,$5,$6,$7,$8,'pending',NOW(),NOW())
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING *`;
  const params = [userId || null, body, simulationEnabled(), phone || '', eventType,
    options.requestId || null, JSON.stringify(options.payload || {}), dedupeKey];
  const row = options.client
    ? (await options.client.query(text, params)).rows[0] || null
    : await one(text, params);
  if (row) return row;
  if (options.client)
    return (await options.client.query(
      'SELECT * FROM notifications_log WHERE dedupe_key=$1', [dedupeKey])).rows[0] || null;
  return await one('SELECT * FROM notifications_log WHERE dedupe_key=$1', [dedupeKey]);
}

async function claimNotification(onlyId = null) {
  return await withTransaction(async client => {
    const result = await client.query(`
      SELECT * FROM notifications_log
      WHERE channel='sms'
        AND (
          (status='pending' AND available_at <= NOW())
          OR (status='sending' AND locked_at < NOW() - INTERVAL '5 minutes')
        )
        AND ($1::bigint IS NULL OR id=$1)
      ORDER BY available_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1`, [onlyId]);
    if (!result.rows.length) return [];
    const claimToken = crypto.randomUUID();
    const claimed = await client.query(`
      UPDATE notifications_log
      SET status='sending', locked_at=NOW(), claim_token=$1,
        attempts=attempts+1, updated_at=NOW()
      WHERE id=$2 RETURNING *`, [claimToken, result.rows[0].id]);
    return claimed.rows;
  });
}

async function recordNotificationFailure(row, error) {
  const message = String(error?.message || error || 'Unknown delivery error').slice(0, 500);
  const dead = row.attempts >= MAX_ATTEMPTS;
  const delay = RETRY_MINUTES[Math.min(row.attempts - 1, RETRY_MINUTES.length - 1)];
  const finalized = await withTransaction(async client => {
    if (row.request_id)
      await client.query('SELECT id FROM requests WHERE id=$1 FOR SHARE', [row.request_id]);
    const changed = await client.query(`
      UPDATE notifications_log
      SET status=$1, last_error=$2, locked_at=NULL, claim_token=NULL,
          available_at=NOW() + ($3::int * INTERVAL '1 minute'), updated_at=NOW()
      WHERE id=$4 AND status='sending' AND claim_token=$5
      RETURNING id`,
      [dead ? 'dead' : 'pending', message, delay, row.id, row.claim_token]);
    if (!changed.rows.length) return false;
    if (row.request_id) {
      await client.query(`
        INSERT INTO dispatch_exceptions (request_id, type, status, detail)
        VALUES ($1,'notification_failure','open',$2)
        ON CONFLICT (request_id, type) WHERE status IN ('open','acknowledged')
        DO UPDATE SET status='open', detail=EXCLUDED.detail,
          occurrence=dispatch_exceptions.occurrence+1, updated_at=NOW()`,
        [row.request_id, JSON.stringify({
          notification_id: row.id,
          event_type: row.event_type,
          attempts: row.attempts,
          error: message,
          dead
        })]);
    }
    return true;
  });
  if (!finalized) return { id: row.id, status: 'superseded' };
  console.error(`SMS delivery failed (notification ${row.id}, attempt ${row.attempts}):`, message);
  return { id: row.id, status: dead ? 'dead' : 'pending', error: message };
}

async function validateClaimApplicability(row) {
  if (!row.request_id) return true;
  return await withTransaction(async client => {
    const request = (await client.query(
      'SELECT * FROM requests WHERE id=$1 FOR SHARE', [row.request_id])).rows[0];
    const current = (await client.query(`
      SELECT status, claim_token FROM notifications_log
      WHERE id=$1 FOR UPDATE`, [row.id])).rows[0];
    if (!current || current.status !== 'sending' || current.claim_token !== row.claim_token)
      return false;
    const payload = row.payload || {};
    let applicable = true;
    if (!request) {
      applicable = false;
    } else if (row.event_type === 'new_lead') {
      applicable = request.status === 'open';
    } else if (row.event_type === 'provider_selected') {
      applicable = request.status === 'selected'
        && request.selected_provider === Number(payload.provider_id)
        && request.selection_generation === Number(payload.selection_generation);
    } else if (row.event_type === 'job_assigned') {
      applicable = request.status === 'selected'
        && ['assigned','accepted'].includes(request.job_state)
        && request.assigned_tech === Number(payload.tech_id)
        && request.assignment_version === Number(payload.assignment_version);
    } else if (row.event_type === 'job_enroute') {
      applicable = request.status === 'selected'
        && request.job_state === 'enroute'
        && request.assignment_version === Number(payload.assignment_version)
        && new Date(request.eta_set_at).getTime() === new Date(payload.eta_set_at).getTime();
    } else if (row.event_type === 'job_late') {
      applicable = request.status === 'selected'
        && request.job_state === 'enroute'
        && request.assignment_version === Number(payload.assignment_version)
        && request.late_update_generation === Number(payload.late_update_generation);
    } else if (row.event_type === 'job_arrived') {
      applicable = request.status === 'selected'
        && request.job_state === 'arrived'
        && request.assignment_version === Number(payload.assignment_version);
    } else if (row.event_type === 'job_unassigned') {
      applicable = ['open','selected'].includes(request.status)
        && request.assigned_tech !== Number(row.user_id);
    } else if ([
      'dispatch_attention',
      'assignment_bounced_driver',
      'assignment_timeout_driver',
      'technician_removed_driver'
    ].includes(row.event_type)) {
      applicable = request.status === 'selected'
        && request.job_state === 'unassigned'
        && request.assignment_version === Number(payload.assignment_version);
    } else if (row.event_type === 'driver_rescue') {
      applicable = request.status === 'selected'
        && ['unassigned','assigned','accepted'].includes(request.job_state)
        && request.selected_provider === Number(payload.provider_id)
        && request.assignment_version === Number(payload.assignment_version);
    } else if (row.event_type === 'job_reopened') {
      applicable = request.status === 'open'
        && request.reopen_generation === Number(payload.reopen_generation);
    } else if (['job_cancelled','job_cancelled_technician'].includes(row.event_type)) {
      applicable = request.status === 'cancelled';
    } else if (row.event_type === 'request_silent_alarm') {
      applicable = request.status === 'open'
        && request.silent_alert_generation === Number(payload.silent_alert_generation);
    } else if (['job_stalled_provider','job_stalled_admin'].includes(row.event_type)) {
      applicable = request.status === 'selected'
        && ['unassigned','assigned','accepted'].includes(request.job_state)
        && request.stall_alert_generation === Number(payload.stall_alert_generation)
        && request.assignment_version === Number(payload.assignment_version);
    } else if (row.event_type === 'request_expiry_warning') {
      applicable = request.status === 'open';
    } else if (row.event_type === 'request_expired') {
      applicable = request.status === 'expired';
    } else if (['job_complete','driver_completed'].includes(row.event_type)) {
      applicable = request.status === 'completed';
    } else if (row.event_type === 'responder_unlocked') {
      applicable = ['open','selected'].includes(request.status);
    }
    if (!applicable) {
      await client.query(`
        UPDATE notifications_log
        SET status='superseded', locked_at=NULL, claim_token=NULL,
          last_error='Superseded by newer request state', updated_at=NOW()
        WHERE id=$1 AND status='sending' AND claim_token=$2`,
        [row.id, row.claim_token]);
    }
    return applicable;
  });
}

async function deliverClaimed(row) {
  const heartbeat = setInterval(() => {
    q(`UPDATE notifications_log SET locked_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='sending' AND claim_token=$2`,
      [row.id, row.claim_token]).catch(error =>
      console.error(`Notification ${row.id} claim heartbeat failed:`, error.message));
  }, 60 * 1000);
  heartbeat.unref?.();
  try {
    if (!await validateClaimApplicability(row))
      return { id: row.id, status: 'superseded' };
    if (!row.phone) throw new Error('No destination phone number');
    let providerMessageId = '';
    let simulated = true;
    if (twilioClient && process.env.TWILIO_FROM_NUMBER) {
      const sent = await twilioClient.messages.create({
        to: row.phone,
        from: process.env.TWILIO_FROM_NUMBER,
        body: row.body
      });
      providerMessageId = sent?.sid || '';
      simulated = false;
    } else {
      if (!simulationEnabled()) throw new Error('SMS delivery is not configured');
      console.log(`[SMS→${row.phone}] ${row.body}`);
    }
    const finalized = await withTransaction(async client => {
      if (row.request_id)
        await client.query('SELECT id FROM requests WHERE id=$1 FOR SHARE', [row.request_id]);
      const changed = await client.query(`
        UPDATE notifications_log
        SET status='sent', simulated=$1, provider_message_id=$2, sent_at=NOW(),
            locked_at=NULL, claim_token=NULL, last_error='', updated_at=NOW()
        WHERE id=$3 AND status='sending' AND claim_token=$4
        RETURNING id`, [simulated, providerMessageId, row.id, row.claim_token]);
      if (!changed.rows.length) return false;
      if (row.request_id) {
        await client.query(`
          UPDATE dispatch_exceptions SET status='resolved', resolved_at=NOW(),
            resolution='A later notification attempt succeeded', updated_at=NOW()
          WHERE request_id=$1 AND type='notification_failure'
            AND status IN ('open','acknowledged')
            AND NOT EXISTS (
              SELECT 1 FROM notifications_log n
              WHERE n.request_id=$1 AND n.status IN ('pending','sending','dead')
                AND n.id<>$2
            )`, [row.request_id, row.id]);
      }
      return true;
    });
    if (!finalized) return { id: row.id, status: 'superseded' };
    return { id: row.id, status: 'sent', simulated, providerMessageId };
  } catch (error) {
    return await recordNotificationFailure(row, error);
  } finally {
    clearInterval(heartbeat);
  }
}

async function processNotificationOutbox({ limit = 25, onlyId = null } = {}) {
  const results = [];
  const max = Math.max(1, Math.min(100, Number(limit) || 25));
  for (let i = 0; i < max; i++) {
    const [row] = await claimNotification(onlyId);
    if (!row) break;
    results.push(await deliverClaimed(row));
    if (onlyId) break;
  }
  return results;
}

async function processNotificationIds(ids = []) {
  const results = [];
  for (const id of [...new Set(ids.filter(Boolean))]) {
    const delivered = await processNotificationOutbox({ limit: 1, onlyId: id });
    if (delivered[0]) results.push(delivered[0]);
  }
  return results;
}

async function supersedeNotificationsTx(client, requestId, eventTypes) {
  const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
  if (!types.length) return [];
  return (await client.query(`
    UPDATE notifications_log
    SET status='superseded', locked_at=NULL, claim_token=NULL,
      last_error='Superseded by newer request state', updated_at=NOW()
    WHERE request_id=$1 AND event_type=ANY($2::text[])
      AND status IN ('pending','sending')
    RETURNING id`, [requestId, types])).rows;
}

// Existing call sites keep a simple interface, but delivery is now recorded before
// it is attempted. A Twilio outage no longer makes a successful business transition
// look rolled back; the worker retries and the admin queue exposes the failure.
async function sms(userId, phone, body, options = {}) {
  const notification = await enqueueSms(userId, phone, body, options);
  if (notification.status === 'sent') return { id: notification.id, status: 'sent', replayed: true };
  const [result] = await processNotificationOutbox({ limit: 1, onlyId: notification.id });
  return result || { id: notification.id, status: notification.status, replayed: true };
}

// WebSocket registry: userId -> Set of sockets (set up in index.js). WebSockets are
// an immediate refresh hint; durable state and SMS remain available after reconnect.
const sockets = new Map();
const sessionSockets = new Map();
// Is this person's app open right now? Someone looking at the screen gets the
// in-app toast; someone who closed Safari gets a text instead.
function isOnline(userId) {
  const set = sockets.get(userId);
  return !!set && set.size > 0;
}

function wsRegister(userId, socket, sessionToken) {
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(socket);
  if (sessionToken) {
    if (!sessionSockets.has(sessionToken)) sessionSockets.set(sessionToken, new Set());
    sessionSockets.get(sessionToken).add(socket);
  }
  socket.on('close', () => {
    sockets.get(userId)?.delete(socket);
    if (!sockets.get(userId)?.size) sockets.delete(userId);
    if (sessionToken) {
      sessionSockets.get(sessionToken)?.delete(socket);
      if (!sessionSockets.get(sessionToken)?.size) sessionSockets.delete(sessionToken);
    }
  });
}
function wsPush(userId, event, data) {
  const set = sockets.get(Number(userId));
  if (!set) return false;
  const payload = JSON.stringify({ event, data });
  let delivered = false;
  for (const socket of set) {
    try {
      socket.send(payload);
      delivered = true;
    } catch (_) {}
  }
  return delivered;
}

function closeSockets(set) {
  if (!set) return;
  for (const socket of [...set]) {
    try { socket.close(4001, 'Session ended'); } catch (_) {}
  }
}

function wsRevokeUser(userId) {
  closeSockets(sockets.get(Number(userId)));
}

function wsRevokeSession(sessionToken) {
  closeSockets(sessionSockets.get(sessionToken));
}

function _setTwilioClient(client) {
  twilioClient = client;
}

module.exports = {
  isOnline,
  sms,
  enqueueSms,
  processNotificationOutbox,
  processNotificationIds,
  supersedeNotificationsTx,
  wsRegister,
  wsPush,
  wsRevokeUser,
  wsRevokeSession,
  _setTwilioClient
};
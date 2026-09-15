const { q, withTransaction } = require('./db');
const { enqueueSms, supersedeNotificationsTx } = require('./notify');

const MOVEMENT_NOTIFICATION_TYPES = [
  'job_assigned',
  'job_enroute',
  'job_late',
  'job_arrived'
];

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function first(client, text, params = []) {
  const result = await client.query(text, params);
  return result.rows[0] || null;
}

async function event(client, request, type, fromState, toState, actorId, detail = {}) {
  await client.query(`
    INSERT INTO job_events
      (request_id, event_type, from_state, to_state, actor_id, assigned_tech,
       assignment_version, detail)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [request.id, type, fromState, toState, actorId || null,
     request.assigned_tech || null, request.assignment_version || 0,
     JSON.stringify(detail)]);
}

async function exceptionTx(client, requestId, type, detail = {}, values = {}) {
  await client.query(`
    INSERT INTO dispatch_exceptions
      (request_id, type, provider_id, tech_id, status, detail)
    VALUES ($1,$2,$3,$4,'open',$5)
    ON CONFLICT (request_id, type) WHERE status IN ('open','acknowledged')
    DO UPDATE SET status='open', provider_id=EXCLUDED.provider_id,
      tech_id=EXCLUDED.tech_id, detail=EXCLUDED.detail,
      occurrence=dispatch_exceptions.occurrence+1, updated_at=NOW()`,
    [requestId, type, values.providerId || null, values.techId || null,
     JSON.stringify(detail)]);
}

async function resolveExceptionTx(client, requestId, types, resolution) {
  const list = Array.isArray(types) ? types : [types];
  await client.query(`
    UPDATE dispatch_exceptions
    SET status='resolved', resolved_at=NOW(), updated_at=NOW(), resolution=$3
    WHERE request_id=$1 AND type=ANY($2::text[])
      AND status IN ('open','acknowledged')`,
    [requestId, list, resolution || 'Recovered']);
}

async function queueSms(client, ids, userId, phone, body, options) {
  const row = await enqueueSms(userId, phone, body, { ...options, client });
  if (row) ids.push(row.id);
}

async function dispatchRecipients(client, providerId) {
  const result = await client.query(`
    SELECT id, phone, name FROM users
    WHERE company_id=$1 AND archived_at IS NULL
      AND member_role IN ('owner','dispatcher')
    ORDER BY id`, [providerId]);
  if (result.rows.length) return result.rows;
  const fallback = await client.query(`
    SELECT id, phone, name FROM users
    WHERE id=$1 AND archived_at IS NULL`, [providerId]);
  return fallback.rows;
}

async function lockCompanyOwner(client, companyId) {
  let owner = await first(client, `
    SELECT * FROM users
    WHERE id=$1 AND role='provider' AND archived_at IS NULL
      AND (
        member_role='owner'
        OR (COALESCE(member_role,'')='' AND (company_id IS NULL OR company_id=id))
      )
    FOR NO KEY UPDATE`, [companyId]);
  if (owner && ((owner.member_role || '') !== 'owner' || owner.company_id !== owner.id))
    owner = await first(client, `
      UPDATE users SET member_role='owner', company_id=id
      WHERE id=$1 RETURNING *`, [companyId]);
  return owner;
}

function localized(user, en, es) {
  return user?.lang === 'es' && es ? es : en;
}

async function openException(requestId, type, detail = {}, values = {}) {
  await q(`
    INSERT INTO dispatch_exceptions
      (request_id, type, provider_id, tech_id, status, detail)
    VALUES ($1,$2,$3,$4,'open',$5)
    ON CONFLICT (request_id, type) WHERE status IN ('open','acknowledged')
    DO UPDATE SET status='open', provider_id=EXCLUDED.provider_id,
      tech_id=EXCLUDED.tech_id, detail=EXCLUDED.detail,
      occurrence=dispatch_exceptions.occurrence+1, updated_at=NOW()`,
    [requestId, type, values.providerId || null, values.techId || null,
     JSON.stringify(detail)]);
}

async function resolveException(requestId, types, resolution) {
  const list = Array.isArray(types) ? types : [types];
  await q(`
    UPDATE dispatch_exceptions
    SET status='resolved', resolved_at=NOW(), updated_at=NOW(), resolution=$3
    WHERE request_id=$1 AND type=ANY($2::text[])
      AND status IN ('open','acknowledged')`,
    [requestId, list, resolution || 'Recovered']);
}

async function assignJob({
  requestId, companyId, actorId, techId, expectedAssignmentVersion, commandKey
}) {
  return await withTransaction(async client => {
    const notificationIds = [];
    if (!Number.isInteger(Number(expectedAssignmentVersion)) || Number(expectedAssignmentVersion) < 0)
      throw fail(400, 'The current assignment version is required');
    if (!/^[A-Za-z0-9:_-]{16,120}$/.test(String(commandKey || '')))
      throw fail(400, 'A valid assignment command key is required');
    const company = await lockCompanyOwner(client, companyId);
    if (!company) throw fail(409, 'This company account is no longer active');

    const replay = await first(client, `
      SELECT * FROM dispatch_commands WHERE command_key=$1`, [commandKey]);
    if (replay) {
      if (replay.request_id !== Number(requestId) || replay.actor_id !== Number(actorId)
          || replay.command_type !== 'assign')
        throw fail(409, 'That assignment command belongs to another action');
      const current = await first(client, `
        SELECT * FROM requests WHERE id=$1 AND selected_provider=$2`, [requestId, companyId]);
      if (!current) throw fail(404, 'Not one of your jobs');
      return {
        request: current,
        tech: null,
        previousTechId: null,
        replayed: true,
        commandReplayed: true,
        notificationIds
      };
    }

    // Anyone assignable on the team can take a job — including the owner or a
    // dispatcher. A one-person shop IS its own technician.
    const tech = await first(client, `
      SELECT * FROM users
      WHERE id=$1 AND company_id=$2 AND member_role IN ('tech','owner','dispatcher')
        AND assignable=TRUE AND archived_at IS NULL
      FOR NO KEY UPDATE`, [techId, companyId]);
    if (!tech) throw fail(400, 'Pick an active, assignable person on your team');

    const request = await first(client, `
      SELECT * FROM requests
      WHERE id=$1 AND selected_provider=$2
      FOR UPDATE`, [requestId, companyId]);
    if (!request) throw fail(404, 'Not one of your jobs');
    if (request.status !== 'selected' || ['enroute', 'arrived', 'completed'].includes(request.job_state))
      throw fail(409, 'This job can no longer be assigned');

    const racedReplay = await first(client, `
      SELECT * FROM dispatch_commands WHERE command_key=$1`, [commandKey]);
    if (racedReplay) {
      if (racedReplay.request_id !== Number(requestId) || racedReplay.actor_id !== Number(actorId))
        throw fail(409, 'That assignment command belongs to another action');
      return {
        request,
        tech,
        previousTechId: null,
        replayed: true,
        commandReplayed: true,
        notificationIds
      };
    }
    if (request.assignment_version !== Number(expectedAssignmentVersion))
      throw fail(409, 'This job changed. Refresh before assigning it again.');

    if (request.assigned_tech === tech.id && ['assigned','accepted'].includes(request.job_state)) {
      await client.query(`
        INSERT INTO dispatch_commands
          (command_key,request_id,actor_id,command_type,expected_assignment_version,result_assignment_version)
        VALUES ($1,$2,$3,'assign',$4,$5)`,
        [commandKey, request.id, actorId, expectedAssignmentVersion, request.assignment_version]);
      return {
        request,
        tech,
        previousTechId: null,
        replayed: true,
        commandReplayed: false,
        notificationIds
      };
    }

    const previousTechId = request.assigned_tech;
    const fromState = request.job_state;
    // Assigning a job to YOURSELF is its own acceptance — no one should have to
    // formally agree with themselves, or get bounced by the no-answer sweep for
    // not doing so. The accept step exists so a dispatcher knows a tech actually
    // saw the job; when they're the same person, it's noise.
    const selfAssign = Number(tech.id) === Number(actorId);
    await supersedeNotificationsTx(client, request.id, MOVEMENT_NOTIFICATION_TYPES);
    const updated = await first(client, `
      UPDATE requests
      SET assigned_tech=$1, assigned_at=NOW(),
        accepted_at=CASE WHEN $3::boolean THEN NOW() ELSE NULL END,
        enroute_at=NULL,
        arrived_at=NULL, eta_minutes=NULL, eta_set_at=NULL, assign_bounced=FALSE,
        bounced_at=NULL, declined_by=NULL, decline_reason='',
        assignment_version=assignment_version+1,
        job_state=CASE WHEN $3::boolean THEN 'accepted' ELSE 'assigned' END,
        job_activity_at=NOW(), stall_alerted=FALSE,
        rescue_requested_at=NULL, rescue_reason=''
      WHERE id=$2
      RETURNING *`, [tech.id, request.id, selfAssign]);
    await event(client, updated, previousTechId ? 'reassigned' : 'assigned',
      fromState, updated.job_state, actorId,
      { previous_tech_id: previousTechId, self_assigned: selfAssign });
    await resolveExceptionTx(client, request.id, 'assignment_bounced',
      'Job reassigned to an active technician');
    if (previousTechId && previousTechId !== tech.id) {
      const previous = await first(client, 'SELECT id, phone FROM users WHERE id=$1', [previousTechId]);
      if (previous) await queueSms(client, notificationIds, previous.id, previous.phone,
        `RIGRX: Job #${updated.id} was reassigned. It is no longer in your queue.`, {
          requestId: updated.id,
          eventType: 'job_unassigned',
          dedupeKey: `request:${updated.id}:unassigned:v${updated.assignment_version}:tech:${previous.id}`,
          payload: { assignment_version: updated.assignment_version }
        });
    }
    if (!selfAssign) await queueSms(client, notificationIds, tech.id, tech.phone,
      `RIGRX JOB: ${updated.service_label} ${updated.area_label}. Open the app to accept. ${process.env.BASE_URL || ''}`, {
        requestId: updated.id,
        eventType: 'job_assigned',
        dedupeKey: `request:${updated.id}:assigned:v${updated.assignment_version}:tech:${tech.id}`,
         payload: {
           assignment_version: updated.assignment_version,
           tech_id: tech.id
         }
      });
    await client.query(`
      INSERT INTO dispatch_commands
        (command_key,request_id,actor_id,command_type,expected_assignment_version,result_assignment_version)
      VALUES ($1,$2,$3,'assign',$4,$5)`,
      [commandKey, request.id, actorId, expectedAssignmentVersion, updated.assignment_version]);
    return { request: updated, tech, previousTechId, replayed: false,
             selfAssigned: selfAssign, notificationIds };
  });
}

const EXPECTED = {
  accept: ['assigned'],
  decline: ['assigned', 'accepted'],
  enroute: ['accepted'],
  late: ['enroute'],
  arrived: ['enroute'],
  complete: ['arrived']
};

async function techAction({
  requestId, techId, assignmentVersion, action, etaMinutes, reason, actionKey
}) {
  if (!EXPECTED[action]) throw fail(400, 'Unknown job action');
  if (!Number.isInteger(Number(assignmentVersion)))
    throw fail(409, 'This job assignment is stale. Refresh your jobs.');
  if (action === 'late' && !/^[A-Za-z0-9:_-]{16,120}$/.test(String(actionKey || '')))
    throw fail(400, 'A valid status update key is required');

  return await withTransaction(async client => {
    const notificationIds = [];
    if (action === 'late') {
      const replay = await first(client,
        'SELECT * FROM dispatch_commands WHERE command_key=$1', [actionKey]);
      if (replay) {
        if (replay.request_id !== Number(requestId) || replay.actor_id !== Number(techId)
            || replay.command_type !== 'late')
          throw fail(409, 'That status update key belongs to another action');
        const current = await first(client, 'SELECT * FROM requests WHERE id=$1', [requestId]);
        if (!current) throw fail(404, 'Job not found');
        return { request: current, replayed: true, notificationIds };
      }
    }
    const technician = await first(client, `
      SELECT id, company_id FROM users
      WHERE id=$1 AND role='provider' AND member_role IN ('tech','owner','dispatcher')
        AND assignable=TRUE AND archived_at IS NULL
      FOR NO KEY UPDATE`, [techId]);
    if (!technician) throw fail(403, 'This technician account is no longer active');
    const request = await first(client, 'SELECT * FROM requests WHERE id=$1 FOR UPDATE', [requestId]);
    if (!request) throw fail(404, 'Job not found');
    if (request.assigned_tech !== Number(techId)
        || request.assignment_version !== Number(assignmentVersion))
      throw fail(409, 'This job is no longer assigned to you');
    if (technician.company_id !== request.selected_provider)
      throw fail(409, 'This job belongs to another company');
    if (action === 'late') {
      const racedReplay = await first(client,
        'SELECT * FROM dispatch_commands WHERE command_key=$1', [actionKey]);
      if (racedReplay) {
        if (racedReplay.request_id !== Number(requestId)
            || racedReplay.actor_id !== Number(techId)
            || racedReplay.command_type !== 'late')
          throw fail(409, 'That status update key belongs to another action');
        return { request, replayed: true, notificationIds };
      }
    }
    if (request.status === 'completed' && action === 'complete')
      return { request, replayed: true, notificationIds };
    if (request.status !== 'selected' || !EXPECTED[action].includes(request.job_state))
      throw fail(409, `Cannot ${action} a job while it is ${request.job_state || request.status}`);

    const fromState = request.job_state;
    if (action !== 'accept')
      await supersedeNotificationsTx(client, request.id, MOVEMENT_NOTIFICATION_TYPES);
    let updated;
    if (action === 'accept') {
      updated = await first(client, `
        UPDATE requests SET job_state='accepted', accepted_at=NOW(),
          assign_bounced=FALSE, job_activity_at=NOW(), stall_alerted=FALSE
        WHERE id=$1 RETURNING *`, [request.id]);
    } else if (action === 'decline') {
      updated = await first(client, `
        UPDATE requests SET job_state='unassigned', assigned_tech=NULL,
          assigned_at=NULL, accepted_at=NULL, enroute_at=NULL, arrived_at=NULL,
          eta_minutes=NULL, eta_set_at=NULL, assign_bounced=TRUE,
          assignment_bounces=assignment_bounces+1, bounced_at=NOW(),
          declined_by=$1, decline_reason=$2, job_activity_at=NOW(),
          assignment_version=assignment_version+1
        WHERE id=$3 RETURNING *`,
        [techId, String(reason || '').trim().slice(0, 200), request.id]);
    } else if (action === 'enroute') {
      const eta = Math.max(1, Math.min(600, Number(etaMinutes) || 30));
      updated = await first(client, `
        UPDATE requests SET job_state='enroute', enroute_at=NOW(),
          eta_minutes=$1, eta_set_at=NOW(), job_activity_at=NOW(),
          rescue_requested_at=NULL, rescue_reason=''
        WHERE id=$2 RETURNING *`, [eta, request.id]);
    } else if (action === 'late') {
      const eta = Math.max(1, Math.min(600, Number(etaMinutes) || 15));
      updated = await first(client, `
        UPDATE requests SET eta_minutes=$1, eta_set_at=NOW(), job_activity_at=NOW(),
          late_update_generation=late_update_generation+1
        WHERE id=$2 RETURNING *`, [eta, request.id]);
    } else if (action === 'arrived') {
      updated = await first(client, `
        UPDATE requests SET job_state='arrived', arrived_at=NOW(), job_activity_at=NOW()
        WHERE id=$1 RETURNING *`, [request.id]);
    } else {
      updated = await first(client, `
        UPDATE requests SET status='completed', job_state='completed',
          completed_at=NOW(), job_activity_at=NOW()
        WHERE id=$1 RETURNING *`, [request.id]);
      await client.query('UPDATE providers SET jobs_won=jobs_won+1 WHERE user_id=$1',
        [request.selected_provider]);
    }
    await event(client, updated, action, fromState, updated.job_state, techId,
      action === 'late' || action === 'enroute' ? { eta_minutes: updated.eta_minutes } : {});
    if (action === 'decline') {
      await exceptionTx(client, request.id, 'assignment_bounced', {
        reason: 'declined',
        technician_id: techId
      }, { providerId: request.selected_provider, techId });
      const recipients = await dispatchRecipients(client, request.selected_provider);
      const tech = await first(client, 'SELECT name FROM users WHERE id=$1', [techId]);
      for (const person of recipients)
        await queueSms(client, notificationIds, person.id, person.phone,
          `RIGRX: ${tech?.name || 'A tech'} declined job #${request.id} — reassign it.`, {
            requestId: request.id,
            eventType: 'dispatch_attention',
            dedupeKey: `request:${request.id}:dispatch:declined:v${updated.assignment_version}:person:${person.id}`,
            payload: { assignment_version: updated.assignment_version }
          });
      const driver = await first(client, 'SELECT id, phone, lang FROM users WHERE id=$1', [request.driver_id]);
      if (driver) await queueSms(client, notificationIds, driver.id, driver.phone, localized(driver,
        `RIGRX: The technician for Job #${request.id} could not take it. The company is assigning someone else now.`,
        `RIGRX: El técnico del trabajo #${request.id} no pudo atenderlo. La compañía está asignando a otra persona.`), {
          requestId: request.id,
          eventType: 'assignment_bounced_driver',
          dedupeKey: `request:${request.id}:declined-driver:v${updated.assignment_version}`,
          payload: { assignment_version: updated.assignment_version }
        });
    } else if (['enroute','late','arrived','complete'].includes(action)) {
      if (action === 'enroute')
        await resolveExceptionTx(client, request.id, ['stalled', 'assignment_bounced'],
          'Technician is en route');
      if (action === 'arrived')
        await resolveExceptionTx(client, request.id, 'stalled', 'Technician arrived');
      if (action === 'complete')
        await resolveExceptionTx(client, request.id, ['stalled', 'assignment_bounced'],
          'Technician completed the job');
      const driver = await first(client, 'SELECT id, phone, lang FROM users WHERE id=$1', [request.driver_id]);
      const provider = await first(client, 'SELECT name FROM providers WHERE user_id=$1', [request.selected_provider]);
      if (driver) {
        const messages = {
          enroute: [
            `RIGRX: ${provider?.name || 'Your provider'} is on the way — about ${updated.eta_minutes} min out.`,
            `RIGRX: ${provider?.name || 'Su proveedor'} va en camino — a unos ${updated.eta_minutes} min.`
          ],
          late: [
            `RIGRX: ${provider?.name || 'Your provider'} updated their ETA — about ${updated.eta_minutes} min out.`,
            `RIGRX: ${provider?.name || 'Su proveedor'} actualizó su tiempo de llegada — a unos ${updated.eta_minutes} min.`
          ],
          arrived: [
            `RIGRX: Your technician has arrived for Job #${request.id}.`,
            `RIGRX: Su técnico llegó para el trabajo #${request.id}.`
          ],
          complete: [
            'RIGRX: Job marked complete. Tap to rate how it went — it takes 10 seconds.',
            'RIGRX: Trabajo completado. Toque para calificar cómo le fue — toma 10 segundos.'
          ]
        };
        await queueSms(client, notificationIds, driver.id, driver.phone,
          localized(driver, ...messages[action]), {
            requestId: request.id,
            eventType: `job_${action}`,
            dedupeKey: action === 'late'
              ? `request:${request.id}:late:g${updated.late_update_generation}`
              : `request:${request.id}:${action}${action === 'complete' ? '' : `:v${request.assignment_version}`}`,
            payload: {
              assignment_version: updated.assignment_version,
              ...(action === 'enroute'
                ? { eta_set_at: updated.eta_set_at }
                : {}),
              ...(action === 'late'
                ? { late_update_generation: updated.late_update_generation }
                : {})
            }
          });
      }
    }
    if (action === 'late') {
      await client.query(`
        INSERT INTO dispatch_commands
          (command_key,request_id,actor_id,command_type,expected_assignment_version,result_assignment_version)
        VALUES ($1,$2,$3,'late',$4,$5)`,
        [actionKey, request.id, techId, assignmentVersion, updated.assignment_version]);
    }
    return { request: updated, replayed: false, notificationIds };
  });
}

async function completeByDriver({ requestId, driverId }) {
  return await withTransaction(async client => {
    const notificationIds = [];
    const driver = await first(client,
      'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [driverId]);
    if (!driver) throw fail(404, 'Driver not found');
    const candidate = await first(client, `
      SELECT assigned_tech FROM requests WHERE id=$1 AND driver_id=$2`,
      [requestId, driverId]);
    if (!candidate) throw fail(404, 'Request not found');
    if (candidate.assigned_tech)
      await client.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',
        [candidate.assigned_tech]);
    const request = await first(client, `
      SELECT * FROM requests WHERE id=$1 AND driver_id=$2 FOR UPDATE`,
      [requestId, driverId]);
    if (!request) throw fail(404, 'Request not found');
    if (request.assigned_tech !== candidate.assigned_tech)
      throw fail(409, 'This job assignment changed. Try completing it again.');
    if (request.status === 'completed') return { request, replayed: true, notificationIds, recipientIds: [] };
    if (request.status !== 'selected' || request.job_state !== 'arrived')
      throw fail(409, 'The technician must arrive before this job can be completed');
    await supersedeNotificationsTx(client, request.id, MOVEMENT_NOTIFICATION_TYPES);
    const updated = await first(client, `
      UPDATE requests SET status='completed', job_state='completed',
        completed_at=NOW(), job_activity_at=NOW()
      WHERE id=$1 RETURNING *`, [request.id]);
    await client.query('UPDATE providers SET jobs_won=jobs_won+1 WHERE user_id=$1',
      [request.selected_provider]);
    await event(client, updated, 'driver_completed', 'arrived', 'completed', driverId);
    await resolveExceptionTx(client, request.id, ['stalled', 'assignment_bounced'],
      'Driver confirmed completion');
    const recipients = await dispatchRecipients(client, request.selected_provider);
    for (const person of recipients)
      await queueSms(client, notificationIds, person.id, person.phone,
        `RIGRX: The driver confirmed Job #${request.id} is complete.`, {
          requestId: request.id,
          eventType: 'driver_completed',
          dedupeKey: `request:${request.id}:driver-completed:person:${person.id}`
        });
    return {
      request: updated,
      replayed: false,
      notificationIds,
      recipientIds: recipients.map(person => person.id)
    };
  });
}

async function bounceUnacceptedJobs() {
  return await withTransaction(async client => {
    const result = await client.query(`
      SELECT * FROM requests
      WHERE status='selected' AND job_state='assigned'
        AND assigned_tech IS NOT NULL
        AND assigned_at < NOW() - INTERVAL '5 minutes'
      ORDER BY assigned_at
      FOR UPDATE SKIP LOCKED
      LIMIT 50`);
    const bounced = [];
    for (const request of result.rows) {
      await supersedeNotificationsTx(client, request.id, MOVEMENT_NOTIFICATION_TYPES);
      const updated = await first(client, `
        UPDATE requests SET job_state='unassigned', assigned_tech=NULL,
          assigned_at=NULL, accepted_at=NULL, assign_bounced=TRUE,
          assignment_bounces=assignment_bounces+1, bounced_at=NOW(),
          decline_reason='Assignment timed out', job_activity_at=NOW(),
          assignment_version=assignment_version+1
        WHERE id=$1 AND assignment_version=$2 AND job_state='assigned'
        RETURNING *`, [request.id, request.assignment_version]);
      if (!updated) continue;
      await event(client, updated, 'assignment_timeout', 'assigned', 'unassigned',
        null, { previous_tech_id: request.assigned_tech });
      await exceptionTx(client, request.id, 'assignment_bounced', {
        reason: 'acceptance_timeout',
        previous_tech_id: request.assigned_tech
      }, { providerId: request.selected_provider, techId: request.assigned_tech });
      const notificationIds = [];
      const recipients = await dispatchRecipients(client, request.selected_provider);
      for (const person of recipients)
        await queueSms(client, notificationIds, person.id, person.phone,
          `RIGRX: Job #${request.id} was not accepted — it is back in your queue.`, {
            requestId: request.id,
            eventType: 'dispatch_attention',
            dedupeKey: `request:${request.id}:dispatch:timeout:v${updated.assignment_version}:person:${person.id}`,
            payload: { assignment_version: updated.assignment_version }
          });
      const driver = await first(client, 'SELECT id, phone, lang FROM users WHERE id=$1', [request.driver_id]);
      if (driver) await queueSms(client, notificationIds, driver.id, driver.phone, localized(driver,
        `RIGRX: The first technician did not accept Job #${request.id}. Dispatch is assigning another person.`,
        `RIGRX: El primer técnico no aceptó el trabajo #${request.id}. Despacho está asignando a otra persona.`), {
          requestId: request.id,
          eventType: 'assignment_timeout_driver',
          dedupeKey: `request:${request.id}:timeout-driver:v${updated.assignment_version}`,
          payload: { assignment_version: updated.assignment_version }
        });
      bounced.push({
        ...updated,
        previous_tech_id: request.assigned_tech,
        notificationIds
      });
    }
    return bounced;
  });
}

async function unassignTechnicianRows(client, { techId, actorId }) {
  const result = await client.query(`
    SELECT * FROM requests
    WHERE assigned_tech=$1 AND status='selected'
      AND job_state IN ('assigned','accepted','enroute','arrived')
    FOR UPDATE`, [techId]);
  if (result.rows.some(request => request.job_state === 'arrived'))
    throw fail(409,
      'This technician is on scene. Complete or hand off the job before removing their access.');
  const rows = [];
  for (const request of result.rows) {
    await supersedeNotificationsTx(client, request.id, MOVEMENT_NOTIFICATION_TYPES);
    const updated = await first(client, `
      UPDATE requests SET job_state='unassigned', assigned_tech=NULL,
        assigned_at=NULL, accepted_at=NULL, enroute_at=NULL, arrived_at=NULL,
        eta_minutes=NULL, eta_set_at=NULL, assign_bounced=TRUE,
        assignment_bounces=assignment_bounces+1, bounced_at=NOW(),
        decline_reason='Technician removed from company', job_activity_at=NOW(),
        assignment_version=assignment_version+1
      WHERE id=$1 RETURNING *`, [request.id]);
    await event(client, updated, 'technician_removed', request.job_state,
      'unassigned', actorId, { previous_tech_id: techId });
    await exceptionTx(client, request.id, 'assignment_bounced', {
      reason: 'technician_unavailable',
      previous_tech_id: techId
    }, { providerId: request.selected_provider, techId });
    const notificationIds = [];
    const recipients = await dispatchRecipients(client, request.selected_provider);
    for (const person of recipients)
      await queueSms(client, notificationIds, person.id, person.phone,
        `RIGRX: Job #${request.id} returned to dispatch because a technician became unavailable.`, {
          requestId: request.id,
          eventType: 'dispatch_attention',
          dedupeKey: `request:${request.id}:dispatch:tech-unavailable:v${updated.assignment_version}:person:${person.id}`,
          payload: { assignment_version: updated.assignment_version }
        });
    const driver = await first(client, 'SELECT id, phone, lang FROM users WHERE id=$1', [request.driver_id]);
    if (driver) await queueSms(client, notificationIds, driver.id, driver.phone, localized(driver,
      `RIGRX: Job #${request.id} is back with dispatch for a new technician assignment.`,
      `RIGRX: El trabajo #${request.id} volvió a despacho para asignar un nuevo técnico.`), {
        requestId: request.id,
        eventType: 'technician_removed_driver',
        dedupeKey: `request:${request.id}:tech-unavailable-driver:v${updated.assignment_version}`,
        payload: { assignment_version: updated.assignment_version }
      });
    rows.push({ ...updated, notificationIds });
  }
  return rows;
}

async function unassignTechnician({
  techId, actorId, companyId = null, userChanges = null
}) {
  return await withTransaction(async client => {
    if (companyId) {
      const company = await first(client, `
        SELECT id FROM users WHERE id=$1 AND archived_at IS NULL FOR NO KEY UPDATE`, [companyId]);
      if (!company) throw fail(409, 'This company account is no longer active');
    }
    const technician = await first(client, `
      SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE`, [techId]);
    if (!technician) return [];
    if (companyId && technician.company_id !== Number(companyId))
      throw fail(409, 'This technician belongs to another company');
    if (userChanges) {
      await client.query(`
        UPDATE users SET name=$1, lang=$2, member_role=$3, assignable=$4,
          member_location_id=$5,
          archived_at=CASE WHEN $6::boolean THEN NOW()
            WHEN $7::boolean THEN NULL ELSE archived_at END,
          archive_reason=CASE WHEN $6::boolean THEN $8
            WHEN $7::boolean THEN '' ELSE archive_reason END,
          archived_by_company=CASE WHEN $7::boolean THEN FALSE ELSE archived_by_company END
        WHERE id=$9`,
        [userChanges.name || technician.name,
         userChanges.lang || technician.lang,
         userChanges.memberRole || technician.member_role,
         userChanges.assignable === true,
         userChanges.memberLocationId === undefined
           ? technician.member_location_id : userChanges.memberLocationId,
         userChanges.archive === true,
         userChanges.restore === true,
         userChanges.archiveReason || '',
         techId]);
    }
    return await unassignTechnicianRows(client, { techId, actorId });
  });
}

async function archiveCompany({ companyId, actorId, reason }) {
  return await withTransaction(async client => {
    const owner = await lockCompanyOwner(client, companyId);
    if (!owner) throw fail(409, 'This company account is no longer active');
    const members = (await client.query(`
      SELECT * FROM users
      WHERE (id=$1 OR company_id=$1) AND archived_at IS NULL
      ORDER BY id FOR NO KEY UPDATE`, [companyId])).rows;
    const jobs = [];
    for (const member of members) {
      if (member.member_role === 'tech')
        jobs.push(...await unassignTechnicianRows(client, {
          techId: member.id,
          actorId
        }));
    }
    const archived = (await client.query(`
      UPDATE users SET archived_at=NOW(),
        archive_reason=CASE WHEN id=$1 THEN $2 ELSE 'Company account archived' END,
        archived_by_company=(id<>$1), assignable=FALSE
      WHERE (id=$1 OR company_id=$1) AND archived_at IS NULL
      RETURNING id`, [companyId, reason || ''])).rows;
    return {
      archivedIds: archived.map(row => row.id),
      jobs
    };
  });
}

async function archiveDriver({ driverId, actorId, reason }) {
  return await withTransaction(async client => {
    const driver = await first(client, `
      SELECT * FROM users
      WHERE id=$1 AND role='driver' AND archived_at IS NULL
      FOR NO KEY UPDATE`, [driverId]);
    if (!driver) throw fail(409, 'This driver account is no longer active');
    const active = (await client.query(`
      SELECT * FROM requests
      WHERE driver_id=$1 AND status IN ('open','selected')
      ORDER BY id FOR UPDATE`, [driverId])).rows;
    if (active.some(request =>
      request.status === 'selected' && ['enroute','arrived'].includes(request.job_state)))
      throw fail(409,
        'This driver has a job already on the way or on scene. Complete it before archiving the account.');

    const jobs = [];
    for (const request of active) {
      const notificationIds = [];
      await supersedeNotificationsTx(client, request.id, [
        ...MOVEMENT_NOTIFICATION_TYPES,
        'new_lead',
        'provider_selected'
      ]);
      const recipients = request.selected_provider
        ? await dispatchRecipients(client, request.selected_provider) : [];
      const technician = request.assigned_tech
        ? await first(client, 'SELECT id, phone, lang FROM users WHERE id=$1',
          [request.assigned_tech]) : null;
      const updated = await first(client, `
        UPDATE requests SET status='cancelled', job_state='none',
          assigned_tech=NULL, assigned_at=NULL, accepted_at=NULL,
          eta_minutes=NULL, eta_set_at=NULL, job_activity_at=NOW(),
          assignment_version=assignment_version+1
        WHERE id=$1 RETURNING *`, [request.id]);
      await event(client, updated, 'driver_archived',
        request.job_state || request.status, 'cancelled', actorId, {
          previous_provider_id: request.selected_provider,
          previous_tech_id: request.assigned_tech
        });
      await resolveExceptionTx(client, request.id,
        ['zero_match', 'no_response', 'stalled', 'assignment_bounced'],
        'Driver account archived');
      for (const person of recipients)
        await queueSms(client, notificationIds, person.id, person.phone,
          `RIGRX: Request #${request.id} was closed because the driver account was archived.`, {
            requestId: request.id,
            eventType: 'job_cancelled',
            dedupeKey: `request:${request.id}:driver-archived:person:${person.id}`
          });
      if (technician)
        await queueSms(client, notificationIds, technician.id, technician.phone,
          localized(technician,
            `RIGRX: Job #${request.id} was cancelled because the driver account was archived. Stop work and contact dispatch if needed.`,
            `RIGRX: El trabajo #${request.id} fue cancelado porque se archivó la cuenta del conductor. Detenga el trabajo y comuníquese con despacho.`), {
            requestId: request.id,
            eventType: 'job_cancelled_technician',
            dedupeKey: `request:${request.id}:driver-archived:tech:${technician.id}`
          });
      jobs.push({
        ...updated,
        previous_tech_id: request.assigned_tech,
        recipientIds: recipients.map(person => person.id),
        notificationIds
      });
    }
    await client.query(`
      UPDATE users SET archived_at=NOW(), archive_reason=$1,
        archived_by_company=FALSE
      WHERE id=$2`, [reason || '', driverId]);
    return { archivedIds: [driverId], jobs };
  });
}

module.exports = {
  assignJob,
  techAction,
  completeByDriver,
  bounceUnacceptedJobs,
  unassignTechnician,
  archiveCompany,
  archiveDriver,
  openException,
  resolveException,
  openExceptionTx: exceptionTx,
  resolveExceptionTx,
  _fail: fail
};
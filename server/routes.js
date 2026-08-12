// ============ All REST API routes ============
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { q, one } = require('./db');
const auth = require('./auth');
const { chargeLead, refund, SIMULATED } = require('./payments');
const { sms, wsPush } = require('./notify');
const { matchProviders, notifyProviders, haversineMiles, distanceBand } = require('./match');

const router = express.Router();
const MAX_STANDARD_SLOTS = 3;
const MAX_TOTAL_SLOTS = 4;

/* ---------------- uploads (photos, COI docs) ---------------- */
const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (req, file, cb) => cb(null, crypto.randomBytes(8).toString('hex') + path.extname(file.originalname).slice(0, 8))
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });
router.post('/upload', auth.requireAuth, upload.single('file'), (req, res) => {
  res.json({ url: '/uploads/' + req.file.filename });
});

/* ---------------- auth ---------------- */
router.post('/auth/request-code', async (req, res) => {
  const phone = auth.normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid phone number' });
  const devCode = await auth.requestCode(phone);
  res.json({ ok: true, devCode }); // devCode only present in simulation mode
});

router.post('/auth/verify', async (req, res) => {
  const phone = auth.normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid phone number' });
  const ok = await auth.verifyCode(phone, String(req.body.code || ''));
  if (!ok) return res.status(400).json({ error: 'Wrong or expired code' });
  const user = await auth.findOrCreateUser(phone, req.body.role);
  const token = await auth.createSession(user.id);
  res.cookie('rigrx_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ user: publicUser(user) });
});

router.post('/auth/logout', async (req, res) => {
  const token = req.cookies?.rigrx_session;
  if (token) await q('DELETE FROM sessions WHERE token=$1', [token]);
  res.clearCookie('rigrx_session');
  res.json({ ok: true });
});

function publicUser(u) {
  return { id: u.id, phone: u.phone, role: u.role, name: u.name, email: u.email,
           driver_type: u.driver_type, company: u.company,
           driver_rating: u.rating_count ? +(u.rating_sum / u.rating_count).toFixed(1) : null };
}

router.get('/me', async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const out = { user: publicUser(req.user), simulatedPayments: SIMULATED() };
  if (req.user.role === 'provider' || req.user.role === 'admin') {
    out.provider = await one('SELECT * FROM providers WHERE user_id=$1', [req.user.id]);
    if (out.provider) {
      out.provider.locations = await q('SELECT * FROM provider_locations WHERE user_id=$1 ORDER BY id', [req.user.id]);
      out.provider.custom = await q('SELECT * FROM custom_services WHERE user_id=$1 ORDER BY id', [req.user.id]);
    }
  }
  if (req.user.role === 'driver' || req.user.role === 'admin') {
    out.trucks = await q('SELECT * FROM trucks WHERE user_id=$1 ORDER BY id', [req.user.id]);
    out.trailers = await q('SELECT * FROM trailers WHERE user_id=$1 ORDER BY id', [req.user.id]);
  }
  res.json(out);
});

/* ---------------- driver profile & garage ---------------- */
router.put('/driver/profile', auth.requireAuth, async (req, res) => {
  const { name = '', email = '', driver_type = '', company = '' } = req.body;
  const u = await one(
    'UPDATE users SET name=$1, email=$2, driver_type=$3, company=$4 WHERE id=$5 RETURNING *',
    [name, email, driver_type, company, req.user.id]);
  res.json({ user: publicUser(u) });
});

router.post('/trucks', auth.requireAuth, async (req, res) => {
  const t = await one('INSERT INTO trucks (user_id, data) VALUES ($1,$2) RETURNING *', [req.user.id, req.body.data || {}]);
  res.json(t);
});
router.put('/trucks/:id', auth.requireAuth, async (req, res) => {
  const t = await one('UPDATE trucks SET data=$1 WHERE id=$2 AND user_id=$3 RETURNING *',
    [req.body.data || {}, req.params.id, req.user.id]);
  res.json(t || {});
});
router.delete('/trucks/:id', auth.requireAuth, async (req, res) => {
  await q('DELETE FROM trucks WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});
router.post('/trailers', auth.requireAuth, async (req, res) => {
  const t = await one('INSERT INTO trailers (user_id, data) VALUES ($1,$2) RETURNING *', [req.user.id, req.body.data || {}]);
  res.json(t);
});
router.put('/trailers/:id', auth.requireAuth, async (req, res) => {
  const t = await one('UPDATE trailers SET data=$1 WHERE id=$2 AND user_id=$3 RETURNING *',
    [req.body.data || {}, req.params.id, req.user.id]);
  res.json(t || {});
});
router.delete('/trailers/:id', auth.requireAuth, async (req, res) => {
  await q('DELETE FROM trailers WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

/* ---------------- provider profile ---------------- */
router.put('/provider/profile', auth.requireRole('provider'), async (req, res) => {
  const { name, dispatch_phone, after_phone, email, hours, services, equipment, verification } = req.body;
  await q('INSERT INTO providers (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [req.user.id]);
  const p = await one(`
    UPDATE providers SET
      name = COALESCE($1, name), dispatch_phone = COALESCE($2, dispatch_phone),
      after_phone = COALESCE($3, after_phone), email = COALESCE($4, email),
      hours = COALESCE($5, hours), services = COALESCE($6, services),
      equipment = COALESCE($7, equipment), verification = COALESCE($8, verification)
    WHERE user_id=$9 RETURNING *`,
    [name, dispatch_phone, after_phone, email, hours,
     services ? JSON.stringify(services) : null,
     equipment ? JSON.stringify(equipment) : null,
     verification ? JSON.stringify(verification) : null, req.user.id]);
  if (name) await q('UPDATE users SET name=$1 WHERE id=$2', [name, req.user.id]);
  res.json(p);
});

router.post('/provider/locations', auth.requireRole('provider'), async (req, res) => {
  const { label, lat, lng, radius_mi = 50, phone = '' } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat/lng required' });
  const l = await one(
    'INSERT INTO provider_locations (user_id, label, lat, lng, radius_mi, phone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.user.id, label || '', lat, lng, Math.min(200, Math.max(5, radius_mi)), phone]);
  res.json(l);
});
router.delete('/provider/locations/:id', auth.requireRole('provider'), async (req, res) => {
  await q('DELETE FROM provider_locations WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

router.post('/provider/custom-service', auth.requireRole('provider'), async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Name required' });
  const c = await one('INSERT INTO custom_services (user_id, name) VALUES ($1,$2) RETURNING *', [req.user.id, name]);
  res.json(c);
});

router.get('/providers/:id/public', async (req, res) => {
  const p = await one(`
    SELECT p.user_id, p.name, p.hours, p.equipment, p.badges, p.jobs_won,
           p.rating_sum, p.rating_count
    FROM providers p WHERE p.user_id=$1`, [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const locations = await q('SELECT label, radius_mi FROM provider_locations WHERE user_id=$1', [req.params.id]);
  const reviews = await q(`
    SELECT r.stars, r.tags, r.comment, r.created_at, req.service_label
    FROM reviews r JOIN requests req ON req.id = r.request_id
    WHERE r.target_provider=$1 ORDER BY r.id DESC LIMIT 10`, [req.params.id]);
  const breakdown = await q(`
    SELECT stars, COUNT(*)::int AS n FROM reviews WHERE target_provider=$1 GROUP BY stars`, [req.params.id]);
  res.json({
    ...p,
    rating: p.rating_count ? +(p.rating_sum / p.rating_count).toFixed(1) : null,
    locations, reviews, breakdown
  });
});

/* ---------------- requests (driver side) ---------------- */
router.post('/requests', auth.requireAuth, async (req, res) => {
  const b = req.body;
  const price = await one('SELECT * FROM pricing WHERE service_key=$1', [b.service_key]);
  if (!price) return res.status(400).json({ error: 'Unknown service type' });
  if (typeof b.lat !== 'number' || typeof b.lng !== 'number')
    return res.status(400).json({ error: 'Location required' });

  // rate limit: max 3 open requests per driver
  const openCount = await one(`SELECT COUNT(*)::int AS n FROM requests WHERE driver_id=$1 AND status='open'`, [req.user.id]);
  if (openCount.n >= 3) return res.status(429).json({ error: 'You already have 3 open requests' });

  let truck = {}, trailer = {};
  if (b.truck_id) truck = (await one('SELECT data FROM trucks WHERE id=$1 AND user_id=$2', [b.truck_id, req.user.id]))?.data || {};
  if (b.trailer_id) trailer = (await one('SELECT data FROM trailers WHERE id=$1 AND user_id=$2', [b.trailer_id, req.user.id]))?.data || {};

  const request = await one(`
    INSERT INTO requests (driver_id, service_key, service_label, lat, lng, area_label, landmark,
                          situation, can_move, description, photos, truck, trailer)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [req.user.id, b.service_key, price.label, b.lat, b.lng,
     b.area_label || 'Near your GPS location', b.landmark || '',
     JSON.stringify(b.situation || []), b.can_move || 'no', b.description || '',
     JSON.stringify(b.photos || []), JSON.stringify(truck), JSON.stringify(trailer)]);

  // match & notify (auto-expand radius if nothing within providers' stated radii)
  let matches = await matchProviders(request);
  let expanded = false;
  if (!matches.length) { matches = await matchProviders(request, 50); expanded = true; }
  await notifyProviders(request, matches, price);
  await q('UPDATE requests SET notified_count=$1 WHERE id=$2', [matches.length, request.id]);

  res.json({ request, notified: matches.length, expanded });
});

router.get('/requests/mine', auth.requireAuth, async (req, res) => {
  const rows = await q(`
    SELECT r.*, (SELECT COUNT(*)::int FROM purchases pu WHERE pu.request_id=r.id) AS buyer_count
    FROM requests r WHERE r.driver_id=$1 ORDER BY r.id DESC LIMIT 30`, [req.user.id]);
  res.json(rows);
});

router.get('/requests/:id', auth.requireAuth, async (req, res) => {
  const r = await one('SELECT * FROM requests WHERE id=$1 AND driver_id=$2', [req.params.id, req.user.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const responders = await q(`
    SELECT pu.provider_id, pu.slot, pu.premium, pu.created_at,
           p.name, p.rating_sum, p.rating_count, p.jobs_won, p.badges,
           (SELECT m.quote FROM messages m
             WHERE m.request_id=pu.request_id AND m.provider_id=pu.provider_id AND m.quote IS NOT NULL
             ORDER BY m.id DESC LIMIT 1) AS quote
    FROM purchases pu JOIN providers p ON p.user_id = pu.provider_id
    WHERE pu.request_id=$1 AND pu.refunded=FALSE ORDER BY pu.slot`, [req.params.id]);
  res.json({
    request: r,
    responders: responders.map(x => ({
      ...x, rating: x.rating_count ? +(x.rating_sum / x.rating_count).toFixed(1) : null
    }))
  });
});

router.post('/requests/:id/select', auth.requireAuth, async (req, res) => {
  const r = await one(`UPDATE requests SET status='selected', selected_provider=$1
    WHERE id=$2 AND driver_id=$3 AND status='open' RETURNING *`,
    [req.body.provider_id, req.params.id, req.user.id]);
  if (!r) return res.status(400).json({ error: 'Request not open' });
  const buyers = await q(`SELECT pu.provider_id, u.phone FROM purchases pu JOIN users u ON u.id=pu.provider_id WHERE pu.request_id=$1`, [r.id]);
  for (const b of buyers) {
    if (b.provider_id === req.body.provider_id) {
      await sms(b.provider_id, b.phone, `RIGRX: You got the job! Request #${r.id} (${r.service_label}). The driver chose you.`);
      wsPush(b.provider_id, 'selected', { request_id: r.id, won: true });
    } else {
      wsPush(b.provider_id, 'selected', { request_id: r.id, won: false });
    }
  }
  res.json({ ok: true });
});

router.post('/requests/:id/complete', auth.requireAuth, async (req, res) => {
  const r = await one(`UPDATE requests SET status='completed'
    WHERE id=$1 AND (driver_id=$2 OR selected_provider=$2) AND status='selected' RETURNING *`,
    [req.params.id, req.user.id]);
  if (!r) return res.status(400).json({ error: 'Nothing to complete' });
  if (r.selected_provider)
    await q('UPDATE providers SET jobs_won = jobs_won + 1 WHERE user_id=$1', [r.selected_provider]);
  res.json({ ok: true });
});

router.post('/requests/:id/cancel', auth.requireAuth, async (req, res) => {
  const r = await one(`UPDATE requests SET status='cancelled'
    WHERE id=$1 AND driver_id=$2 AND status='open' RETURNING *`, [req.params.id, req.user.id]);
  if (!r) return res.status(400).json({ error: 'Request not open' });
  res.json({ ok: true });
});

/* ---------------- leads (provider side) ---------------- */
async function providerOf(req) {
  return await one('SELECT * FROM providers WHERE user_id=$1', [req.user.id]);
}
async function slotInfo(requestId) {
  const rows = await q('SELECT slot, premium FROM purchases WHERE request_id=$1 AND refunded=FALSE ORDER BY slot', [requestId]);
  const standard = rows.filter(r => !r.premium).length;
  const total = rows.length;
  return { standard, total, standardLeft: Math.max(0, MAX_STANDARD_SLOTS - standard),
           premiumOpen: standard >= MAX_STANDARD_SLOTS && total < MAX_TOTAL_SLOTS,
           soldOut: total >= MAX_TOTAL_SLOTS };
}

router.get('/leads', auth.requireRole('provider'), async (req, res) => {
  const p = await providerOf(req);
  const locations = await q('SELECT * FROM provider_locations WHERE user_id=$1', [req.user.id]);
  const open = await q(`
    SELECT r.*, pr.standard_cents, pr.premium_cents,
      u.rating_sum AS d_rsum, u.rating_count AS d_rcount
    FROM requests r
    JOIN pricing pr ON pr.service_key = r.service_key
    JOIN users u ON u.id = r.driver_id
    WHERE r.status='open' AND r.created_at > NOW() - INTERVAL '6 hours'
    ORDER BY r.id DESC LIMIT 50`);
  const out = [];
  for (const r of open) {
    // distance from closest location; only show if inside any radius (+50mi grace band shown greyed? keep strict)
    let best = null;
    for (const l of locations) {
      const d = haversineMiles(r.lat, r.lng, l.lat, l.lng);
      if (d <= l.radius_mi && (best === null || d < best)) best = d;
    }
    if (best === null) continue;
    const slots = await slotInfo(r.id);
    if (slots.soldOut) continue;
    const mine = await one('SELECT id FROM purchases WHERE request_id=$1 AND provider_id=$2', [r.id, req.user.id]);
    out.push({
      id: r.id, service_key: r.service_key, service_label: r.service_label,
      area_label: r.area_label, band: distanceBand(best),
      created_at: r.created_at, situation: r.situation, can_move: r.can_move,
      truck_class: r.truck?.make ? `${r.truck.year || ''} ${r.truck.make}`.trim() : 'Class 8 tractor',
      trailer_type: r.trailer?.type || 'No trailer', loaded: true,
      hazmat: !!(r.trailer && r.trailer.hazmat),
      driver_rating: r.d_rcount ? +(r.d_rsum / r.d_rcount).toFixed(1) : null,
      slots, price_cents: slots.premiumOpen ? r.premium_cents : r.standard_cents,
      premium: slots.premiumOpen, purchased: !!mine
    });
  }
  res.json({ leads: out, approved: p?.approved || false });
});

router.get('/leads/:id', auth.requireRole('provider'), async (req, res) => {
  const r = await one(`SELECT r.*, pr.standard_cents, pr.premium_cents FROM requests r
    JOIN pricing pr ON pr.service_key=r.service_key WHERE r.id=$1`, [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const slots = await slotInfo(r.id);
  const mine = await one('SELECT * FROM purchases WHERE request_id=$1 AND provider_id=$2 AND refunded=FALSE', [r.id, req.user.id]);
  const driver = await one('SELECT * FROM users WHERE id=$1', [r.driver_id]);
  const base = {
    id: r.id, service_key: r.service_key, service_label: r.service_label,
    area_label: r.area_label, created_at: r.created_at, status: r.status,
    situation: r.situation, can_move: r.can_move,
    truck_class: r.truck?.make ? `${r.truck.year || ''} ${r.truck.make} ${r.truck.model || ''}`.trim() : 'Class 8 tractor',
    trailer_type: r.trailer?.type || 'No trailer',
    hazmat: !!(r.trailer && r.trailer.hazmat),
    hazmat_info: r.trailer?.hazmat ? { class: r.trailer.hzClass, un: r.trailer.un } : null,
    driver_rating: driver.rating_count ? +(driver.rating_sum / driver.rating_count).toFixed(1) : null,
    slots, price_cents: slots.premiumOpen ? r.premium_cents : r.standard_cents, premium: slots.premiumOpen,
    purchased: !!mine, selected_provider: r.selected_provider
  };
  if (mine) {
    base.full = {
      driver_name: driver.name || 'Driver', driver_phone: driver.phone,
      lat: r.lat, lng: r.lng, landmark: r.landmark, description: r.description,
      photos: r.photos, truck: r.truck, trailer: r.trailer
    };
  }
  res.json(base);
});

router.post('/leads/:id/buy', auth.requireRole('provider'), async (req, res) => {
  const p = await providerOf(req);
  if (!p) return res.status(400).json({ error: 'Complete your company profile first' });
  if (!p.approved) return res.status(403).json({ error: 'Your account is pending RIGRX approval' });

  const r = await one(`SELECT r.*, pr.standard_cents, pr.premium_cents FROM requests r
    JOIN pricing pr ON pr.service_key=r.service_key WHERE r.id=$1 AND r.status='open'`, [req.params.id]);
  if (!r) return res.status(400).json({ error: 'Lead is no longer open' });

  const existing = await one('SELECT id FROM purchases WHERE request_id=$1 AND provider_id=$2', [r.id, req.user.id]);
  if (existing) return res.status(400).json({ error: 'You already own this lead' });

  const slots = await slotInfo(r.id);
  if (slots.soldOut) return res.status(400).json({ error: 'Lead sold out (4 responders max)' });
  const premium = slots.premiumOpen;
  const amount = premium ? r.premium_cents : r.standard_cents;

  const charge = await chargeLead(p, amount, `RIGRX lead #${r.id} — ${r.service_label}${premium ? ' (premium slot)' : ''}`);
  if (!charge.ok) return res.status(402).json({ error: 'Card charge failed: ' + (charge.error || 'declined') });

  const slot = slots.total + 1;
  try {
    await q(`INSERT INTO purchases (request_id, provider_id, slot, amount_cents, premium, stripe_payment)
             VALUES ($1,$2,$3,$4,$5,$6)`, [r.id, req.user.id, slot, amount, premium, charge.paymentId]);
  } catch (e) {
    return res.status(409).json({ error: 'Slot was just taken — refresh the lead' });
  }

  // tell the driver instantly
  const driver = await one('SELECT * FROM users WHERE id=$1', [r.driver_id]);
  wsPush(driver.id, 'responder', { request_id: r.id, provider_id: req.user.id, name: p.name, slot });
  await sms(driver.id, driver.phone, `RIGRX: ${p.name} unlocked your ${r.service_label} request and can now contact you. Open the app to chat.`);

  res.json({ ok: true, slot, premium, amount_cents: amount, simulated: charge.paymentId === 'simulated' });
});

router.get('/myleads', auth.requireRole('provider'), async (req, res) => {
  const rows = await q(`
    SELECT pu.*, r.service_label, r.area_label, r.status AS request_status, r.selected_provider, r.created_at AS requested_at
    FROM purchases pu JOIN requests r ON r.id = pu.request_id
    WHERE pu.provider_id=$1 ORDER BY pu.id DESC LIMIT 50`, [req.user.id]);
  res.json(rows.map(x => ({ ...x, won: x.selected_provider === req.user.id })));
});

router.get('/provider/stats', auth.requireRole('provider'), async (req, res) => {
  const p = await providerOf(req);
  const bought = await one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::int AS spend
    FROM purchases WHERE provider_id=$1 AND refunded=FALSE`, [req.user.id]);
  const won = await one(`SELECT COUNT(*)::int AS n FROM requests WHERE selected_provider=$1 AND status IN ('selected','completed')`, [req.user.id]);
  const week = await q(`
    SELECT to_char(created_at, 'Dy') AS day, COUNT(*)::int AS n
    FROM purchases WHERE provider_id=$1 AND created_at > NOW() - INTERVAL '7 days'
    GROUP BY 1`, [req.user.id]);
  res.json({
    leads_bought: bought.n, spend_cents: bought.spend, jobs_won: won.n,
    win_rate: bought.n ? Math.round(won.n / bought.n * 100) : 0,
    rating: p?.rating_count ? +(p.rating_sum / p.rating_count).toFixed(1) : null,
    rating_count: p?.rating_count || 0, week
  });
});

/* ---------------- messaging ---------------- */
async function canAccessThread(user, requestId, providerId) {
  const r = await one('SELECT * FROM requests WHERE id=$1', [requestId]);
  if (!r) return null;
  if (user.role === 'admin') return r;
  if (r.driver_id === user.id) return r;                       // the driver
  if (user.id === Number(providerId)) {                        // the provider — must have bought
    const pu = await one('SELECT id FROM purchases WHERE request_id=$1 AND provider_id=$2 AND refunded=FALSE', [requestId, providerId]);
    if (pu) return r;
  }
  return null;
}

router.get('/messages/threads', auth.requireAuth, async (req, res) => {
  let rows;
  if (req.user.role === 'provider') {
    rows = await q(`
      SELECT r.id AS request_id, pu.provider_id, r.service_label, r.status, u.name AS other_name,
        (SELECT body FROM messages m WHERE m.request_id=r.id AND m.provider_id=pu.provider_id ORDER BY m.id DESC LIMIT 1) AS last_body
      FROM purchases pu JOIN requests r ON r.id=pu.request_id JOIN users u ON u.id=r.driver_id
      WHERE pu.provider_id=$1 AND pu.refunded=FALSE ORDER BY pu.id DESC LIMIT 30`, [req.user.id]);
  } else {
    rows = await q(`
      SELECT r.id AS request_id, pu.provider_id, r.service_label, r.status, p.name AS other_name,
        (SELECT body FROM messages m WHERE m.request_id=r.id AND m.provider_id=pu.provider_id ORDER BY m.id DESC LIMIT 1) AS last_body
      FROM requests r JOIN purchases pu ON pu.request_id=r.id JOIN providers p ON p.user_id=pu.provider_id
      WHERE r.driver_id=$1 AND pu.refunded=FALSE ORDER BY pu.id DESC LIMIT 30`, [req.user.id]);
  }
  res.json(rows);
});

router.get('/messages/:requestId/:providerId', auth.requireAuth, async (req, res) => {
  const r = await canAccessThread(req.user, req.params.requestId, req.params.providerId);
  if (!r) return res.status(403).json({ error: 'No access to this thread' });
  const msgs = await q(`SELECT * FROM messages WHERE request_id=$1 AND provider_id=$2 ORDER BY id`,
    [req.params.requestId, req.params.providerId]);
  res.json({ request: { id: r.id, service_label: r.service_label, status: r.status, driver_id: r.driver_id }, messages: msgs });
});

router.post('/messages/:requestId/:providerId', auth.requireAuth, async (req, res) => {
  const r = await canAccessThread(req.user, req.params.requestId, req.params.providerId);
  if (!r) return res.status(403).json({ error: 'No access to this thread' });
  const body = String(req.body.body || '').slice(0, 2000);
  const quote = req.body.quote || null; // {amount_cents, eta, note}
  if (!body && !quote) return res.status(400).json({ error: 'Empty message' });
  const m = await one(
    `INSERT INTO messages (request_id, provider_id, sender_id, body, quote) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.params.requestId, req.params.providerId, req.user.id, body, quote ? JSON.stringify(quote) : null]);
  // push to the other party
  const recipient = req.user.id === r.driver_id ? Number(req.params.providerId) : r.driver_id;
  wsPush(recipient, 'message', m);
  res.json(m);
});

/* ---------------- reviews ---------------- */
router.post('/reviews', auth.requireAuth, async (req, res) => {
  const { request_id, stars, tags = [], comment = '' } = req.body;
  const r = await one('SELECT * FROM requests WHERE id=$1', [request_id]);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (!['selected', 'completed'].includes(r.status))
    return res.status(400).json({ error: 'You can review after a provider is chosen' });
  const s = Math.max(1, Math.min(5, Number(stars) || 0));

  let targetProvider = null, targetDriver = null;
  if (req.user.id === r.driver_id) targetProvider = r.selected_provider;
  else if (req.user.id === r.selected_provider) targetDriver = r.driver_id;
  else return res.status(403).json({ error: 'Only the driver and chosen provider can review this job' });

  try {
    await q(`INSERT INTO reviews (request_id, reviewer_id, target_provider, target_driver, stars, tags, comment)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [request_id, req.user.id, targetProvider, targetDriver, s, JSON.stringify(tags), comment.slice(0, 1000)]);
  } catch (e) {
    return res.status(409).json({ error: 'You already reviewed this job' });
  }
  if (targetProvider)
    await q('UPDATE providers SET rating_sum=rating_sum+$1, rating_count=rating_count+1 WHERE user_id=$2', [s, targetProvider]);
  if (targetDriver)
    await q('UPDATE users SET rating_sum=rating_sum+$1, rating_count=rating_count+1 WHERE id=$2', [s, targetDriver]);
  res.json({ ok: true });
});

/* ---------------- admin ---------------- */
router.get('/admin/overview', auth.requireRole('admin'), async (req, res) => {
  const [reqToday, revToday, revTotal, pendingProviders, fill, users] = await Promise.all([
    one(`SELECT COUNT(*)::int AS n FROM requests WHERE created_at > NOW() - INTERVAL '24 hours'`),
    one(`SELECT COALESCE(SUM(amount_cents),0)::int AS c FROM purchases WHERE refunded=FALSE AND created_at > NOW() - INTERVAL '24 hours'`),
    one(`SELECT COALESCE(SUM(amount_cents),0)::int AS c FROM purchases WHERE refunded=FALSE`),
    one(`SELECT COUNT(*)::int AS n FROM providers WHERE approved=FALSE`),
    one(`SELECT
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM purchases pu WHERE pu.request_id=r.id))::int AS filled,
          COUNT(*)::int AS total
         FROM requests r`),
    one(`SELECT COUNT(*) FILTER (WHERE role='driver')::int AS drivers,
                COUNT(*) FILTER (WHERE role='provider')::int AS providers FROM users`)
  ]);
  res.json({
    requests_24h: reqToday.n, revenue_24h_cents: revToday.c, revenue_total_cents: revTotal.c,
    pending_providers: pendingProviders.n,
    fill_rate: fill.total ? Math.round(fill.filled / fill.total * 100) : 0,
    drivers: users.drivers, providers: users.providers
  });
});

router.get('/admin/providers', auth.requireRole('admin'), async (req, res) => {
  const rows = await q(`
    SELECT p.*, u.phone,
      (SELECT COUNT(*)::int FROM provider_locations l WHERE l.user_id=p.user_id) AS location_count
    FROM providers p JOIN users u ON u.id=p.user_id
    ORDER BY p.approved ASC, p.created_at DESC LIMIT 100`);
  res.json(rows);
});
router.post('/admin/providers/:id/approve', auth.requireRole('admin'), async (req, res) => {
  await q('UPDATE providers SET approved=TRUE WHERE user_id=$1', [req.params.id]);
  const u = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (u) await sms(u.id, u.phone, 'RIGRX: Your company is approved! You can now buy leads. Matching alerts are live.');
  res.json({ ok: true });
});
router.post('/admin/providers/:id/reject', auth.requireRole('admin'), async (req, res) => {
  await q('UPDATE providers SET approved=FALSE WHERE user_id=$1', [req.params.id]);
  res.json({ ok: true });
});

router.get('/admin/pricing', auth.requireRole('admin'), async (req, res) => {
  res.json(await q('SELECT * FROM pricing ORDER BY service_key'));
});
router.put('/admin/pricing/:key', auth.requireRole('admin'), async (req, res) => {
  const { standard_cents, premium_cents } = req.body;
  const p = await one(
    'UPDATE pricing SET standard_cents=$1, premium_cents=$2 WHERE service_key=$3 RETURNING *',
    [Math.max(0, standard_cents | 0), Math.max(0, premium_cents | 0), req.params.key]);
  res.json(p || {});
});

router.get('/admin/purchases', auth.requireRole('admin'), async (req, res) => {
  const rows = await q(`
    SELECT pu.*, p.name AS provider_name, r.service_label
    FROM purchases pu JOIN providers p ON p.user_id=pu.provider_id
    JOIN requests r ON r.id=pu.request_id
    ORDER BY pu.id DESC LIMIT 100`);
  res.json(rows);
});
router.post('/admin/purchases/:id/refund', auth.requireRole('admin'), async (req, res) => {
  const pu = await one('SELECT * FROM purchases WHERE id=$1', [req.params.id]);
  if (!pu) return res.status(404).json({ error: 'Not found' });
  const r = await refund(pu.stripe_payment);
  if (!r.ok) return res.status(400).json({ error: r.error });
  await q('UPDATE purchases SET refunded=TRUE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

router.get('/admin/custom-services', auth.requireRole('admin'), async (req, res) => {
  const rows = await q(`
    SELECT cs.*, p.name AS provider_name FROM custom_services cs
    JOIN providers p ON p.user_id=cs.user_id ORDER BY cs.status='pending' DESC, cs.id DESC LIMIT 100`);
  res.json(rows);
});
router.post('/admin/custom-services/:id/:action', auth.requireRole('admin'), async (req, res) => {
  const status = req.params.action === 'approve' ? 'approved' : 'rejected';
  await q('UPDATE custom_services SET status=$1 WHERE id=$2', [status, req.params.id]);
  res.json({ ok: true });
});

router.get('/admin/requests', auth.requireRole('admin'), async (req, res) => {
  const rows = await q(`
    SELECT r.id, r.service_label, r.area_label, r.status, r.notified_count, r.created_at, u.name AS driver_name,
      (SELECT COUNT(*)::int FROM purchases pu WHERE pu.request_id=r.id AND pu.refunded=FALSE) AS buyers
    FROM requests r JOIN users u ON u.id=r.driver_id ORDER BY r.id DESC LIMIT 100`);
  res.json(rows);
});

module.exports = router;

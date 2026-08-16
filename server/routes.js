// ============ All REST API routes ============
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { q, one } = require('./db');
const auth = require('./auth');
const { chargeLead, refund, SIMULATED } = require('./payments');
const { sms, wsPush } = require('./notify');
const { matchProviders, notifyProviders, alertRecipients, haversineMiles, distanceBand } = require('./match');
const { areaLabel } = require('./geo');
const { getCatalog, getTrades, ensurePricing, slugify } = require('./catalog');
const EQUIP = require('./equipment');
// Same file the browser loads, so a message is judged identically on both sides.
const guard = require('../public/guard.js');

const router = express.Router();
const MAX_STANDARD_SLOTS = 3;
const MAX_TOTAL_SLOTS = 4;

// Express 4 does not catch errors thrown inside async handlers — they become
// unhandled promise rejections, which take the whole server down. One malformed
// request should return a 500, not knock every driver and provider offline, so
// every handler registered below is wrapped to hand its errors to next().
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const original = router[method].bind(router);
  router[method] = (path, ...handlers) => original(path, ...handlers.map(h =>
    (typeof h === 'function' && h.length < 4)
      ? function (req, res, next) { Promise.resolve(h(req, res, next)).catch(next); }
      : h));
}

/* ---------------- uploads (photos, COI docs) ---------------- */
const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (req, file, cb) => cb(null, crypto.randomBytes(8).toString('hex') + path.extname(file.originalname).slice(0, 8))
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });
router.post('/upload', auth.requireAuth, upload.single('file'), (req, res) => {
  res.json({ url: '/uploads/' + req.file.filename });
});

/* ---------------- service catalog ---------------- */
// Everyone reads the catalog; only the admin writes it.
router.get('/catalog', async (req, res) => {
  const all = req.query.all === '1' && req.user?.role === 'admin';
  res.json(await getCatalog({ activeOnly: !all }));
});

router.post('/admin/catalog', auth.requireRole('admin'), async (req, res) => {
  const label = String(req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Name required' });
  const std = Math.max(0, Math.round((parseFloat(req.body.standard) || 25) * 100));
  const prem = Math.max(0, Math.round((parseFloat(req.body.premium) || (std / 100) * 2) * 100));
  let key = slugify(label);
  if (await one('SELECT id FROM service_categories WHERE key=$1', [key])) key += Date.now().toString().slice(-4);
  const max = await one('SELECT COALESCE(MAX(sort_order),0)::int AS m FROM service_categories WHERE key <> $1', ['other']);
  const cat = await one(`
    INSERT INTO service_categories (key, label, icon, blurb, driver_visible, sort_order)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [key, label, req.body.icon || 'box', String(req.body.blurb || '').slice(0, 80),
     req.body.driver_visible !== false, max.m + 10]);
  await ensurePricing(key, label, std, prem);
  res.json(cat);
});

router.put('/admin/catalog/:id', auth.requireRole('admin'), async (req, res) => {
  const b = req.body;
  const cat = await one(`
    UPDATE service_categories SET
      label = COALESCE($1, label), icon = COALESCE($2, icon), blurb = COALESCE($3, blurb),
      driver_visible = COALESCE($4, driver_visible), active = COALESCE($5, active),
      sort_order = COALESCE($6, sort_order)
    WHERE id=$7 RETURNING *`,
    [b.label ?? null, b.icon ?? null, b.blurb ?? null,
     typeof b.driver_visible === 'boolean' ? b.driver_visible : null,
     typeof b.active === 'boolean' ? b.active : null,
     Number.isFinite(b.sort_order) ? b.sort_order : null, req.params.id]);
  if (!cat) return res.status(404).json({ error: 'Not found' });
  if (b.label || b.standard != null || b.premium != null) {
    const price = await one('SELECT * FROM pricing WHERE service_key=$1', [cat.key]);
    const std = b.standard != null ? Math.round(parseFloat(b.standard) * 100) : (price?.standard_cents ?? 2500);
    const prem = b.premium != null ? Math.round(parseFloat(b.premium) * 100) : (price?.premium_cents ?? 5000);
    await ensurePricing(cat.key, cat.label, std, prem);
  }
  res.json(cat);
});

router.post('/admin/catalog/:id/items', auth.requireRole('admin'), async (req, res) => {
  const label = String(req.body.label || '').trim().slice(0, 80);
  if (!label) return res.status(400).json({ error: 'Name required' });
  const max = await one('SELECT COALESCE(MAX(sort_order),0)::int AS m FROM service_items WHERE category_id=$1', [req.params.id]);
  const item = await one(
    'INSERT INTO service_items (category_id, label, sort_order) VALUES ($1,$2,$3) RETURNING *',
    [req.params.id, label, max.m + 10]);
  res.json(item);
});

router.delete('/admin/catalog/items/:id', auth.requireRole('admin'), async (req, res) => {
  await q('UPDATE service_items SET active=FALSE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

router.get('/trades', async (req, res) => {
  const all = req.query.all === '1' && req.user?.role === 'admin';
  res.json(await getTrades({ activeOnly: !all }));
});

router.post('/admin/trades', auth.requireRole('admin'), async (req, res) => {
  const label = String(req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Name required' });
  let key = slugify(label);
  if (await one('SELECT id FROM provider_trades WHERE key=$1', [key])) key += Date.now().toString().slice(-4);
  const max = await one('SELECT COALESCE(MAX(sort_order),0)::int AS m FROM provider_trades');
  const t = await one(`INSERT INTO provider_trades (key, label, icon, blurb, sort_order)
    VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [key, label, req.body.icon || 'wrench', String(req.body.blurb || '').slice(0, 80), max.m + 10]);
  res.json(t);
});

router.put('/admin/trades/:id', auth.requireRole('admin'), async (req, res) => {
  const b = req.body;
  const t = await one(`UPDATE provider_trades SET
      label = COALESCE($1,label), icon = COALESCE($2,icon), blurb = COALESCE($3,blurb),
      active = COALESCE($4,active), presets = COALESCE($5,presets)
    WHERE id=$6 RETURNING *`,
    [b.label ?? null, b.icon ?? null, b.blurb ?? null,
     typeof b.active === 'boolean' ? b.active : null,
     b.presets ? JSON.stringify(b.presets) : null, req.params.id]);
  res.json(t || {});
});

// How many companies would actually get this request? Lets the driver see the
// cost of narrowing before they send, instead of discovering zero afterwards.
router.get('/requests/preview', auth.requireAuth, async (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat/lng required' });
  let trades = [];
  try { trades = JSON.parse(req.query.trades || '[]'); } catch (e) {}
  const fake = {
    service_key: req.query.service_key, lat, lng,
    licensed_only: req.query.licensed_only === '1',
    trade_filter: trades,
    duty_class: req.query.duty_class || 'heavy'
  };
  const narrowed = await matchProviders(fake);
  const wide = await matchProviders({ ...fake, licensed_only: false, trade_filter: [] });
  res.json({ matches: narrowed.length, without_filters: wide.length });
});

/* ---------------- coverage waitlist ---------------- */
// A company outside a live corridor still gets to raise its hand. Public on
// purpose — this is the recruiting page, and where companies sign up is the
// signal for which corridor to open next.
router.post('/waitlist', async (req, res) => {
  const b = req.body || {};
  const clip = (v, n) => String(v || '').trim().slice(0, n);
  const company = clip(b.company, 120);
  if (!company) return res.status(400).json({ error: 'Company name is required' });
  if (!clip(b.phone, 40) && !clip(b.email, 120))
    return res.status(400).json({ error: 'Leave a phone number or an email so we can reach you' });
  await q(`INSERT INTO waitlist (company, contact, phone, email, city, state, trade, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [company, clip(b.contact, 120), clip(b.phone, 40), clip(b.email, 120),
     clip(b.city, 80), clip(b.state, 40), clip(b.trade, 80), clip(b.note, 500)]);
  res.json({ ok: true });
});

router.get('/admin/waitlist', auth.requireRole('admin'), async (req, res) => {
  res.json(await q(`SELECT * FROM waitlist ORDER BY contacted, id DESC LIMIT 300`));
});

router.post('/admin/waitlist/:id/contacted', auth.requireRole('admin'), async (req, res) => {
  await q('UPDATE waitlist SET contacted = NOT contacted WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

/* ---------------- equipment reference lists ---------------- */
// Powers every dropdown in onboarding so drivers pick instead of type.
router.get('/equipment', (req, res) => res.json(EQUIP));

// Anything typed into an "Other…" box gets logged so the lists can be improved
// from real usage. Fire-and-forget: never blocks the person filling the form.
router.post('/other-entry', auth.requireAuth, async (req, res) => {
  const field = String(req.body.field || '').slice(0, 40);
  const value = String(req.body.value || '').trim().slice(0, 80);
  if (field && value) {
    await q('INSERT INTO other_entries (field, value, duty_class) VALUES ($1,$2,$3)',
      [field, value, String(req.body.duty_class || '').slice(0, 20)]).catch(() => {});
  }
  res.json({ ok: true });
});

router.get('/admin/other-entries', auth.requireRole('admin'), async (req, res) => {
  res.json(await q(`
    SELECT field, value, duty_class, COUNT(*)::int AS times, MAX(created_at) AS last_seen
    FROM other_entries GROUP BY field, value, duty_class
    ORDER BY times DESC, last_seen DESC LIMIT 100`));
});

/* ---------------- geocoding ---------------- */
// Live preview for the driver: coordinates -> "Near Buttonwillow, CA"
router.get('/geo', (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat/lng required' });
  res.json({ area_label: areaLabel(lat, lng) });
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
  if (user.archived_at)
    return res.status(403).json({ error: 'This account has been closed. Contact RIGRX if you think that is a mistake.' });
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
           company_id: u.company_id || null,
           member_role: u.member_role || (u.role === 'provider' ? 'owner' : ''),
           assignable: !!u.assignable,
           prefer_licensed_only: !!u.prefer_licensed_only,
           driver_rating: u.rating_count ? +(u.rating_sum / u.rating_count).toFixed(1) : null };
}

router.get('/me', async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const out = { user: publicUser(req.user), simulatedPayments: SIMULATED() };
  if (req.user.role === 'provider' || req.user.role === 'admin') {
    const cid = companyIdOf(req.user);
    out.provider = await one('SELECT * FROM providers WHERE user_id=$1', [cid]);
    if (out.provider) {
      out.provider.locations = await q('SELECT * FROM provider_locations WHERE user_id=$1 ORDER BY id', [cid]);
      out.provider.custom = await q('SELECT * FROM custom_services WHERE user_id=$1 ORDER BY id', [cid]);
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
router.put('/provider/profile', requireOwner, async (req, res) => {
  const { name, dispatch_phone, after_phone, email, hours, services, equipment, verification, capabilities, primary_trade, duty_classes } = req.body;
  await q('INSERT INTO providers (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [companyIdOf(req.user)]);
  const p = await one(`
    UPDATE providers SET
      name = COALESCE($1, name), dispatch_phone = COALESCE($2, dispatch_phone),
      after_phone = COALESCE($3, after_phone), email = COALESCE($4, email),
      hours = COALESCE($5, hours), services = COALESCE($6, services),
      equipment = COALESCE($7, equipment), verification = COALESCE($8, verification),
      capabilities = COALESCE($9, capabilities), primary_trade = COALESCE($10, primary_trade),
      duty_classes = COALESCE($11, duty_classes)
    WHERE user_id=$12 RETURNING *`,
    [name, dispatch_phone, after_phone, email, hours,
     services ? JSON.stringify(services) : null,
     equipment ? JSON.stringify(equipment) : null,
     verification ? JSON.stringify(verification) : null,
     capabilities ? JSON.stringify(capabilities) : null, primary_trade ?? null,
     duty_classes ? JSON.stringify(duty_classes) : null, companyIdOf(req.user)]);
  if (name) await q('UPDATE users SET name=$1 WHERE id=$2', [name, companyIdOf(req.user)]);
  res.json(p);
});

router.post('/provider/locations', requireOwner, async (req, res) => {
  const { label, lat, lng, radius_mi = 50, phone = '' } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat/lng required' });
  const l = await one(
    'INSERT INTO provider_locations (user_id, label, lat, lng, radius_mi, phone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [companyIdOf(req.user), label || '', lat, lng, Math.min(200, Math.max(5, radius_mi)), phone]);
  res.json(l);
});
router.delete('/provider/locations/:id', requireOwner, async (req, res) => {
  await q('DELETE FROM provider_locations WHERE id=$1 AND user_id=$2', [req.params.id, companyIdOf(req.user)]);
  res.json({ ok: true });
});

router.post('/provider/custom-service', requireOwner, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Name required' });
  const c = await one('INSERT INTO custom_services (user_id, name) VALUES ($1,$2) RETURNING *', [companyIdOf(req.user), name]);
  res.json(c);
});

router.get('/providers/:id/public', async (req, res) => {
  const p = await one(`
    SELECT p.user_id, p.name, p.hours, p.equipment, p.badges, p.jobs_won,
           p.rating_sum, p.rating_count, p.license_verified, p.services, p.capabilities, p.primary_trade
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

  const licensedOnly = !!b.licensed_only;
  // Tire requests carry the exact failed position; the size is derived from the saved rig
  // so the provider knows what rubber to load before leaving the shop.
  let tirePos = null;
  if (b.tire_position && b.tire_position.axle) {
    const tp = b.tire_position;
    const isTrailer = /trailer/i.test(tp.axle);
    const isSteer = /steer/i.test(tp.axle);
    tirePos = {
      axle: tp.axle, side: tp.side || '', position: tp.position || '',
      problem: tp.problem || '',
      size: isTrailer ? (trailer.tires || '') : (isSteer ? (truck.steer || '') : (truck.drive || '')),
      wheel: isTrailer ? '' : (truck.wheels || '')
    };
  }
  const request = await one(`
    INSERT INTO requests (driver_id, service_key, service_label, lat, lng, area_label, landmark,
                          situation, can_move, description, photos, truck, trailer, licensed_only, tire_position, service_item, trade_filter, duty_class, direction)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [req.user.id, b.service_key, price.label, b.lat, b.lng,
     areaLabel(b.lat, b.lng) || b.area_label || 'Location shared by driver', b.landmark || '',
     JSON.stringify(b.situation || []), b.can_move || 'no', b.description || '',
     JSON.stringify(b.photos || []), JSON.stringify(truck), JSON.stringify(trailer), licensedOnly,
     tirePos ? JSON.stringify(tirePos) : null, String(b.service_item || '').slice(0, 80),
     JSON.stringify(Array.isArray(b.trade_filter) ? b.trade_filter.slice(0, 8) : []),
     // trust the saved rig over whatever the client sent, falling back to heavy
     ['heavy','medium','light'].includes(truck.duty) ? truck.duty
       : (['heavy','medium','light'].includes(b.duty_class) ? b.duty_class : 'heavy'),
     String(b.direction || '').slice(0, 24)]);
  // remember the driver's preference for next time
  await q('UPDATE users SET prefer_licensed_only=$1 WHERE id=$2', [licensedOnly, req.user.id]);

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
           p.name, p.rating_sum, p.rating_count, p.jobs_won, p.badges, p.license_verified, p.primary_trade,
           (SELECT m.quote FROM messages m
             WHERE m.request_id=pu.request_id AND m.provider_id=pu.provider_id AND m.quote IS NOT NULL
             ORDER BY m.id DESC LIMIT 1) AS quote
    FROM purchases pu JOIN providers p ON p.user_id = pu.provider_id
    WHERE pu.request_id=$1 AND pu.refunded=FALSE ORDER BY pu.slot`, [req.params.id]);
  // Once a tech is rolling, the driver should see who is coming and when — that is
  // the whole point of the job flow, and it is what they are actually anxious about.
  let onTheWay = null;
  if (r.selected_provider && r.enroute_at) {
    const tech = r.assigned_tech ? await one('SELECT name, phone FROM users WHERE id=$1', [r.assigned_tech]) : null;
    const comp = await one('SELECT name FROM providers WHERE user_id=$1', [r.selected_provider]);
    onTheWay = {
      company: comp?.name || '', tech_name: tech?.name || '', tech_phone: tech?.phone || '',
      eta_minutes: r.eta_minutes, eta_set_at: r.eta_set_at,
      arrived: !!r.arrived_at, completed: !!r.completed_at
    };
  }
  res.json({
    request: r,
    on_the_way: onTheWay,
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

// Safety valve: a driver who chose "licensed only" and got no responders
// can open the same request to every approved company without re-typing it.
router.post('/requests/:id/open-to-all', auth.requireAuth, async (req, res) => {
  const r = await one(`UPDATE requests SET licensed_only=FALSE, trade_filter='[]'
    WHERE id=$1 AND driver_id=$2 AND status='open'
      AND (licensed_only=TRUE OR jsonb_array_length(trade_filter) > 0) RETURNING *`,
    [req.params.id, req.user.id]);
  if (!r) return res.status(400).json({ error: 'Nothing to widen' });
  const price = await one('SELECT * FROM pricing WHERE service_key=$1', [r.service_key]);
  const already = (await q('SELECT provider_id FROM purchases WHERE request_id=$1', [r.id])).map(x => x.provider_id);
  let matches = (await matchProviders(r)).filter(m => !already.includes(m.user_id));
  if (!matches.length) matches = (await matchProviders(r, 50)).filter(m => !already.includes(m.user_id));
  await notifyProviders(r, matches, price);
  await q('UPDATE requests SET notified_count = notified_count + $1 WHERE id=$2', [matches.length, r.id]);
  await q('UPDATE users SET prefer_licensed_only=FALSE WHERE id=$1', [req.user.id]);
  res.json({ ok: true, notified: matches.length });
});

router.post('/requests/:id/cancel', auth.requireAuth, async (req, res) => {
  const r = await one(`UPDATE requests SET status='cancelled'
    WHERE id=$1 AND driver_id=$2 AND status='open' RETURNING *`, [req.params.id, req.user.id]);
  if (!r) return res.status(400).json({ error: 'Request not open' });
  res.json({ ok: true });
});

/* ---------------- leads (provider side) ---------------- */
// Equipment detail that is safe to show BEFORE purchase — it describes the rig,
// never the driver. This is what lets a provider load the right parts up front.
function buildSpec(r) {
  const t = r.truck || {}, tr = r.trailer || {};
  const out = [];
  if (t.engine) out.push({ k: 'Engine', v: t.engine });
  if (t.trans) out.push({ k: 'Transmission', v: t.trans });
  if (t.axles) out.push({ k: 'Axles', v: t.axles });
  if (t.steer || t.drive) out.push({ k: 'Truck tires', v: [t.steer, t.drive].filter(Boolean).join(' steer / ') + (t.drive ? ' drive' : '') });
  if (t.wheels) out.push({ k: 'Wheels', v: t.wheels });
  if (t.extras && t.extras.length) out.push({ k: 'Extras', v: t.extras.join(' · ') });
  if (tr.len || tr.axles) out.push({ k: 'Trailer', v: [tr.len, tr.axles].filter(Boolean).join(' · ') });
  if (tr.tires) out.push({ k: 'Trailer tires', v: tr.tires });
  if (tr.reefer) out.push({ k: 'Reefer unit', v: tr.reefer });
  if (tr.liftgate) out.push({ k: 'Liftgate', v: tr.liftgate });
  return out;
}

// Non-blocking heads-up when a lead needs a capability the provider has not claimed.
function capabilityWarning(provider, r) {
  const c = (provider && provider.capabilities) || {};
  const notes = [];
  if (r.trailer && r.trailer.hazmat && !c.hazmat) notes.push('this load is placarded hazmat');
  if (/tanker/i.test(r.trailer?.type || '') && !c.tanker) notes.push('this is a cargo tank / tanker');
  if ((r.situation || []).some(s => /scale|inspection/i.test(s)) && !c.scale) notes.push('this is at a scale or inspection facility');
  if (!notes.length) return null;
  return 'Heads up — ' + notes.join(' and ') + ', and you have not marked that capability in your settings.';
}

// A service company can have several logins. Every provider route works on the
// company record, so the owner, a dispatcher and a tech all resolve to the same one.
function companyIdOf(user) { return user?.company_id || user?.id; }
async function providerOf(req) {
  return await one('SELECT * FROM providers WHERE user_id=$1', [companyIdOf(req.user)]);
}
// Techs only ever see work handed to them — never the lead feed, prices or the queue.
function requireOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  if (req.user.role === 'admin') return next();
  if (req.user.role !== 'provider') return res.status(403).json({ error: 'provider account required' });
  if ((req.user.member_role || 'owner') !== 'owner')
    return res.status(403).json({ error: 'Only the account owner can change this' });
  next();
}
function requireDispatch(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  if (req.user.role === 'admin') return next();
  if (req.user.role !== 'provider') return res.status(403).json({ error: 'provider account required' });
  if (req.user.member_role === 'tech')
    return res.status(403).json({ error: 'Technicians see their assigned jobs only. Ask your dispatcher.' });
  next();
}
async function slotInfo(requestId) {
  const rows = await q('SELECT slot, premium FROM purchases WHERE request_id=$1 AND refunded=FALSE ORDER BY slot', [requestId]);
  const standard = rows.filter(r => !r.premium).length;
  const total = rows.length;
  return { standard, total, standardLeft: Math.max(0, MAX_STANDARD_SLOTS - standard),
           premiumOpen: standard >= MAX_STANDARD_SLOTS && total < MAX_TOTAL_SLOTS,
           soldOut: total >= MAX_TOTAL_SLOTS };
}

router.get('/leads', requireDispatch, async (req, res) => {
  const p = await providerOf(req);
  const locations = await q('SELECT * FROM provider_locations WHERE user_id=$1', [companyIdOf(req.user)]);
  const open = await q(`
    SELECT r.*, pr.standard_cents, pr.premium_cents,
      u.rating_sum AS d_rsum, u.rating_count AS d_rcount
    FROM requests r
    JOIN pricing pr ON pr.service_key = r.service_key
    JOIN users u ON u.id = r.driver_id
    WHERE r.status='open' AND r.created_at > NOW() - INTERVAL '6 hours'
      AND u.archived_at IS NULL
      AND (r.licensed_only = FALSE OR $1::boolean = TRUE)
      AND (jsonb_array_length(r.trade_filter) = 0 OR r.trade_filter ? $2)
      AND ($3::jsonb ? r.duty_class)
    ORDER BY r.id DESC LIMIT 50`,
    [p?.license_verified || false, p?.primary_trade || '',
     JSON.stringify(p?.duty_classes || ['heavy','medium','light'])]);
  // count what an unverified provider is missing, to nudge them to send paperwork
  const missed = p?.license_verified ? { n: 0 } : await one(`
    SELECT COUNT(*)::int AS n FROM requests
    WHERE status='open' AND licensed_only=TRUE AND created_at > NOW() - INTERVAL '7 days'`);
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
    const mine = await one('SELECT id FROM purchases WHERE request_id=$1 AND provider_id=$2', [r.id, companyIdOf(req.user)]);
    out.push({
      id: r.id, service_key: r.service_key, service_label: r.service_label,
      area_label: r.area_label, band: distanceBand(best),
      created_at: r.created_at, situation: r.situation, can_move: r.can_move,
      truck_class: r.truck?.make ? `${r.truck.year || ''} ${r.truck.make} ${r.truck.model || ''}`.trim() : 'Class 8 tractor',
      trailer_type: r.trailer?.type || 'No trailer', loaded: true,
      hazmat: !!(r.trailer && r.trailer.hazmat),
      spec: buildSpec(r),
      duty_class: r.duty_class || 'heavy',
      service_item: r.service_item || '',
      tire_position: r.tire_position || null,
      driver_rating: r.d_rcount ? +(r.d_rsum / r.d_rcount).toFixed(1) : null,
      slots, price_cents: slots.premiumOpen ? r.premium_cents : r.standard_cents,
      premium: slots.premiumOpen, purchased: !!mine
    });
  }
  res.json({
    leads: out,
    approved: p?.approved || false,
    license_verified: p?.license_verified || false,
    missed_licensed_leads: missed.n
  });
});

router.get('/leads/:id', requireDispatch, async (req, res) => {
  const p = await providerOf(req);
  const r = await one(`SELECT r.*, pr.standard_cents, pr.premium_cents FROM requests r
    JOIN pricing pr ON pr.service_key=r.service_key WHERE r.id=$1`, [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const slots = await slotInfo(r.id);
  const mine = await one('SELECT * FROM purchases WHERE request_id=$1 AND provider_id=$2 AND refunded=FALSE', [r.id, companyIdOf(req.user)]);
  const driver = await one('SELECT * FROM users WHERE id=$1', [r.driver_id]);
  const base = {
    id: r.id, service_key: r.service_key, service_label: r.service_label,
    area_label: r.area_label, created_at: r.created_at, status: r.status,
    situation: r.situation, can_move: r.can_move, direction: r.direction || '',
    truck_class: r.truck?.make ? `${r.truck.year || ''} ${r.truck.make} ${r.truck.model || ''}`.trim() : 'Class 8 tractor',
    trailer_type: r.trailer?.type || 'No trailer',
    hazmat: !!(r.trailer && r.trailer.hazmat),
    hazmat_info: r.trailer?.hazmat ? { class: r.trailer.hzClass, un: r.trailer.un } : null,
    spec: buildSpec(r),
    duty_class: r.duty_class || 'heavy',
    service_item: r.service_item || '',
    tire_position: r.tire_position || null,
    capability_warning: capabilityWarning(p, r),
    driver_rating: driver.rating_count ? +(driver.rating_sum / driver.rating_count).toFixed(1) : null,
    slots, price_cents: slots.premiumOpen ? r.premium_cents : r.standard_cents, premium: slots.premiumOpen,
    purchased: !!mine, selected_provider: r.selected_provider
  };
  if (mine) {
    // Staged disclosure. Buying unlocks the driver, the problem and enough distance
    // to quote an accurate ETA — but NOT turn-by-turn detail. Only the company the
    // driver actually chooses gets the exact pin, the landmark and the map link, so
    // losing bidders can't roll out to a truck that isn't theirs.
    const won = r.selected_provider === companyIdOf(req.user);
    const locs = await q('SELECT lat, lng FROM provider_locations WHERE user_id=$1', [companyIdOf(req.user)]);
    let nearest = null;
    for (const l of locs) {
      const d = haversineMiles(r.lat, r.lng, l.lat, l.lng);
      if (nearest === null || d < nearest) nearest = d;
    }
    base.full = {
      driver_name: driver.name || 'Driver', driver_phone: driver.phone,
      description: r.description, photos: r.photos, truck: r.truck, trailer: r.trailer,
      won,
      distance_mi: nearest === null ? null : +nearest.toFixed(1),
      eta_min: nearest === null ? null : Math.max(5, Math.round(nearest / 45 * 60)),
      // exact navigation detail — winner only
      lat: won ? r.lat : null,
      lng: won ? r.lng : null,
      landmark: won ? r.landmark : null
    };
  }
  res.json(base);
});

router.post('/leads/:id/buy', requireDispatch, async (req, res) => {
  const p = await providerOf(req);
  if (!p) return res.status(400).json({ error: 'Complete your company profile first' });
  if (!p.approved) return res.status(403).json({ error: 'Your account is pending RIGRX approval' });

  const r = await one(`SELECT r.*, pr.standard_cents, pr.premium_cents FROM requests r
    JOIN pricing pr ON pr.service_key=r.service_key WHERE r.id=$1 AND r.status='open'`, [req.params.id]);
  if (!r) return res.status(400).json({ error: 'Lead is no longer open' });
  if (r.licensed_only && !p.license_verified)
    return res.status(403).json({ error: 'This driver requested licensed companies only' });
  const tf = Array.isArray(r.trade_filter) ? r.trade_filter : [];
  if (tf.length && !tf.includes(p.primary_trade))
    return res.status(403).json({ error: 'This driver asked for a different kind of company' });
  const dc = Array.isArray(p.duty_classes) ? p.duty_classes : ['heavy','medium','light'];
  if (!dc.includes(r.duty_class || 'heavy'))
    return res.status(403).json({ error: 'You have not marked that you service this size of truck' });

  const existing = await one('SELECT id FROM purchases WHERE request_id=$1 AND provider_id=$2', [r.id, companyIdOf(req.user)]);
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
             VALUES ($1,$2,$3,$4,$5,$6)`, [r.id, companyIdOf(req.user), slot, amount, premium, charge.paymentId]);
  } catch (e) {
    return res.status(409).json({ error: 'Slot was just taken — refresh the lead' });
  }

  // tell the driver instantly
  const driver = await one('SELECT * FROM users WHERE id=$1', [r.driver_id]);
  wsPush(driver.id, 'responder', { request_id: r.id, provider_id: companyIdOf(req.user), name: p.name, slot });
  await sms(driver.id, driver.phone, `RIGRX: ${p.name} unlocked your ${r.service_label} request and can now contact you. Open the app to chat.`);

  res.json({ ok: true, slot, premium, amount_cents: amount, simulated: charge.paymentId === 'simulated' });
});

router.get('/myleads', requireDispatch, async (req, res) => {
  const rows = await q(`
    SELECT pu.*, r.service_label, r.area_label, r.status AS request_status, r.selected_provider, r.created_at AS requested_at
    FROM purchases pu JOIN requests r ON r.id = pu.request_id
    WHERE pu.provider_id=$1 ORDER BY pu.id DESC LIMIT 50`, [companyIdOf(req.user)]);
  res.json(rows.map(x => ({ ...x, won: x.selected_provider === companyIdOf(req.user) })));
});

router.get('/provider/stats', requireDispatch, async (req, res) => {
  const p = await providerOf(req);
  const bought = await one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::int AS spend
    FROM purchases WHERE provider_id=$1 AND refunded=FALSE`, [companyIdOf(req.user)]);
  const won = await one(`SELECT COUNT(*)::int AS n FROM requests WHERE selected_provider=$1 AND status IN ('selected','completed')`, [companyIdOf(req.user)]);
  const week = await q(`
    SELECT to_char(created_at, 'Dy') AS day, COUNT(*)::int AS n
    FROM purchases WHERE provider_id=$1 AND created_at > NOW() - INTERVAL '7 days'
    GROUP BY 1`, [companyIdOf(req.user)]);
  // How long after buying a lead they actually said something to the driver. Speed is
  // what wins these jobs, so a company should be able to see its own number.
  const reply = await one(`
    SELECT AVG(EXTRACT(EPOCH FROM (m.first_at - pu.created_at)) / 60)::float AS mins, COUNT(*)::int AS n
    FROM purchases pu
    JOIN LATERAL (
      SELECT MIN(created_at) AS first_at FROM messages
      WHERE request_id = pu.request_id AND sender_id = $1
    ) m ON TRUE
    WHERE pu.provider_id = $1 AND pu.refunded = FALSE AND m.first_at IS NOT NULL
      AND m.first_at >= pu.created_at`, [companyIdOf(req.user)]);
  res.json({
    leads_bought: bought.n, spend_cents: bought.spend, jobs_won: won.n,
    win_rate: bought.n ? Math.round(won.n / bought.n * 100) : 0,
    cost_per_win_cents: won.n ? Math.round(bought.spend / won.n) : null,
    avg_reply_mins: reply?.n ? Math.round(reply.mins) : null,
    replied_count: reply?.n || 0,
    never_replied: Math.max(0, bought.n - (reply?.n || 0)),
    rating: p?.rating_count ? +(p.rating_sum / p.rating_count).toFixed(1) : null,
    rating_count: p?.rating_count || 0, week
  });
});

// Every review a driver left for this company, with the job it came from.
router.get('/provider/reviews', requireDispatch, async (req, res) => {
  const rows = await q(`
    SELECT rv.stars, rv.tags, rv.comment, rv.created_at,
           req.id AS request_id, req.service_label, req.area_label
    FROM reviews rv JOIN requests req ON req.id = rv.request_id
    WHERE rv.target_provider = $1 ORDER BY rv.id DESC LIMIT 100`, [companyIdOf(req.user)]);
  const breakdown = await q(`
    SELECT stars, COUNT(*)::int AS n FROM reviews WHERE target_provider=$1 GROUP BY stars`, [companyIdOf(req.user)]);
  res.json({ reviews: rows, breakdown });
});

/* ---------------- jobs: won -> assigned -> on the way -> done ---------------- */
// A lead ends when the driver picks you. The job starts there. These timestamps are
// also where response-time data comes from, which nobody in this industry publishes.
const JOB_COLS = `r.id, r.service_label, r.service_key, r.area_label, r.landmark, r.lat, r.lng,
  r.description, r.situation, r.can_move, r.truck, r.trailer, r.tire_position, r.duty_class,
  r.status, r.assigned_tech, r.assigned_at, r.accepted_at, r.enroute_at, r.arrived_at,
  r.completed_at, r.eta_minutes, r.eta_set_at, r.assign_bounced, r.created_at`;

async function jobFor(req, id, { techOnly = false } = {}) {
  const r = await one(`SELECT * FROM requests WHERE id=$1 AND selected_provider=$2`,
    [id, companyIdOf(req.user)]);
  if (!r) return null;
  if (techOnly && r.assigned_tech !== req.user.id) return null;
  return r;
}

// The dispatcher's queue: everything this company won, newest first.
router.get('/jobs', requireDispatch, async (req, res) => {
  const cid = companyIdOf(req.user);
  const rows = await q(`
    SELECT ${JOB_COLS}, u.name AS driver_name, u.phone AS driver_phone,
           t.name AS tech_name, t.phone AS tech_phone
    FROM requests r
    JOIN users u ON u.id = r.driver_id
    LEFT JOIN users t ON t.id = r.assigned_tech
    WHERE r.selected_provider = $1 AND r.status IN ('selected','completed')
    ORDER BY (r.completed_at IS NOT NULL), r.id DESC LIMIT 60`, [cid]);
  const techs = await q(`SELECT id, name, phone, member_role, member_location_id FROM users
    WHERE company_id=$1 AND assignable=TRUE AND archived_at IS NULL ORDER BY name`, [cid]);
  res.json({ jobs: rows, techs });
});

router.post('/jobs/:id/assign', requireDispatch, async (req, res) => {
  const r = await jobFor(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Not one of your jobs' });
  if (r.completed_at) return res.status(400).json({ error: 'That job is already finished' });
  const tech = await one(`SELECT * FROM users WHERE id=$1 AND company_id=$2
    AND assignable=TRUE AND archived_at IS NULL`, [req.body.tech_id, companyIdOf(req.user)]);
  if (!tech) return res.status(400).json({ error: 'Pick someone on your team' });

  await q(`UPDATE requests SET assigned_tech=$1, assigned_at=NOW(), accepted_at=NULL,
           assign_bounced=FALSE WHERE id=$2`, [tech.id, r.id]);
  await sms(tech.id, tech.phone,
    `RIGRX JOB: ${r.service_label} ${r.area_label}. Open the app to accept. ${process.env.BASE_URL || ''}`);
  wsPush(tech.id, 'job_assigned', { request_id: r.id, service: r.service_label });
  res.json({ ok: true });
});

router.post('/jobs/:id/accept', auth.requireRole('provider'), async (req, res) => {
  const r = await jobFor(req, req.params.id, { techOnly: true });
  if (!r) return res.status(404).json({ error: 'That job is not assigned to you' });
  await q('UPDATE requests SET accepted_at=NOW(), assign_bounced=FALSE WHERE id=$1', [r.id]);
  res.json({ ok: true });
});

// Declining hands it straight back rather than leaving a driver waiting on nobody.
router.post('/jobs/:id/decline', auth.requireRole('provider'), async (req, res) => {
  const r = await jobFor(req, req.params.id, { techOnly: true });
  if (!r) return res.status(404).json({ error: 'That job is not assigned to you' });
  await q(`UPDATE requests SET assigned_tech=NULL, assigned_at=NULL, accepted_at=NULL,
           assign_bounced=TRUE WHERE id=$1`, [r.id]);
  await notifyDispatch(r, `${req.user.name || 'A tech'} declined job #${r.id} — reassign it.`);
  res.json({ ok: true });
});

router.post('/jobs/:id/enroute', auth.requireRole('provider'), async (req, res) => {
  const r = await jobFor(req, req.params.id, { techOnly: true });
  if (!r) return res.status(404).json({ error: 'That job is not assigned to you' });
  const eta = Math.max(1, Math.min(600, Number(req.body.eta_minutes) || 30));
  await q(`UPDATE requests SET enroute_at = COALESCE(enroute_at, NOW()), accepted_at = COALESCE(accepted_at, NOW()),
           eta_minutes=$1, eta_set_at=NOW() WHERE id=$2`, [eta, r.id]);
  const d = await one('SELECT id, phone FROM users WHERE id=$1', [r.driver_id]);
  const p = await one('SELECT name FROM providers WHERE user_id=$1', [companyIdOf(req.user)]);
  if (d) {
    await sms(d.id, d.phone, `RIGRX: ${p?.name || 'Your provider'} is on the way — about ${eta} min out.`);
    wsPush(d.id, 'job_status', { request_id: r.id, state: 'enroute', eta_minutes: eta });
  }
  res.json({ ok: true });
});

// A delay the driver is told about is a very different experience to one they aren't.
router.post('/jobs/:id/late', auth.requireRole('provider'), async (req, res) => {
  const r = await jobFor(req, req.params.id, { techOnly: true });
  if (!r) return res.status(404).json({ error: 'That job is not assigned to you' });
  const eta = Math.max(1, Math.min(600, Number(req.body.eta_minutes) || 15));
  await q('UPDATE requests SET eta_minutes=$1, eta_set_at=NOW() WHERE id=$2', [eta, r.id]);
  const d = await one('SELECT id, phone FROM users WHERE id=$1', [r.driver_id]);
  const p = await one('SELECT name FROM providers WHERE user_id=$1', [companyIdOf(req.user)]);
  if (d) {
    await sms(d.id, d.phone, `RIGRX: ${p?.name || 'Your provider'} updated their ETA — about ${eta} min out.`);
    wsPush(d.id, 'job_status', { request_id: r.id, state: 'late', eta_minutes: eta });
  }
  res.json({ ok: true });
});

router.post('/jobs/:id/arrived', auth.requireRole('provider'), async (req, res) => {
  const r = await jobFor(req, req.params.id, { techOnly: true });
  if (!r) return res.status(404).json({ error: 'That job is not assigned to you' });
  await q('UPDATE requests SET arrived_at = COALESCE(arrived_at, NOW()) WHERE id=$1', [r.id]);
  wsPush(r.driver_id, 'job_status', { request_id: r.id, state: 'arrived' });
  res.json({ ok: true });
});

router.post('/jobs/:id/complete', auth.requireRole('provider'), async (req, res) => {
  const r = await jobFor(req, req.params.id, req.user.member_role === 'tech' ? { techOnly: true } : {});
  if (!r) return res.status(404).json({ error: 'Not one of your jobs' });
  await q(`UPDATE requests SET status='completed', completed_at = COALESCE(completed_at, NOW()),
           arrived_at = COALESCE(arrived_at, NOW()) WHERE id=$1`, [r.id]);
  const d = await one('SELECT id, phone FROM users WHERE id=$1', [r.driver_id]);
  if (d) {
    await sms(d.id, d.phone, 'RIGRX: Job marked complete. Tap to rate how it went — it takes 10 seconds.');
    wsPush(d.id, 'job_status', { request_id: r.id, state: 'completed' });
  }
  res.json({ ok: true });
});

// A tech only ever sees what was handed to them.
router.get('/tech/jobs', auth.requireRole('provider'), async (req, res) => {
  const rows = await q(`
    SELECT ${JOB_COLS}, u.name AS driver_name, u.phone AS driver_phone
    FROM requests r JOIN users u ON u.id = r.driver_id
    WHERE r.assigned_tech = $1
    ORDER BY (r.completed_at IS NOT NULL), r.id DESC LIMIT 30`, [req.user.id]);
  res.json(rows);
});

async function notifyDispatch(r, body) {
  const people = await alertRecipients(r.selected_provider, null);
  for (const person of people) {
    await sms(person.id, person.phone, `RIGRX: ${body}`);
    wsPush(person.id, 'job_bounced', { request_id: r.id });
  }
}

// Nothing sits silently while a driver waits on a shoulder: an assignment nobody
// accepted inside five minutes goes back to the queue and the dispatcher is told.
async function sweepUnacceptedJobs() {
  const stale = await q(`
    UPDATE requests SET assigned_tech=NULL, assign_bounced=TRUE
    WHERE status='selected' AND assigned_tech IS NOT NULL AND accepted_at IS NULL
      AND assigned_at < NOW() - INTERVAL '5 minutes'
    RETURNING id, selected_provider`);
  for (const r of stale) {
    await notifyDispatch(r, `Job #${r.id} was not accepted — it is back in your queue.`);
  }
  return stale.length;
}

/* ---------------- company people ---------------- */
// Owner runs the account, dispatchers take alerts for their yard and hand work out,
// techs only see the job they were given. Everyone signs in with their own phone.
const MEMBER_ROLES = ['owner', 'dispatcher', 'tech'];

router.get('/provider/members', requireDispatch, async (req, res) => {
  const cid = companyIdOf(req.user);
  const rows = await q(`
    SELECT u.id, u.name, u.phone, u.member_role, u.assignable, u.member_location_id, u.archived_at,
           u.created_at, l.label AS location_label
    FROM users u
    LEFT JOIN provider_locations l ON l.id = u.member_location_id
    WHERE u.company_id = $1 ORDER BY
      CASE u.member_role WHEN 'owner' THEN 0 WHEN 'dispatcher' THEN 1 ELSE 2 END, u.id`, [cid]);
  res.json(rows);
});

router.post('/provider/members', requireOwner, async (req, res) => {
  const cid = companyIdOf(req.user);
  const phone = auth.normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid mobile number' });
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Enter their name' });
  const role = MEMBER_ROLES.includes(req.body.member_role) ? req.body.member_role : 'tech';
  if (role === 'owner') return res.status(400).json({ error: 'There can only be one owner' });

  const existing = await one('SELECT * FROM users WHERE phone=$1', [phone]);
  if (existing && existing.company_id && existing.company_id !== cid)
    return res.status(409).json({ error: 'That number already belongs to another company' });
  if (existing && existing.role === 'driver' && !existing.company_id)
    return res.status(409).json({ error: 'That number is already signed up as a driver' });

  const locId = Number(req.body.member_location_id) || null;
  const assignable = req.body.assignable !== false;   // techs are assignable by default
  const u = existing
    ? await one(`UPDATE users SET name=$1, role='provider', company_id=$2, member_role=$3,
                 assignable=$4, member_location_id=$5, archived_at=NULL WHERE id=$6 RETURNING *`,
                [name, cid, role, assignable, locId, existing.id])
    : await one(`INSERT INTO users (phone, role, name, company_id, member_role, assignable, member_location_id)
                 VALUES ($1,'provider',$2,$3,$4,$5,$6) RETURNING *`,
                [phone, name, cid, role, assignable, locId]);

  const company = await one('SELECT name FROM providers WHERE user_id=$1', [cid]);
  await sms(u.id, u.phone,
    `RIGRX: ${company?.name || 'Your company'} added you as ${role === 'tech' ? 'a technician' : 'a dispatcher'}. ` +
    `Sign in with this number — no password needed. ${process.env.BASE_URL || ''}`);
  res.json({ ok: true, member: { id: u.id, name: u.name, phone: u.phone, member_role: u.member_role } });
});

router.put('/provider/members/:id', requireOwner, async (req, res) => {
  const cid = companyIdOf(req.user);
  const m = await one('SELECT * FROM users WHERE id=$1 AND company_id=$2', [req.params.id, cid]);
  if (!m) return res.status(404).json({ error: 'Not on your team' });
  if (m.member_role === 'owner') return res.status(400).json({ error: 'The owner cannot be changed here' });
  const role = MEMBER_ROLES.includes(req.body.member_role) && req.body.member_role !== 'owner'
    ? req.body.member_role : m.member_role;
  await q(`UPDATE users SET member_role=$1, assignable=$2, member_location_id=$3 WHERE id=$4`,
    [role, req.body.assignable !== false,
     req.body.member_location_id === null ? null : (Number(req.body.member_location_id) || null), m.id]);
  res.json({ ok: true });
});

// Removing someone unhooks them from the company rather than deleting the person, so
// any job they worked keeps its record. Their login stops working immediately.
router.delete('/provider/members/:id', requireOwner, async (req, res) => {
  const cid = companyIdOf(req.user);
  const m = await one('SELECT * FROM users WHERE id=$1 AND company_id=$2', [req.params.id, cid]);
  if (!m) return res.status(404).json({ error: 'Not on your team' });
  if (m.member_role === 'owner') return res.status(400).json({ error: 'You cannot remove the owner' });
  const openJobs = await q(`SELECT id FROM requests WHERE assigned_tech=$1 AND completed_at IS NULL
    AND status IN ('selected')`, [m.id]);
  await q(`UPDATE requests SET assigned_tech=NULL, assigned_at=NULL, accepted_at=NULL
           WHERE assigned_tech=$1 AND completed_at IS NULL`, [m.id]);
  await q(`UPDATE users SET archived_at=NOW(), archive_reason='Removed from company' WHERE id=$1`, [m.id]);
  await auth.endAllSessions(m.id);
  res.json({ ok: true, unassigned_jobs: openJobs.length });
});

/* ---------------- archive & restore ---------------- */
// There is deliberately no delete. Deleting a user cascades away the purchases other
// companies paid for and silently rewrites the revenue history, so an account is
// archived instead: locked out, invisible everywhere, every record intact, reversible.
router.post('/admin/users/:id/archive', auth.requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const u = await one('SELECT * FROM users WHERE id=$1', [id]);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.role === 'admin') return res.status(400).json({ error: 'You cannot archive an admin account' });
  if (u.archived_at) return res.status(400).json({ error: 'Already archived' });

  await q(`UPDATE users SET archived_at = NOW(), archive_reason = $1 WHERE id = $2`,
    [String(req.body.reason || '').slice(0, 300), id]);
  await auth.endAllSessions(id);          // signed-in devices are out on the next request

  // Don't strand anyone mid-job: an archived driver's open requests are closed so
  // companies stop chasing them, and a chosen company is told the job is off.
  let cancelled = 0;
  if (u.role === 'driver') {
    const open = await q(`UPDATE requests SET status='cancelled'
      WHERE driver_id=$1 AND status IN ('open','selected') RETURNING id, selected_provider`, [id]);
    cancelled = open.length;
    for (const r of open) {
      if (!r.selected_provider) continue;
      const pu = await one('SELECT u.phone, u.id FROM users u WHERE u.id=$1', [r.selected_provider]);
      if (pu) await sms(pu.id, pu.phone, `RIGRX: Request #${r.id} has been closed and is no longer active.`);
    }
  }
  res.json({ ok: true, cancelled_requests: cancelled });
});

router.post('/admin/users/:id/restore', auth.requireRole('admin'), async (req, res) => {
  const u = await one(`UPDATE users SET archived_at = NULL, archive_reason = ''
    WHERE id=$1 RETURNING *`, [req.params.id]);
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
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
  // Who am I talking to? The chat header shows the name so a driver comparing four
  // companies always knows which thread they are in.
  const other = req.user.role === 'provider'
    ? await one('SELECT name FROM users WHERE id=$1', [r.driver_id])
    : await one('SELECT name FROM providers WHERE user_id=$1', [req.params.providerId]);
  // How many other companies are in play, and how many have actually quoted. The
  // driver sees this before he chooses so he isn't rushed into the first bid.
  let others = null;
  if (req.user.role !== 'provider') {
    const c = await one(`
      SELECT COUNT(*)::int AS responders,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM messages m WHERE m.request_id = pu.request_id
            AND m.provider_id = pu.provider_id AND m.quote IS NOT NULL))::int AS quoted
      FROM purchases pu WHERE pu.request_id=$1 AND pu.refunded=FALSE AND pu.provider_id <> $2`,
      [r.id, req.params.providerId]);
    others = { responders: c?.responders || 0, quoted: c?.quoted || 0 };
  }
  res.json({
    request: {
      id: r.id, service_label: r.service_label, status: r.status,
      driver_id: r.driver_id, selected_provider: r.selected_provider
    },
    other_name: other?.name || '',
    others,
    messages: msgs
  });
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

  // The message is already saved and delivered before we judge it — the guard is a
  // review queue, never a gate. Only matters while the job is still up for grabs;
  // once a company is chosen they're entitled to the location anyway.
  if (r.status === 'open' && body) {
    const senderRole = req.user.id === r.driver_id ? 'driver' : 'provider';
    const hit = guard.inspect(body, senderRole);
    if (hit) {
      await q(`INSERT INTO chat_flags
        (request_id, provider_id, message_id, sender_id, sender_role, type, kind, snippet, warned)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [r.id, req.params.providerId, m.id, req.user.id, senderRole,
         hit.type, hit.kind, hit.snippet, !!req.body.warned]);
    }
  }

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
  const flags = await one(`SELECT COUNT(*)::int AS n FROM chat_flags WHERE reviewed_at IS NULL`);
  res.json({
    requests_24h: reqToday.n, revenue_24h_cents: revToday.c, revenue_total_cents: revTotal.c,
    pending_providers: pendingProviders.n,
    fill_rate: fill.total ? Math.round(fill.filled / fill.total * 100) : 0,
    drivers: users.drivers, providers: users.providers,
    open_flags: flags.n
  });
});

/* ---- chat guard review queue ---- */
router.get('/admin/flags', auth.requireRole('admin'), async (req, res) => {
  const showAll = String(req.query.all || '') === '1';
  const rows = await q(`
    SELECT f.*, p.name AS company, u.name AS sender_name, r.service_label, m.body
    FROM chat_flags f
    LEFT JOIN providers p ON p.user_id = f.provider_id
    LEFT JOIN users u ON u.id = f.sender_id
    LEFT JOIN requests r ON r.id = f.request_id
    LEFT JOIN messages m ON m.id = f.message_id
    ${showAll ? '' : 'WHERE f.reviewed_at IS NULL'}
    ORDER BY f.created_at DESC LIMIT 200`);
  // A repeat offender matters far more than a one-off, so send the running count too.
  const tally = await q(`
    SELECT f.provider_id, p.name AS company, COUNT(*)::int AS n
    FROM chat_flags f LEFT JOIN providers p ON p.user_id=f.provider_id
    WHERE f.sender_role='provider' GROUP BY f.provider_id, p.name ORDER BY n DESC LIMIT 20`);
  res.json({ flags: rows, repeat: tally });
});

router.post('/admin/flags/:id/review', auth.requireRole('admin'), async (req, res) => {
  await q(`UPDATE chat_flags SET reviewed_at = NOW() WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

router.get('/admin/providers', auth.requireRole('admin'), async (req, res) => {
  const rows = await q(`
    SELECT p.user_id, p.name, p.email, p.approved, p.license_verified, p.verification, p.created_at, p.primary_trade, u.phone,
      u.archived_at, u.archive_reason,
      (SELECT COUNT(*)::int FROM provider_locations l WHERE l.user_id=p.user_id) AS location_count
    FROM providers p JOIN users u ON u.id=p.user_id
    WHERE ($1::boolean = TRUE OR u.archived_at IS NULL)
    ORDER BY p.approved ASC, p.created_at DESC LIMIT 100`, [req.query.archived === '1']);
  res.json(rows);
});
// Full provider dossier for the admin review page
router.get('/admin/providers/:id', auth.requireRole('admin'), async (req, res) => {
  const p = await one(`
    SELECT p.*, u.phone, u.email AS user_email, u.created_at AS signed_up,
           u.archived_at, u.archive_reason
    FROM providers p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1`, [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const [locations, custom, stats, reviews] = await Promise.all([
    q('SELECT * FROM provider_locations WHERE user_id=$1 ORDER BY id', [req.params.id]),
    q('SELECT * FROM custom_services WHERE user_id=$1 ORDER BY id', [req.params.id]),
    one(`SELECT COUNT(*)::int AS leads_bought, COALESCE(SUM(amount_cents),0)::int AS spend
         FROM purchases WHERE provider_id=$1 AND refunded=FALSE`, [req.params.id]),
    q(`SELECT stars, comment, created_at FROM reviews WHERE target_provider=$1 ORDER BY id DESC LIMIT 5`, [req.params.id])
  ]);
  res.json({
    ...p, locations, custom, stats, reviews,
    rating: p.rating_count ? +(p.rating_sum / p.rating_count).toFixed(1) : null
  });
});

router.post('/admin/providers/:id/license', auth.requireRole('admin'), async (req, res) => {
  const verified = !!req.body.verified;
  await q(`UPDATE providers SET license_verified=$1, license_verified_at=CASE WHEN $1 THEN NOW() ELSE NULL END
           WHERE user_id=$2`, [verified, req.params.id]);
  const u = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (u && verified)
    await sms(u.id, u.phone, 'RIGRX: Your license is verified. You now also receive leads from drivers who request licensed companies only.');
  res.json({ ok: true, license_verified: verified });
});

router.post('/admin/providers/:id/notes', auth.requireRole('admin'), async (req, res) => {
  await q('UPDATE providers SET admin_notes=$1 WHERE user_id=$2', [String(req.body.notes || '').slice(0, 2000), req.params.id]);
  res.json({ ok: true });
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
  const win = req.query.window === '24h' ? `WHERE pu.created_at > NOW() - INTERVAL '24 hours'` : '';
  const rows = await q(`
    SELECT pu.*, p.name AS provider_name, r.service_label, r.area_label, r.status AS request_status,
           r.selected_provider, u.name AS driver_name
    FROM purchases pu JOIN providers p ON p.user_id=pu.provider_id
    JOIN requests r ON r.id=pu.request_id
    JOIN users u ON u.id=r.driver_id
    ${win} ORDER BY pu.id DESC LIMIT 100`);
  res.json(rows.map(x => ({ ...x, won: x.selected_provider === x.provider_id })));
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
  const cs = await one('UPDATE custom_services SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
  // Approving folds the provider's suggestion into the real catalog so every
  // company can pick it from then on — otherwise "approved" means nothing.
  if (status === 'approved' && req.body.category_id) {
    const dupe = await one('SELECT id FROM service_items WHERE category_id=$1 AND lower(label)=lower($2)',
      [req.body.category_id, cs.name]);
    if (!dupe) {
      const max = await one('SELECT COALESCE(MAX(sort_order),0)::int AS m FROM service_items WHERE category_id=$1', [req.body.category_id]);
      await q('INSERT INTO service_items (category_id, label, sort_order) VALUES ($1,$2,$3)',
        [req.body.category_id, cs.name, max.m + 10]);
    }
    await q('UPDATE custom_services SET promoted_category=$1 WHERE id=$2', [req.body.category_id, req.params.id]);
  }
  res.json({ ok: true });
});

router.get('/admin/requests', auth.requireRole('admin'), async (req, res) => {
  const win = req.query.window === '24h' ? `WHERE r.created_at > NOW() - INTERVAL '24 hours'`
            : req.query.filled === '1' ? `WHERE EXISTS (SELECT 1 FROM purchases pu WHERE pu.request_id=r.id AND pu.refunded=FALSE)`
            : req.query.unfilled === '1' ? `WHERE NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.request_id=r.id AND pu.refunded=FALSE)`
            : '';
  const rows = await q(`
    SELECT r.id, r.service_label, r.area_label, r.status, r.notified_count, r.created_at,
           r.licensed_only, u.name AS driver_name, u.phone AS driver_phone,
      (SELECT COUNT(*)::int FROM purchases pu WHERE pu.request_id=r.id AND pu.refunded=FALSE) AS buyers,
      (SELECT COALESCE(SUM(amount_cents),0)::int FROM purchases pu WHERE pu.request_id=r.id AND pu.refunded=FALSE) AS revenue_cents
    FROM requests r JOIN users u ON u.id=r.driver_id ${win} ORDER BY r.id DESC LIMIT 100`);
  res.json(rows);
});

// Everything about one request: what the driver sent, who bought it, and every
// message exchanged with each provider.
router.get('/admin/requests/:id', auth.requireRole('admin'), async (req, res) => {
  const r = await one(`
    SELECT r.*, u.name AS driver_name, u.phone AS driver_phone, u.email AS driver_email,
           u.company AS driver_company, u.driver_type,
           u.rating_sum AS d_rsum, u.rating_count AS d_rcount
    FROM requests r JOIN users u ON u.id=r.driver_id WHERE r.id=$1`, [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });

  const buyers = await q(`
    SELECT pu.*, p.name AS provider_name, u.phone AS provider_phone, p.license_verified
    FROM purchases pu JOIN providers p ON p.user_id=pu.provider_id
    JOIN users u ON u.id=pu.provider_id
    WHERE pu.request_id=$1 ORDER BY pu.slot`, [req.params.id]);

  // group every message into a thread per provider
  const msgs = await q(`
    SELECT m.*, COALESCE(p.name, u.name, 'Driver') AS sender_name,
           (m.sender_id = $2) AS from_driver
    FROM messages m
    LEFT JOIN providers p ON p.user_id = m.sender_id
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.request_id=$1 ORDER BY m.id`, [req.params.id, r.driver_id]);
  const threads = {};
  for (const m of msgs) {
    (threads[m.provider_id] = threads[m.provider_id] || []).push(m);
  }

  const reviews = await q(`
    SELECT rv.*, u.name AS reviewer_name FROM reviews rv
    JOIN users u ON u.id=rv.reviewer_id WHERE rv.request_id=$1`, [req.params.id]);

  res.json({
    request: r,
    driver: {
      name: r.driver_name, phone: r.driver_phone, email: r.driver_email,
      company: r.driver_company, type: r.driver_type,
      rating: r.d_rcount ? +(r.d_rsum / r.d_rcount).toFixed(1) : null
    },
    buyers: buyers.map(b => ({
      ...b,
      thread: threads[b.provider_id] || []
    })),
    orphan_threads: Object.entries(threads)
      .filter(([pid]) => !buyers.some(b => b.provider_id === Number(pid)))
      .map(([pid, thread]) => ({ provider_id: Number(pid), thread })),
    reviews,
    revenue_cents: buyers.filter(b => !b.refunded).reduce((a, b) => a + b.amount_cents, 0)
  });
});

// Drivers list + one driver's history
router.get('/admin/drivers', auth.requireRole('admin'), async (req, res) => {
  const rows = await q(`
    SELECT u.id, u.name, u.phone, u.email, u.company, u.driver_type, u.created_at,
      u.archived_at, u.archive_reason,
      (SELECT COUNT(*)::int FROM requests r WHERE r.driver_id=u.id) AS requests,
      (SELECT COUNT(*)::int FROM trucks t WHERE t.user_id=u.id) AS trucks,
      (SELECT COALESCE(SUM(pu.amount_cents),0)::int FROM purchases pu
        JOIN requests r ON r.id=pu.request_id WHERE r.driver_id=u.id AND pu.refunded=FALSE) AS revenue_cents
    FROM users u WHERE u.role='driver' AND ($1::boolean = TRUE OR u.archived_at IS NULL)
    ORDER BY u.id DESC LIMIT 100`, [req.query.archived === '1']);
  res.json(rows);
});

router.get('/admin/drivers/:id', auth.requireRole('admin'), async (req, res) => {
  const u = await one(`SELECT * FROM users WHERE id=$1 AND role IN ('driver','admin')`, [req.params.id]);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const [trucks, trailers, requests] = await Promise.all([
    q('SELECT * FROM trucks WHERE user_id=$1', [req.params.id]),
    q('SELECT * FROM trailers WHERE user_id=$1', [req.params.id]),
    q(`SELECT r.*,
        (SELECT COUNT(*)::int FROM purchases pu WHERE pu.request_id=r.id AND pu.refunded=FALSE) AS buyers,
        (SELECT COALESCE(SUM(amount_cents),0)::int FROM purchases pu WHERE pu.request_id=r.id AND pu.refunded=FALSE) AS revenue_cents
       FROM requests r WHERE r.driver_id=$1 ORDER BY r.id DESC LIMIT 50`, [req.params.id])
  ]);
  res.json({
    driver: { ...u, rating: u.rating_count ? +(u.rating_sum / u.rating_count).toFixed(1) : null },
    trucks, trailers, requests
  });
});

module.exports = router;
module.exports.sweepUnacceptedJobs = sweepUnacceptedJobs;

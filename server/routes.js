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
const { areaLabel } = require('./geo');
const { getCatalog, getTrades, ensurePricing, slugify } = require('./catalog');

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
    trade_filter: trades
  };
  const narrowed = await matchProviders(fake);
  const wide = await matchProviders({ ...fake, licensed_only: false, trade_filter: [] });
  res.json({ matches: narrowed.length, without_filters: wide.length });
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
           prefer_licensed_only: !!u.prefer_licensed_only,
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
  const { name, dispatch_phone, after_phone, email, hours, services, equipment, verification, capabilities, primary_trade } = req.body;
  await q('INSERT INTO providers (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [req.user.id]);
  const p = await one(`
    UPDATE providers SET
      name = COALESCE($1, name), dispatch_phone = COALESCE($2, dispatch_phone),
      after_phone = COALESCE($3, after_phone), email = COALESCE($4, email),
      hours = COALESCE($5, hours), services = COALESCE($6, services),
      equipment = COALESCE($7, equipment), verification = COALESCE($8, verification),
      capabilities = COALESCE($9, capabilities), primary_trade = COALESCE($10, primary_trade)
    WHERE user_id=$11 RETURNING *`,
    [name, dispatch_phone, after_phone, email, hours,
     services ? JSON.stringify(services) : null,
     equipment ? JSON.stringify(equipment) : null,
     verification ? JSON.stringify(verification) : null,
     capabilities ? JSON.stringify(capabilities) : null, primary_trade ?? null, req.user.id]);
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
                          situation, can_move, description, photos, truck, trailer, licensed_only, tire_position, service_item, trade_filter)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [req.user.id, b.service_key, price.label, b.lat, b.lng,
     areaLabel(b.lat, b.lng) || b.area_label || 'Location shared by driver', b.landmark || '',
     JSON.stringify(b.situation || []), b.can_move || 'no', b.description || '',
     JSON.stringify(b.photos || []), JSON.stringify(truck), JSON.stringify(trailer), licensedOnly,
     tirePos ? JSON.stringify(tirePos) : null, String(b.service_item || '').slice(0, 80),
     JSON.stringify(Array.isArray(b.trade_filter) ? b.trade_filter.slice(0, 8) : [])]);
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
      AND (r.licensed_only = FALSE OR $1::boolean = TRUE)
      AND (jsonb_array_length(r.trade_filter) = 0 OR r.trade_filter ? $2)
    ORDER BY r.id DESC LIMIT 50`, [p?.license_verified || false, p?.primary_trade || '']);
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
    const mine = await one('SELECT id FROM purchases WHERE request_id=$1 AND provider_id=$2', [r.id, req.user.id]);
    out.push({
      id: r.id, service_key: r.service_key, service_label: r.service_label,
      area_label: r.area_label, band: distanceBand(best),
      created_at: r.created_at, situation: r.situation, can_move: r.can_move,
      truck_class: r.truck?.make ? `${r.truck.year || ''} ${r.truck.make} ${r.truck.model || ''}`.trim() : 'Class 8 tractor',
      trailer_type: r.trailer?.type || 'No trailer', loaded: true,
      hazmat: !!(r.trailer && r.trailer.hazmat),
      spec: buildSpec(r),
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

router.get('/leads/:id', auth.requireRole('provider'), async (req, res) => {
  const p = await providerOf(req);
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
    spec: buildSpec(r),
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
    const won = r.selected_provider === req.user.id;
    const locs = await q('SELECT lat, lng FROM provider_locations WHERE user_id=$1', [req.user.id]);
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

router.post('/leads/:id/buy', auth.requireRole('provider'), async (req, res) => {
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
    SELECT p.user_id, p.name, p.email, p.approved, p.license_verified, p.verification, p.created_at, p.primary_trade, u.phone,
      (SELECT COUNT(*)::int FROM provider_locations l WHERE l.user_id=p.user_id) AS location_count
    FROM providers p JOIN users u ON u.id=p.user_id
    ORDER BY p.approved ASC, p.created_at DESC LIMIT 100`);
  res.json(rows);
});
// Full provider dossier for the admin review page
router.get('/admin/providers/:id', auth.requireRole('admin'), async (req, res) => {
  const p = await one(`
    SELECT p.*, u.phone, u.email AS user_email, u.created_at AS signed_up
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
      (SELECT COUNT(*)::int FROM requests r WHERE r.driver_id=u.id) AS requests,
      (SELECT COUNT(*)::int FROM trucks t WHERE t.user_id=u.id) AS trucks,
      (SELECT COALESCE(SUM(pu.amount_cents),0)::int FROM purchases pu
        JOIN requests r ON r.id=pu.request_id WHERE r.driver_id=u.id AND pu.refunded=FALSE) AS revenue_cents
    FROM users u WHERE u.role='driver' ORDER BY u.id DESC LIMIT 100`);
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

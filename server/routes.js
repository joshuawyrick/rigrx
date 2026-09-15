// ============ All REST API routes ============
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { q, one, withTransaction } = require('./db');
const auth = require('./auth');
const { SIMULATED, cardSetup, saveCard } = require('./payments');
const marketplace = require('./marketplace');
const dispatch = require('./dispatch');
const { memberConflict } = require('./account-policy');
const { PRODUCTION, smsConfigured } = require('./config');
const {
  sms,
  enqueueSms,
  isOnline,
  wsPush,
  processNotificationOutbox,
  processNotificationIds,
  supersedeNotificationsTx
} = require('./notify');
const {
  matchProviders,
  queueProviderNotifications,
  deliverProviderNotifications,
  alertRecipients,
  haversineMiles,
  distanceBand
} = require('./match');
const { areaLabel, searchCities } = require('./geo');
const { getCatalog, getTrades, ensurePricing, slugify } = require('./catalog');
const EQUIP = require('./equipment');
// Same file the browser loads, so a message is judged identically on both sides.
const guard = require('../public/guard.js');

const router = express.Router();

// Text messages reach people in their own language. The English string is the
// default; pass the Spanish alongside and the recipient's saved language decides.
function inLang(user, en, esText) {
  return (user && user.lang === 'es' && esText) ? esText : en;
}
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
// Only photos and PDFs. Without this, any signed-in user could upload an .html
// file and have it served from this domain — a hosted phishing page with our name
// on it. Breakdown photos and insurance documents are all this endpoint is for.
const OK_UPLOADS = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/i;
const OK_EXT = /\.(jpe?g|png|webp|gif|heic|heif|pdf)$/i;
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (OK_UPLOADS.test(file.mimetype) && OK_EXT.test(file.originalname)) return cb(null, true);
    cb(Object.assign(new Error('Only photos (JPG, PNG, WebP, HEIC) and PDFs can be uploaded'), { status: 400 }));
  }
});
router.post('/upload', auth.requireAuth, upload.single('file'), (req, res) => {
  return q(`
    INSERT INTO uploads (file_name, owner_id, mime_type, original_name)
    VALUES ($1,$2,$3,$4)`,
    [req.file.filename, req.user.id, req.file.mimetype, String(req.file.originalname || '').slice(0, 240)])
    .then(() => res.json({ url: '/api/uploads/' + req.file.filename }))
    .catch(error => {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      throw error;
    });
});

function uploadFilename(value) {
  const match = String(value || '').match(/^\/(?:api\/)?uploads\/([a-f0-9]{16}\.(?:jpe?g|png|webp|gif|heic|heif|pdf))$/i);
  return match ? match[1] : null;
}

function containsUpload(value, urls) {
  if (typeof value === 'string') return urls.includes(value);
  if (Array.isArray(value)) return value.some(item => containsUpload(item, urls));
  if (value && typeof value === 'object') return Object.values(value).some(item => containsUpload(item, urls));
  return false;
}

async function assertOwnedUpload(userId, value, legacyValue = null, imagesOnly = false) {
  if (!value) return null;
  if (value === legacyValue && uploadFilename(value)) return value;
  const fileName = uploadFilename(value);
  if (!fileName) throw Object.assign(new Error('Use a file uploaded through RIGRX'), { status: 400 });
  const row = await one('SELECT * FROM uploads WHERE file_name=$1 AND owner_id=$2', [fileName, userId]);
  if (!row) throw Object.assign(new Error('That upload does not belong to this account'), { status: 403 });
  if (imagesOnly && !String(row.mime_type).startsWith('image/'))
    throw Object.assign(new Error('Breakdown photos must be images'), { status: 400 });
  return `/api/uploads/${fileName}`;
}

async function canReadUpload(user, fileName) {
  if (user.role === 'admin') return true;
  const uploadRow = await one('SELECT owner_id FROM uploads WHERE file_name=$1', [fileName]);
  if (uploadRow?.owner_id === user.id) return true;

  const urls = [`/api/uploads/${fileName}`, `/uploads/${fileName}`];
  const requests = await q(`
    SELECT id, driver_id, photos FROM requests
    WHERE photos ? $1 OR photos ? $2`, [urls[0], urls[1]]);
  for (const request of requests) {
    if (request.driver_id === user.id) return true;
    if (user.role === 'provider') {
      const purchase = await one(`
        SELECT id FROM purchases
        WHERE request_id=$1 AND provider_id=$2 AND refunded=FALSE AND status='succeeded'`,
        [request.id, companyIdOf(user)]);
      if (purchase) return true;
    }
  }

  if (user.role === 'provider') {
    const provider = await one('SELECT verification FROM providers WHERE user_id=$1', [companyIdOf(user)]);
    if (provider && containsUpload(provider.verification, urls)) return true;
  }
  return false;
}

router.get('/uploads/:filename', auth.requireAuth, async (req, res) => {
  const fileName = uploadFilename(`/uploads/${req.params.filename}`);
  if (!fileName) return res.status(404).json({ error: 'File not found' });
  if (!(await canReadUpload(req.user, fileName)))
    return res.status(403).json({ error: 'No access to this file' });
  const filePath = path.join(__dirname, '..', 'uploads', fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.set({
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox"
  });
  res.sendFile(filePath);
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
  let user = await auth.findOrCreateUser(phone, req.body.role);
  if (user.archived_at)
    return res.status(403).json({ error: 'This account has been closed. Contact RIGRX if you think that is a mistake.' });
  // Remember the language their phone was using, so texts arrive in it too.
  const lang = req.body.lang === 'es' ? 'es' : 'en';
  if (user.lang !== lang) user = await one('UPDATE users SET lang=$1 WHERE id=$2 RETURNING *', [lang, user.id]);
  const token = await auth.createSession(user.id);
  res.cookie('rigrx_session', token, {
    httpOnly: true,
    secure: PRODUCTION,
    sameSite: 'lax',
    maxAge: 30 * 24 * 3600 * 1000
  });
  res.json({ user: publicUser(user) });
});

router.put('/me/lang', auth.requireAuth, async (req, res) => {
  const lang = req.body.lang === 'es' ? 'es' : 'en';
  await q('UPDATE users SET lang=$1 WHERE id=$2', [lang, req.user.id]);
  res.json({ ok: true, lang });
});

router.post('/auth/logout', async (req, res) => {
  const token = req.cookies?.rigrx_session;
  if (token) await auth.endSession(token);
  res.clearCookie('rigrx_session', { httpOnly: true, secure: PRODUCTION, sameSite: 'lax' });
  res.json({ ok: true });
});

function publicUser(u) {
  return { id: u.id, phone: u.phone, role: u.role, name: u.name, email: u.email,
           driver_type: u.driver_type, company: u.company, lang: u.lang || '',
           company_id: u.company_id || null,
           member_role: u.member_role || (u.role === 'provider' ? 'owner' : ''),
           assignable: !!u.assignable,
           prefer_licensed_only: !!u.prefer_licensed_only,
           driver_rating: u.rating_count ? +(u.rating_sum / u.rating_count).toFixed(1) : null };
}

function providerForSelf(provider) {
  if (!provider) return null;
  const safe = { ...provider, has_payment_method: !!provider.stripe_pm };
  delete safe.admin_notes;
  delete safe.stripe_customer;
  delete safe.stripe_pm;
  return safe;
}

router.get('/me', async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const out = { user: publicUser(req.user), simulatedPayments: SIMULATED() };
  if (req.user.role === 'provider' || req.user.role === 'admin') {
    const cid = companyIdOf(req.user);
    out.provider = providerForSelf(await one('SELECT * FROM providers WHERE user_id=$1', [cid]));
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
  const companyId = companyIdOf(req.user);
  await q('INSERT INTO providers (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [companyId]);
  let safeVerification = null;
  if (verification) {
    const current = await one('SELECT verification FROM providers WHERE user_id=$1', [companyId]);
    const old = current?.verification || {};
    const patch = {};
    if (verification.license !== undefined)
      patch.license = String(verification.license || '').trim().slice(0, 120);
    if (verification.coi_file !== undefined)
      patch.coi_file = await assertOwnedUpload(companyId, verification.coi_file, old.coi_file);
    if (verification.w9_file !== undefined)
      patch.w9_file = await assertOwnedUpload(companyId, verification.w9_file, old.w9_file);
    if (Object.keys(patch).length) safeVerification = patch;
  }
  const p = await one(`
    UPDATE providers SET
      name = COALESCE($1, name), dispatch_phone = COALESCE($2, dispatch_phone),
      after_phone = COALESCE($3, after_phone), email = COALESCE($4, email),
      hours = COALESCE($5, hours), services = COALESCE($6, services),
      equipment = COALESCE($7, equipment),
      verification = CASE WHEN $8::jsonb IS NULL THEN verification
        ELSE COALESCE(verification, '{}'::jsonb) || $8::jsonb END,
      capabilities = COALESCE($9, capabilities), primary_trade = COALESCE($10, primary_trade),
      duty_classes = COALESCE($11, duty_classes)
    WHERE user_id=$12 RETURNING *`,
    [name, dispatch_phone, after_phone, email, hours,
     services ? JSON.stringify(services) : null,
     equipment ? JSON.stringify(equipment) : null,
     safeVerification ? JSON.stringify(safeVerification) : null,
     capabilities ? JSON.stringify(capabilities) : null, primary_trade ?? null,
     duty_classes ? JSON.stringify(duty_classes) : null, companyId]);
  if (name) await q('UPDATE users SET name=$1 WHERE id=$2', [name, companyId]);
  res.json(providerForSelf(p));
});

// Type-ahead city search against the offline nationwide database.
router.get('/geo/cities', auth.requireAuth, async (req, res) => {
  res.json(searchCities(req.query.q, 12));
});

router.post('/provider/locations', requireOwner, async (req, res) => {
  const { label, lat, lng, radius_mi = 50, phone = '' } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat/lng required' });
  const l = await one(
    'INSERT INTO provider_locations (user_id, label, lat, lng, radius_mi, phone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [companyIdOf(req.user), label || '', lat, lng, Math.min(5000, Math.max(5, Number(radius_mi) || 50)), phone]);
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

// The owner flips this on when someone answering their dispatch line speaks
// Spanish. Shown to drivers as a badge when comparing responders.
router.post('/provider/spanish-dispatch', requireOwner, async (req, res) => {
  const on = !!req.body.on;
  await q('UPDATE providers SET spanish_dispatch=$1 WHERE user_id=$2', [on, companyIdOf(req.user)]);
  res.json({ ok: true, spanish_dispatch: on });
});

router.get('/providers/:id/public', async (req, res) => {
  const p = await one(`
    SELECT p.user_id, p.name, p.hours, p.equipment, p.badges, p.jobs_won,
           p.rating_sum, p.rating_count, p.license_verified, p.services, p.capabilities, p.primary_trade, p.spanish_dispatch
    FROM providers p JOIN users owner ON owner.id=p.user_id
    WHERE p.user_id=$1 AND p.approved=TRUE AND owner.archived_at IS NULL`, [req.params.id]);
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
  const locationSource = b.location_source === 'manual' ? 'manual' : 'device';
  const locationCapturedAt = b.location_captured_at ? new Date(b.location_captured_at) : new Date();
  if (Number.isNaN(locationCapturedAt.getTime()))
    return res.status(400).json({ error: 'Location time is invalid. Capture it again or enter a town.' });
  if (locationSource === 'device'
      && (Date.now() - locationCapturedAt.getTime() > 15 * 60 * 1000
          || locationCapturedAt.getTime() > Date.now() + 5 * 60 * 1000))
    return res.status(400).json({ error: 'That GPS location is stale. Capture it again or enter your location by hand.' });
  const locationAccuracy = Number.isFinite(Number(b.location_accuracy_m))
    ? Math.max(0, Math.min(100000, Number(b.location_accuracy_m))) : null;
  if (locationSource === 'manual' && !String(b.landmark || '').trim())
    return res.status(400).json({ error: 'Add a landmark or mile marker when entering location by hand.' });
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
  const photoInputs = Array.isArray(b.photos) ? b.photos.slice(0, 8) : [];
  const photos = [];
  for (const photo of photoInputs)
    photos.push(await assertOwnedUpload(req.user.id, photo, null, true));

  const created = await withTransaction(async client => {
    const activeDriver = (await client.query(`
      SELECT id FROM users
      WHERE id=$1 AND role='driver' AND archived_at IS NULL
      FOR NO KEY UPDATE`, [req.user.id])).rows[0];
    if (!activeDriver)
      throw Object.assign(
        new Error('This driver account is no longer active'), { status: 409 });
    let request = (await client.query(`
      INSERT INTO requests (driver_id, service_key, service_label, lat, lng, area_label, landmark,
                            situation, can_move, description, photos, truck, trailer, licensed_only,
                            tire_position, service_item, trade_filter, duty_class, direction,
                            location_source, location_captured_at, location_accuracy_m)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      RETURNING *`,
      [req.user.id, b.service_key, price.label, b.lat, b.lng,
       areaLabel(b.lat, b.lng) || b.area_label || 'Location shared by driver', b.landmark || '',
       JSON.stringify(b.situation || []), b.can_move || 'no', b.description || '',
       JSON.stringify(photos), JSON.stringify(truck), JSON.stringify(trailer), licensedOnly,
       tirePos ? JSON.stringify(tirePos) : null, String(b.service_item || '').slice(0, 80),
       JSON.stringify(Array.isArray(b.trade_filter) ? b.trade_filter.slice(0, 8) : []),
       ['heavy','medium','light'].includes(truck.duty) ? truck.duty
         : (['heavy','medium','light'].includes(b.duty_class) ? b.duty_class : 'heavy'),
       String(b.direction || '').slice(0, 24), locationSource, locationCapturedAt, locationAccuracy])).rows[0];
    await client.query('UPDATE users SET prefer_licensed_only=$1 WHERE id=$2',
      [licensedOnly, req.user.id]);
    let matches = await matchProviders(request, 0, client);
    let expanded = false;
    if (!matches.length) {
      matches = await matchProviders(request, 50, client);
      expanded = true;
    }
    const prepared = await queueProviderNotifications(client, request, matches, price);
    request = (await client.query(`
      UPDATE requests SET notified_count=$1, last_notified_at=NOW()
      WHERE id=$2 RETURNING *`, [matches.length, request.id])).rows[0];
    if (!matches.length)
      await dispatch.openExceptionTx(client, request.id, 'zero_match', {
        area_label: request.area_label,
        filters: {
          licensed_only: request.licensed_only,
          trade_filter: request.trade_filter
        }
      });
    return { request, matches, expanded, prepared };
  });
  await deliverProviderNotifications(created.prepared);
  res.json({
    request: created.request,
    notified: created.matches.length,
    expanded: created.expanded
  });
});

router.get('/requests/mine', auth.requireAuth, async (req, res) => {
  const rows = await q(`
    SELECT r.*, (SELECT COUNT(*)::int FROM purchases pu
      WHERE pu.request_id=r.id AND pu.refunded=FALSE AND pu.status='succeeded') AS buyer_count
    FROM requests r WHERE r.driver_id=$1 ORDER BY r.id DESC LIMIT 30`, [req.user.id]);
  res.json(rows);
});

router.get('/requests/:id', auth.requireAuth, async (req, res) => {
  const r = await one('SELECT * FROM requests WHERE id=$1 AND driver_id=$2', [req.params.id, req.user.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const responders = await q(`
    SELECT pu.provider_id, pu.slot, pu.premium, pu.created_at,
           p.name, p.rating_sum, p.rating_count, p.jobs_won, p.badges, p.license_verified, p.primary_trade, p.spanish_dispatch,
           (SELECT m.quote FROM messages m
             WHERE m.request_id=pu.request_id AND m.provider_id=pu.provider_id AND m.quote IS NOT NULL
             ORDER BY m.id DESC LIMIT 1) AS quote
    FROM purchases pu JOIN providers p ON p.user_id = pu.provider_id
    WHERE pu.request_id=$1 AND pu.refunded=FALSE AND pu.status='succeeded' ORDER BY pu.slot`, [req.params.id]);
  // Once a tech is rolling, the driver should see who is coming and when — that is
  // the whole point of the job flow, and it is what they are actually anxious about.
  let onTheWay = null;
  let selectedCompany = null;
  if (r.selected_provider) {
    const company = await one(`
      SELECT name, dispatch_phone, after_phone
      FROM providers WHERE user_id=$1`, [r.selected_provider]);
    selectedCompany = company ? {
      name: company.name,
      phone: company.dispatch_phone || company.after_phone || ''
    } : null;
  }
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
    selected_company: selectedCompany,
    responders: responders.map(x => ({
      ...x, rating: x.rating_count ? +(x.rating_sum / x.rating_count).toFixed(1) : null
    }))
  });
});

router.post('/requests/:id/select', auth.requireAuth, async (req, res) => {
  const providerId = Number(req.body.provider_id);
  if (!providerId) return res.status(400).json({ error: 'Choose a service company' });
  const r = await marketplace.selectProvider({
    requestId: Number(req.params.id),
    driverId: req.user.id,
    providerId
  });
  const buyers = await q(`
    SELECT pu.provider_id
    FROM purchases pu JOIN users u ON u.id=pu.provider_id
    WHERE pu.request_id=$1 AND pu.refunded=FALSE AND pu.status='succeeded'`, [r.id]);
  await processNotificationIds(r.notificationIds);
  for (const recipientId of r.winnerRecipients || [])
    wsPush(recipientId, 'selected', { request_id: r.id, won: true });
  for (const b of buyers) {
    if (b.provider_id !== providerId)
      wsPush(b.provider_id, 'selected', { request_id: r.id, won: false });
  }
  res.json({ ok: true });
});

router.post('/requests/:id/complete', auth.requireAuth, async (req, res) => {
  const result = await dispatch.completeByDriver({
    requestId: Number(req.params.id),
    driverId: req.user.id
  });
  if (!result.replayed) {
    await processNotificationIds(result.notificationIds);
    for (const recipientId of result.recipientIds)
      wsPush(recipientId, 'job_status', {
        request_id: result.request.id,
        state: 'completed'
      });
  }
  res.json({ ok: true, replayed: result.replayed });
});

// Safety valve: a driver who chose "licensed only" and got no responders
// can open the same request to every approved company without re-typing it.
router.post('/requests/:id/open-to-all', auth.requireAuth, async (req, res) => {
  const result = await withTransaction(async client => {
    const driver = (await client.query(`
      SELECT id FROM users
      WHERE id=$1 AND role='driver' AND archived_at IS NULL
      FOR NO KEY UPDATE`, [req.user.id])).rows[0];
    if (!driver)
      throw Object.assign(
        new Error('This driver account is no longer active'), { status: 409 });
    let r = (await client.query(`
      UPDATE requests SET licensed_only=FALSE, trade_filter='[]',
        rescue_attempts=rescue_attempts+1, last_notified_at=NOW(), silent_alerted=FALSE
      WHERE id=$1 AND driver_id=$2 AND status='open'
      RETURNING *`, [req.params.id, req.user.id])).rows[0];
    if (!r) return null;
    const price = (await client.query(
      'SELECT * FROM pricing WHERE service_key=$1', [r.service_key])).rows[0];
    const already = (await client.query(`
      SELECT provider_id FROM purchases
      WHERE request_id=$1 AND refunded=FALSE AND status='succeeded'`, [r.id]))
      .rows.map(row => row.provider_id);
    let matches = (await matchProviders(r, 0, client))
      .filter(match => !already.includes(match.user_id));
    if (!matches.length)
      matches = (await matchProviders(r, 50, client))
        .filter(match => !already.includes(match.user_id));
    if (!matches.length)
      matches = (await matchProviders(r, 50, client, { anyService: true }))
        .filter(match => !already.includes(match.user_id));
    const prepared = await queueProviderNotifications(client, r, matches, price, {
      eventSuffix: `open-to-all-${r.rescue_attempts}`
    });
    r = (await client.query(`
      UPDATE requests SET notified_count=notified_count+$1,
        last_notified_at=NOW(), silent_alerted=FALSE
      WHERE id=$2 RETURNING *`, [matches.length, r.id])).rows[0];
    if (matches.length)
      await dispatch.resolveExceptionTx(client, r.id, ['zero_match'],
        'Request widened and providers were found');
    await client.query('UPDATE users SET prefer_licensed_only=FALSE WHERE id=$1',
      [req.user.id]);
    return { r, matches, prepared };
  });
  if (!result) return res.status(400).json({ error: 'Nothing to widen' });
  await deliverProviderNotifications(result.prepared);
  res.json({ ok: true, notified: result.matches.length });
});

// Re-run matching with a wider safety radius. This is available even when the
// original request had no filters, so a zero-match driver is never left at a dead end.
router.post('/requests/:id/retry', auth.requireAuth, async (req, res) => {
  const result = await withTransaction(async client => {
    let r = (await client.query(`
      UPDATE requests SET rescue_attempts=rescue_attempts+1,
        last_notified_at=NOW(), rescue_requested_at=NOW(), rescue_reason='retry'
      WHERE id=$1 AND driver_id=$2 AND status='open'
        AND (last_notified_at IS NULL OR last_notified_at < NOW() - INTERVAL '2 minutes')
      RETURNING *`, [req.params.id, req.user.id])).rows[0];
    if (!r) return null;
    const price = (await client.query(
      'SELECT * FROM pricing WHERE service_key=$1', [r.service_key])).rows[0];
    let matches = await matchProviders(r, 150, client);
    // Last resort: a driver would rather hear from a wrecker that "doesn't do
    // tires" than from nobody at all.
    if (!matches.length) matches = await matchProviders(r, 150, client, { anyService: true });
    const prepared = await queueProviderNotifications(client, r, matches, price, {
      eventSuffix: `retry-${r.rescue_attempts}`
    });
    r = (await client.query(`
      UPDATE requests SET notified_count=notified_count+$1, silent_alerted=FALSE
      WHERE id=$2 RETURNING *`, [matches.length, r.id])).rows[0];
    if (matches.length)
      await dispatch.resolveExceptionTx(client, r.id, ['zero_match'],
        'Wider search found providers to alert');
    else
      await dispatch.openExceptionTx(client, r.id, 'zero_match', {
        area_label: r.area_label,
        retry: true,
        radius_extra_miles: 150
      });
    return { r, matches, prepared };
  });
  if (!result)
    return res.status(429).json({ error: 'Wait two minutes before alerting companies again' });
  await deliverProviderNotifications(result.prepared);
  res.json({ ok: true, notified: result.matches.length });
});

// A selected company that has not started moving can be nudged and surfaced to
// operations. This is safe to repeat; the exception is de-duplicated.
router.post('/requests/:id/rescue', auth.requireAuth, async (req, res) => {
  const result = await withTransaction(async client => {
    const changed = await client.query(`
      UPDATE requests SET rescue_requested_at=NOW(), rescue_reason='stalled'
      WHERE id=$1 AND driver_id=$2 AND status='selected'
        AND job_state IN ('unassigned','assigned','accepted')
      RETURNING *`, [req.params.id, req.user.id]);
    const r = changed.rows[0];
    if (!r) return null;
    await client.query(`
      INSERT INTO dispatch_exceptions
        (request_id,type,provider_id,tech_id,status,detail)
      VALUES ($1,'stalled',$2,$3,'open',$4)
      ON CONFLICT (request_id,type) WHERE status IN ('open','acknowledged')
      DO UPDATE SET status='open', provider_id=EXCLUDED.provider_id,
        tech_id=EXCLUDED.tech_id, detail=EXCLUDED.detail,
        occurrence=dispatch_exceptions.occurrence+1, updated_at=NOW()`,
      [r.id, r.selected_provider, r.assigned_tech,
       JSON.stringify({ requested_by_driver: true, job_state: r.job_state })]);
    let people = (await client.query(`
      SELECT id, phone FROM users WHERE company_id=$1 AND archived_at IS NULL
        AND member_role IN ('owner','dispatcher')`, [r.selected_provider])).rows;
    if (!people.length)
      people = (await client.query(`
        SELECT id, phone FROM users WHERE id=$1 AND archived_at IS NULL`, [r.selected_provider])).rows;
    const notificationIds = [];
    for (const person of people) {
      const notification = await enqueueSms(person.id, person.phone,
        `RIGRX URGENT: The driver on Job #${r.id} says nobody is moving. Update the job or reassign it now.`, {
          client,
          requestId: r.id,
          eventType: 'driver_rescue',
          dedupeKey: `request:${r.id}:driver-rescue:${Math.floor(Date.now() / 300000)}:person:${person.id}`,
          payload: {
            assignment_version: r.assignment_version,
            provider_id: r.selected_provider
          }
        });
      if (notification) notificationIds.push(notification.id);
    }
    return { request: r, people, notificationIds };
  });
  if (!result) return res.status(409).json({ error: 'This job is already moving or no longer active' });
  await processNotificationIds(result.notificationIds);
  for (const person of result.people)
    wsPush(person.id, 'job_rescue', { request_id: result.request.id });
  res.json({ ok: true });
});

// Before anyone is en route, a stranded driver can put a stalled selection back
// into the responder pool and choose another company.
router.post('/requests/:id/reopen', auth.requireAuth, async (req, res) => {
  const result = await withTransaction(async client => {
    const locked = await client.query(`
      SELECT * FROM requests WHERE id=$1 AND driver_id=$2 FOR UPDATE`,
      [req.params.id, req.user.id]);
    const r = locked.rows[0];
    if (!r || r.status !== 'selected'
        || !['unassigned','assigned','accepted'].includes(r.job_state)) return null;
    await supersedeNotificationsTx(client, r.id, [
      'provider_selected',
      'job_assigned',
      'job_enroute',
      'job_late',
      'job_arrived'
    ]);
    const updated = await client.query(`
      UPDATE requests SET status='open', selected_provider=NULL, selected_at=NULL,
        job_state='none', assigned_tech=NULL, assigned_at=NULL, accepted_at=NULL,
        assignment_version=assignment_version+1, job_activity_at=NOW(),
        rescue_requested_at=NULL, rescue_reason='', stall_alerted=FALSE,
        silent_alerted=FALSE, last_notified_at=NOW(),
        reopen_generation=reopen_generation+1
      WHERE id=$1 RETURNING *`, [r.id]);
    await client.query(`
      INSERT INTO job_events
        (request_id,event_type,from_state,to_state,actor_id,assignment_version,detail)
      VALUES ($1,'driver_reopened',$2,'open',$3,$4,$5)`,
      [r.id, r.job_state, req.user.id, updated.rows[0].assignment_version,
       JSON.stringify({ previous_provider_id: r.selected_provider, previous_tech_id: r.assigned_tech })]);
    await client.query(`
      UPDATE dispatch_exceptions SET status='resolved', resolved_at=NOW(),
        updated_at=NOW(), resolution='Driver reopened the request'
      WHERE request_id=$1 AND type=ANY($2::text[])
        AND status IN ('open','acknowledged')`,
      [r.id, ['stalled', 'assignment_bounced']]);
    let people = (await client.query(`
      SELECT id, phone FROM users WHERE company_id=$1 AND archived_at IS NULL
        AND member_role IN ('owner','dispatcher')`, [r.selected_provider])).rows;
    if (!people.length)
      people = (await client.query(`
        SELECT id, phone FROM users WHERE id=$1 AND archived_at IS NULL`, [r.selected_provider])).rows;
    const notificationIds = [];
    for (const person of people) {
      const notification = await enqueueSms(person.id, person.phone,
        `RIGRX: The driver reopened Request #${r.id} to choose another responder.`, {
          client,
          requestId: r.id,
          eventType: 'job_reopened',
          dedupeKey: `request:${r.id}:reopened:g${updated.rows[0].reopen_generation}:person:${person.id}`,
          payload: { reopen_generation: updated.rows[0].reopen_generation }
        });
      if (notification) notificationIds.push(notification.id);
    }
    if (r.assigned_tech) {
      const tech = (await client.query('SELECT id, phone FROM users WHERE id=$1', [r.assigned_tech])).rows[0];
      if (tech) {
        const notification = await enqueueSms(tech.id, tech.phone,
          `RIGRX: Job #${r.id} was reopened by the driver and is no longer assigned to you.`, {
            client,
            requestId: r.id,
            eventType: 'job_unassigned',
            dedupeKey: `request:${r.id}:reopened:g${updated.rows[0].reopen_generation}:tech:${tech.id}`,
            payload: {
              assignment_version: updated.rows[0].assignment_version,
              reopen_generation: updated.rows[0].reopen_generation
            }
          });
        if (notification) notificationIds.push(notification.id);
      }
    }
    return { before: r, request: updated.rows[0], people, notificationIds };
  });
  if (!result) return res.status(409).json({ error: 'This job is already moving or cannot be reopened' });
  await processNotificationIds(result.notificationIds);
  for (const person of result.people)
    wsPush(person.id, 'job_reopened', { request_id: result.before.id });
  if (result.before.assigned_tech) {
    wsPush(result.before.assigned_tech, 'job_unassigned', { request_id: result.before.id });
  }
  res.json({ ok: true });
});

router.post('/requests/:id/cancel', auth.requireAuth, async (req, res) => {
  const result = await withTransaction(async client => {
    const locked = await client.query(`
      SELECT * FROM requests WHERE id=$1 AND driver_id=$2 FOR UPDATE`,
      [req.params.id, req.user.id]);
    const before = locked.rows[0];
    if (!before || !(before.status === 'open'
        || (before.status === 'selected' && ['unassigned','assigned','accepted'].includes(before.job_state))))
      return null;
    await supersedeNotificationsTx(client, before.id, [
      'new_lead',
      'provider_selected',
      'job_assigned',
      'job_enroute',
      'job_late',
      'job_arrived'
    ]);
    const changed = await client.query(`
      UPDATE requests SET status='cancelled', job_state='none',
        assigned_tech=NULL, assignment_version=assignment_version+1, job_activity_at=NOW()
      WHERE id=$1 RETURNING *`, [before.id]);
    await client.query(`
      INSERT INTO job_events
        (request_id,event_type,from_state,to_state,actor_id,assignment_version,detail)
      VALUES ($1,'driver_cancelled',$2,'cancelled',$3,$4,$5)`,
      [before.id, before.job_state || before.status, req.user.id,
       changed.rows[0].assignment_version,
       JSON.stringify({ previous_provider_id: before.selected_provider, previous_tech_id: before.assigned_tech })]);
    await client.query(`
      UPDATE dispatch_exceptions SET status='resolved', resolved_at=NOW(),
        updated_at=NOW(), resolution='Driver cancelled the request'
      WHERE request_id=$1 AND type=ANY($2::text[])
        AND status IN ('open','acknowledged')`,
      [before.id, ['zero_match', 'no_response', 'stalled', 'assignment_bounced']]);
    let people = [];
    const notificationIds = [];
    if (before.selected_provider) {
      people = (await client.query(`
        SELECT id, phone FROM users WHERE company_id=$1 AND archived_at IS NULL
          AND member_role IN ('owner','dispatcher')`, [before.selected_provider])).rows;
      if (!people.length)
        people = (await client.query(`
          SELECT id, phone FROM users WHERE id=$1 AND archived_at IS NULL`, [before.selected_provider])).rows;
      for (const person of people) {
        const notification = await enqueueSms(person.id, person.phone,
          `RIGRX: The driver cancelled Job #${before.id}.`, {
            client,
            requestId: before.id,
            eventType: 'job_cancelled',
            dedupeKey: `request:${before.id}:cancelled:${person.id}`
          });
        if (notification) notificationIds.push(notification.id);
      }
    }
    if (before.assigned_tech) {
      const tech = (await client.query('SELECT id, phone FROM users WHERE id=$1', [before.assigned_tech])).rows[0];
      if (tech) {
        const notification = await enqueueSms(tech.id, tech.phone,
          `RIGRX: The driver cancelled Job #${before.id}. Stop work and contact dispatch if needed.`, {
            client,
            requestId: before.id,
            eventType: 'job_cancelled_technician',
            dedupeKey: `request:${before.id}:cancelled:tech:${tech.id}`
          });
        if (notification) notificationIds.push(notification.id);
      }
    }
    return { before, request: changed.rows[0], people, notificationIds };
  });
  if (!result) return res.status(409).json({ error: 'A job already on the way cannot be cancelled here' });
  const r = result.request;
  await processNotificationIds(result.notificationIds);
  for (const person of result.people)
    wsPush(person.id, 'job_cancelled', { request_id: r.id });
  if (result.before.assigned_tech) {
    wsPush(result.before.assigned_tech, 'job_cancelled', { request_id: r.id });
  }
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
  return await one(`
    SELECT p.* FROM providers p JOIN users owner ON owner.id=p.user_id
    WHERE p.user_id=$1 AND owner.archived_at IS NULL`, [companyIdOf(req.user)]);
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
function requireTechnician(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  // Not only formal techs: an owner or dispatcher who assigned a job to
  // themselves works it with the same buttons. dispatch.js still verifies the
  // job is actually assigned to this exact person.
  if (req.user.role !== 'provider'
      || !['tech', 'owner', 'dispatcher'].includes(req.user.member_role)
      || req.user.assignable === false)
    return res.status(403).json({ error: 'An active, assignable team account is required' });
  next();
}
async function slotInfo(requestId) {
  const rows = await q(`
    SELECT slot, premium FROM purchases
    WHERE request_id=$1 AND refunded=FALSE AND status IN ('pending','succeeded') ORDER BY slot`, [requestId]);
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
      u.rating_sum AS d_rsum, u.rating_count AS d_rcount,
      le.distance_mi AS alerted_distance_mi
    FROM requests r
    JOIN pricing pr ON pr.service_key = r.service_key
    JOIN users u ON u.id = r.driver_id
    LEFT JOIN lead_eligibility le
      ON le.request_id=r.id AND le.provider_id=$4
    WHERE r.status='open' AND r.created_at > NOW() - INTERVAL '6 hours'
      AND u.archived_at IS NULL
      AND (r.licensed_only = FALSE OR $1::boolean = TRUE)
      AND (jsonb_array_length(r.trade_filter) = 0 OR r.trade_filter ? $2)
      AND ($3::jsonb ? r.duty_class)
    ORDER BY r.id DESC LIMIT 50`,
    [p?.license_verified || false, p?.primary_trade || '',
     JSON.stringify(p?.duty_classes || ['heavy','medium','light']),
     companyIdOf(req.user)]);
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
    if (best === null && r.alerted_distance_mi !== null)
      best = Number(r.alerted_distance_mi);
    if (best === null) continue;
    const slots = await slotInfo(r.id);
    if (slots.soldOut) continue;
    const mine = await one(`
      SELECT id FROM purchases
      WHERE request_id=$1 AND provider_id=$2 AND refunded=FALSE AND status='succeeded'`,
      [r.id, companyIdOf(req.user)]);
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
  const mine = await one(`
    SELECT * FROM purchases
    WHERE request_id=$1 AND provider_id=$2 AND refunded=FALSE AND status='succeeded'`,
    [r.id, companyIdOf(req.user)]);
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
    my_credits: p?.lead_credits || 0,
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
      landmark: won ? r.landmark : null,
      location_source: won ? r.location_source : null,
      location_captured_at: won ? r.location_captured_at : null,
      location_accuracy_m: won ? r.location_accuracy_m : null
    };
  }
  res.json(base);
});

router.post('/leads/:id/buy', requireDispatch, async (req, res) => {
  const result = await marketplace.purchaseLead({
    requestId: Number(req.params.id),
    providerId: companyIdOf(req.user)
  });
  const purchase = result.purchase;
  const p = result.provider;
  const r = result.request;

  await processNotificationIds(result.notificationIds || []);
  if (result.justCompleted) {
    wsPush(result.responder.driverId, 'responder', {
      request_id: r.id,
      provider_id: companyIdOf(req.user),
      name: p.name,
      slot: purchase.slot
    });
  }

  res.json({
    ok: true,
    replayed: !!result.replayed,
    slot: purchase.slot,
    premium: purchase.premium,
    amount_cents: purchase.amount_cents,
    paid_with: purchase.paid_with,
    credits_left: result.creditsLeft,
    simulated: purchase.stripe_payment === 'simulated'
  });
});

router.get('/myleads', requireDispatch, async (req, res) => {
  const rows = await q(`
    SELECT pu.id, pu.request_id, pu.provider_id, pu.slot, pu.amount_cents, pu.premium,
      pu.paid_with, pu.list_price_cents, pu.refunded, pu.created_at,
      r.service_label, r.area_label, r.status AS request_status, r.selected_provider, r.created_at AS requested_at
    FROM purchases pu JOIN requests r ON r.id = pu.request_id
    WHERE pu.provider_id=$1 AND pu.status='succeeded' ORDER BY pu.id DESC LIMIT 50`, [companyIdOf(req.user)]);
  res.json(rows.map(x => ({ ...x, won: x.selected_provider === companyIdOf(req.user) })));
});

router.get('/provider/stats', requireDispatch, async (req, res) => {
  const p = await providerOf(req);
  const bought = await one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::int AS spend
    FROM purchases WHERE provider_id=$1 AND refunded=FALSE AND status='succeeded'`, [companyIdOf(req.user)]);
  const won = await one(`SELECT COUNT(*)::int AS n FROM requests WHERE selected_provider=$1 AND status IN ('selected','completed')`, [companyIdOf(req.user)]);
  const week = await q(`
    SELECT to_char(created_at, 'Dy') AS day, COUNT(*)::int AS n
    FROM purchases WHERE provider_id=$1 AND status='succeeded' AND refunded=FALSE
      AND created_at > NOW() - INTERVAL '7 days'
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
    WHERE pu.provider_id = $1 AND pu.refunded = FALSE AND pu.status='succeeded' AND m.first_at IS NOT NULL
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
  r.completed_at, r.eta_minutes, r.eta_set_at, r.assign_bounced, r.assignment_bounces,
  r.assignment_version, r.job_state, r.bounced_at, r.decline_reason, r.rescue_requested_at,
  r.location_source, r.location_captured_at, r.location_accuracy_m, r.created_at`;

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
    SELECT ${JOB_COLS}, r.driver_id, u.name AS driver_name, u.phone AS driver_phone,
           t.name AS tech_name, t.phone AS tech_phone,
           dr.stars AS my_driver_rating
    FROM requests r
    JOIN users u ON u.id = r.driver_id
    LEFT JOIN users t ON t.id = r.assigned_tech
    LEFT JOIN driver_ratings dr ON dr.request_id = r.id AND dr.provider_id = $1
    WHERE r.selected_provider = $1 AND r.status IN ('selected','completed')
    ORDER BY (r.completed_at IS NOT NULL), r.id DESC LIMIT 60`, [cid]);
  const techs = await q(`SELECT id, name, phone, member_role, member_location_id FROM users
    WHERE company_id=$1 AND member_role IN ('tech','owner','dispatcher') AND assignable=TRUE
      AND archived_at IS NULL ORDER BY name`, [cid]);
  res.json({ jobs: rows, techs });
});

// The other half of the trust loop: every lead advertises the driver's rating
// "as rated by providers" — this is where that rating actually comes from.
router.post('/jobs/:id/rate-driver', requireDispatch, async (req, res) => {
  const cid = companyIdOf(req.user);
  const r = await one(`SELECT * FROM requests WHERE id=$1 AND selected_provider=$2`, [req.params.id, cid]);
  if (!r) return res.status(404).json({ error: 'Not one of your jobs' });
  if (!r.completed_at && r.status !== 'completed')
    return res.status(400).json({ error: 'Rate the driver after the job is done' });
  const stars = Math.max(1, Math.min(5, Number(req.body.stars) || 0));
  try {
    await q(`INSERT INTO driver_ratings (request_id, provider_id, driver_id, stars) VALUES ($1,$2,$3,$4)`,
      [r.id, cid, r.driver_id, stars]);
  } catch (e) {
    return res.status(409).json({ error: 'You already rated this driver' });
  }
  await q(`UPDATE users SET rating_sum = rating_sum + $1, rating_count = rating_count + 1 WHERE id=$2`,
    [stars, r.driver_id]);
  res.json({ ok: true, stars });
});

router.post('/jobs/:id/assign', requireDispatch, async (req, res) => {
  const result = await dispatch.assignJob({
    requestId: Number(req.params.id),
    companyId: companyIdOf(req.user),
    actorId: req.user.id,
    techId: Number(req.body.tech_id),
    expectedAssignmentVersion: req.body.assignment_version,
    commandKey: req.body.command_key
  });
  const r = result.request;
  if (!result.replayed) {
    if (result.previousTechId && result.previousTechId !== result.tech.id) {
      wsPush(result.previousTechId, 'job_unassigned', { request_id: r.id });
    }
    await processNotificationIds(result.notificationIds);
    wsPush(result.tech.id, 'job_assigned', {
      request_id: r.id,
      service: r.service_label,
      assignment_version: r.assignment_version
    });
  }
  res.json({ ok: true, replayed: result.replayed, self_accepted: !!result.selfAssigned,
             assignment_version: r.assignment_version });
});

router.post('/jobs/:id/accept', requireTechnician, async (req, res) => {
  const result = await dispatch.techAction({
    requestId: Number(req.params.id),
    techId: req.user.id,
    assignmentVersion: req.body.assignment_version,
    action: 'accept'
  });
  if (!result.replayed) {
    const people = await alertRecipients(result.request.selected_provider, null);
    for (const person of people)
      wsPush(person.id, 'job_status', { request_id: result.request.id, state: 'accepted' });
  }
  res.json({ ok: true, replayed: result.replayed });
});

// Declining hands it straight back rather than leaving a driver waiting on nobody.
router.post('/jobs/:id/decline', requireTechnician, async (req, res) => {
  const result = await dispatch.techAction({
    requestId: Number(req.params.id),
    techId: req.user.id,
    assignmentVersion: req.body.assignment_version,
    action: 'decline',
    reason: req.body.reason
  });
  const r = result.request;
  await processNotificationIds(result.notificationIds);
  const recipients = await alertRecipients(r.selected_provider, null);
  for (const person of recipients)
    wsPush(person.id, 'job_bounced', { request_id: r.id });
  wsPush(r.driver_id, 'job_status', { request_id: r.id, state: 'unassigned' });
  res.json({ ok: true });
});

router.post('/jobs/:id/enroute', requireTechnician, async (req, res) => {
  const eta = Math.max(1, Math.min(600, Number(req.body.eta_minutes) || 30));
  const result = await dispatch.techAction({
    requestId: Number(req.params.id),
    techId: req.user.id,
    assignmentVersion: req.body.assignment_version,
    action: 'enroute',
    etaMinutes: eta
  });
  const r = result.request;
  await processNotificationIds(result.notificationIds);
  wsPush(r.driver_id, 'job_status', { request_id: r.id, state: 'enroute', eta_minutes: eta });
  res.json({ ok: true, replayed: result.replayed });
});

// A delay the driver is told about is a very different experience to one they aren't.
router.post('/jobs/:id/late', requireTechnician, async (req, res) => {
  const eta = Math.max(1, Math.min(600, Number(req.body.eta_minutes) || 15));
  const result = await dispatch.techAction({
    requestId: Number(req.params.id),
    techId: req.user.id,
    assignmentVersion: req.body.assignment_version,
    action: 'late',
    etaMinutes: eta,
    actionKey: req.body.action_key
  });
  const r = result.request;
  await processNotificationIds(result.notificationIds);
  wsPush(r.driver_id, 'job_status', { request_id: r.id, state: 'late', eta_minutes: eta });
  res.json({ ok: true, replayed: result.replayed });
});

router.post('/jobs/:id/arrived', requireTechnician, async (req, res) => {
  const result = await dispatch.techAction({
    requestId: Number(req.params.id),
    techId: req.user.id,
    assignmentVersion: req.body.assignment_version,
    action: 'arrived'
  });
  const r = result.request;
  await processNotificationIds(result.notificationIds);
  wsPush(r.driver_id, 'job_status', { request_id: r.id, state: 'arrived' });
  res.json({ ok: true, replayed: result.replayed });
});

router.post('/jobs/:id/complete', requireTechnician, async (req, res) => {
  const result = await dispatch.techAction({
    requestId: Number(req.params.id),
    techId: req.user.id,
    assignmentVersion: req.body.assignment_version,
    action: 'complete'
  });
  const r = result.request;
  await processNotificationIds(result.notificationIds);
  if (!result.replayed)
    wsPush(r.driver_id, 'job_status', { request_id: r.id, state: 'completed' });
  res.json({ ok: true, replayed: result.replayed });
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

async function notifyDispatch(r, body, suffix = 'bounce') {
  const people = await alertRecipients(r.selected_provider, null);
  for (const person of people) {
    await sms(person.id, person.phone, `RIGRX: ${body}`, {
      requestId: r.id,
      eventType: 'dispatch_attention',
      dedupeKey: `request:${r.id}:dispatch:${suffix}:person:${person.id}`
    });
    wsPush(person.id, 'job_bounced', { request_id: r.id });
  }
}

// Nothing sits silently while a driver waits on a shoulder: an assignment nobody
// accepted inside five minutes goes back to the queue and the dispatcher is told.
async function sweepUnacceptedJobs() {
  const stale = await dispatch.bounceUnacceptedJobs();
  for (const r of stale) {
    await processNotificationIds(r.notificationIds);
    const recipients = await alertRecipients(r.selected_provider, null);
    for (const person of recipients)
      wsPush(person.id, 'job_bounced', { request_id: r.id });
    wsPush(r.driver_id, 'job_status', { request_id: r.id, state: 'unassigned' });
    if (r.previous_tech_id)
      wsPush(r.previous_tech_id, 'job_unassigned', { request_id: r.id });
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

  const locId = Number(req.body.member_location_id) || null;
  const assignable = role === 'tech' && req.body.assignable !== false;
  // The invite text is this person's first contact with RIGRX — before any phone
  // detection can happen — so the owner says what language they speak.
  const mlang = req.body.lang === 'es' ? 'es' : 'en';
  const outcome = await withTransaction(async client => {
    const company = (await client.query(`
      SELECT p.user_id FROM providers p JOIN users owner ON owner.id=p.user_id
      WHERE p.user_id=$1 AND owner.archived_at IS NULL FOR NO KEY UPDATE OF owner`, [cid])).rows[0];
    if (!company) throw Object.assign(new Error('This company account is not active'), { status: 403 });
    if (locId) {
      const location = (await client.query(
        'SELECT id FROM provider_locations WHERE id=$1 AND user_id=$2', [locId, cid])).rows[0];
      if (!location) throw Object.assign(new Error('Choose a location owned by this company'), { status: 400 });
    }
    const existing = (await client.query(
      'SELECT * FROM users WHERE phone=$1 FOR NO KEY UPDATE', [phone])).rows[0] || null;
    const conflict = memberConflict(existing, cid);
    if (conflict) throw Object.assign(new Error(conflict), { status: 409 });
    if (existing) {
      if (existing.member_role === 'tech' && (!assignable || role !== 'tech'))
        return { user: existing, deactivate: true };
      const user = (await client.query(`
        UPDATE users SET name=$1, member_role=$2, assignable=$3, member_location_id=$4,
          lang=$5, archived_at=NULL, archive_reason='', archived_by_company=FALSE
        WHERE id=$6 RETURNING *`,
        [name, role, assignable, locId, mlang, existing.id])).rows[0];
      return { user, deactivate: false };
    }
    const user = (await client.query(`
      INSERT INTO users (phone, role, name, company_id, member_role, assignable, member_location_id, lang)
      VALUES ($1,'provider',$2,$3,$4,$5,$6,$7) RETURNING *`,
      [phone, name, cid, role, assignable, locId, mlang])).rows[0];
    return { user, deactivate: false };
  });
  let u = outcome.user;
  let returned = [];
  if (outcome.deactivate) {
    returned = await dispatch.unassignTechnician({
      techId: u.id,
      actorId: req.user.id,
      companyId: cid,
      userChanges: {
        name,
        lang: mlang,
        memberRole: role,
        assignable: false,
        memberLocationId: locId,
        restore: true
      }
    });
    u = await one('SELECT * FROM users WHERE id=$1', [u.id]);
    for (const job of returned) {
      await processNotificationIds(job.notificationIds);
      const recipients = await alertRecipients(job.selected_provider, null);
      for (const person of recipients)
        wsPush(person.id, 'job_bounced', { request_id: job.id });
      wsPush(job.driver_id, 'job_status', { request_id: job.id, state: 'unassigned' });
      wsPush(outcome.user.id, 'job_unassigned', { request_id: job.id });
    }
  }

  const company = await one('SELECT name FROM providers WHERE user_id=$1', [cid]);
  await sms(u.id, u.phone, mlang === 'es'
    ? `RIGRX: ${company?.name || 'Su compañía'} lo agregó como ${role === 'tech' ? 'técnico' : 'despachador'}. ` +
      `Inicie sesión con este número — sin contraseña. ${process.env.BASE_URL || ''}`
    : `RIGRX: ${company?.name || 'Your company'} added you as ${role === 'tech' ? 'a technician' : 'a dispatcher'}. ` +
      `Sign in with this number — no password needed. ${process.env.BASE_URL || ''}`);
  res.json({
    ok: true,
    member: { id: u.id, name: u.name, phone: u.phone, member_role: u.member_role },
    sms_simulated: !smsConfigured(),
    unassigned_jobs: returned.length
  });
});

router.put('/provider/members/:id', requireOwner, async (req, res) => {
  const cid = companyIdOf(req.user);
  const m = await one('SELECT * FROM users WHERE id=$1 AND company_id=$2', [req.params.id, cid]);
  if (!m) return res.status(404).json({ error: 'Not on your team' });
  if (m.member_role === 'owner') return res.status(400).json({ error: 'The owner cannot be changed here' });
  const role = MEMBER_ROLES.includes(req.body.member_role) && req.body.member_role !== 'owner'
    ? req.body.member_role : m.member_role;
  const assignable = role === 'tech' && req.body.assignable !== false;
  const memberLocationId = req.body.member_location_id === null
    ? null : (Number(req.body.member_location_id) || null);
  let returned = [];
  if (assignable) {
    await withTransaction(async client => {
      const company = (await client.query(`
        SELECT id FROM users
        WHERE id=$1 AND archived_at IS NULL FOR NO KEY UPDATE`, [cid])).rows[0];
      if (!company) throw Object.assign(
        new Error('This company account is no longer active'), { status: 409 });
      await client.query(`
        UPDATE users SET member_role=$1, assignable=TRUE, member_location_id=$2
        WHERE id=$3 AND company_id=$4`,
        [role, memberLocationId, m.id, cid]);
    });
  } else {
    returned = await dispatch.unassignTechnician({
      techId: m.id,
      actorId: req.user.id,
      companyId: cid,
      userChanges: {
        memberRole: role,
        assignable: false,
        memberLocationId
      }
    });
  }
  for (const job of returned) {
    await processNotificationIds(job.notificationIds);
    const recipients = await alertRecipients(job.selected_provider, null);
    for (const person of recipients)
      wsPush(person.id, 'job_bounced', { request_id: job.id });
    wsPush(job.driver_id, 'job_status', { request_id: job.id, state: 'unassigned' });
  }
  res.json({ ok: true, unassigned_jobs: returned.length });
});

// Removing someone unhooks them from the company rather than deleting the person, so
// any job they worked keeps its record. Their login stops working immediately.
router.delete('/provider/members/:id', requireOwner, async (req, res) => {
  const cid = companyIdOf(req.user);
  const m = await one('SELECT * FROM users WHERE id=$1 AND company_id=$2', [req.params.id, cid]);
  if (!m) return res.status(404).json({ error: 'Not on your team' });
  if (m.member_role === 'owner') return res.status(400).json({ error: 'You cannot remove the owner' });
  const openJobs = await dispatch.unassignTechnician({
    techId: m.id,
    actorId: req.user.id,
    companyId: cid,
    userChanges: {
      memberRole: m.member_role,
      assignable: false,
      memberLocationId: m.member_location_id,
      archive: true,
      archiveReason: 'Removed from company'
    }
  });
  await auth.endAllSessions(m.id);
  for (const job of openJobs) {
    await processNotificationIds(job.notificationIds);
    const recipients = await alertRecipients(job.selected_provider, null);
    for (const person of recipients)
      wsPush(person.id, 'job_bounced', { request_id: job.id });
    wsPush(job.driver_id, 'job_status', { request_id: job.id, state: 'unassigned' });
  }
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

  const reason = String(req.body.reason || '').slice(0, 300);
  let recoveredJobs = [];
  let cancelledJobs = [];
  let archivedIds;
  if (u.role === 'driver') {
    const archived = await dispatch.archiveDriver({
      driverId: id,
      actorId: req.user.id,
      reason
    });
    cancelledJobs = archived.jobs;
    archivedIds = archived.archivedIds;
  } else if (u.role === 'provider' && (u.member_role || 'owner') === 'owner') {
    const archived = await dispatch.archiveCompany({
      companyId: id,
      actorId: req.user.id,
      reason
    });
    recoveredJobs = archived.jobs;
    archivedIds = archived.archivedIds;
  } else if (u.role === 'provider' && u.member_role === 'tech') {
    recoveredJobs = await dispatch.unassignTechnician({
      techId: id,
      actorId: req.user.id,
      companyId: u.company_id,
      userChanges: {
        name: u.name,
        lang: u.lang,
        memberRole: 'tech',
        assignable: false,
        memberLocationId: u.member_location_id,
        archive: true,
        archiveReason: reason
      }
    });
    archivedIds = [id];
  } else {
    archivedIds = await withTransaction(async client => {
    await client.query(`
      UPDATE users SET archived_at=NOW(), archive_reason=$1, archived_by_company=FALSE WHERE id=$2`,
      [reason, id]);
    return [id];
    });
  }
  for (const archivedId of archivedIds) await auth.endAllSessions(archivedId);
  for (const job of recoveredJobs) {
    await processNotificationIds(job.notificationIds);
    const recipients = await alertRecipients(job.selected_provider, null);
    for (const person of recipients)
      wsPush(person.id, 'job_bounced', { request_id: job.id });
    wsPush(job.driver_id, 'job_status', { request_id: job.id, state: 'unassigned' });
  }
  for (const job of cancelledJobs) {
    await processNotificationIds(job.notificationIds);
    for (const recipientId of job.recipientIds)
      wsPush(recipientId, 'job_cancelled', { request_id: job.id });
    if (job.previous_tech_id)
      wsPush(job.previous_tech_id, 'job_cancelled', { request_id: job.id });
  }
  res.json({
    ok: true,
    cancelled_requests: cancelledJobs.length,
    archived_accounts: archivedIds.length
  });
});

router.post('/admin/users/:id/restore', auth.requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const existing = await one('SELECT * FROM users WHERE id=$1', [id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const restored = await withTransaction(async client => {
    const user = (await client.query(`
      UPDATE users SET archived_at=NULL, archive_reason='', archived_by_company=FALSE
      WHERE id=$1 RETURNING *`, [id])).rows[0];
    if (user.role === 'provider' && (user.member_role || 'owner') === 'owner') {
      await client.query(`
        UPDATE users SET archived_at=NULL, archive_reason='', archived_by_company=FALSE
        WHERE company_id=$1 AND archived_by_company=TRUE`, [id]);
    }
    return user;
  });
  const u = restored;
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

/* ---------------- messaging ---------------- */
async function canAccessThread(user, requestId, providerId) {
  const r = await one('SELECT * FROM requests WHERE id=$1', [requestId]);
  if (!r) return null;
  if (user.role === 'admin') return r;
  if (r.driver_id === user.id) {
    // Only companies that actually bought the lead have a thread — otherwise chat
    // (and its offline text messages) would reach shops that never paid.
    const bought = await one(`SELECT id FROM purchases
      WHERE request_id=$1 AND provider_id=$2 AND refunded=FALSE AND status='succeeded'`,
      [requestId, providerId]);
    return bought ? r : null;
  }
  if (user.role === 'provider' && companyIdOf(user) === Number(providerId)) {
    const pu = await one(`
      SELECT id FROM purchases
      WHERE request_id=$1 AND provider_id=$2 AND refunded=FALSE AND status='succeeded'`,
      [requestId, providerId]);
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
      WHERE pu.provider_id=$1 AND pu.refunded=FALSE AND pu.status='succeeded'
      ORDER BY pu.id DESC LIMIT 30`, [companyIdOf(req.user)]);
  } else {
    rows = await q(`
      SELECT r.id AS request_id, pu.provider_id, r.service_label, r.status, p.name AS other_name,
        (SELECT body FROM messages m WHERE m.request_id=r.id AND m.provider_id=pu.provider_id ORDER BY m.id DESC LIMIT 1) AS last_body
      FROM requests r JOIN purchases pu ON pu.request_id=r.id JOIN providers p ON p.user_id=pu.provider_id
      WHERE r.driver_id=$1 AND pu.refunded=FALSE AND pu.status='succeeded'
      ORDER BY pu.id DESC LIMIT 30`, [req.user.id]);
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
      FROM purchases pu WHERE pu.request_id=$1 AND pu.refunded=FALSE
        AND pu.status='succeeded' AND pu.provider_id <> $2`,
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

  // push to the other party — and, when their app is closed, a text message.
  // Quotes always text (a quote is money); plain chatter is batched to one text
  // per thread per 10 minutes so a back-and-forth doesn't machine-gun a phone.
  if (req.user.id === r.driver_id) {
    const recipients = await q(`
      SELECT id FROM users
      WHERE company_id=$1 AND archived_at IS NULL AND member_role IN ('owner','dispatcher')`,
      [Number(req.params.providerId)]);
    for (const recipient of recipients) wsPush(recipient.id, 'message', m);
  } else {
    wsPush(r.driver_id, 'message', m);
  }
  notifyOfflineParty(r, req.user, Number(req.params.providerId), m)
    .catch(e => console.error('chat sms failed:', e.message));
  res.json(m);
});

const chatSmsLast = new Map(); // threadKey:userId -> last text time (in-memory batch window)
function chatSmsDue(key, isQuote) {
  if (isQuote) { chatSmsLast.set(key, Date.now()); return true; }
  const last = chatSmsLast.get(key) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return false;
  chatSmsLast.set(key, Date.now());
  if (chatSmsLast.size > 5000) chatSmsLast.clear();
  return true;
}
async function notifyOfflineParty(r, sender, providerId, m) {
  const isQuote = !!m.quote;
  const base = process.env.BASE_URL || '';
  const snippet = String(m.body || '').slice(0, 70);
  const textFor = (person, senderName) => {
    if (isQuote) {
      const amt = '$' + Math.round((m.quote.amount_cents || 0) / 100);
      const eta = m.quote.eta ? ` · ETA ${m.quote.eta} min` : '';
      return inLang(person,
        `RIGRX: New quote on request #${r.id} (${r.service_label}): ${amt}${eta} from ${senderName}. Compare and choose in the app. ${base}`,
        `RIGRX: Nueva cotización en la solicitud #${r.id} (${r.service_label}): ${amt}${eta} de ${senderName}. Compare y elija en la app. ${base}`);
    }
    return inLang(person,
      `RIGRX: New message from ${senderName} on request #${r.id}: "${snippet}" Reply in the app. ${base}`,
      `RIGRX: Nuevo mensaje de ${senderName} en la solicitud #${r.id}: "${snippet}" Responda en la app. ${base}`);
  };
  const send = async (person, senderName) => {
    if (isOnline(person.id)) return;
    if (!chatSmsDue(`${r.id}:${providerId}:${person.id}`, isQuote)) return;
    const notification = await enqueueSms(person.id, person.phone, textFor(person, senderName), {
      requestId: r.id,
      eventType: isQuote ? 'chat_quote' : 'chat_message',
      dedupeKey: `message:${m.id}:recipient:${person.id}`,
      payload: { provider_id: providerId, message_id: m.id }
    });
    if (notification) await processNotificationIds([notification.id]);
  };
  if (sender.id === r.driver_id) {
    // driver wrote -> text every offline owner/dispatcher at the company
    const senderName = sender.name || 'the driver';
    const people = await q(`
      SELECT id, phone, lang FROM users
      WHERE company_id=$1 AND archived_at IS NULL AND member_role IN ('owner','dispatcher')`,
      [providerId]);
    for (const person of people) await send(person, senderName);
  } else {
    // company wrote -> text the driver if their app is closed
    const d = await one('SELECT id, phone, lang FROM users WHERE id=$1 AND archived_at IS NULL', [r.driver_id]);
    const p = await one('SELECT name FROM providers WHERE user_id=$1', [providerId]);
    if (d) await send(d, p?.name || 'the service company');
  }
}

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
    one(`SELECT COALESCE(SUM(amount_cents),0)::int AS c FROM purchases
         WHERE refunded=FALSE AND status='succeeded' AND created_at > NOW() - INTERVAL '24 hours'`),
    one(`SELECT COALESCE(SUM(amount_cents),0)::int AS c FROM purchases
         WHERE refunded=FALSE AND status='succeeded'`),
    one(`SELECT COUNT(*)::int AS n FROM providers WHERE approved=FALSE`),
    one(`SELECT
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM purchases pu WHERE pu.request_id=r.id
              AND pu.refunded=FALSE AND pu.status='succeeded'))::int AS filled,
          COUNT(*)::int AS total
         FROM requests r`),
    one(`SELECT COUNT(*) FILTER (WHERE role='driver')::int AS drivers,
                COUNT(*) FILTER (WHERE role='provider')::int AS providers FROM users`)
  ]);
  const [flags, exceptions] = await Promise.all([
    one(`SELECT COUNT(*)::int AS n FROM chat_flags WHERE reviewed_at IS NULL`),
    one(`SELECT COUNT(*)::int AS n FROM dispatch_exceptions WHERE status IN ('open','acknowledged')`)
  ]);
  res.json({
    requests_24h: reqToday.n, revenue_24h_cents: revToday.c, revenue_total_cents: revTotal.c,
    pending_providers: pendingProviders.n,
    fill_rate: fill.total ? Math.round(fill.filled / fill.total * 100) : 0,
    drivers: users.drivers, providers: users.providers,
    open_flags: flags.n,
    open_dispatch_exceptions: exceptions.n
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

/* ---- operational exception queue ---- */
router.get('/admin/exceptions', auth.requireRole('admin'), async (req, res) => {
  const includeResolved = req.query.all === '1';
  const exceptions = await q(`
    SELECT e.*, r.service_label, r.area_label, r.status AS request_status,
      r.job_state, r.notified_count, r.created_at AS requested_at,
      d.name AS driver_name, d.phone AS driver_phone,
      p.name AS provider_name, t.name AS tech_name
    FROM dispatch_exceptions e
    JOIN requests r ON r.id=e.request_id
    JOIN users d ON d.id=r.driver_id
    LEFT JOIN providers p ON p.user_id=e.provider_id
    LEFT JOIN users t ON t.id=e.tech_id
    ${includeResolved ? '' : `WHERE e.status IN ('open','acknowledged')`}
    ORDER BY
      CASE e.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
      e.created_at DESC
    LIMIT 200`);
  const notifications = await q(`
    SELECT n.id, n.request_id, n.event_type, n.status, n.attempts,
      n.available_at, n.last_error, n.created_at, n.updated_at,
      r.service_label, r.area_label
    FROM notifications_log n
    LEFT JOIN requests r ON r.id=n.request_id
    WHERE n.status='dead'
       OR (n.status IN ('pending','sending') AND n.attempts > 0)
    ORDER BY (n.status='dead') DESC, n.updated_at DESC
    LIMIT 100`);
  res.json({ exceptions, notifications });
});

router.post('/admin/exceptions/:id/:action', auth.requireRole('admin'), async (req, res) => {
  const action = req.params.action;
  if (!['acknowledge', 'resolve'].includes(action))
    return res.status(400).json({ error: 'Choose acknowledge or resolve' });
  const occurrence = Number(req.body.occurrence);
  if (!Number.isInteger(occurrence) || occurrence < 1)
    return res.status(400).json({ error: 'The exception revision is required' });
  const row = await one(`
    UPDATE dispatch_exceptions
    SET status=$1, updated_at=NOW(), resolved_at=$2, resolved_by=$3, resolution=$4
    WHERE id=$5 AND occurrence=$6 AND status IN ('open','acknowledged')
    RETURNING *`,
    [action === 'resolve' ? 'resolved' : 'acknowledged',
     action === 'resolve' ? new Date() : null,
     action === 'resolve' ? req.user.id : null,
     action === 'resolve' ? String(req.body.resolution || 'Resolved by admin').slice(0, 300) : '',
     req.params.id, occurrence]);
  if (!row) return res.status(409).json({
    error: 'This exception changed. Refresh the queue before updating it.'
  });
  res.json({ ok: true, exception: row });
});

router.post('/admin/notifications/:id/retry', auth.requireRole('admin'), async (req, res) => {
  const notification = await one(`
    UPDATE notifications_log
    SET status='pending', available_at=NOW(), locked_at=NULL, updated_at=NOW()
    WHERE id=$1 AND status IN ('pending','dead')
    RETURNING id`, [req.params.id]);
  if (!notification) return res.status(404).json({ error: 'Notification is not retryable' });
  const results = await processNotificationOutbox({ limit: 1, onlyId: notification.id });
  res.json({ ok: true, delivery: results[0] || { status: 'pending' } });
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
  const [locations, custom, stats, reviews, credits] = await Promise.all([
    q('SELECT * FROM provider_locations WHERE user_id=$1 ORDER BY id', [req.params.id]),
    q('SELECT * FROM custom_services WHERE user_id=$1 ORDER BY id', [req.params.id]),
    one(`SELECT COUNT(*)::int AS leads_bought, COALESCE(SUM(amount_cents),0)::int AS spend
         FROM purchases WHERE provider_id=$1 AND refunded=FALSE AND status='succeeded'`, [req.params.id]),
    q(`SELECT stars, comment, created_at FROM reviews WHERE target_provider=$1 ORDER BY id DESC LIMIT 5`, [req.params.id]),
    q(`SELECT delta, reason, by_admin, created_at FROM credit_log WHERE provider_id=$1 ORDER BY id DESC LIMIT 10`, [req.params.id])
  ]);
  res.json({
    ...p, locations, custom, stats, reviews, credit_log: credits,
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
  const result = await marketplace.refundPurchase({ purchaseId: Number(req.params.id) });
  res.json({ ok: true, replayed: !!result.replayed });
});

/* ---- admin settings ---- */
router.get('/admin/settings', auth.requireRole('admin'), async (req, res) => {
  const rows = await q('SELECT key, value FROM settings');
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});
router.put('/admin/settings/welcome-credits', auth.requireRole('admin'), async (req, res) => {
  const n = Math.max(0, Math.min(100, Math.round(Number(req.body.value))));
  if (Number.isNaN(n)) return res.status(400).json({ error: 'Enter a number' });
  await q(`INSERT INTO settings (key, value) VALUES ('welcome_credits', $1)
           ON CONFLICT (key) DO UPDATE SET value = $1`, [String(n)]);
  res.json({ ok: true, welcome_credits: n });
});

/* ---- free lead credits (admin-granted) ---- */
router.post('/admin/providers/:id/credits', auth.requireRole('admin'), async (req, res) => {
  const delta = Math.max(-100, Math.min(100, Number(req.body.delta) || 0));
  if (!delta) return res.status(400).json({ error: 'How many credits?' });
  const p = await one(
    `UPDATE providers SET lead_credits = GREATEST(0, lead_credits + $1) WHERE user_id=$2 RETURNING lead_credits`,
    [delta, req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  await q(`INSERT INTO credit_log (provider_id, delta, reason, by_admin) VALUES ($1,$2,$3,TRUE)`,
    [req.params.id, delta, String(req.body.reason || '').slice(0, 120) || (delta > 0 ? 'Granted by RIGRX' : 'Adjusted by RIGRX')]);
  // Free leads are a gift — make sure the shop knows they got it.
  if (delta > 0) {
    const u = await one('SELECT id, phone, lang FROM users WHERE id=$1', [req.params.id]);
    if (u) await sms(u.id, u.phone, inLang(u,
      `RIGRX: You have ${p.lead_credits} free lead${p.lead_credits === 1 ? '' : 's'} on your account. They're used automatically when you unlock a lead.`,
      `RIGRX: Tiene ${p.lead_credits} aviso${p.lead_credits === 1 ? '' : 's'} gratis en su cuenta. Se usan automáticamente al desbloquear un aviso.`));
  }
  res.json({ ok: true, lead_credits: p.lead_credits });
});

/* ---- card collection (Stripe Elements + SetupIntent) ---- */
// Step 1: the client asks to add a card. We make (or reuse) the Stripe customer
// and hand back a SetupIntent secret for Stripe Elements to collect against.
router.post('/provider/card-setup', requireOwner, async (req, res) => {
  if (SIMULATED()) return res.status(400).json({ error: 'Payments are in simulation mode — no Stripe keys are set yet' });
  const p = await providerOf(req);
  if (!p) return res.status(400).json({ error: 'Complete your company profile first' });
  const setup = await cardSetup(p, p.name, p.email);
  if (!setup) return res.status(500).json({ error: 'Could not start card setup' });
  if (setup.customerId !== p.stripe_customer)
    await q('UPDATE providers SET stripe_customer=$1 WHERE user_id=$2', [setup.customerId, p.user_id]);
  res.json({ clientSecret: setup.clientSecret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// Step 2: Elements confirmed the card. Verify it server-side and make it the
// company's charging default. The card number itself never touched our server.
router.post('/provider/card-saved', requireOwner, async (req, res) => {
  if (SIMULATED()) return res.status(400).json({ error: 'Payments are in simulation mode' });
  const p = await providerOf(req);
  const pmId = String(req.body.payment_method || '');
  if (!p?.stripe_customer || !pmId) return res.status(400).json({ error: 'Card setup incomplete' });
  const card = await saveCard(p.stripe_customer, pmId);
  if (!card) return res.status(400).json({ error: "That card didn't save — try again" });
  await q('UPDATE providers SET stripe_pm=$1, card_last4=$2, card_brand=$3 WHERE user_id=$4',
    [pmId, card.last4, card.brand, p.user_id]);
  res.json({ ok: true, last4: card.last4, brand: card.brand });
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
            : req.query.filled === '1' ? `WHERE EXISTS (SELECT 1 FROM purchases pu WHERE pu.request_id=r.id AND pu.refunded=FALSE AND pu.status='succeeded')`
            : req.query.unfilled === '1' ? `WHERE NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.request_id=r.id AND pu.refunded=FALSE AND pu.status='succeeded')`
            : '';
  const rows = await q(`
    SELECT r.id, r.service_label, r.area_label, r.status, r.notified_count, r.created_at,
           r.licensed_only, u.name AS driver_name, u.phone AS driver_phone,
      (SELECT COUNT(*)::int FROM purchases pu WHERE pu.request_id=r.id
        AND pu.refunded=FALSE AND pu.status='succeeded') AS buyers,
      (SELECT COALESCE(SUM(amount_cents),0)::int FROM purchases pu WHERE pu.request_id=r.id
        AND pu.refunded=FALSE AND pu.status='succeeded') AS revenue_cents
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
    WHERE pu.request_id=$1 AND pu.status='succeeded' ORDER BY pu.slot`, [req.params.id]);

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
        JOIN requests r ON r.id=pu.request_id WHERE r.driver_id=u.id
          AND pu.refunded=FALSE AND pu.status='succeeded') AS revenue_cents
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
       (SELECT COUNT(*)::int FROM purchases pu WHERE pu.request_id=r.id
         AND pu.refunded=FALSE AND pu.status='succeeded') AS buyers,
       (SELECT COALESCE(SUM(amount_cents),0)::int FROM purchases pu WHERE pu.request_id=r.id
         AND pu.refunded=FALSE AND pu.status='succeeded') AS revenue_cents
       FROM requests r WHERE r.driver_id=$1 ORDER BY r.id DESC LIMIT 50`, [req.params.id])
  ]);
  res.json({
    driver: { ...u, rating: u.rating_count ? +(u.rating_sum / u.rating_count).toFixed(1) : null },
    trucks, trailers, requests
  });
});

module.exports = router;
module.exports.sweepUnacceptedJobs = sweepUnacceptedJobs;

/* ---------------- marketplace sweeps ----------------
   Runs every minute alongside the job sweep. Three jobs:

   1. SILENCE ALARM — a request with no buyers after 10 minutes pages the admin.
      In the early months the admin IS the safety net: this is the text that says
      "call a shop and make this happen".
   2. STALL NUDGE — a company won the job but nobody is rolling 15 minutes later.
      The dispatchers get a reminder text and the admin is copied.
   3. AUTO-EXPIRY — unanswered requests close after 4 hours (with a warning text
      to the driver at ~3.5h); answered-but-never-chosen close after 24. Stale
      leads sitting in shop feeds teach shops the feed is junk — this keeps it
      honest. Buyers of an expired lead keep chat access.               */
async function sweepMarketplace() {
  const adminPhone = auth.normalizePhone(process.env.ADMIN_PHONE || '');

  // 1 — nobody bought, admin gets paged once
  const silentBatch = await withTransaction(async client => {
    const silent = (await client.query(`
      WITH updated AS (
      UPDATE requests r SET silent_alerted = TRUE,
        silent_alert_generation=silent_alert_generation+1
      WHERE r.status='open' AND r.silent_alerted = FALSE
        AND COALESCE(r.last_notified_at, r.created_at) < NOW() - INTERVAL '10 minutes'
        AND NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.request_id=r.id
          AND pu.refunded=FALSE AND pu.status='succeeded')
      RETURNING r.id, r.service_label, r.area_label, r.notified_count,
        r.silent_alert_generation
    ), opened AS (
      INSERT INTO dispatch_exceptions (request_id, type, status, detail)
      SELECT id, CASE WHEN notified_count > 0 THEN 'no_response' ELSE 'zero_match' END,
        'open', jsonb_build_object(
          'service_label', service_label,
          'area_label', area_label,
          'notified_count', notified_count)
      FROM updated
      ON CONFLICT (request_id, type) WHERE status IN ('open','acknowledged')
      DO UPDATE SET status='open', detail=EXCLUDED.detail,
        occurrence=dispatch_exceptions.occurrence+1, updated_at=NOW()
    )
      SELECT * FROM updated`)).rows;
    const notificationIds = [];
    if (adminPhone) for (const r of silent) {
      const notification = await enqueueSms(null, adminPhone,
        `RIGRX ALARM: Request #${r.id} (${r.service_label}, ${r.area_label}) has NO responders after 10 min. ` +
        (r.notified_count ? `${r.notified_count} compan${r.notified_count===1?'y was':'ies were'} alerted — call one.` : `Nobody matched it at all.`),
        {
          client,
          requestId: r.id,
          eventType: 'request_silent_alarm',
          dedupeKey: `request:${r.id}:silent-alarm:g${r.silent_alert_generation}`,
          payload: { silent_alert_generation: r.silent_alert_generation }
        });
      if (notification) notificationIds.push(notification.id);
    }
    return { rows: silent, notificationIds };
  });
  await processNotificationIds(silentBatch.notificationIds);

  // 2 — won it, not rolling
  const stalledBatch = await withTransaction(async client => {
    const stalled = (await client.query(`
      WITH updated AS (
      UPDATE requests r SET stall_alerted = TRUE,
        stall_alert_generation=stall_alert_generation+1
      WHERE r.status='selected' AND r.stall_alerted = FALSE
        AND r.job_state IN ('unassigned','assigned','accepted')
        AND COALESCE(r.job_activity_at, r.selected_at) < NOW() - INTERVAL '15 minutes'
      RETURNING r.id, r.service_label, r.selected_provider, r.assigned_tech,
        r.job_state, r.stall_alert_generation, r.assignment_version
    ), opened AS (
      INSERT INTO dispatch_exceptions
        (request_id, type, provider_id, tech_id, status, detail)
      SELECT id, 'stalled', selected_provider, assigned_tech, 'open',
        jsonb_build_object('service_label', service_label, 'reason', 'selected_not_enroute',
          'job_state', job_state)
      FROM updated
      ON CONFLICT (request_id, type) WHERE status IN ('open','acknowledged')
      DO UPDATE SET status='open', provider_id=EXCLUDED.provider_id,
        tech_id=EXCLUDED.tech_id, detail=EXCLUDED.detail,
        occurrence=dispatch_exceptions.occurrence+1, updated_at=NOW()
    )
      SELECT * FROM updated`)).rows;
    const notificationIds = [];
    const recipientIds = [];
    for (const r of stalled) {
      let people = (await client.query(`
        SELECT id, phone FROM users WHERE company_id=$1 AND archived_at IS NULL
          AND member_role IN ('owner','dispatcher')`, [r.selected_provider])).rows;
      if (!people.length)
        people = (await client.query(`
          SELECT id, phone FROM users WHERE id=$1 AND archived_at IS NULL`,
          [r.selected_provider])).rows;
      for (const person of people) {
        const notification = await enqueueSms(person.id, person.phone,
        `RIGRX: The driver on Request #${r.id} (${r.service_label}) chose you 15 minutes ago and nobody is on the way yet. Open the app and assign it.`,
        {
          client,
          requestId: r.id,
          eventType: 'job_stalled_provider',
          dedupeKey: `request:${r.id}:stalled:g${r.stall_alert_generation}:provider:${person.id}`,
          payload: {
            stall_alert_generation: r.stall_alert_generation,
            assignment_version: r.assignment_version
          }
        });
        if (notification) notificationIds.push(notification.id);
        recipientIds.push(person.id);
      }
      if (adminPhone) {
        const notification = await enqueueSms(null, adminPhone,
          `RIGRX: Request #${r.id} was won 15 min ago but the company hasn't rolled anyone. They've been nudged.`,
          {
            client,
            requestId: r.id,
            eventType: 'job_stalled_admin',
            dedupeKey: `request:${r.id}:stalled:g${r.stall_alert_generation}:admin`,
            payload: {
              stall_alert_generation: r.stall_alert_generation,
              assignment_version: r.assignment_version
            }
          });
        if (notification) notificationIds.push(notification.id);
      }
    }
    return { rows: stalled, notificationIds, recipientIds };
  });
  await processNotificationIds(stalledBatch.notificationIds);
  for (const recipientId of stalledBatch.recipientIds)
    wsPush(recipientId, 'job_rescue', {});

  // 3a — warn the driver before an unanswered request closes
  const warningIds = await withTransaction(async client => {
    const warn = (await client.query(`
      UPDATE requests r SET expire_warned = TRUE
      WHERE r.status='open' AND r.expire_warned = FALSE
        AND r.created_at < NOW() - INTERVAL '3 hours 30 minutes'
        AND NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.request_id=r.id
          AND pu.refunded=FALSE AND pu.status='succeeded')
      RETURNING r.id, r.driver_id`)).rows;
    const ids = [];
    for (const r of warn) {
      const d = (await client.query(
        'SELECT id, phone, lang FROM users WHERE id=$1', [r.driver_id])).rows[0];
      if (d) {
        const notification = await enqueueSms(d.id, d.phone, inLang(d,
          `RIGRX: Your request #${r.id} closes in 30 minutes with no responses. Still stuck? Open the app and send it again — or widen your filters.`,
          `RIGRX: Su solicitud #${r.id} se cierra en 30 minutos sin respuestas. ¿Sigue varado? Abra la app y envíela de nuevo — o amplíe sus filtros.`),
          {
            client,
            requestId: r.id,
            eventType: 'request_expiry_warning',
            dedupeKey: `request:${r.id}:expiry-warning`
          });
        if (notification) ids.push(notification.id);
      }
    }
    return ids;
  });
  await processNotificationIds(warningIds);

  // 3b — expire: 4h with no buyers, 24h with buyers but no choice
  const expiredBatch = await withTransaction(async client => {
    const expired = (await client.query(`
      WITH updated AS (
      UPDATE requests r SET status='expired'
      WHERE r.status='open' AND (
        (r.created_at < NOW() - INTERVAL '4 hours'
          AND NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.request_id=r.id
            AND pu.refunded=FALSE AND pu.status='succeeded'))
        OR r.created_at < NOW() - INTERVAL '24 hours')
      RETURNING r.id, r.driver_id
    ), opened AS (
      INSERT INTO dispatch_exceptions (request_id, type, status, detail)
      SELECT id, 'expired', 'open',
        jsonb_build_object('reason', 'Request reached its automatic expiry window')
      FROM updated
      ON CONFLICT (request_id, type) WHERE status IN ('open','acknowledged')
      DO UPDATE SET status='open', detail=EXCLUDED.detail,
        occurrence=dispatch_exceptions.occurrence+1, updated_at=NOW()
    ), resolved AS (
      UPDATE dispatch_exceptions de SET status='resolved', resolved_at=NOW(),
        updated_at=NOW(), resolution='Request expired'
      FROM updated u
      WHERE de.request_id=u.id AND de.type IN ('zero_match','no_response')
        AND de.status IN ('open','acknowledged')
    )
    SELECT * FROM updated`)).rows;
    const notificationIds = [];
    for (const r of expired) {
      const d = (await client.query(
        'SELECT id, phone, lang FROM users WHERE id=$1', [r.driver_id])).rows[0];
      if (d) {
        const notification = await enqueueSms(d.id, d.phone, inLang(d,
          `RIGRX: Request #${r.id} was closed automatically. If you still need help, open the app and send a fresh one — it takes 30 seconds.`,
          `RIGRX: La solicitud #${r.id} se cerró automáticamente. Si aún necesita ayuda, abra la app y envíe una nueva — toma 30 segundos.`),
          {
            client,
            requestId: r.id,
            eventType: 'request_expired',
            dedupeKey: `request:${r.id}:expired`
          });
        if (notification) notificationIds.push(notification.id);
      }
    }
    return { rows: expired, notificationIds };
  });
  await processNotificationIds(expiredBatch.notificationIds);
}
module.exports.sweepMarketplace = sweepMarketplace;

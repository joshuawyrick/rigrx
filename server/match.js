// ============ Lead matching engine ============
const { q, one } = require('./db');
const { sms, wsPush } = require('./notify');

// Legacy labels from before the catalog was admin-managed. Provider selections
// saved under an old label still count, so nobody loses their setup.
const LEGACY_LABELS = {
  towing:    ['Towing & Recovery'],
  tires:     ['Tires'],
  wontstart: ['Mobile Mechanic'],
  mechanic:  ['Mobile Mechanic'],
  trailer:   ['Trailer / Reefer'],
  fuel:      ['Fuel & Fluids'],
  lockout:   ['Other'],
  other:     ['Other']
};

// A provider matches a request's category if they have at least one service
// checked under it — looked up by catalog KEY first, then by any legacy label.
function offersCategory(services, serviceKey, categoryLabel) {
  if (!services) return false;
  if ((services[serviceKey] || []).length) return true;                 // new: keyed by catalog key
  if (categoryLabel && (services[categoryLabel] || []).length) return true; // current label
  for (const legacy of (LEGACY_LABELS[serviceKey] || [])) {
    if ((services[legacy] || []).length) return true;
  }
  return false;
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // earth radius, miles
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Distance band shown on masked leads (never the exact distance)
function distanceBand(mi) {
  if (mi < 10) return '5–10 mi';
  if (mi < 15) return '8–15 mi';
  if (mi < 25) return '15–25 mi';
  if (mi < 35) return '25–35 mi';
  if (mi < 50) return '35–50 mi';
  return '50+ mi';
}

// Find approved providers whose ANY location radius covers the point and who offer the category.
// extraMiles widens the search when nobody matched (radius auto-expansion).
async function matchProviders(request, extraMiles = 0) {
  const cat = await one('SELECT label FROM service_categories WHERE key=$1', [request.service_key]);
  const categoryLabel = cat?.label || null;
  // If the driver asked for licensed companies only, unverified providers are excluded.
  // A trade filter is the driver saying "only companies whose main work is this".
  // Duty class is a hard gate, not a preference: a heavy-only wrecker service should
  // never be texted about a box truck, and vice versa.
  const trades = Array.isArray(request.trade_filter) ? request.trade_filter : [];
  const duty = ['heavy','medium','light'].includes(request.duty_class) ? request.duty_class : 'heavy';
  const rows = await q(`
    SELECT p.user_id, p.name, p.services, p.license_verified, p.primary_trade, u.phone,
           l.id AS location_id, l.lat, l.lng, l.radius_mi
    FROM providers p
    JOIN users u ON u.id = p.user_id
    JOIN provider_locations l ON l.user_id = p.user_id
    WHERE p.approved = TRUE
      AND u.archived_at IS NULL
      AND ($1::boolean = FALSE OR p.license_verified = TRUE)
      AND ($2::int = 0 OR p.primary_trade = ANY($3::text[]))
      AND p.duty_classes ? $4`,
    [!!request.licensed_only, trades.length, trades, duty]);
  const seen = new Map(); // provider -> closest distance
  for (const r of rows) {
    if (!offersCategory(r.services, request.service_key, categoryLabel)) continue;
    const d = haversineMiles(request.lat, request.lng, r.lat, r.lng);
    if (d <= r.radius_mi + extraMiles) {
      if (!seen.has(r.user_id) || d < seen.get(r.user_id).distance) {
        seen.set(r.user_id, { user_id: r.user_id, name: r.name, phone: r.phone,
                              distance: d, location_id: r.location_id });
      }
    }
  }
  return [...seen.values()];
}

// Blast text + websocket alerts to matched providers (masked info only)
// Who at this company should actually be woken up? Owners and dispatchers — never
// techs, who only hear about a job once it has been handed to them. A dispatcher tied
// to a specific yard is only alerted for leads that matched that yard, so a Bakersfield
// dispatcher is not woken at 3 AM for a Fresno breakdown.
async function alertRecipients(companyId, locationId) {
  const rows = await q(`
    SELECT id, phone, name FROM users
    WHERE company_id = $1 AND archived_at IS NULL AND member_role IN ('owner','dispatcher')
      AND (member_location_id IS NULL OR member_location_id = $2)`, [companyId, locationId || null]);
  return rows;
}

async function notifyProviders(request, matches, price) {
  const priceStr = '$' + (price.standard_cents / 100).toFixed(0);
  for (const m of matches) {
    const body = `RIGRX: New ${request.service_label.toUpperCase()} request ${request.area_label} — ` +
      `${distanceBand(m.distance)} from you — ${priceStr} to unlock. ${process.env.BASE_URL || ''}/#lead-${request.id}`;
    let people = await alertRecipients(m.user_id, m.location_id);
    // A company set up before people existed still has its own account to fall back on.
    if (!people.length) people = [{ id: m.user_id, phone: m.phone }];
    for (const person of people) {
      await sms(person.id, person.phone, body);
      wsPush(person.id, 'new_lead', {
        request_id: request.id, service: request.service_label, band: distanceBand(m.distance) });
    }
  }
}

module.exports = { matchProviders, notifyProviders, alertRecipients, haversineMiles, distanceBand, offersCategory };

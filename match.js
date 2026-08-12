// ============ Lead matching engine ============
const { q } = require('./db');
const { sms, wsPush } = require('./notify');

// service_key -> provider service category that must be non-empty to match
const KEY_TO_CATEGORY = {
  towing:    'Towing & Recovery',
  tires:     'Tires',
  wontstart: 'Mobile Mechanic',
  mechanic:  'Mobile Mechanic',
  trailer:   'Trailer / Reefer',
  fuel:      'Fuel & Fluids',
  lockout:   'Other',
  other:     'Other'
};

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
  const category = KEY_TO_CATEGORY[request.service_key] || 'Other';
  // If the driver asked for licensed companies only, unverified providers are excluded.
  const rows = await q(`
    SELECT p.user_id, p.name, p.services, p.license_verified, u.phone,
           l.lat, l.lng, l.radius_mi
    FROM providers p
    JOIN users u ON u.id = p.user_id
    JOIN provider_locations l ON l.user_id = p.user_id
    WHERE p.approved = TRUE
      AND ($1::boolean = FALSE OR p.license_verified = TRUE)`,
    [!!request.licensed_only]);
  const seen = new Map(); // provider -> closest distance
  for (const r of rows) {
    const services = r.services || {};
    if (!(services[category] || []).length) continue;
    const d = haversineMiles(request.lat, request.lng, r.lat, r.lng);
    if (d <= r.radius_mi + extraMiles) {
      if (!seen.has(r.user_id) || d < seen.get(r.user_id).distance) {
        seen.set(r.user_id, { user_id: r.user_id, name: r.name, phone: r.phone, distance: d });
      }
    }
  }
  return [...seen.values()];
}

// Blast text + websocket alerts to matched providers (masked info only)
async function notifyProviders(request, matches, price) {
  const priceStr = '$' + (price.standard_cents / 100).toFixed(0);
  for (const m of matches) {
    const body = `RIGRX: New ${request.service_label.toUpperCase()} request ${request.area_label} — ` +
      `${distanceBand(m.distance)} from you — ${priceStr} to unlock. ${process.env.BASE_URL || ''}/#lead-${request.id}`;
    await sms(m.user_id, m.phone, body);
    wsPush(m.user_id, 'new_lead', { request_id: request.id, service: request.service_label, band: distanceBand(m.distance) });
  }
}

module.exports = { matchProviders, notifyProviders, haversineMiles, distanceBand, KEY_TO_CATEGORY };

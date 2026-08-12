// ============ Service catalog ============
// Seeds the catalog from the original hardcoded lists on first boot, then never
// touches it again — after that it belongs to the admin. Provider selections are
// stored against category KEYS (not names), so labels can be renamed freely.
const { q, one } = require('./db');

// key, label, icon, blurb, driver_visible, sort, [sub-services]
const SEED = [
  ['towing', 'Towing', 'truck', 'Heavy & medium duty, winch-out', true, 10,
    ['Heavy tow','Medium tow','Winch-out','Rotator / rollover','Accident recovery','Load transfer','Decking / undecking']],
  ['tires', 'Tires', 'tire', 'Replace or repair on the shoulder', true, 20,
    ['Roadside tire replacement','Tire repair / section','Mobile tire service','Air-up / valve stems']],
  ['wontstart', "Won't Start", 'zap', 'Jump, batteries, starter', true, 30,
    ['Jump start','Batteries / starters','Charging system','No-crank diagnosis']],
  ['mechanic', 'Engine / Mechanical', 'wrench', 'Diagnostics, derate, air leaks', true, 40,
    ['Engine diagnostics','DPF / regen','Air system & brakes','Coolant / overheating','Electrical & lighting',
     'Wheel seals / hubs','Driveline','Mobile welding','Hydraulics / wet kits','A/C & HVAC','APU repair']],
  ['trailer', 'Trailer / Reefer', 'trailer', 'Reefer down, brakes, lights', true, 50,
    ['Reefer repair','Trailer brakes & air','Lights / ABS / 7-way','Landing gear','Doors / roll-up',
     'Liftgate','Tanker pump / wet-line','Chassis repair']],
  ['fuel', 'Fuel / DEF', 'fuel', 'Out of fuel, gelled, DEF', true, 60,
    ['Diesel delivery','DEF delivery','Gelled fuel rescue','Coolant / oil delivery']],
  ['lockout', 'Lockout', 'key', 'Keys locked in the cab', true, 70,
    ['Truck lockout','Trailer lockout','Lost keys']],
  ['other', 'Other', 'box', 'Welding, glass, hydraulics…', true, 999,
    ['Mobile glass','On-site PM service','DOT inspection help','Load securement']]
];

async function seedIfEmpty() {
  const existing = await one('SELECT COUNT(*)::int AS n FROM service_categories');
  if (existing.n > 0) return;
  for (const [key, label, icon, blurb, visible, sort, items] of SEED) {
    const cat = await one(
      `INSERT INTO service_categories (key, label, icon, blurb, driver_visible, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [key, label, icon, blurb, visible, sort]);
    let i = 10;
    for (const label2 of items) {
      await q('INSERT INTO service_items (category_id, label, sort_order) VALUES ($1,$2,$3)', [cat.id, label2, i]);
      i += 10;
    }
  }
  console.log('Service catalog seeded with ' + SEED.length + ' categories');
}

// Full catalog with items, joined to pricing
async function getCatalog({ activeOnly = true } = {}) {
  const cats = await q(`
    SELECT c.*, p.standard_cents, p.premium_cents
    FROM service_categories c
    LEFT JOIN pricing p ON p.service_key = c.key
    ${activeOnly ? 'WHERE c.active = TRUE' : ''}
    ORDER BY c.sort_order, c.id`);
  const items = await q(`SELECT * FROM service_items ${activeOnly ? 'WHERE active = TRUE' : ''} ORDER BY sort_order, id`);
  return cats.map(c => ({
    ...c,
    items: items.filter(i => i.category_id === c.id)
  }));
}

// Make sure every category has a pricing row so no lead is ever accidentally free
async function ensurePricing(key, label, standard = 2500, premium = 5000) {
  await q(`INSERT INTO pricing (service_key, label, standard_cents, premium_cents)
           VALUES ($1,$2,$3,$4) ON CONFLICT (service_key) DO UPDATE SET label = EXCLUDED.label`,
          [key, label, standard, premium]);
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40) || ('cat' + Date.now().toString().slice(-6));
}

module.exports = { seedIfEmpty, getCatalog, ensurePricing, slugify };

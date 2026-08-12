// ============ Database layer ============
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: false }
});

async function q(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}
async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  // default pricing (insert-if-missing so admin edits survive restarts)
  const defaults = [
    ['towing',   'Heavy Towing & Recovery', 7500, 15000],
    ['tires',    'Tires',                   2500,  5000],
    ['wontstart',"Won't Start",             3500,  7000],
    ['mechanic', 'Mobile Mechanic',         3500,  7000],
    ['trailer',  'Trailer / Reefer',        4000,  8000],
    ['fuel',     'Fuel / DEF Delivery',     1500,  3000],
    ['lockout',  'Lockout',                 1500,  3000],
    ['other',    'Other Services',          2500,  5000]
  ];
  for (const [key, label, std, prem] of defaults) {
    await pool.query(
      `INSERT INTO pricing (service_key, label, standard_cents, premium_cents)
       VALUES ($1,$2,$3,$4) ON CONFLICT (service_key) DO NOTHING`, [key, label, std, prem]);
  }
}

module.exports = { pool, q, one, migrate };

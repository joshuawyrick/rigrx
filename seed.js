// ============ Seed script: demo data so the app isn't empty on first run ============
// Run once with:  npm run seed
require('dotenv').config();
const { q, one, migrate, pool } = require('./db');

async function main() {
  await migrate();

  // Demo DRIVER — sign in with phone (661) 555-0198
  let driver = await one('SELECT * FROM users WHERE phone=$1', ['+16615550198']);
  if (!driver) {
    driver = await one(`INSERT INTO users (phone, role, name, driver_type, company)
      VALUES ('+16615550198','driver','Josh Wyrick','Owner-operator','Petrol Transport, Inc. · DOT 1234567') RETURNING *`);
    await q(`INSERT INTO trucks (user_id, data) VALUES ($1,$2)`, [driver.id, JSON.stringify({
      unit: '12', year: '2022', make: 'Peterbilt', model: '389', engine: 'Cummins',
      trans: '18-spd manual', axles: 'Tandem', steer: '295/75R22.5', drive: '11R24.5',
      wheels: 'Aluminum', color: 'Red', vin: '1XPBD49X…', extras: ['APU'] })]);
    await q(`INSERT INTO trailers (user_id, data) VALUES ($1,$2)`, [driver.id, JSON.stringify({
      type: 'Tanker — crude', num: '407', len: "42'", axles: 'Tandem · air ride',
      tires: '11R24.5', hazmat: true, hzClass: '3 — Flammable', un: '1267' })]);
    console.log('Seeded demo driver:  (661) 555-0198');
  }

  // Demo PROVIDER — sign in with phone (661) 555-8804 (approved, Bakersfield + Fresno coverage)
  let prov = await one('SELECT * FROM users WHERE phone=$1', ['+16615558804']);
  if (!prov) {
    prov = await one(`INSERT INTO users (phone, role, name) VALUES ('+16615558804','provider','Big Rig Towing & Recovery') RETURNING *`);
    await q(`INSERT INTO providers (user_id, name, dispatch_phone, email, hours, services, equipment, approved, card_last4, badges)
      VALUES ($1,'Big Rig Towing & Recovery','(661) 555-8804','dispatch@bigrigtowing.com','24 / 7',$2,$3,TRUE,'4242',$4)`,
      [prov.id, JSON.stringify({
        'Towing & Recovery': ['Heavy tow','Medium tow','Winch-out','Rotator / rollover','Accident recovery','Load transfer'],
        'Mobile Mechanic': ['Jump start','Batteries / starters','Air system & brakes','Mobile welding'],
        'Tires': [], 'Trailer / Reefer': [], 'Fuel & Fluids': [], 'Other': ['Lockout']
      }), JSON.stringify({ wreckers: '3', rotator: 'Yes — 60 ton', service: '4', landoll: '1' }),
      JSON.stringify(['Hazmat certified','Rotator on fleet','24/7'])]);
    await q(`INSERT INTO provider_locations (user_id, label, lat, lng, radius_mi, phone)
      VALUES ($1,'Bakersfield, CA — HQ',35.3733,-119.0187,50,'(661) 555-8804'),
             ($1,'Fresno, CA — North yard',36.7378,-119.7871,75,'(559) 555-2210')`, [prov.id]);
    console.log('Seeded demo provider: (661) 555-8804 (approved)');
  }

  // Second provider, pending approval — so the admin queue has something in it
  let prov2 = await one('SELECT * FROM users WHERE phone=$1', ['+16615552210']);
  if (!prov2) {
    prov2 = await one(`INSERT INTO users (phone, role, name) VALUES ('+16615552210','provider','Valley Tire Rescue') RETURNING *`);
    await q(`INSERT INTO providers (user_id, name, dispatch_phone, email, services, approved)
      VALUES ($1,'Valley Tire Rescue','(661) 555-2210','help@valleytire.com',$2,FALSE)`,
      [prov2.id, JSON.stringify({ 'Tires': ['Roadside tire replacement','Tire repair / section','Mobile tire service'] })]);
    await q(`INSERT INTO provider_locations (user_id, label, lat, lng, radius_mi)
      VALUES ($1,'Bakersfield, CA',35.3733,-119.0187,60)`, [prov2.id]);
    await q(`INSERT INTO custom_services (user_id, name) VALUES ($1,'Mobile alignment')`, [prov2.id]);
    console.log('Seeded pending provider: Valley Tire Rescue (in your admin approval queue)');
  }

  console.log('\nSeed complete. Admin access: sign in with the phone number set as ADMIN_PHONE in your environment.');
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });

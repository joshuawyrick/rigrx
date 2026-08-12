// ============ Offline reverse geocoding ============
// Turns GPS coordinates into a readable area label a dispatcher can act on:
//   "Near Buttonwillow, CA"   or   "14 mi SW of Bakersfield, CA"
// No API key, no network call, no per-lookup cost.
//
// Coverage: heavy on California's Central Valley and the I-5 / 99 / 58 / 40 / 10
// truck corridors (RIGRX's launch region), plus major metros and truck-stop towns
// nationwide. To upgrade to nationwide street-level accuracy later, swap the body
// of areaLabel() for a Google/Mapbox reverse-geocode call — nothing else changes.

const PLACES = [
  // ---- California: Central Valley / I-5 / SR-99 / SR-58 corridors ----
  ['Bakersfield','CA',35.3733,-119.0187], ['Buttonwillow','CA',35.4003,-119.4718],
  ['Lost Hills','CA',35.6169,-119.6943], ['Shafter','CA',35.5005,-119.2718],
  ['Wasco','CA',35.5941,-119.3409], ['Delano','CA',35.7688,-119.2471],
  ['Taft','CA',35.1425,-119.4565], ['Tehachapi','CA',35.1322,-118.4489],
  ['Mojave','CA',35.0525,-118.1739], ['Boron','CA',35.0000,-117.6492],
  ['Arvin','CA',35.2091,-118.8281], ['McFarland','CA',35.6780,-119.2290],
  ['Tulare','CA',36.2077,-119.3473], ['Visalia','CA',36.3302,-119.2921],
  ['Fresno','CA',36.7378,-119.7871], ['Kingsburg','CA',36.5138,-119.5537],
  ['Selma','CA',36.5708,-119.6121], ['Coalinga','CA',36.1397,-120.3601],
  ['Kettleman City','CA',36.0088,-119.9612], ['Firebaugh','CA',36.8588,-120.4560],
  ['Los Banos','CA',37.0583,-120.8499], ['Madera','CA',36.9613,-120.0607],
  ['Merced','CA',37.3022,-120.4830], ['Turlock','CA',37.4947,-120.8466],
  ['Modesto','CA',37.6391,-120.9969], ['Manteca','CA',37.7974,-121.2161],
  ['Tracy','CA',37.7397,-121.4252], ['Stockton','CA',37.9577,-121.2908],
  ['Lodi','CA',38.1341,-121.2722], ['Sacramento','CA',38.5816,-121.4944],
  ['Woodland','CA',38.6785,-121.7733], ['Williams','CA',39.1546,-122.1492],
  ['Willows','CA',39.5243,-122.1936], ['Corning','CA',39.9277,-122.1792],
  ['Red Bluff','CA',40.1785,-122.2358], ['Redding','CA',40.5865,-122.3917],
  ['Weed','CA',41.4227,-122.3861], ['Yreka','CA',41.7354,-122.6345],
  // ---- California: Southern / coastal / desert ----
  ['Santa Clarita','CA',34.3917,-118.5426], ['Lancaster','CA',34.6868,-118.1542],
  ['Palmdale','CA',34.5794,-118.1165], ['Los Angeles','CA',34.0549,-118.2426],
  ['Long Beach','CA',33.7701,-118.1937], ['Ontario','CA',34.0633,-117.6509],
  ['San Bernardino','CA',34.1083,-117.2898], ['Riverside','CA',33.9806,-117.3755],
  ['Barstow','CA',34.8958,-117.0173], ['Baker','CA',35.2686,-116.0764],
  ['Needles','CA',34.8481,-114.6141], ['Victorville','CA',34.5362,-117.2928],
  ['Indio','CA',33.7206,-116.2156], ['Blythe','CA',33.6178,-114.5885],
  ['Palm Springs','CA',33.8303,-116.5453], ['Temecula','CA',33.4936,-117.1484],
  ['San Diego','CA',32.7157,-117.1611], ['Escondido','CA',33.1192,-117.0864],
  ['Santa Barbara','CA',34.4208,-119.6982], ['Santa Maria','CA',34.9530,-120.4357],
  ['San Luis Obispo','CA',35.2828,-120.6596], ['Paso Robles','CA',35.6266,-120.6910],
  ['Salinas','CA',36.6777,-121.6555], ['Gilroy','CA',37.0058,-121.5683],
  ['San Jose','CA',37.3382,-121.8863], ['Oakland','CA',37.8044,-122.2712],
  ['San Francisco','CA',37.7749,-122.4194], ['Vallejo','CA',38.1041,-122.2566],
  ['Fairfield','CA',38.2494,-122.0400], ['Santa Rosa','CA',38.4404,-122.7141],
  ['Ukiah','CA',39.1502,-123.2078], ['Eureka','CA',40.8021,-124.1637],
  ['El Centro','CA',32.7920,-115.5631], ['Bishop','CA',37.3614,-118.3951],
  // ---- Nevada / Arizona / Utah ----
  ['Las Vegas','NV',36.1699,-115.1398], ['Reno','NV',39.5296,-119.8138],
  ['Elko','NV',40.8324,-115.7631], ['Winnemucca','NV',40.9730,-117.7357],
  ['Ely','NV',39.2472,-114.8883], ['Mesquite','NV',36.8055,-114.0672],
  ['Phoenix','AZ',33.4484,-112.0740], ['Tucson','AZ',32.2226,-110.9747],
  ['Flagstaff','AZ',35.1983,-111.6513], ['Kingman','AZ',35.1894,-114.0530],
  ['Yuma','AZ',32.6927,-114.6277], ['Winslow','AZ',35.0242,-110.6974],
  ['Salt Lake City','UT',40.7608,-111.8910], ['Provo','UT',40.2338,-111.6585],
  ['St. George','UT',37.0965,-113.5684], ['Ogden','UT',41.2230,-111.9738],
  ['Cedar City','UT',37.6775,-113.0619], ['Green River','UT',38.9955,-110.1596],
  // ---- Pacific Northwest / Mountain ----
  ['Portland','OR',45.5152,-122.6784], ['Salem','OR',44.9429,-123.0351],
  ['Eugene','OR',44.0521,-123.0868], ['Medford','OR',42.3265,-122.8756],
  ['Bend','OR',44.0582,-121.3153], ['Pendleton','OR',45.6721,-118.7886],
  ['Seattle','WA',47.6062,-122.3321], ['Tacoma','WA',47.2529,-122.4443],
  ['Spokane','WA',47.6588,-117.4260], ['Yakima','WA',46.6021,-120.5059],
  ['Boise','ID',43.6150,-116.2023], ['Twin Falls','ID',42.5558,-114.4701],
  ['Idaho Falls','ID',43.4917,-112.0339], ['Missoula','MT',46.8721,-113.9940],
  ['Billings','MT',45.7833,-108.5007], ['Butte','MT',46.0038,-112.5348],
  ['Cheyenne','WY',41.1400,-104.8202], ['Casper','WY',42.8666,-106.3131],
  ['Rock Springs','WY',41.5875,-109.2029], ['Laramie','WY',41.3114,-105.5911],
  ['Denver','CO',39.7392,-104.9903], ['Colorado Springs','CO',38.8339,-104.8214],
  ['Grand Junction','CO',39.0639,-108.5506], ['Pueblo','CO',38.2544,-104.6091],
  ['Albuquerque','NM',35.0844,-106.6504], ['Las Cruces','NM',32.3199,-106.7637],
  ['Gallup','NM',35.5281,-108.7426], ['Santa Fe','NM',35.6870,-105.9378],
  ['Tucumcari','NM',35.1717,-103.7250],
  // ---- Texas / South Central ----
  ['El Paso','TX',31.7619,-106.4850], ['Odessa','TX',31.8457,-102.3676],
  ['Midland','TX',31.9973,-102.0779], ['Lubbock','TX',33.5779,-101.8552],
  ['Amarillo','TX',35.2220,-101.8313], ['Abilene','TX',32.4487,-99.7331],
  ['Fort Worth','TX',32.7555,-97.3308], ['Dallas','TX',32.7767,-96.7970],
  ['Waco','TX',31.5493,-97.1467], ['Austin','TX',30.2672,-97.7431],
  ['San Antonio','TX',29.4241,-98.4936], ['Houston','TX',29.7604,-95.3698],
  ['Beaumont','TX',30.0802,-94.1266], ['Laredo','TX',27.5306,-99.4803],
  ['Texarkana','TX',33.4251,-94.0477], ['Oklahoma City','OK',35.4676,-97.5164],
  ['Tulsa','OK',36.1540,-95.9928], ['Little Rock','AR',34.7465,-92.2896],
  ['Shreveport','LA',32.5252,-93.7502], ['Baton Rouge','LA',30.4515,-91.1871],
  ['New Orleans','LA',29.9511,-90.0715], ['Jackson','MS',32.2988,-90.1848],
  ['Wichita','KS',37.6872,-97.3301], ['Topeka','KS',39.0473,-95.6752],
  ['Salina','KS',38.8403,-97.6114], ['Kansas City','MO',39.0997,-94.5786],
  ['Springfield','MO',37.2090,-93.2923], ['St. Louis','MO',38.6270,-90.1994],
  ['Omaha','NE',41.2565,-95.9345], ['Lincoln','NE',40.8136,-96.7026],
  ['North Platte','NE',41.1239,-100.7654], ['Sioux Falls','SD',43.5460,-96.7313],
  ['Rapid City','SD',44.0805,-103.2310], ['Fargo','ND',46.8772,-96.7898],
  ['Bismarck','ND',46.8083,-100.7837],
  // ---- Midwest ----
  ['Des Moines','IA',41.5868,-93.6250], ['Davenport','IA',41.5236,-90.5776],
  ['Council Bluffs','IA',41.2619,-95.8608], ['Minneapolis','MN',44.9778,-93.2650],
  ['Duluth','MN',46.7867,-92.1005], ['Madison','WI',43.0731,-89.4012],
  ['Milwaukee','WI',43.0389,-87.9065], ['Eau Claire','WI',44.8113,-91.4985],
  ['Chicago','IL',41.8781,-87.6298], ['Rockford','IL',42.2711,-89.0940],
  ['Springfield','IL',39.7817,-89.6501], ['Effingham','IL',39.1200,-88.5434],
  ['Indianapolis','IN',39.7684,-86.1581], ['Gary','IN',41.5934,-87.3464],
  ['Fort Wayne','IN',41.0793,-85.1394], ['Detroit','MI',42.3314,-83.0458],
  ['Grand Rapids','MI',42.9634,-85.6681], ['Lansing','MI',42.7325,-84.5555],
  ['Toledo','OH',41.6528,-83.5379], ['Columbus','OH',39.9612,-82.9988],
  ['Cleveland','OH',41.4993,-81.6944], ['Cincinnati','OH',39.1031,-84.5120],
  ['Dayton','OH',39.7589,-84.1916], ['Louisville','KY',38.2527,-85.7585],
  ['Lexington','KY',38.0406,-84.5037], ['Nashville','TN',36.1627,-86.7816],
  ['Memphis','TN',35.1495,-90.0490], ['Knoxville','TN',35.9606,-83.9207],
  ['Chattanooga','TN',35.0456,-85.3097],
  // ---- East / Southeast ----
  ['Atlanta','GA',33.7490,-84.3880], ['Macon','GA',32.8407,-83.6324],
  ['Savannah','GA',32.0809,-81.0912], ['Jacksonville','FL',30.3322,-81.6557],
  ['Orlando','FL',28.5383,-81.3792], ['Tampa','FL',27.9506,-82.4572],
  ['Miami','FL',25.7617,-80.1918], ['Ocala','FL',29.1872,-82.1401],
  ['Tallahassee','FL',30.4383,-84.2807], ['Birmingham','AL',33.5186,-86.8104],
  ['Montgomery','AL',32.3668,-86.3000], ['Mobile','AL',30.6954,-88.0399],
  ['Charlotte','NC',35.2271,-80.8431], ['Raleigh','NC',35.7796,-78.6382],
  ['Greensboro','NC',36.0726,-79.7920], ['Columbia','SC',34.0007,-81.0348],
  ['Charleston','SC',32.7765,-79.9311], ['Richmond','VA',37.5407,-77.4360],
  ['Roanoke','VA',37.2710,-79.9414], ['Norfolk','VA',36.8508,-76.2859],
  ['Charleston','WV',38.3498,-81.6326], ['Pittsburgh','PA',40.4406,-79.9959],
  ['Harrisburg','PA',40.2732,-76.8867], ['Philadelphia','PA',39.9526,-75.1652],
  ['Scranton','PA',41.4090,-75.6624], ['Baltimore','MD',39.2904,-76.6122],
  ['Washington','DC',38.9072,-77.0369], ['Newark','NJ',40.7357,-74.1724],
  ['New York','NY',40.7128,-74.0060], ['Albany','NY',42.6526,-73.7562],
  ['Buffalo','NY',42.8864,-78.8784], ['Syracuse','NY',43.0481,-76.1474],
  ['Hartford','CT',41.7658,-72.6734], ['Providence','RI',41.8240,-71.4128],
  ['Boston','MA',42.3601,-71.0589], ['Portland','ME',43.6591,-70.2568],
  ['Manchester','NH',42.9956,-71.4548], ['Burlington','VT',44.4759,-73.2121]
];

const R_MILES = 3958.8;
const toRad = d => d * Math.PI / 180;

function distanceMiles(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.sqrt(a));
}

// Compass direction FROM the town TO the breakdown point
function bearingLabel(fromLat, fromLng, toLat, toLng) {
  const y = Math.sin(toRad(toLng - fromLng)) * Math.cos(toRad(toLat));
  const x = Math.cos(toRad(fromLat)) * Math.sin(toRad(toLat)) -
            Math.sin(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.cos(toRad(toLng - fromLng));
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return ['N','NE','E','SE','S','SW','W','NW'][Math.round(deg / 45) % 8];
}

function nearestPlace(lat, lng) {
  let best = null, bestD = Infinity;
  for (const p of PLACES) {
    const d = distanceMiles(lat, lng, p[2], p[3]);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best ? { name: best[0], state: best[1], miles: bestD } : null;
}

// The public label shown to providers before they buy.
function areaLabel(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return '';
  const p = nearestPlace(lat, lng);
  if (!p) return '';
  if (p.miles <= 8) return `Near ${p.name}, ${p.state}`;
  const dir = bearingLabel(
    PLACES.find(x => x[0] === p.name && x[1] === p.state)[2],
    PLACES.find(x => x[0] === p.name && x[1] === p.state)[3],
    lat, lng);
  return `${Math.round(p.miles)} mi ${dir} of ${p.name}, ${p.state}`;
}

module.exports = { areaLabel, nearestPlace, distanceMiles, PLACES };

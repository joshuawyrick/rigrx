// ============ Equipment reference lists ============
// Everything a driver or company would otherwise have to type. Ordered by real-world
// frequency so the common answer is near the top of the list.
//
// Sources for the ordering:
//  - Tire sizes: U.S. Tire Manufacturers Association share data (295/75R22.5 and
//    11R22.5 together are roughly half of all commercial fitments; 225/70R19.5 leads
//    medium duty).
//  - Class 8 makes: US sales volume — Freightliner ~1/3 of the market, then Peterbilt,
//    Kenworth, International, Volvo, Mack, Western Star.
//  - Class ranges: FHWA/industry standard GVWR classes 1-8.
//
// Every list is a suggestion, never a restriction — the UI always offers "Other…".

const DUTY_CLASSES = [
  { key: 'heavy',  label: 'Heavy duty',  blurb: 'Class 7–8 · semi tractors, big rigs' },
  { key: 'medium', label: 'Medium duty', blurb: 'Class 4–6 · box trucks, dumps, service trucks' },
  { key: 'light',  label: 'Light duty',  blurb: 'Class 1–3 · pickups, cargo vans' }
];

const MAKES = {
  heavy: ['Freightliner','Peterbilt','Kenworth','International','Volvo','Mack','Western Star','Autocar'],
  medium: ['Freightliner','International','Hino','Isuzu','Ford','Ram','Chevrolet','GMC','Kenworth','Peterbilt','Mack','Mitsubishi Fuso'],
  light: ['Ford','Ram','Chevrolet','GMC','Toyota','Nissan','Mercedes-Benz']
};

// Typed as suggestions under the make — models change yearly so this is never a hard list
const MODELS = {
  'Freightliner': ['Cascadia','Coronado','122SD','114SD','M2 106','M2 112','108SD','114SD'],
  'Peterbilt': ['579','389','567','520','337','348','325','365'],
  'Kenworth': ['T680','W900','T880','W990','T270','T280','T380','T480','K370'],
  'International': ['LT','LoneStar','HX','RH','MV','CV','HV','DuraStar'],
  'Volvo': ['VNL','VNR','VNX','VHD'],
  'Mack': ['Anthem','Pinnacle','Granite','MD6','MD7'],
  'Western Star': ['57X','49X','47X','4900','5700XE'],
  'Hino': ['L6','L7','M5','268','338'],
  'Isuzu': ['NPR','NPR-HD','NQR','NRR','FTR','FVR'],
  'Ford': ['F-450','F-550','F-650','F-750','E-350','E-450','Transit'],
  'Ram': ['3500','4500','5500'],
  'Chevrolet': ['Silverado 4500HD','Silverado 5500HD','Silverado 6500HD','Express'],
  'GMC': ['Sierra 3500','Savana']
};

const ENGINES = {
  heavy: ['Cummins X15','Cummins X12','Detroit DD15','Detroit DD13','Detroit DD16',
          'Paccar MX-13','Paccar MX-11','Volvo D13','Volvo D11','Volvo D16',
          'Mack MP8','Mack MP7','International A26','Caterpillar C15'],
  medium: ['Cummins B6.7','Cummins L9','Paccar PX-7','Paccar PX-9','Detroit DD5','Detroit DD8',
           'International A26','Hino J08','Isuzu 4HK1','Isuzu 6HK1','Ford Power Stroke 6.7','GM Duramax 6.6'],
  light: ['Ford Power Stroke 6.7','GM Duramax 6.6','Ram Cummins 6.7','Gas V8']
};

const TRANSMISSIONS = {
  heavy: ['Eaton Fuller 10-speed manual','Eaton Fuller 13-speed manual','Eaton Fuller 18-speed manual',
          'Eaton Endurant (automated)','Eaton UltraShift (automated)','Detroit DT12 (automated)',
          'Volvo I-Shift (automated)','Mack mDRIVE (automated)','Paccar TX-12 (automated)','Allison automatic'],
  medium: ['Allison automatic','Eaton Fuller 6-speed manual','Eaton Fuller 10-speed manual',
           'Aisin automatic','Ford TorqShift automatic','Paccar TX-8 (automated)'],
  light: ['Automatic','Manual']
};

const AXLE_CONFIGS = {
  heavy: ['6x4 tandem drive','6x2 tandem drive','4x2 single drive','8x4 tridem','6x6 all-wheel drive','Tandem with lift axle'],
  medium: ['4x2 single rear axle','6x4 tandem drive','4x4 all-wheel drive','Single axle with tag'],
  light: ['4x2 (2WD)','4x4 (4WD)','Dually rear']
};

// Ordered by market share — the first two cover roughly half of all commercial trucks
const TIRE_SIZES = {
  heavy: ['295/75R22.5','11R22.5','275/80R22.5','11R24.5','285/75R24.5','315/80R22.5',
          '385/65R22.5','425/65R22.5','445/50R22.5 (super single)','455/55R22.5 (super single)','12R22.5','255/70R22.5'],
  medium: ['225/70R19.5','245/70R19.5','265/70R19.5','285/70R19.5','215/75R17.5','235/75R17.5',
           '245/75R17.5','11R22.5','225/75R16','245/70R17.5'],
  light: ['LT245/75R16','LT265/70R17','LT245/75R17','LT235/80R17','LT275/70R18','LT225/75R16']
};

const WHEEL_TYPES = ['Aluminum','Steel','Mixed (aluminum outer, steel inner)','Polished aluminum'];

const TRUCK_COLORS = ['White','Black','Red','Blue','Gray','Silver','Green','Maroon','Orange','Yellow','Brown','Two-tone'];

const TRAILER_TYPES = [
  'Dry van','Reefer','Flatbed','Step deck','Double drop','Lowboy / RGN','Container chassis',
  'Tanker — crude','Tanker — fuel','Tanker — chemical','Tanker — food grade','Pneumatic dry bulk',
  'Vacuum tanker','End dump','Side dump','Belly dump','Walking floor','Hopper','Livestock',
  'Auto transport','Conestoga','Curtain side','Logging','Dolly / converter','None — bobtail'
];

const TRAILER_LENGTHS = ["53'","48'","45'","42'","40'","32'","28'","20'","Multiple / varies"];

const TRAILER_AXLES = ['Tandem','Spread tandem','Tridem','Single axle','Quad axle','Tandem with lift axle'];

const SUSPENSIONS = ['Air ride','Spring','Walking beam','Air ride with lift axle'];

const REEFER_MAKES = ['Thermo King','Carrier','Utility','Klinge','Zanotti'];

const HAZMAT_CLASSES = [
  '1 — Explosives','2 — Gases','2.1 — Flammable gas','2.2 — Non-flammable gas','2.3 — Toxic gas',
  '3 — Flammable liquid','4 — Flammable solid','5.1 — Oxidizer','5.2 — Organic peroxide',
  '6.1 — Toxic','7 — Radioactive','8 — Corrosive','9 — Miscellaneous'
];

const DOOR_TYPES =['Swing doors','Roll-up door','Curtain side','Open deck','No doors'];

const TRUCK_EXTRAS = ['APU','Wet kit / PTO','Inverter','Sleeper','Day cab','Headache rack','Chains on board'];

// Which duty classes a service company will work on
const SERVED_CLASSES = [
  { key: 'heavy',  label: 'Heavy duty (Class 7–8)' },
  { key: 'medium', label: 'Medium duty (Class 4–6)' },
  { key: 'light',  label: 'Light duty (Class 1–3)' }
];

module.exports = {
  DUTY_CLASSES, MAKES, MODELS, ENGINES, TRANSMISSIONS, AXLE_CONFIGS, TIRE_SIZES,
  WHEEL_TYPES, TRUCK_COLORS, TRAILER_TYPES, TRAILER_LENGTHS, TRAILER_AXLES,
  SUSPENSIONS, REEFER_MAKES, DOOR_TYPES, TRUCK_EXTRAS, SERVED_CLASSES, HAZMAT_CLASSES
};

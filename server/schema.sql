-- ============ RIGRX database schema (PostgreSQL) ============
-- Runs automatically on server boot (CREATE TABLE IF NOT EXISTS is idempotent).

CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  phone       TEXT UNIQUE NOT NULL,          -- E.164-ish, the primary identity
  role        TEXT NOT NULL DEFAULT 'driver',-- driver | provider | admin
  name        TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  driver_type TEXT NOT NULL DEFAULT '',      -- Owner-operator | Company driver | Fleet dispatcher
  company     TEXT NOT NULL DEFAULT '',      -- driver's company / MC-DOT
  rating_sum  INTEGER NOT NULL DEFAULT 0,    -- driver rating (as rated by providers)
  rating_count INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id         SERIAL PRIMARY KEY,
  phone      TEXT NOT NULL,
  code       TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trucks (
  id       SERIAL PRIMARY KEY,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data     JSONB NOT NULL DEFAULT '{}',      -- unit, year, make, model, engine, trans, axles, steer, drive, wheels, color, vin, extras[]
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trailers (
  id       SERIAL PRIMARY KEY,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data     JSONB NOT NULL DEFAULT '{}',      -- type, num, len, axles, tires, reefer, liftgate, door, hazmat{}, ...
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS providers (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  dispatch_phone TEXT NOT NULL DEFAULT '',
  after_phone    TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  hours      TEXT NOT NULL DEFAULT '24 / 7',
  services   JSONB NOT NULL DEFAULT '{}',    -- {category: [service, ...]}
  equipment  JSONB NOT NULL DEFAULT '{}',
  verification JSONB NOT NULL DEFAULT '{}',  -- {license, coi_file, w9_file}
  approved   BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_customer TEXT NOT NULL DEFAULT '',
  card_last4 TEXT NOT NULL DEFAULT '',
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  jobs_won   INTEGER NOT NULL DEFAULT 0,
  badges     JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_locations (
  id        SERIAL PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES providers(user_id) ON DELETE CASCADE,
  label     TEXT NOT NULL DEFAULT '',        -- "Bakersfield, CA — HQ"
  lat       DOUBLE PRECISION NOT NULL,
  lng       DOUBLE PRECISION NOT NULL,
  radius_mi INTEGER NOT NULL DEFAULT 50,
  phone     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS custom_services (
  id        SERIAL PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES providers(user_id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lead pricing per service category (admin-editable)
CREATE TABLE IF NOT EXISTS pricing (
  service_key   TEXT PRIMARY KEY,            -- towing | tires | wontstart | mechanic | trailer | fuel | lockout | other
  label         TEXT NOT NULL,
  standard_cents INTEGER NOT NULL,           -- price per standard slot (x3)
  premium_cents  INTEGER NOT NULL            -- price for the 4th forced slot
);

CREATE TABLE IF NOT EXISTS requests (
  id          SERIAL PRIMARY KEY,
  driver_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_key TEXT NOT NULL,
  service_label TEXT NOT NULL,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  area_label  TEXT NOT NULL DEFAULT '',      -- coarse public area, e.g. "Near Buttonwillow, CA on I-5"
  landmark    TEXT NOT NULL DEFAULT '',      -- exact free-text location (unlocked buyers only)
  situation   JSONB NOT NULL DEFAULT '[]',   -- flags
  can_move    TEXT NOT NULL DEFAULT 'no',
  description TEXT NOT NULL DEFAULT '',
  photos      JSONB NOT NULL DEFAULT '[]',
  truck       JSONB NOT NULL DEFAULT '{}',   -- snapshot
  trailer     JSONB NOT NULL DEFAULT '{}',   -- snapshot
  status      TEXT NOT NULL DEFAULT 'open',  -- open | selected | completed | cancelled | expired
  selected_provider INTEGER,
  notified_count INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchases (
  id          SERIAL PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES providers(user_id) ON DELETE CASCADE,
  slot        INTEGER NOT NULL,              -- 1..4 (4 = premium)
  amount_cents INTEGER NOT NULL,
  premium     BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_payment TEXT NOT NULL DEFAULT '',   -- payment intent id or 'simulated'
  refunded    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, provider_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id          SERIAL PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL,              -- thread key: request x provider
  sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  quote       JSONB,                          -- {amount_cents, eta, note} for structured quotes
  read_by_recipient BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  id          SERIAL PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_provider INTEGER,                   -- set when driver reviews provider
  target_driver   INTEGER,                   -- set when provider reviews driver
  stars       INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags        JSONB NOT NULL DEFAULT '[]',
  comment     TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS notifications_log (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER,
  channel    TEXT NOT NULL,                  -- sms | email | push | ws
  body       TEXT NOT NULL,
  simulated  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- migrations for existing databases (safe to re-run) ----
-- License verification is SEPARATE from approval: a provider can be approved
-- (allowed on the platform) without a verified license. Drivers choose whether
-- their request goes to licensed-only companies or all approved ones.
ALTER TABLE providers ADD COLUMN IF NOT EXISTS license_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS license_verified_at TIMESTAMPTZ;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS admin_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE requests  ADD COLUMN IF NOT EXISTS licensed_only BOOLEAN NOT NULL DEFAULT FALSE;
-- Exact failed tire: {axle, side, position, size, wheel, problem}
ALTER TABLE requests  ADD COLUMN IF NOT EXISTS tire_position JSONB;
-- Provider yes/no capability flags used for matching precision and lead warnings
ALTER TABLE providers ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{}';
ALTER TABLE users     ADD COLUMN IF NOT EXISTS prefer_licensed_only BOOLEAN NOT NULL DEFAULT FALSE;

-- ============ Admin-managed service catalog ============
-- One catalog drives three things: the driver's request buttons, the provider's
-- capability checklist, and the matching between them. Categories are switched
-- off rather than deleted so historical requests keep their labels.
CREATE TABLE IF NOT EXISTS service_categories (
  id            SERIAL PRIMARY KEY,
  key           TEXT UNIQUE NOT NULL,        -- stable slug; provider selections key off this so names can change
  label         TEXT NOT NULL,
  icon          TEXT NOT NULL DEFAULT 'box',
  blurb         TEXT NOT NULL DEFAULT '',    -- the small line under the driver's button
  driver_visible BOOLEAN NOT NULL DEFAULT TRUE,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_items (
  id          SERIAL PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_items_category ON service_items(category_id);

-- What kind of shop a company is. One pick during onboarding both badges them
-- and pre-checks the services that trade normally performs.
CREATE TABLE IF NOT EXISTS provider_trades (
  id         SERIAL PRIMARY KEY,
  key        TEXT UNIQUE NOT NULL,
  label      TEXT NOT NULL,
  icon       TEXT NOT NULL DEFAULT 'wrench',
  blurb      TEXT NOT NULL DEFAULT '',
  presets    JSONB NOT NULL DEFAULT '{}',   -- {category_key: [service labels]} pre-checked on pick
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE providers ADD COLUMN IF NOT EXISTS primary_trade TEXT NOT NULL DEFAULT '';
-- Driver may narrow a request to companies whose main work is one of these
ALTER TABLE requests ADD COLUMN IF NOT EXISTS trade_filter JSONB NOT NULL DEFAULT '[]';

-- The driver's optional "what kind?" refinement
ALTER TABLE requests ADD COLUMN IF NOT EXISTS service_item TEXT NOT NULL DEFAULT '';
-- Which category an approved custom service was folded into
ALTER TABLE custom_services ADD COLUMN IF NOT EXISTS promoted_category INTEGER;

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_purchases_request ON purchases(request_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(request_id, provider_id);
CREATE INDEX IF NOT EXISTS idx_locations_user ON provider_locations(user_id);

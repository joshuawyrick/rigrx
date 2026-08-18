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
-- Which truck sizes a company will work on: ["heavy","medium","light"]
-- Which truck sizes a company works on. Defaults to heavy + medium because most
-- commercial shops take both, and a too-narrow default silently starves them of leads.
ALTER TABLE providers ADD COLUMN IF NOT EXISTS duty_classes JSONB NOT NULL DEFAULT '["heavy","medium"]';
ALTER TABLE providers ALTER COLUMN duty_classes SET DEFAULT '["heavy","medium"]';
-- One-time widening for companies created before medium duty existed. Runs once,
-- tracked in app_flags, so a company that later chooses heavy-only stays heavy-only.
CREATE TABLE IF NOT EXISTS app_flags (key TEXT PRIMARY KEY, set_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_flags WHERE key = 'duty_widen_v1') THEN
    UPDATE providers SET duty_classes = '["heavy","medium"]' WHERE duty_classes = '["heavy"]';
    INSERT INTO app_flags (key) VALUES ('duty_widen_v1');
  END IF;
END $$;
-- Duty class of the rig on a request, so a box truck never gets a Class 8 wrecker
ALTER TABLE requests  ADD COLUMN IF NOT EXISTS duty_class TEXT NOT NULL DEFAULT 'heavy';

-- Whatever people type into an "Other…" box, so the dropdown lists can be
-- improved from real usage instead of guesswork.
CREATE TABLE IF NOT EXISTS other_entries (
  id         SERIAL PRIMARY KEY,
  field      TEXT NOT NULL,
  value      TEXT NOT NULL,
  duty_class TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_other_field ON other_entries(field);
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

-- Companies that found the recruiting page from outside a live coverage area.
-- Where they sign up is how we decide which corridor to open next.
CREATE TABLE IF NOT EXISTS waitlist (
  id         SERIAL PRIMARY KEY,
  company    TEXT NOT NULL DEFAULT '',
  contact    TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  city       TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT '',
  trade      TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  contacted  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Archived accounts: cannot sign in, invisible to matching and to every admin list
-- by default, but every record they touched stays intact. Reversible on purpose —
-- there is no delete, because deleting a user would cascade away purchases other
-- companies paid for and quietly rewrite the revenue history.
ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS archive_reason TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_users_archived ON users(archived_at);

-- ---- company people (owner / dispatcher / tech) ----
-- A service company is more than one login. The owner runs the account, dispatchers
-- take the lead alerts for their yard and hand work out, and techs only ever see the
-- job they were given. Everyone signs in with their own phone — no shared logins and
-- no passwords, because the one credential a tech always has on a call is their phone.
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS member_role TEXT NOT NULL DEFAULT '';   -- owner | dispatcher | tech
ALTER TABLE users ADD COLUMN IF NOT EXISTS assignable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS member_location_id INTEGER;             -- which yard they work out of
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);

-- Existing provider accounts become the owner of their own company.
UPDATE users u SET company_id = u.id, member_role = 'owner', assignable = TRUE
  WHERE u.role = 'provider' AND u.company_id IS NULL;

-- ---- the job, once a driver has chosen a company ----
-- A won lead becomes a job that moves through assign -> accept -> on my way ->
-- arrived -> complete. Those timestamps are also where response-time data comes from.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS assigned_tech  INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS assigned_at    TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS accepted_at    TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS enroute_at     TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS arrived_at     TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS completed_at   TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS eta_minutes    INTEGER;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS eta_set_at     TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS assign_bounced BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_requests_tech ON requests(assigned_tech);

-- ---- direction of travel ----
-- A shop quoting a job on a divided highway needs to know which side you're on.
-- It's the one thing they legitimately had to ask for in chat, so we put it in the
-- lead instead: give them every honest reason to not ask, and the ones who ask
-- anyway stand out.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT '';

-- ---- chat guard flags ----
-- Nothing here blocks a message. This is a review queue: the server judges every
-- message the same way the browser did, so a company that dismisses the warning
-- (or scripts around it) still lands in the admin's list.
CREATE TABLE IF NOT EXISTS chat_flags (
  id          SERIAL PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL DEFAULT '',        -- driver | provider
  type        TEXT NOT NULL,                   -- ask | share | offplatform
  kind        TEXT NOT NULL DEFAULT '',        -- which pattern matched
  snippet     TEXT NOT NULL DEFAULT '',        -- the matched words only, for review
  warned      BOOLEAN NOT NULL DEFAULT FALSE,  -- did we warn them and they sent anyway?
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_flags_open ON chat_flags(reviewed_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_flags_provider ON chat_flags(provider_id);

-- ---- languages ----
-- The language belongs to the PERSON, not the company: one shop can have an
-- English-speaking owner and a Spanish-speaking tech. Stored so text messages
-- reach people in their own language even before they open the app.
ALTER TABLE users ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT '';
-- A company that answers dispatch calls in Spanish can say so; drivers see the
-- badge when comparing responders — language becomes a reason to win the job.
ALTER TABLE providers ADD COLUMN IF NOT EXISTS spanish_dispatch BOOLEAN NOT NULL DEFAULT FALSE;

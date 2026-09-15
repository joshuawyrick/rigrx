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
ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_by_company BOOLEAN NOT NULL DEFAULT FALSE;
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

-- ---- free lead credits ----
-- The "first 10 leads free" offer, as a real feature: the admin grants credits,
-- and buying a lead spends a credit before any card is ever touched. A credit
-- purchase records amount_cents = 0, so revenue numbers stay honest.
ALTER TABLE providers ADD COLUMN IF NOT EXISTS lead_credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS paid_with TEXT NOT NULL DEFAULT 'card';  -- card | credit
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS list_price_cents INTEGER;                -- what it WOULD have cost
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'succeeded'; -- pending | succeeded | failed
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_error TEXT NOT NULL DEFAULT '';
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS refund_status TEXT NOT NULL DEFAULT 'none'; -- none | pending | succeeded | failed
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS refund_idempotency_key TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS stripe_refund TEXT;
UPDATE purchases SET refund_status='succeeded'
  WHERE refunded=TRUE AND refund_status='none';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM purchases
    WHERE refunded=FALSE AND status IN ('pending','succeeded')
    GROUP BY request_id HAVING COUNT(*) > 4
  ) THEN
    RAISE EXCEPTION 'Cannot secure purchase slots: a legacy request has more than four active purchases';
  END IF;
END $$;
WITH problematic_requests AS (
  SELECT request_id
  FROM purchases
  WHERE refunded=FALSE AND status IN ('pending','succeeded')
  GROUP BY request_id
  HAVING COUNT(*) <> COUNT(DISTINCT slot)
     OR MIN(slot) < 1 OR MAX(slot) > 4
), ranked AS (
  SELECT p.id,
         ROW_NUMBER() OVER (
           PARTITION BY p.request_id
           ORDER BY p.premium ASC, p.created_at ASC, p.id ASC
         ) AS safe_slot
  FROM purchases p
  JOIN problematic_requests bad ON bad.request_id=p.request_id
  WHERE p.refunded=FALSE AND p.status IN ('pending','succeeded')
)
UPDATE purchases p SET slot=ranked.safe_slot
FROM ranked WHERE p.id=ranked.id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchases_active_slot
  ON purchases(request_id, slot) WHERE refunded=FALSE AND status IN ('pending','succeeded');
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchases_idempotency
  ON purchases(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchases_refund_idempotency
  ON purchases(refund_idempotency_key) WHERE refund_idempotency_key IS NOT NULL;
DO $$
BEGIN
  ALTER TABLE purchases ADD CONSTRAINT purchases_slot_range CHECK (slot BETWEEN 1 AND 4);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE purchases ADD CONSTRAINT purchases_amount_nonnegative CHECK (amount_cents >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE purchases ADD CONSTRAINT purchases_payment_kind CHECK (paid_with IN ('card','credit'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE purchases ADD CONSTRAINT purchases_status_valid CHECK (status IN ('pending','succeeded','failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE purchases ADD CONSTRAINT purchases_refund_status_valid
    CHECK (refund_status IN ('none','pending','succeeded','failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS credit_log (
  id          SERIAL PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(user_id) ON DELETE CASCADE,
  delta       INTEGER NOT NULL,               -- +10 granted, -1 spent, +1 refund
  reason      TEXT NOT NULL DEFAULT '',       -- 'beta welcome' | 'spent on lead #12' | ...
  by_admin    BOOLEAN NOT NULL DEFAULT FALSE,
  event_key   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_log_provider ON credit_log(provider_id);
ALTER TABLE credit_log ADD COLUMN IF NOT EXISTS event_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_log_event ON credit_log(event_key) WHERE event_key IS NOT NULL;

-- ---- stripe customer ----
ALTER TABLE providers ADD COLUMN IF NOT EXISTS stripe_customer TEXT NOT NULL DEFAULT '';
ALTER TABLE providers ADD COLUMN IF NOT EXISTS card_brand TEXT NOT NULL DEFAULT '';

-- ---- sign-in code rate limiting ----
-- Once Twilio is live every code is a real text that costs real money, so both
-- directions get a ceiling: how fast codes can be requested, and how many wrong
-- guesses a code survives.
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_otp_phone_created ON otp_codes(phone, created_at DESC);
ALTER TABLE providers ADD COLUMN IF NOT EXISTS stripe_pm TEXT NOT NULL DEFAULT '';

-- ---- admin-tunable settings ----
-- Small key/value store for numbers the admin should be able to change without a
-- code change. First use: how many free lead credits the welcome button grants.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
INSERT INTO settings (key, value) VALUES ('welcome_credits', '5') ON CONFLICT (key) DO NOTHING;

-- ---- closing the loop ----
ALTER TABLE requests ADD COLUMN IF NOT EXISTS selected_at    TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS silent_alerted BOOLEAN NOT NULL DEFAULT FALSE;  -- admin was texted: nobody bought
ALTER TABLE requests ADD COLUMN IF NOT EXISTS stall_alerted  BOOLEAN NOT NULL DEFAULT FALSE;  -- company was nudged: won it, hasn't moved
ALTER TABLE requests ADD COLUMN IF NOT EXISTS expire_warned  BOOLEAN NOT NULL DEFAULT FALSE;  -- driver was warned before auto-close
-- Dispatch is an explicit state machine. assignment_version fences a technician's
-- delayed tap against a later reassignment, including reassignment back to that same person.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS job_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS assignment_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS assignment_bounces INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS declined_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS decline_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS job_activity_at TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS rescue_requested_at TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS rescue_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS rescue_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS silent_alert_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS stall_alert_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS late_update_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS selection_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS reopen_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ;
-- A manual city is deliberately distinguishable from live GPS so everyone knows to
-- rely on the driver's landmark or mile marker for the final approach.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS location_source TEXT NOT NULL DEFAULT 'device';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS location_captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE requests ADD COLUMN IF NOT EXISTS location_accuracy_m DOUBLE PRECISION;
UPDATE requests SET job_state = CASE
  WHEN status='completed' OR completed_at IS NOT NULL THEN 'completed'
  WHEN status<>'selected' THEN 'none'
  WHEN arrived_at IS NOT NULL THEN 'arrived'
  WHEN enroute_at IS NOT NULL THEN 'enroute'
  WHEN accepted_at IS NOT NULL THEN 'accepted'
  WHEN assigned_tech IS NOT NULL THEN 'assigned'
  ELSE 'unassigned'
END
WHERE job_state='none' AND (status='selected' OR completed_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_requests_job_state ON requests(status, job_state, job_activity_at);
DO $$
BEGIN
  ALTER TABLE requests ADD CONSTRAINT requests_job_state_valid
    CHECK (job_state IN ('none','unassigned','assigned','accepted','enroute','arrived','completed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE requests ADD CONSTRAINT requests_location_source_valid
    CHECK (location_source IN ('device','manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS job_events (
  id                 BIGSERIAL PRIMARY KEY,
  request_id         INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  event_type         TEXT NOT NULL,
  from_state         TEXT NOT NULL DEFAULT '',
  to_state           TEXT NOT NULL DEFAULT '',
  actor_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_tech      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assignment_version INTEGER NOT NULL DEFAULT 0,
  detail             JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_events_request ON job_events(request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dispatch_commands (
  id BIGSERIAL PRIMARY KEY,
  command_key TEXT NOT NULL UNIQUE,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  command_type TEXT NOT NULL,
  expected_assignment_version INTEGER NOT NULL,
  result_assignment_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dispatch_commands_request
  ON dispatch_commands(request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lead_eligibility (
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES providers(user_id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES provider_locations(id) ON DELETE SET NULL,
  distance_mi NUMERIC NOT NULL,
  match_identity TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (request_id, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_eligibility_provider
  ON lead_eligibility(provider_id, request_id);

CREATE TABLE IF NOT EXISTS dispatch_exceptions (
  id          BIGSERIAL PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  provider_id INTEGER REFERENCES providers(user_id) ON DELETE SET NULL,
  tech_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  detail      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution  TEXT NOT NULL DEFAULT ''
);
ALTER TABLE dispatch_exceptions ADD COLUMN IF NOT EXISTS occurrence INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_exception_open
  ON dispatch_exceptions(request_id, type) WHERE status IN ('open','acknowledged');
CREATE INDEX IF NOT EXISTS idx_dispatch_exceptions_queue
  ON dispatch_exceptions(status, created_at DESC);

-- Older releases let owner/dispatcher accounts receive jobs. Pre-arrival work
-- returns to dispatch because those accounts cannot use technician actions now.
-- Arrived work stays on scene and the driver can complete it; treating it as an
-- ordinary unassigned job would risk dispatching a second technician.
INSERT INTO job_events
  (request_id,event_type,from_state,to_state,actor_id,assignment_version,detail)
SELECT r.id, 'legacy_assignment_recovered', r.job_state, 'unassigned', NULL,
  r.assignment_version + 1,
  jsonb_build_object('previous_tech_id', r.assigned_tech, 'migration', TRUE)
FROM requests r
WHERE r.status='selected' AND r.job_state IN ('assigned','accepted','enroute')
  AND NOT EXISTS (
    SELECT 1 FROM users tech
    WHERE tech.id=r.assigned_tech AND tech.archived_at IS NULL
      AND tech.member_role IN ('tech','owner','dispatcher') AND tech.assignable=TRUE
      AND tech.company_id=r.selected_provider
  );

WITH recovered AS (
  UPDATE requests r SET job_state='unassigned', assigned_tech=NULL,
    assigned_at=NULL, accepted_at=NULL, enroute_at=NULL, arrived_at=NULL,
    eta_minutes=NULL, eta_set_at=NULL, assignment_version=assignment_version+1,
    assignment_bounces=assignment_bounces+1, assign_bounced=TRUE,
    bounced_at=NOW(), decline_reason='Legacy assignment required recovery',
    job_activity_at=NOW(), stall_alerted=FALSE
  WHERE r.status='selected' AND r.job_state IN ('assigned','accepted','enroute')
    AND NOT EXISTS (
      SELECT 1 FROM users tech
      WHERE tech.id=r.assigned_tech AND tech.archived_at IS NULL
        AND tech.member_role IN ('tech','owner','dispatcher') AND tech.assignable=TRUE
        AND tech.company_id=r.selected_provider
    )
  RETURNING r.id, r.selected_provider
)
INSERT INTO dispatch_exceptions
  (request_id,type,provider_id,status,detail)
SELECT id, 'assignment_bounced', selected_provider, 'open',
  jsonb_build_object('reason','legacy_assignment_recovered')
FROM recovered
ON CONFLICT (request_id,type) WHERE status IN ('open','acknowledged')
DO UPDATE SET status='open', provider_id=EXCLUDED.provider_id,
  detail=EXCLUDED.detail, occurrence=dispatch_exceptions.occurrence+1,
  updated_at=NOW();

-- notifications_log is also the durable delivery outbox. Legacy rows represent
-- already-recorded sends; new rows move pending -> sending -> sent/dead with retries.
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL;
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}';
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS claim_token TEXT;
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS last_error TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS provider_message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe
  ON notifications_log(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_delivery
  ON notifications_log(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_request
  ON notifications_log(request_id, created_at DESC);
ALTER TABLE notifications_log DROP CONSTRAINT IF EXISTS notifications_status_valid;
ALTER TABLE notifications_log ADD CONSTRAINT notifications_status_valid
  CHECK (status IN ('pending','sending','sent','dead','superseded'));

-- Shops rating drivers: one rating per company per job. Rolls up onto the
-- driver's rating shown on every lead ('as rated by providers').
CREATE TABLE IF NOT EXISTS driver_ratings (
  id          SERIAL PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES providers(user_id) ON DELETE CASCADE,
  driver_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stars       INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, provider_id)
);

-- Uploads are private application data. Files are served only after the API verifies
-- the signed-in user's relationship to the owner, request, or provider dossier.
CREATE TABLE IF NOT EXISTS uploads (
  file_name     TEXT PRIMARY KEY,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime_type     TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_uploads_owner ON uploads(owner_id);

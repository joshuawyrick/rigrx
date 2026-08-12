# RIGRX

**Emergency roadside service marketplace for trucks.** Drivers request help in seconds; qualified service companies nearby get text alerts, buy the lead (3 standard slots + 1 premium slot, max 4), unlock the driver's location and info, and chat instantly to win the job.

Built with Node.js + Express + PostgreSQL + WebSockets. No build step — deploys anywhere Node runs.

---

## What's inside

| Piece | Where | What it does |
|---|---|---|
| API server | `server/index.js`, `server/routes.js` | Accounts, garage, requests, lead matching, purchases, chat, reviews, admin |
| Auth | `server/auth.js` | Phone-number sign-in with texted codes (no passwords) |
| Matching engine | `server/match.js` | Finds approved providers whose service radius covers the breakdown + who offer that service; auto-expands if none |
| Payments | `server/payments.js` | Stripe charges for lead unlocks. **No Stripe keys = simulation mode** (purchases succeed, marked simulated) |
| Notifications | `server/notify.js` | Twilio SMS + live WebSocket pushes. **No Twilio keys = simulation mode** (texts print to the console, sign-in codes show on screen) |
| Database schema | `server/schema.sql` | Creates all tables automatically on first boot |
| Seed data | `server/seed.js` | Demo driver, approved demo provider, pending provider for your admin queue |
| Front-end | `public/` | The full app — sign-in, driver + company onboarding, dashboards, chat, admin panel |
| Geocoding | `server/geo.js` | Turns GPS into a readable area ("Near Buttonwillow, CA") with no API key or cost |

## The three roles

- **Driver** — free. Signs in with their phone, saves trucks/trailers to "My Garage," requests help, compares up to 4 responders, chats, picks one, rates them.
- **Service company** — builds a profile (multiple locations each with its own radius, full service checklist + custom services, equipment, license/COI uploads), waits for your approval, then gets lead alerts and buys leads.
- **Admin (you)** — the phone number in the `ADMIN_PHONE` secret gets the admin panel on sign-in: provider review & approval, license verification, lead pricing, refunds, custom-service approvals, marketplace metrics.

## Approval vs. license verification (two separate switches)

| Switch | What it controls | Who can be it |
|---|---|---|
| **Approved** | Can see leads and buy them at all | Any vetted company, licensed or not |
| **License verified** | Also receives requests from drivers who chose "licensed companies only" | Companies whose license/insurance you've checked |

Click any company in **Providers** to open its full dossier: contact info, every coverage location with radius, all services offered, custom service requests, equipment, license number, clickable COI and W-9 documents, lead-spend history, driver reviews, and your own private notes. A banner lists any onboarding fields they left blank. Approve and verify independently from that page.

Drivers pick **All approved companies** (default) or **Licensed companies only** on every request, and the choice is remembered. If a licensed-only request finds nobody, the driver gets a one-tap "send to all approved companies instead" button so they're never stranded without responders.

---

## Deploying: GitHub → Replit (step by step)

### Step 1 — put the code on GitHub
1. Create a free account at github.com if you don't have one.
2. Click **+** (top right) → **New repository** → name it `rigrx` → keep it **Private** → Create.
3. On the empty repo page click **uploading an existing file**, drag ALL the files/folders from this project in (keep the folder structure), and click **Commit changes**.
   *(If you use git on your computer instead: `git init && git add . && git commit -m "RIGRX v1" && git remote add origin <your repo url> && git push -u origin main`)*

### Step 2 — import into Replit
1. In Replit click **Create Repl** → **Import from GitHub** → pick your `rigrx` repo.
2. Replit detects Node.js automatically. The run command is `npm start`.

### Step 3 — add a database
1. In your Repl, open the **PostgreSQL** tool (left sidebar → Tools → PostgreSQL) and create the database.
2. Replit automatically sets the `DATABASE_URL` secret for you. Done.

### Step 4 — add secrets
Open **Tools → Secrets** and add:
- `SESSION_SECRET` — any long random string
- `ADMIN_PHONE` — YOUR mobile number (this is what makes you the admin), e.g. `+16615551234`
- `BASE_URL` — your repl's URL once you know it

Leave the Stripe/Twilio secrets out for now — the app runs fully in simulation mode without them.

### Step 5 — first run
1. Hit **Run**. The database tables create themselves.
2. In the **Shell** tab run `npm run seed` once for demo data (a demo driver, an approved demo towing company, and a pending company in your approval queue).
3. Open the web preview. Sign in with your own phone number → you're the admin.

### Step 6 — go live later (real money & real texts)
- **Stripe:** make a stripe.com account, copy the secret key into the `STRIPE_SECRET_KEY` secret. Lead purchases start charging real cards.
- **Twilio:** buy a number at twilio.com, register A2P 10DLC (required by US carriers), then set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`. Sign-in codes and lead alerts start texting for real.
- **Deploy:** use Replit **Deployments** for an always-on URL, and point a custom domain (rigrx.com) at it in the deployment settings.

## Testing the whole flow (simulation mode, two browser windows)

1. Window A: sign in as a driver (any phone # — the code shows on screen in test mode), do the quick setup, hit **Request Help**, send a request (Buttonwillow-area GPS is the default if you deny location).
2. Window B: sign in as `(661) 555-8804` — the seeded, approved demo company. The lead is in **Live Leads** (its Bakersfield yard covers Buttonwillow). Buy it (simulated payment) → driver info unlocks.
3. Chat flows instantly both ways (WebSockets). Send a quote from the company side.
4. Window A: choose the company → mark complete → leave a rating.
5. Sign in with your `ADMIN_PHONE` → approve the pending "Valley Tire Rescue," tweak pricing, see revenue.

## Lead quality features

**Exact tire position.** A tire request asks which axle (steer / drive 1-3 / trailer 1-3), which side, and inside vs outside vs super single — no diagrams, just taps. Steer axles skip the inside/outside question automatically. The tire SIZE is then pulled from the saved rig (steer size for steer axles, drive size for drive axles, trailer size for trailer axles), so the driver never types it and the provider knows what rubber to load before leaving the shop.

**Richer masked leads.** Providers see engine, transmission, axle config, tire sizes, wheel type, trailer length/suspension, reefer unit and liftgate BEFORE paying. None of it identifies the driver, so the paywall still holds — but a provider can decide what to bring based on real equipment detail.

**Provider capability flags.** Seven yes/no answers (works at scales, hazmat placarded loads, loaded trailers, cargo tanks, rotator, aluminum welding, tire inventory) shown on their public profile and in your admin dossier. When a lead needs a capability a provider has not claimed, they get a non-blocking heads-up rather than being filtered out.

**Service presets.** Provider onboarding offers eight one-tap trade presets (heavy towing, commercial tire, mobile diesel mechanic, trailer & reefer, tanker & pump, fuel delivery, welding & hydraulics, lockout & glass) that check the usual service set, which they then adjust — instead of facing a long checklist cold.

## The admin dashboard

Every number on the Overview page is clickable and opens the data behind it:

- **Requests / Fill rate** → the request list, filterable by last-24h, sold, and unsold
- **Revenue** → every lead sale, with the buyer, the driver, and a link to the request
- **Drivers** → who is requesting help, their saved equipment, and their full request history
- **Providers** → the company review dossier (see above)

Opening any request shows the complete picture: who sent it, everything they entered, the exact GPS and landmark, which companies bought it and for how much, and **every message exchanged between the driver and each provider**, plus any reviews left afterwards.

## Local development (optional)

```bash
npm install
cp .env.example .env        # edit DATABASE_URL to point at your local Postgres
npm run seed
npm start                   # http://localhost:3000
```

## Production hardening still on the list

These are known gaps to close as the business grows — none block launch-in-simulation or a pilot:
- Stripe: use SetupIntents to collect cards in-app (right now real mode expects a customer with a saved default payment method — add the card-collection page when you connect Stripe)
- Geocoding: `server/geo.js` resolves coordinates from a bundled place list (no key, no cost). Accurate around California and major corridors, coarser in remote areas — swap the body of `areaLabel()` for a Google/Mapbox call for street-level accuracy nationwide. Provider locations still use a city picker.
- Auto-expiry job for stale open requests (e.g. close after 4 hours)
- Rate limiting on the OTP endpoint (basic per-driver open-request cap exists)
- Terms of service + privacy policy pages before charging real money
- Error monitoring (Sentry) + database backups on a schedule

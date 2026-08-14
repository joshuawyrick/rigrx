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
| Service catalog | `server/catalog.js` | Admin-managed categories & services; seeds itself once, then belongs to the admin |

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

## Fast onboarding: dropdowns instead of typing

Drivers are often filling this out on a phone shoulder, so almost nothing in the truck and trailer forms is free text any more. `server/equipment.js` holds researched lists — makes, models, engines, transmissions, axle configs, tire sizes, wheel types, colors, trailer types, lengths, axles, suspensions, reefer units, door types, hazmat classes — ordered so the common answer sits near the top (295/75R22.5 and 11R22.5 lead the heavy tire list; 225/70R19.5 leads medium; Freightliner leads Class 8 makes).

Every list still ends in **Other…**, which reveals a text box. Whatever they type is saved normally *and* logged, so **Admin → Services** ends with a **"Other" answers** table showing what people typed, how many times, and for which truck class. Anything appearing repeatedly is telling you what to add to the built-in list.

Model choices redraw when the make changes, so picking Kenworth offers T680/W900/T880 rather than the whole industry.

## Heavy, medium and light duty

Duty class is the first question in driver onboarding, and it filters everything under it — a medium-duty truck offers Hino, Isuzu and Mitsubishi Fuso, 19.5" tires and Allison automatics; heavy duty offers Peterbilt, X15s and 22.5" rubber.

Service companies pick which classes they work on in onboarding step 4. Existing companies were widened to heavy + medium automatically (a one-time migration, tracked in `app_flags`) because a too-narrow default silently starves a shop of leads — they can narrow it back any time.

The class is a hard gate enforced in all four places a lead can travel: the SMS/push blast, the browsable lead feed, the purchase endpoint, and the match preview. A heavy-only wrecker service never gets texted about a box truck, and can't buy that lead by any route. Leads carry a **MEDIUM DUTY** / **LIGHT DUTY** badge so a dispatcher sees the size at a glance. If a medium-duty driver posts where every nearby shop is heavy-only, the request screen says so plainly instead of leaving them staring at a spinner.

## The service catalog (admin-managed)

Categories and the services under them live in the database, not in code. **Admin → Services** is where you run it:

- **Add a category** — name, one-line blurb, icon, lead price and premium price, and whether drivers see it on the request screen
- **Add services under it** — these become the checkboxes every service company can select, and the optional "what kind?" refinement drivers can tap
- **Rename freely** — provider selections are stored against a hidden key, so renaming a category never orphans anyone's setup
- **Turn off, don't delete** — switching a category off removes it from new requests while past requests keep their labels and revenue reports stay intact
- **Promote requests** — approving something from **Requested Services** folds that provider's suggestion into a category you choose, so every company can then offer it

One catalog feeds all three sides: the driver's request buttons (filtered to driver-visible, in your sort order), the provider's capability checklist, and the matching between them. A provider matches a request when they have at least one service checked under that category. Selections saved before the catalog existed still match, so nothing was lost in the migration.

Practical note: a brand-new category reaches nobody until service companies check something under it. Add categories as demand appears — the Requested Services queue is providers telling you exactly what is missing.

## Recruiting service companies

`/for-service-companies` (also `/providers` and `/service-companies`) is a public landing page aimed at tow operators, tire shops and mobile mechanics. It's a real static file, not an app route, so it loads instantly and search engines can read it — which matters, because "how to get more towing leads" is a far less contested search than "tow truck near me", and the people searching it are the ones who pay you.

The page ends in a **coverage waitlist** for companies outside a live corridor. Their submissions land in **Admin → Providers**, underneath the approval queue, with a contacted/not-contacted toggle. Where those companies cluster is the data for which corridor to open next — so a shop in a market you haven't reached is worth capturing, not turning away.

`RIGRX_For_Service_Companies.pdf` is the printable one-page version of the same pitch, for leaving on a counter.

## Provider trades

Each company picks **one primary trade** during onboarding — Heavy towing & recovery, Commercial tire service, Mobile diesel mechanic, Trailer & reefer repair, Tanker & pump service, Fuel & fluid delivery, Mobile welding & hydraulics, Lockout & glass. That single pick does two jobs: it becomes their badge across the app, and it pre-checks the services that trade normally performs so they aren't facing a blank checklist.

The badge appears on their public profile, on the driver's responder cards, in provider settings, and throughout the admin panel. Trades are admin-managed the same way categories are — add, rename or retire them from the API, and each trade carries its own service presets.

**Drivers can narrow by trade.** On the final request screen there's an optional "only companies whose main work is…" row alongside the licensed-only toggle. Because narrowing can strand a driver, the screen runs a **live match preview**: it shows how many companies will actually be alerted, and how many would be alerted without the filters, before they send. If they send anyway and nobody matches, the one-tap "send to all approved companies" button clears both filters.

Filtering is enforced in three places — the notification blast, the browsable lead feed, and the purchase endpoint — so a company outside the requested trade cannot see or buy the lead by any route.

## Staged location disclosure

Buying a lead is not the same as winning the job, so the two unlock different things:

| | On purchase | After the driver chooses them |
|---|---|---|
| Driver name & phone | yes | yes |
| In-app chat | yes | yes |
| Equipment, problem, photos | yes | yes |
| Distance & drive time | yes | yes |
| **Exact GPS, map link, mile marker** | **no** | **yes** |

A buyer has everything needed to quote an accurate ETA and price, but cannot navigate to the truck until the driver picks them — which stops four wreckers rolling to the same breakdown and keeps a precise pin on a stranded driver away from companies who did not win.

Losing bidders keep the contact info and chat they paid for (so there is no refund argument, and the driver keeps a fallback if the winner no-shows) but the pin never unlocks for them. Drivers see a reminder in chat not to volunteer their exact spot before choosing.

Choosing a provider is irreversible, so it goes through a confirmation dialog that spells out the consequences, and **Chat first** is styled as the primary action on every responder card.

## The company scoreboard

**Stats** works the same way the admin Overview does — every number opens the data behind it:

- **Leads bought** → every purchase, newest first
- **Jobs won** → only the leads the driver chose them for, with what those cost
- **Lead spend** → the same list with a spend total for what's shown
- **Your rating** → every review a driver left, the star breakdown, the tags drivers mention most, and a tap through to the job each came from
- **Cost per job won** → lead spend divided by jobs won. This is the number that tells a company whether RIGRX pays for itself, so it's on the front page rather than buried
- **Avg reply time** → how long they take to message the driver after buying, plus how many leads they bought and never messaged at all

The last two are deliberate. Speed and price are what win these jobs, and a company that can see it takes eleven minutes to answer — while its competitors answer in two — has something to act on. A short panel next to the chart explains each number in plain language, because most of these owners have never used a dashboard.

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

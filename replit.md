# RIGRX

Emergency roadside service marketplace for trucks. Drivers request help in seconds; nearby qualified service companies get text alerts, buy the lead, unlock driver info, and chat to win the job.

## Stack

- **Runtime:** Node.js 18
- **Framework:** Express (no build step)
- **Database:** PostgreSQL (Replit built-in)
- **Real-time:** WebSockets (`ws`)
- **Auth:** Phone-number OTP (no passwords)
- **Payments:** Stripe (optional — runs in simulation mode without it)
- **SMS:** Twilio (optional — codes shown on-screen in test mode without it)

## How to run

```
npm start
```

Runs on port 5000 (set via `PORT` env var). The workflow "Start application" is configured to start it automatically.

## Environment variables / secrets

| Key | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | Set automatically by Replit PostgreSQL |
| `SESSION_SECRET` | Yes | Set as a Replit Secret |
| `ADMIN_PHONE` | Yes | Phone number that gets admin access (e.g. `+16615990027`) |
| `STRIPE_SECRET_KEY` | No | Live payments; omit to run in simulation mode |
| `TWILIO_ACCOUNT_SID` | No | Real SMS; omit to show codes on-screen |
| `TWILIO_AUTH_TOKEN` | No | Required with Twilio |
| `TWILIO_FROM_NUMBER` | No | Required with Twilio |
| `BASE_URL` | No | Public URL for links in texts |

## Demo accounts (seeded)

- **Driver:** `(661) 555-0198`
- **Approved provider:** `(661) 555-8804` (Bakersfield, covers Buttonwillow)
- **Pending provider:** Valley Tire Rescue (in admin approval queue)
- **Admin:** sign in with `ADMIN_PHONE`

Re-seed anytime with `npm run seed` (safe to re-run; upserts data).

## Project structure

```
server/
  index.js      — entry point, HTTP + WebSocket server
  routes.js     — all API routes
  auth.js       — phone OTP sign-in
  match.js      — lead-matching engine (service radius + service type)
  seed.js       — demo data seeder
public/         — static frontend (HTML/CSS/JS, no framework)
uploads/        — driver photo & document uploads (created at setup)
```

## User preferences

- Do not change app code, design, or features without explicit instruction.

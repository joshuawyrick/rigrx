// ============ Phone-code (OTP) authentication + sessions ============
const crypto = require('crypto');
const { q, one } = require('./db');
const { sms, smsSimulated } = require('./notify');

const DEV_MODE = !process.env.TWILIO_ACCOUNT_SID; // without Twilio, the code is returned in the API response

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (String(raw).startsWith('+')) return '+' + digits;
  return null;
}

async function requestCode(phone) {
  // Rate limits, because with Twilio live every code is a text that costs money:
  // at most 5 codes per phone per hour, and no new code within 30 seconds of the
  // last (stops double-taps and scripts without ever locking out a real person).
  // In simulation mode (no Twilio keys) codes are free and shown on screen, so the
  // anti-fraud ceiling would only brick testing. Real texts keep the tight limits.
  const simulated = smsSimulated();
  const maxPerHour = simulated ? 100 : 5;
  const minGapMs = simulated ? 3 * 1000 : 30 * 1000;
  const recent = await one(
    `SELECT COUNT(*)::int AS n, MAX(created_at) AS last FROM otp_codes
     WHERE phone=$1 AND created_at > NOW() - INTERVAL '1 hour'`, [phone]);
  if (recent.n >= maxPerHour) {
    const err = new Error('Too many codes requested for this number. Try again in an hour, or call RIGRX if you are stuck.');
    err.status = 429; throw err;
  }
  if (recent.last && Date.now() - new Date(recent.last).getTime() < minGapMs) {
    const err = new Error(simulated
      ? 'One moment — give it a few seconds between codes.'
      : 'We just sent a code — give it 30 seconds to arrive before requesting another.');
    err.status = 429; throw err;
  }
  const code = String(crypto.randomInt(100000, 999999));
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  await q('INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1,$2,$3)', [phone, code, expires]);
  // A returning Spanish-speaking user gets the code text in Spanish too.
  const known = await one('SELECT lang FROM users WHERE phone=$1', [phone]);
  await sms(null, phone, known?.lang === 'es'
    ? `Su código de acceso RIGRX es ${code}. Vence en 10 minutos.`
    : `Your RIGRX sign-in code is ${code}. It expires in 10 minutes.`);
  return DEV_MODE ? code : null; // in dev/simulation mode, surface the code so the app is testable
}

async function verifyCode(phone, code) {
  // A 6-digit code has a million combinations; without an attempt cap that is
  // guessable by script. Six wrong tries kills every live code for the number.
  const tries = await one(
    `SELECT COALESCE(SUM(attempts),0)::int AS n FROM otp_codes
     WHERE phone=$1 AND used=FALSE AND expires_at > NOW()`, [phone]);
  if (tries.n >= 6) {
    const err = new Error('Too many wrong attempts. Request a fresh code.');
    err.status = 429; throw err;
  }
  const row = await one(
    `SELECT * FROM otp_codes WHERE phone=$1 AND code=$2 AND used=FALSE AND expires_at > NOW()
     ORDER BY id DESC LIMIT 1`, [phone, code]);
  if (!row) {
    await q(`UPDATE otp_codes SET attempts = attempts + 1
             WHERE id = (SELECT id FROM otp_codes WHERE phone=$1 AND used=FALSE AND expires_at > NOW()
                         ORDER BY id DESC LIMIT 1)`, [phone]);
    return null;
  }
  await q('UPDATE otp_codes SET used=TRUE WHERE id=$1', [row.id]);
  return true;
}

async function findOrCreateUser(phone, role) {
  let user = await one('SELECT * FROM users WHERE phone=$1', [phone]);
  if (!user) {
    const isAdmin = phone === normalizePhone(process.env.ADMIN_PHONE || '');
    user = await one(
      'INSERT INTO users (phone, role) VALUES ($1,$2) RETURNING *',
      [phone, isAdmin ? 'admin' : (role === 'provider' ? 'provider' : 'driver')]);
    if (user.role === 'provider') {
      await q('INSERT INTO providers (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
    }
  }
  return user;
}

// Archiving takes effect immediately: every live session for that account is dropped,
// so someone already signed in is out on their next request rather than at expiry.
async function endAllSessions(userId) {
  await q('DELETE FROM sessions WHERE user_id=$1', [userId]);
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000); // 30 days
  await q('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)', [token, userId, expires]);
  return token;
}

// Express middleware: attaches req.user if a valid session cookie exists
async function attachUser(req, res, next) {
  try {
    const token = req.cookies?.rigrx_session;
    if (token) {
      req.user = await one(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token=$1 AND s.expires_at > NOW() AND u.archived_at IS NULL`, [token]);
    }
  } catch (e) { /* ignore */ }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    if (req.user.role !== role && req.user.role !== 'admin')
      return res.status(403).json({ error: `${role} account required` });
    next();
  };
}

module.exports = { normalizePhone, requestCode, verifyCode, findOrCreateUser, createSession, endAllSessions, attachUser, requireAuth, requireRole, DEV_MODE };

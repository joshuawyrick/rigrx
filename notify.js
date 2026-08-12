// ============ Notifications: SMS (Twilio) + in-app websocket push ============
// With no Twilio keys set, SMS are SIMULATED: logged to console + notifications_log,
// so the whole app works before you buy a phone number.
const { q } = require('./db');

let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try { twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN); }
  catch (e) { console.error('Twilio init failed, running in simulation mode:', e.message); }
}

async function sms(userId, phone, body) {
  let simulated = true;
  if (twilioClient && process.env.TWILIO_FROM_NUMBER) {
    try {
      await twilioClient.messages.create({ to: phone, from: process.env.TWILIO_FROM_NUMBER, body });
      simulated = false;
    } catch (e) { console.error('SMS send failed:', e.message); }
  }
  if (simulated) console.log(`[SMS→${phone}] ${body}`);
  await q('INSERT INTO notifications_log (user_id, channel, body, simulated) VALUES ($1,$2,$3,$4)',
          [userId, 'sms', body, simulated]).catch(() => {});
}

// WebSocket registry: userId -> Set of sockets (set up in index.js)
const sockets = new Map();
function wsRegister(userId, socket) {
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(socket);
  socket.on('close', () => sockets.get(userId)?.delete(socket));
}
function wsPush(userId, event, data) {
  const set = sockets.get(userId);
  if (!set) return;
  const payload = JSON.stringify({ event, data });
  for (const s of set) { try { s.send(payload); } catch (e) {} }
}

module.exports = { sms, wsRegister, wsPush };

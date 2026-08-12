// ============ RIGRX server ============
require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const { migrate, one } = require('./db');
const { attachUser } = require('./auth');
const { wsRegister } = require('./notify');
const routes = require('./routes');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(attachUser);

app.use('/api', routes);
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
// index:false so the cache-busting handler below always renders index.html itself
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// ---- cache-busting ----
// index.html is never cached, and it stamps the current build number onto app.js /
// styles.css. When you deploy an update, browsers fetch the new files automatically
// instead of running stale code until someone thinks to hard-refresh.
const fs = require('fs');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
function buildStamp() {
  let newest = 0;
  for (const f of ['app.js', 'icons.js', 'styles.css', 'index.html']) {
    try { newest = Math.max(newest, fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs); } catch (e) {}
  }
  return String(Math.round(newest));
}
let BUILD = buildStamp();
function sendIndex(req, res) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load the app');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html.replace(/__BUILD__/g, BUILD));
  });
}
app.get('*', sendIndex);

// central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end' });
});

const server = http.createServer(app);

// ---- WebSocket: authenticated by session cookie ----
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', async (socket, req) => {
  try {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')));
    const token = cookies.rigrx_session;
    if (!token) return socket.close();
    const user = await one(
      `SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at > NOW()`, [token]);
    if (!user) return socket.close();
    wsRegister(user.id, socket);
    socket.send(JSON.stringify({ event: 'hello', data: { user_id: user.id } }));
  } catch (e) { socket.close(); }
});

const PORT = process.env.PORT || 3000;
const { seedIfEmpty } = require('./catalog');
migrate().then(seedIfEmpty).then(() => {
  server.listen(PORT, () => console.log(`RIGRX running on http://localhost:${PORT}`));
}).catch(e => {
  console.error('Database migration failed. Is DATABASE_URL set correctly?', e);
  process.exit(1);
});

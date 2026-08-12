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
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

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
migrate().then(() => {
  server.listen(PORT, () => console.log(`RIGRX running on http://localhost:${PORT}`));
}).catch(e => {
  console.error('Database migration failed. Is DATABASE_URL set correctly?', e);
  process.exit(1);
});

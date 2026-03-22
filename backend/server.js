const express = require('express');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// Serve frontend static files
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));

// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

const RATE_PER_MINUTE = 0.50;
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Track active sessions and inactivity timers (keyed by socket.id)
const activeSessions = new Map();
const inactivityTimeouts = new Map();

function clearInactivityTimeout(socketId) {
  if (inactivityTimeouts.has(socketId)) {
    clearTimeout(inactivityTimeouts.get(socketId));
    inactivityTimeouts.delete(socketId);
  }
}

function setInactivityTimeout(socket) {
  clearInactivityTimeout(socket.id);
  const timeout = setTimeout(() => {
    const session = activeSessions.get(socket.id);
    if (!session) return;
    const endTime = new Date();
    const durationMs = endTime - session.startTime;
    const durationSeconds = Math.floor(durationMs / 1000);
    const durationMinutes = durationMs / 60000;
    const cost = durationMinutes * RATE_PER_MINUTE;
    activeSessions.delete(socket.id);
    inactivityTimeouts.delete(socket.id);
    socket.emit('session_ended', { carId: session.carId, durationSeconds, cost, reason: 'inactivity' });
    console.log(`Session auto-ended (inactivity): Car ${session.carId}, duration ${durationSeconds}s, cost $${cost.toFixed(2)}`);
  }, INACTIVITY_TIMEOUT_MS);
  inactivityTimeouts.set(socket.id, timeout);
}

app.get('/api/cars', (req, res) => {
  const activeCars = new Set([...activeSessions.values()].map((s) => s.carId));
  res.json({
    ratePerMinute: RATE_PER_MINUTE,
    cars: [
      { id: 1, name: 'MJX Hyper Go 14302', status: activeCars.has(1) ? 'unavailable' : 'available', model: 'Drift Car' },
    ],
  });
});

// End session via HTTP (used by navigator.sendBeacon on page unload)
app.post('/api/session/end', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ ended: false, message: 'Invalid sessionId.' });
  }
  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.json({ ended: false, message: 'No active session found.' });
  }
  clearInactivityTimeout(sessionId);
  const endTime = new Date();
  const durationMs = endTime - session.startTime;
  const durationSeconds = Math.floor(durationMs / 1000);
  const durationMinutes = durationMs / 60000;
  const cost = durationMinutes * RATE_PER_MINUTE;
  activeSessions.delete(sessionId);
  console.log(`Session ended via HTTP: Car ${session.carId}, duration ${durationSeconds}s, cost $${cost.toFixed(2)}`);
  res.json({ ended: true, carId: session.carId, durationSeconds, cost });
});

// Routes for frontend pages
const pageRateLimit = rateLimit({ windowMs: 60 * 1000, max: 60 });

app.get('/', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

app.get('/control', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'control.html'));
});

// Socket.io events for real-time car control
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('start_session', (data) => {
    const { carId, userId } = data;
    activeSessions.set(socket.id, { carId, userId, startTime: new Date() });
    socket.emit('session_started', { carId, sessionId: socket.id });
    setInactivityTimeout(socket);
    console.log(`Session started: User ${userId} connected to Car ${carId}`);
  });

  socket.on('control_command', (data) => {
    const { direction, speed } = data;
    console.log(
      `Control command received: direction=${direction}, speed=${speed}`
    );
    // Reset inactivity timer on every command
    if (activeSessions.has(socket.id)) {
      setInactivityTimeout(socket);
    }
    socket.broadcast.emit('car_moving', { direction, speed });
  });

  socket.on('end_session', (data) => {
    clearInactivityTimeout(socket.id);
    const session = activeSessions.get(socket.id);
    if (!session) {
      socket.emit('session_error', { message: 'No active session found.' });
      return;
    }
    const endTime = new Date();
    const durationMs = endTime - session.startTime;
    const durationSeconds = Math.floor(durationMs / 1000);
    const durationMinutes = durationMs / 60000;
    const cost = durationMinutes * RATE_PER_MINUTE;
    activeSessions.delete(socket.id);
    socket.emit('session_ended', { carId: session.carId, durationSeconds, cost });
    console.log(`Session ended: Car ${session.carId}, duration ${durationSeconds}s, cost $${cost.toFixed(2)}`);
  });

  socket.on('disconnect', () => {
    clearInactivityTimeout(socket.id);
    activeSessions.delete(socket.id);
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

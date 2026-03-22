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
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes AFK

const CARS = [
  { id: 1, name: 'MJX Hyper Go 14302', model: 'Drift Car' },
  { id: 2, name: 'WLtoys 144001', model: 'Buggy' },
];

// Track active sessions and inactivity timers (keyed by socket.id)
const activeSessions = new Map();
const inactivityTimeouts = new Map();

// --- Race Management ---
const raceRooms = new Map(); // raceId -> race object
const leaderboard = []; // sorted array of { userId, carName, lapTimeMs, date }
const MAX_LEADERBOARD = 20;
let raceCounter = 0;

function createRaceId() {
  raceCounter += 1;
  return 'race-' + Date.now() + '-' + raceCounter + '-' + Math.random().toString(36).slice(2, 7);
}

function serializePlayer(p) {
  return {
    socketId: p.socketId,
    userId: p.userId,
    carId: p.carId,
    carName: p.carName,
    lapCount: p.lapCount,
    bestLapTime: p.bestLapTime,
  };
}

function findRaceBySocketId(socketId) {
  for (const race of raceRooms.values()) {
    if (race.players.some((p) => p.socketId === socketId)) return race;
  }
  return null;
}

function removeFromRace(socket) {
  const race = findRaceBySocketId(socket.id);
  if (!race) return;
  race.players = race.players.filter((p) => p.socketId !== socket.id);
  socket.leave(race.id);
  if (race.players.length === 0) {
    raceRooms.delete(race.id);
  } else {
    io.to(race.id).emit('race_updated', {
      raceId: race.id,
      raceName: race.name,
      players: race.players.map(serializePlayer),
    });
  }
}

function broadcastCarsUpdate() {
  const activeCars = new Set([...activeSessions.values()].map((s) => s.carId));
  io.emit('cars_updated', {
    cars: CARS.map((c) => ({ ...c, status: activeCars.has(c.id) ? 'unavailable' : 'available' })),
  });
}

function broadcastRacesUpdate() {
  const races = [...raceRooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    playerCount: r.players.length,
    status: r.status,
    createdAt: r.createdAt,
  }));
  io.emit('races_updated', { races });
}

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
    // Bug 2: Notify all clients that the car is now available
    broadcastCarsUpdate();
    console.log(`Session auto-ended (inactivity): Car ${session.carId}, duration ${durationSeconds}s, cost $${cost.toFixed(2)}`);
  }, INACTIVITY_TIMEOUT_MS);
  inactivityTimeouts.set(socket.id, timeout);
}

app.get('/api/cars', (req, res) => {
  const activeCars = new Set([...activeSessions.values()].map((s) => s.carId));
  res.json({
    ratePerMinute: RATE_PER_MINUTE,
    cars: CARS.map((c) => ({ ...c, status: activeCars.has(c.id) ? 'unavailable' : 'available' })),
  });
});

// API: Get active race sessions
app.get('/api/races', (req, res) => {
  const races = [...raceRooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    playerCount: r.players.length,
    status: r.status,
    createdAt: r.createdAt,
  }));
  res.json({ races });
});

// API: Get global leaderboard (top 10 best lap times)
app.get('/api/leaderboard', (req, res) => {
  res.json({ leaderboard: leaderboard.slice(0, 10) });
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
  // Bug 2: Notify all clients that the car is now available
  broadcastCarsUpdate();
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
    // Bug 5: Prevent multiple users controlling the same car
    const carAlreadyActive = [...activeSessions.values()].some((s) => s.carId === carId);
    if (carAlreadyActive) {
      socket.emit('session_error', { message: 'Эта машина уже занята. Выберите другую.' });
      return;
    }
    activeSessions.set(socket.id, { carId, userId, startTime: new Date() });
    socket.emit('session_started', { carId, sessionId: socket.id });
    setInactivityTimeout(socket);
    // Bug 2: Notify all clients of updated car availability in real time
    broadcastCarsUpdate();
    console.log(`Session started: User ${userId} connected to Car ${carId}`);
  });

  socket.on('control_command', (data) => {
    const { direction, speed, steering_angle } = data;
    console.log(
      `Control command received: direction=${direction}, speed=${speed}, steering_angle=${steering_angle}`
    );
    // Reset inactivity timer on every command
    if (activeSessions.has(socket.id)) {
      setInactivityTimeout(socket);
    }
    // Forward full command to Pi (and other clients) so the Pi can act on it
    socket.broadcast.emit('control_command', data);
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
    // Bug 2: Notify all clients that the car is now available
    broadcastCarsUpdate();
    console.log(`Session ended: Car ${session.carId}, duration ${durationSeconds}s, cost $${cost.toFixed(2)}`);
  });

  socket.on('disconnect', () => {
    clearInactivityTimeout(socket.id);
    const hadSession = activeSessions.has(socket.id);
    activeSessions.delete(socket.id);
    removeFromRace(socket);
    if (hadSession) broadcastCarsUpdate();
    broadcastRacesUpdate();
    console.log('Client disconnected:', socket.id);
  });

  // --- Race events ---

  socket.on('join_race', (data) => {
    const { raceId, userId, carId, carName } = data || {};
    if (!userId) return;

    // Leave current race before joining a new one
    removeFromRace(socket);

    let race;
    if (raceId && raceRooms.has(raceId)) {
      race = raceRooms.get(raceId);
    } else {
      const newId = createRaceId();
      race = {
        id: newId,
        name: 'Гонка #' + (raceRooms.size + 1),
        players: [],
        status: 'racing',
        createdAt: new Date().toISOString(),
      };
      raceRooms.set(newId, race);
    }

    const player = {
      socketId: socket.id,
      userId,
      carId: carId || null,
      carName: carName || ('Машина #' + (carId || '?')),
      lapCount: 0,
      bestLapTime: null,
      currentLapStart: null,
    };
    race.players.push(player);
    socket.join(race.id);

    socket.emit('race_joined', {
      raceId: race.id,
      raceName: race.name,
      players: race.players.map(serializePlayer),
      leaderboard: leaderboard.slice(0, 10),
    });

    io.to(race.id).emit('race_updated', {
      raceId: race.id,
      raceName: race.name,
      players: race.players.map(serializePlayer),
    });

    // Bug 4: Notify all clients instantly of updated race list
    broadcastRacesUpdate();

    console.log(`User ${userId} joined race ${race.id}`);
  });

  socket.on('leave_race', () => {
    removeFromRace(socket);
    socket.emit('race_left');
    // Bug 4: Keep race list up to date for all clients
    broadcastRacesUpdate();
  });

  socket.on('start_lap', () => {
    const race = findRaceBySocketId(socket.id);
    if (!race) return;
    const player = race.players.find((p) => p.socketId === socket.id);
    if (!player) return;
    player.currentLapStart = Date.now();
    socket.emit('lap_started', { startTime: player.currentLapStart });
  });

  socket.on('end_lap', () => {
    const race = findRaceBySocketId(socket.id);
    if (!race) return;
    const player = race.players.find((p) => p.socketId === socket.id);
    if (!player || !player.currentLapStart) return;

    const lapTimeMs = Date.now() - player.currentLapStart;
    player.currentLapStart = null;
    player.lapCount++;

    const isPersonalBest = !player.bestLapTime || lapTimeMs < player.bestLapTime;
    if (isPersonalBest) player.bestLapTime = lapTimeMs;

    leaderboard.push({
      userId: player.userId,
      carName: player.carName,
      lapTimeMs,
      date: new Date().toISOString(),
    });
    leaderboard.sort((a, b) => a.lapTimeMs - b.lapTimeMs);
    if (leaderboard.length > MAX_LEADERBOARD) leaderboard.length = MAX_LEADERBOARD;

    // After sorting, the new entry is a global record if it sits at position 0
    const isGlobalRecord = leaderboard[0].lapTimeMs === lapTimeMs && leaderboard[0].userId === player.userId;

    io.to(race.id).emit('lap_recorded', {
      userId: player.userId,
      carName: player.carName,
      lapTimeMs,
      isPersonalBest,
      isGlobalRecord,
      leaderboard: leaderboard.slice(0, 10),
    });

    io.to(race.id).emit('race_updated', {
      raceId: race.id,
      raceName: race.name,
      players: race.players.map(serializePlayer),
    });

    console.log(`Lap recorded: ${player.carName}, ${lapTimeMs}ms, personal best: ${isPersonalBest}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

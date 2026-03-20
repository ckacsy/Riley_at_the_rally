const express = require('express');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');
const cors = require('cors');
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

app.get('/api/cars', (req, res) => {
  res.json({
    cars: [
      { id: 1, name: 'MJX Hyper Go 14302', status: 'available', model: 'Drift Car' },
    ],
  });
});

// SPA fallback: serve index.html for non-API routes
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// Socket.io events for real-time car control
const activeSessions = new Map();

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('start_session', (data) => {
    const { carId, userId } = data;
    activeSessions.set(socket.id, { carId, userId, startTime: new Date() });
    socket.emit('session_started', { carId, sessionId: socket.id });
    console.log(`Session started: User ${userId} connected to Car ${carId}`);
  });

  socket.on('control_command', (data) => {
    const { direction, speed } = data;
    console.log(
      `Control command received: direction=${direction}, speed=${speed}`
    );
    socket.broadcast.emit('car_moving', { direction, speed });
  });

  socket.on('disconnect', () => {
    activeSessions.delete(socket.id);
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

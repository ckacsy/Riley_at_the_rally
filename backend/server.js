const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// Store active car sessions
const activeSessions = new Map();

// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

app.get('/api/cars', (req, res) => {
  res.json({
    cars: [
      { id: 1, name: 'MJX Hyper Go 14302', status: 'available', model: 'Drift Car' }
    ]
  });
});

// Socket.io events for real-time car control
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // User selects a car and starts session
  socket.on('start_session', (data) => {
    const { carId, userId } = data;
    activeSessions.set(socket.id, { carId, userId, startTime: new Date() });
    socket.emit('session_started', { carId, sessionId: socket.id });
    console.log(`Session started: User ${userId} connected to Car ${carId}`);
  });

  // Receive control commands from frontend
  socket.on('control_command', (data) => {
    const { direction, speed } = data;
    // TODO: Send command to Raspberry Pi to control the car
    console.log(`Control command received: direction=${direction}, speed=${speed}`);
    socket.broadcast.emit('car_moving', { direction, speed });
  });

  // Disconnect
  socket.on('disconnect', () => {
    activeSessions.delete(socket.id);
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

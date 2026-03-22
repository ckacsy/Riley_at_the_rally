# API Examples

Reference for the RC Car Control project (MJX Hyper Go 14302). The backend runs on port **5000**. Real-time control uses **Socket.io**; a small REST layer provides status and discovery endpoints.

---

## REST API

### Health Check

Verify that the backend server is running.

**Request:**
```
GET /api/health
```

**Response:**
```json
{ "status": "Server is running" }
```

---

### List Cars

Return the list of registered RC cars and their current availability.

**Request:**
```
GET /api/cars
```

**Response:**
```json
{
  "cars": [
    { "id": 1, "name": "MJX Hyper Go 14302", "status": "available", "model": "Drift Car" }
  ]
}
```

---

## Socket.io Events

All real-time control happens over a Socket.io connection to `http://<server>:5000`.

### `control_command` — Send a driving command

Emitted by the **frontend** (or any Socket.io client) to drive the car.

| Field | Type | Description |
|---|---|---|
| `direction` | `string` | `"forward"` or `"backward"` |
| `speed` | `number` | Speed percentage (`-100` – `100`). Negative values reverse the car. |
| `steering_angle` | `number` | Steering angle in degrees. Negative = left, positive = right. |

**Examples:**
```js
// Drive forward at 50% speed
socket.emit('control_command', { direction: 'forward', speed: 50 });

// Drive backward at 50% speed
socket.emit('control_command', { direction: 'backward', speed: -50 });

// Steer left (keep current throttle)
socket.emit('control_command', { steering_angle: -30 });

// Steer right (keep current throttle)
socket.emit('control_command', { steering_angle: 30 });

// Combined: forward at 60% with a slight right turn
socket.emit('control_command', { direction: 'forward', speed: 60, steering_angle: 15 });
```

---

### `session_started` — Session acknowledgement (received by client)

After the client emits `start_session`, the server responds with this event.

**Emit to start a session:**
```js
socket.emit('start_session', { carId: 1, userId: 'driver-1' });
```

**Received event payload:**
```json
{ "carId": 1, "sessionId": "<socket-id>" }
```

---

## Code Snippets

### JavaScript — Frontend (browser)

```js
// Connect to the backend
const socket = io('http://localhost:5000');

socket.on('connect', () => {
  console.log('Connected to backend, socket id:', socket.id);

  // Start a control session for car 1
  socket.emit('start_session', { carId: 1, userId: 'driver-1' });
});

socket.on('session_started', ({ carId, sessionId }) => {
  console.log(`Session started for car ${carId}, session: ${sessionId}`);
});

// Drive forward
function driveForward() {
  socket.emit('control_command', { direction: 'forward', speed: 50 });
}

// Drive backward
function driveBackward() {
  socket.emit('control_command', { direction: 'backward', speed: -50 });
}

// Steer left
function steerLeft() {
  socket.emit('control_command', { steering_angle: -30 });
}

// Steer right
function steerRight() {
  socket.emit('control_command', { steering_angle: 30 });
}

socket.on('disconnect', () => {
  console.log('Disconnected from backend');
});
```

---

### Python — Raspberry Pi (`rpi/main.py`)

The Pi connects to the backend as a Socket.io client and executes every `control_command` it receives.

```python
import socketio
from rc_car_controller import RCCarController

sio = socketio.Client()
car = RCCarController()

SERVER_URL = 'http://localhost:5000'  # replace with actual backend IP

@sio.on('connect')
def on_connect():
    print('Connected to backend server')

@sio.on('disconnect')
def on_disconnect():
    print('Disconnected — stopping car')
    car.stop()

@sio.on('control_command')
def on_control_command(data):
    direction      = data.get('direction', 'unknown')
    speed          = data.get('speed', 0)
    steering_angle = data.get('steering_angle', 0)
    car.drive_command(speed, steering_angle)
    print(f"Executed: {direction} at {speed}% with {steering_angle}° steering")

if __name__ == '__main__':
    sio.connect(SERVER_URL)
    sio.wait()
```

**REST health check from Python (optional diagnostic):**
```python
import requests

response = requests.get('http://localhost:5000/api/health')
print(response.json())  # {'status': 'Server is running'}
```

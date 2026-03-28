# RC Car Control — MJX Hyper Go 14302

A web-based interface for remotely controlling an **MJX Hyper Go 14302** RC car via a browser. The backend runs on any PC or server; motor control and camera streaming run on a Raspberry Pi connected to the car.

## Architecture

```
Browser (HTML/CSS/JS)
        │  WebSocket (Socket.io) + HTTP
        ▼
Node.js Backend  (Express + Socket.io)  — port 5000
        │  WebSocket (Socket.io)
        ▼
Raspberry Pi  (Python)
  ├── rc_car_controller.py  — PCA9685 motor/servo control
  └── camera_stream.py      — MJPEG camera stream (port 8000)
```

| Layer | Technology |
|-------|-----------|
| Frontend | HTML, CSS, JavaScript (vanilla) |
| Backend | Node.js, Express, Socket.io |
| Raspberry Pi | Python, python-socketio, adafruit-pca9685 |

## Prerequisites

- **Node.js** v14 or higher
- **npm** v6 or higher
- **Raspberry Pi** with Raspberry Pi OS (for motor/camera control)
- **Python** 3.7+ on the Raspberry Pi
- PCA9685 PWM driver board wired to the Pi's I2C bus

## Installation

### Backend

```bash
cd backend
npm install
```

Copy the environment template and configure it for your setup (see **Configuration** below):

```bash
cp backend/.env.example backend/.env
```

### Raspberry Pi

```bash
cd rpi
pip install -r requirements.txt
```

> Enable I2C on the Pi: `sudo raspi-config` → Interface Options → I2C → Enable.

## Usage

### 1. Start the backend

```bash
cd backend
npm start
```

The server starts on `http://localhost:5000`.

### 2. Open the frontend

Navigate to `http://localhost:5000` in your browser. Use the on-screen buttons to send directional commands.

### 3. Start the Raspberry Pi code

```bash
cd rpi
python main.py
```

The Pi connects to the backend via Socket.io and executes motor commands as they arrive. The camera stream is available at `http://<pi-ip>:8000`.

## API Examples

### REST

**Health check**
```
GET /api/health
→ { "status": "Server is running" }
```

**List cars**
```
GET /api/cars
→ { "cars": [{ "id": 1, "name": "MJX Hyper Go 14302", "status": "available" }] }
```

### Socket.io

**Send a control command** (emitted by the frontend):
```js
socket.emit('control_command', { direction: 'forward', speed: 50 });
socket.emit('control_command', { steering_angle: -30 });  // left
socket.emit('control_command', { steering_angle:  30 });  // right
socket.emit('control_command', { direction: 'backward', speed: -50 });
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `npm start` fails on Windows (execution policy) | Run `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` in PowerShell as Administrator, then retry. |
| Pi cannot connect to backend | Make sure the backend is running and `server_url` in `rpi/main.py` points to the correct IP/hostname. |
| I2C / PCA9685 not detected on Pi | Run `sudo i2cdetect -y 1` to verify the device is visible. Check wiring and that I2C is enabled. |
| Camera stream not loading | Confirm `picamera` is installed and the camera module is enabled (`sudo raspi-config` → Interface Options → Camera). Note: `picamera` requires the legacy camera stack (Raspberry Pi OS Bullseye or older). On newer OS versions use `picamera2` instead. |
| Verification / magic-link emails not arriving | See **Configuration → Email** below. |

## Configuration

Copy `backend/.env.example` to `backend/.env` and fill in your values.  The most important variables for email delivery are `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `NODE_ENV`, and `APP_BASE_URL`.  Set `DISABLE_EMAIL=true` to print email content to the server console instead of sending real messages.

See [INSTALL.md](./INSTALL.md#email-configuration) for a complete step-by-step guide to Gmail SMTP setup and switching between dev and production email modes.
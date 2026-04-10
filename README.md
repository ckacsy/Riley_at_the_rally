# RC Car Control — Riley at the Rally

A web-based platform for remotely controlling an **MJX Hyper Go 14302** RC car via a browser.  The backend runs on any PC or server; motor control and camera streaming run on a Raspberry Pi connected to the car.

## Features

- **Live RC car control** — real-time directional commands and speed control via browser
- **3D Garage** — WebGL car viewer with livery carousel and car selection
- **Leaderboard** — per-user lap time records with day/week/all-time filters
- **Live broadcast** — spectator view with MJPEG camera feed and global chat
- **User accounts** — registration, email verification, magic-link login, password reset
- **Session management** — time-limited rentals with inactivity timeout and session timer UI
- **News system** — admin/moderator-created news shown on the garage page (Markdown, DOMPurify sanitised)
- **Admin dashboard (Operations Hub)** — at-a-glance counters for active sessions, orphaned holds, maintenance cars, and recent audit actions
- **Admin user management** — ban/unban/delete users, adjust or compensate balances
- **Admin compensation workflow** — structured internal credit with reason codes, idempotency, and full audit trail
- **Admin transactions ledger** — full transaction history with filters for every transaction type (`hold`, `release`, `deduct`, `topup`, `admin_adjust`, `admin_compensation`)
- **Orphaned hold release** — detect and remediate stale session holds via admin action
- **Per-car maintenance mode** — take individual cars out of service via admin UI
- **Admin audit log** — immutable record of all high-impact admin actions
- **Admin analytics** — KPI overview and time-series charts for sessions, revenue, and user activity
- **Admin investigation timeline** — unified chronological timeline aggregating transactions, sessions, audit log, and maintenance events with filtering, pagination, and entity quick cards (`admin-investigation.js` + `admin-investigation.html`)
- **Admin session management** — view active and past rental sessions, force-end sessions from admin UI (`admin-sessions.js` + `admin-sessions.html`)
- **Payment / top-up** — balance top-up flow for users (`payment.js`)
- **User profile** — personal dashboard with balance, session history, and account settings (`profile.html`)
- **CSRF protection** — all state-changing endpoints are protected with CSRF tokens
- **Cross-link navigation** — admin pages are interconnected with investigation, audit, and user/car/session quick links

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
| Backend | Node.js 18+, Express, Socket.io, better-sqlite3 |
| Raspberry Pi | Python, python-socketio, adafruit-pca9685 |

## Prerequisites

- **Node.js** v18 or higher
- **npm** v8 or higher
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

## Role Management

### Method 1: Direct SQLite (production)

```bash
cd backend
sqlite3 riley.sqlite "UPDATE users SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE username = 'YourUsername';"
```

For moderator:
```bash
sqlite3 riley.sqlite "UPDATE users SET role = 'moderator', updated_at = CURRENT_TIMESTAMP WHERE username = 'YourUsername';"
```

To verify:
```bash
sqlite3 riley.sqlite "SELECT id, username, role FROM users WHERE username = 'YourUsername';"
```

### Method 2: Dev API (test/development only)

When the server is running with `NODE_ENV=test`, there is a dev endpoint `POST /api/dev/set-user-role`:

```bash
curl -X POST http://localhost:5000/api/dev/set-user-role \
  -H "Content-Type: application/json" \
  -d '{"username": "YourUsername", "role": "admin"}'
```

### Available roles

| Role | Weight | Permissions |
|------|--------|------------|
| `user` | 1 | Default role. Can rent cars, participate in duels, view profile. |
| `moderator` | 2 | Can ban/unban users, adjust balances, manage news, view admin entity cards. |
| `admin` | 3 | Full access: all moderator permissions plus delete users, investigation timeline, analytics, compensation workflow. |

### Important notes

- The first admin must be created via SQLite (Method 1) since there is no admin UI for role assignment.
- Admins can only act on users with a strictly lower role weight (admin → moderator/user, moderator → user only).
- The dev API endpoint (`/api/dev/set-user-role`) is **only available** when `NODE_ENV=test`. It is not exposed in production.

## API Examples

### REST

**Health check**
```
GET /api/health
→ { "ok": true, "status": "ok", "db": "ok", "socket": { "clients": 0 } }
```

**List cars**
```
GET /api/cars
→ { "ratePerMinute": 0.5, "cars": [{ "id": 1, "name": "Riley-X1 «Алый»", "status": "available" }] }
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

## Testing

The project includes a comprehensive E2E test suite built with [Playwright](https://playwright.dev/). The suite contains **23 spec files** covering all API endpoints and key UI flows.

```bash
cd backend
npm run test:e2e
```

See [backend/TESTING.md](./backend/TESTING.md) for the full list of spec files and what each covers.

## See also

- [INSTALL.md](./INSTALL.md) — step-by-step installation and email configuration guide
- [API_EXAMPLES.md](./API_EXAMPLES.md) — extended REST and Socket.io API examples
- [SECURITY.md](./SECURITY.md) — security policy and vulnerability reporting
- [backend/TESTING.md](./backend/TESTING.md) — E2E test suite documentation (23 spec files)
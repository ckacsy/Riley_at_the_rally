# Device ↔ Server Protocol

This document describes the full communication protocol between an RC-car device (Raspberry Pi) and the Riley backend server.

---

## Overview

Devices communicate with the backend over a **Socket.IO** connection.  
Authentication happens at connection time via `socket.handshake.auth`.  
After successful authentication the device is placed in a Socket.IO room (`car:{carId}`) so that drive commands are routed only to the correct hardware.

---

## 1. Authentication Flow

### 1.1 Device connects

The device opens a Socket.IO connection and passes credentials in the handshake:

```python
sio.connect(SERVER_URL, auth={'carId': CAR_ID, 'deviceKey': DEVICE_KEY})
```

| Field | Type | Description |
|---|---|---|
| `carId` | `number` | Numeric ID of the car this device controls. |
| `deviceKey` | `string` | Raw (un-hashed) device key issued via the admin panel. |

### 1.2 Server verifies

The server computes `SHA-256(deviceKey)` and compares it to the stored hash.  
It also checks that the device record is `status = 'active'`.

### 1.3 Outcomes

| Event | Direction | Payload | Meaning |
|---|---|---|---|
| `device:auth_ok` | server → device | `{ deviceId, carId }` | Authentication succeeded. |
| `device:auth_error` | server → device | `{ reason }` | Authentication failed; socket is disconnected immediately. |

Possible `reason` values: `'device_not_found'`, `'device_disabled'`, `'invalid_key'`.

### 1.4 Post-auth

After `device:auth_ok` the device socket is automatically joined to room `car:{carId}`.  
`last_seen_at` in the `devices` table is updated to `NOW()`.

---

## 2. Events: Server → Device

| Event | Payload | Description |
|---|---|---|
| `device:auth_ok` | `{ deviceId: number, carId: number }` | Authentication accepted. |
| `device:auth_error` | `{ reason: string }` | Authentication rejected. Socket will be disconnected. |
| `control_command` | `{ direction?, speed?, steering_angle? }` | Drive command forwarded from an active user session (room-routed). |
| `device:heartbeat_ack` | `{ ts: string }` | Acknowledgement of a received heartbeat. |
| `device:kicked` | `{ reason: string }` | Server is forcibly disconnecting the device. |

Possible `device:kicked` reasons:

| Reason | Trigger |
|---|---|
| `'new_connection'` | A newer device socket authenticated for the same car (hot-swap). |
| `'key_regenerated'` | An admin regenerated the device key; device must re-authenticate. |
| `'device_disabled'` | An admin disabled the device record. |
| `'device_replaced'` | An admin replaced the device (hardware swap). |
| `'heartbeat_timeout'` | Server did not receive a heartbeat within 45 s. *(emitted implicitly via disconnect)* |

---

## 3. Events: Device → Server

| Event | Payload | Description |
|---|---|---|
| `device:heartbeat` | `{ carId: number, timestamp: number }` | Periodic keepalive. Must be sent every **15 seconds**. |

---

## 4. Heartbeat Protocol

```
Device                           Server
  │──── device:heartbeat ──────▶ │  (every 15 s)
  │◀─── device:heartbeat_ack ─── │  (immediate response)
```

* The device starts emitting heartbeats **after** receiving `device:auth_ok`.
* If the server receives no heartbeat for **45 seconds** it considers the device stale,
  disconnects the socket, and removes it from the `deviceSockets` map.
* The stale-device check runs every **30 seconds** on the server.
* `last_seen_at` in the `devices` table is updated on every heartbeat.

---

## 5. Room-Based Routing

* On successful authentication the server calls `socket.join('car:{carId}')`.
* When a user sends a `control_command`, the server routes it exclusively to that room:
  ```javascript
  io.to(`car:${session.carId}`).emit('control_command', data);
  ```
* This ensures commands from user A driving Car 1 never reach the device for Car 2.
* **Only** the device socket joins the car room — user sockets do not.

---

## 6. Reconnection

Devices should implement automatic reconnection with exponential backoff.  
The reference implementation uses a simple fixed 5-second retry:

```python
def connect_to_server():
    while True:
        try:
            sio.connect(SERVER_URL, auth=auth_payload)
            sio.wait()
        except Exception as exc:
            print(f'Connection error: {exc}. Retrying in 5 s…')
            time.sleep(5)
```

For production use, consider exponential backoff with jitter (e.g. 2 s → 4 s → 8 s … up to 60 s).

---

## 7. Admin Operations That Affect Devices

| Admin action | Effect on device |
|---|---|
| **Regenerate key** | Server emits `device:kicked` with reason `'key_regenerated'`, then disconnects. Device must reconnect with the new key. |
| **Disable device** | Server emits `device:kicked` with reason `'device_disabled'`, then disconnects. Device cannot reconnect until re-enabled. |
| **Replace device** | Server emits `device:kicked` with reason `'device_replaced'`, then disconnects the old socket. |
| **Heartbeat timeout** | Server disconnects the socket silently (no `device:kicked` event). |

---

## 8. Configuration on Pi

### Command-line arguments

| Argument | Default | Description |
|---|---|---|
| `--server URL` | `http://localhost:5000` | Backend server URL. |
| `--car-id N` | — | Car ID for device authentication. |
| `--device-key KEY` | — | Raw device key for authentication. |
| `--stream-port PORT` | `8000` | Port for the local MJPEG camera stream. |
| `--mock` | `false` | Run without real GPIO/camera hardware. |

### Environment variables (alternative to CLI args)

| Variable | Description |
|---|---|
| `DEVICE_CAR_ID` | Equivalent to `--car-id`. |
| `DEVICE_KEY` | Equivalent to `--device-key`. |

CLI arguments take precedence over environment variables.

---

## 9. Example Connection Code (Python)

Based on `rpi/control.py`:

```python
import os
import threading
import time
import socketio as sio_module

SERVER_URL = os.environ.get('SERVER_URL', 'http://localhost:5000')
CAR_ID     = int(os.environ.get('DEVICE_CAR_ID', '1'))
DEVICE_KEY = os.environ.get('DEVICE_KEY', '')

auth_payload = {'carId': CAR_ID, 'deviceKey': DEVICE_KEY}

sio = sio_module.Client()
_heartbeat_stop = threading.Event()


def _heartbeat_loop():
    while not _heartbeat_stop.wait(15):
        if sio.connected:
            sio.emit('device:heartbeat', {
                'carId': CAR_ID,
                'timestamp': time.time(),
            })


@sio.on('device:auth_ok')
def on_auth_ok(data):
    print(f"Authenticated as device {data['deviceId']} for car {data['carId']}")


@sio.on('device:auth_error')
def on_auth_error(data):
    print(f"Auth failed: {data.get('reason')}")


@sio.on('device:heartbeat_ack')
def on_heartbeat_ack(data):
    pass  # acknowledged


@sio.on('control_command')
def on_control_command(data):
    direction      = data.get('direction')
    speed          = data.get('speed', 0)
    steering_angle = data.get('steering_angle', 0)
    # … apply to motor controller …


@sio.on('device:kicked')
def on_kicked(data):
    print(f"Kicked: {data.get('reason')}")
    _heartbeat_stop.set()


@sio.on('connect')
def on_connect():
    _heartbeat_stop.clear()
    threading.Thread(target=_heartbeat_loop, daemon=True).start()


@sio.on('disconnect')
def on_disconnect():
    _heartbeat_stop.set()


def connect_to_server():
    while True:
        try:
            sio.connect(SERVER_URL, auth=auth_payload)
            sio.wait()
        except Exception as exc:
            print(f'Retrying in 5 s… ({exc})')
            time.sleep(5)


if __name__ == '__main__':
    connect_to_server()
```
